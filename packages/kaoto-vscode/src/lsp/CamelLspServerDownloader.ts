/**
 * Copyright 2025 Red Hat, Inc. and/or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as crypto from 'crypto'; // NOSONAR
import * as fs from 'fs'; // NOSONAR
import * as https from 'https'; // NOSONAR
import * as path from 'path'; // NOSONAR
import { pipeline } from 'stream/promises'; // NOSONAR

/**
 * The Camel Language Server release used by Kaoto, and the SHA-256 of its JAR on Maven Central.
 * Update both together when moving to a new release.
 */
export const CAMEL_LSP_SERVER_VERSION = '1.35.0';
const CAMEL_LSP_SERVER_SHA256 = 'fdae586f74afcec5cd2c55f19343f870c88f3613e418fd3840d09d8af18d6270';

const MAVEN_CENTRAL_URL = 'https://repo1.maven.org/maven2/com/github/camel-tooling/camel-lsp-server';
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** Reports the bytes received so far, and the total size when the server sends it. */
export type DownloadProgress = (receivedBytes: number, totalBytes: number | undefined) => void;

export type FileDownload = (url: string, targetPath: string, onProgress?: DownloadProgress) => Promise<void>;

/**
 * Downloads the Camel Language Server JAR from Maven Central into the extension storage, once per release.
 * The JAR is only kept when its SHA-256 matches the expected one.
 */
export class CamelLspServerDownloader {
	private readonly serverDir: string;

	constructor(
		storageDir: string,
		private readonly version = CAMEL_LSP_SERVER_VERSION,
		private readonly sha256 = CAMEL_LSP_SERVER_SHA256,
		private readonly download: FileDownload = downloadFile,
	) {
		this.serverDir = path.join(storageDir, 'camel-lsp-server');
	}

	getVersion(): string {
		return this.version;
	}

	getJarPath(): string {
		return path.join(this.serverDir, this.version, `camel-lsp-server-${this.version}.jar`);
	}

	getDownloadUrl(): string {
		return `${MAVEN_CENTRAL_URL}/${this.version}/camel-lsp-server-${this.version}.jar`;
	}

	isDownloaded(): boolean {
		return fs.existsSync(this.getJarPath());
	}

	/**
	 * @returns the path of the server JAR, downloaded first when it is not in the storage yet
	 */
	async ensureServerJar(onProgress?: DownloadProgress): Promise<string> {
		const jarPath = this.getJarPath();
		if (fs.existsSync(jarPath)) {
			return jarPath;
		}

		await fs.promises.mkdir(path.dirname(jarPath), { recursive: true });
		// download next to the JAR, so that an interrupted download is never taken for the JAR
		const partPath = `${jarPath}.part`;
		const url = this.getDownloadUrl();
		try {
			await this.download(url, partPath, onProgress);
			const actualSha256 = await computeSha256(partPath);
			if (actualSha256 !== this.sha256) {
				throw new Error(`Checksum mismatch for ${url}: expected SHA-256 ${this.sha256}, got ${actualSha256}`);
			}
			await fs.promises.rename(partPath, jarPath);
		} catch (error) {
			await fs.promises.rm(partPath, { force: true });
			throw error;
		}

		await this.removeOtherVersions();
		return jarPath;
	}

	private async removeOtherVersions(): Promise<void> {
		try {
			const entries = await fs.promises.readdir(this.serverDir, { withFileTypes: true });
			const otherVersions = entries.filter((entry) => entry.isDirectory() && entry.name !== this.version);
			await Promise.all(otherVersions.map((entry) => fs.promises.rm(path.join(this.serverDir, entry.name), { recursive: true, force: true })));
		} catch {
			// the previous releases only take disk space, they are removed on the next download
		}
	}
}

/**
 * Downloads a file over HTTPS, following redirects.
 */
export function downloadFile(url: string, targetPath: string, onProgress?: DownloadProgress, redirects = MAX_REDIRECTS): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
			const statusCode = response.statusCode ?? 0;
			const location = response.headers.location;
			if (statusCode >= 300 && statusCode < 400 && location && redirects > 0) {
				response.resume();
				downloadFile(new URL(location, url).toString(), targetPath, onProgress, redirects - 1).then(resolve, reject);
				return;
			}
			if (statusCode !== 200) {
				response.resume();
				reject(new Error(`HTTP ${statusCode} for ${url}`));
				return;
			}

			const totalBytes = Number(response.headers['content-length']) || undefined;
			let receivedBytes = 0;
			response.on('data', (chunk: Buffer) => {
				receivedBytes += chunk.length;
				onProgress?.(receivedBytes, totalBytes);
			});
			pipeline(response, fs.createWriteStream(targetPath)).then(resolve, reject);
		});
		request.on('timeout', () => request.destroy(new Error(`No data from ${url} for ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`)));
		request.on('error', reject);
	});
}

async function computeSha256(filePath: string): Promise<string> {
	const hash = crypto.createHash('sha256');
	for await (const chunk of fs.createReadStream(filePath)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}
