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
import { expect } from 'chai';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { IncomingMessage, OutgoingHttpHeaders } from 'http';
import https, { type RequestOptions } from 'https';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { CAMEL_LSP_SERVER_VERSION, CamelLspServerDownloader, fetchText, FileDownload } from '../../lsp/CamelLspServerDownloader';

const JAR_CONTENT = 'camel-lsp-server jar content';
const JAR_SHA256 = crypto.createHash('sha256').update(JAR_CONTENT).digest('hex');
const VERSION = '1.2.3';

async function getRejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('The promise was expected to be rejected');
}

suite('CamelLspServerDownloader', () => {
	let storageDir: string;
	let requestedUrls: string[];

	const downloadWriting =
		(content: string): FileDownload =>
		async (url, targetPath, onProgress) => {
			requestedUrls.push(url);
			await fs.promises.writeFile(targetPath, content);
			onProgress?.(content.length, content.length);
		};

	const versionDir = () => path.join(storageDir, 'camel-lsp-server', VERSION);

	setup(() => {
		storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoto-lsp-server-'));
		requestedUrls = [];
	});

	teardown(() => {
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	test('downloads the release JAR from Maven Central into the storage', async () => {
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting(JAR_CONTENT));

		const jarPath = await downloader.ensureServerJar();

		expect(jarPath).to.equal(path.join(versionDir(), `camel-lsp-server-${VERSION}.jar`));
		expect(fs.readFileSync(jarPath, 'utf8')).to.equal(JAR_CONTENT);
		expect(requestedUrls).to.deep.equal([
			`https://repo1.maven.org/maven2/com/github/camel-tooling/camel-lsp-server/${VERSION}/camel-lsp-server-${VERSION}.jar`,
		]);
		expect(fs.readdirSync(versionDir())).to.deep.equal([`camel-lsp-server-${VERSION}.jar`]);
	});

	test('reuses the downloaded JAR', async () => {
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting(JAR_CONTENT));
		expect(downloader.isDownloaded()).to.be.false;

		const jarPath = await downloader.ensureServerJar();

		expect(downloader.isDownloaded()).to.be.true;
		expect(await downloader.ensureServerJar()).to.equal(jarPath);
		expect(requestedUrls).to.have.lengthOf(1);
	});

	test('reports the download progress', async () => {
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting(JAR_CONTENT));
		const progress: Array<[number, number | undefined]> = [];

		await downloader.ensureServerJar((receivedBytes, totalBytes) => progress.push([receivedBytes, totalBytes]));

		expect(progress).to.deep.equal([[JAR_CONTENT.length, JAR_CONTENT.length]]);
	});

	test('rejects a JAR with another checksum and keeps nothing', async () => {
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting('tampered content'));

		const error = await getRejection(downloader.ensureServerJar());

		expect(error.message).to.contain('Checksum mismatch').and.contain(JAR_SHA256);
		expect(downloader.isDownloaded()).to.be.false;
		expect(fs.readdirSync(versionDir())).to.be.empty;
	});

	test('keeps nothing when the download fails', async () => {
		const failingDownload: FileDownload = async (_url, targetPath) => {
			await fs.promises.writeFile(targetPath, 'partial content');
			throw new Error('HTTP 503');
		};
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, failingDownload);

		const error = await getRejection(downloader.ensureServerJar());

		expect(error.message).to.equal('HTTP 503');
		expect(fs.readdirSync(versionDir())).to.be.empty;
	});

	test('removes the JARs of the other releases after a download', async () => {
		const previousJar = path.join(storageDir, 'camel-lsp-server', '1.0.0', 'camel-lsp-server-1.0.0.jar');
		fs.mkdirSync(path.dirname(previousJar), { recursive: true });
		fs.writeFileSync(previousJar, 'previous release');
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting(JAR_CONTENT));

		await downloader.ensureServerJar();

		expect(fs.readdirSync(path.join(storageDir, 'camel-lsp-server'))).to.deep.equal([VERSION]);
	});

	test('keeps the downloaded snapshot after a download', async () => {
		const snapshotJar = path.join(storageDir, 'camel-lsp-server-snapshot', '1.36.0-20261030.152716-14', 'camel-lsp-server-1.36.0-20261030.152716-14.jar');
		fs.mkdirSync(path.dirname(snapshotJar), { recursive: true });
		fs.writeFileSync(snapshotJar, 'snapshot build');
		const downloader = new CamelLspServerDownloader(storageDir, VERSION, JAR_SHA256, downloadWriting(JAR_CONTENT));

		await downloader.ensureServerJar();

		expect(fs.existsSync(snapshotJar)).to.be.true;
	});

	test('names Kaoto in its requests, which the Maven Central snapshot repository refuses without a User-Agent', async () => {
		const originalGet = https.get;
		const userAgents: unknown[] = [];
		Object.defineProperty(https, 'get', {
			value: (_url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
				userAgents.push((options.headers as OutgoingHttpHeaders | undefined)?.['User-Agent']);
				const response = Object.assign(Readable.from([Buffer.from('<metadata/>')]), { statusCode: 200, headers: {} });
				callback(response as unknown as IncomingMessage);
				return new EventEmitter();
			},
			configurable: true,
		});

		try {
			expect(await fetchText('https://central.sonatype.com/repository/maven-snapshots/maven-metadata.xml')).to.equal('<metadata/>');
		} finally {
			Object.defineProperty(https, 'get', { value: originalGet, configurable: true });
		}

		expect(userAgents).to.have.lengthOf(1);
		expect(userAgents[0]).to.match(/^vscode-kaoto\b/);
	});

	test('reads a text file as bytes, as the network inspection of a debugged extension host requires', async () => {
		const originalGet = https.get;
		Object.defineProperty(https, 'get', {
			value: (_url: string, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
				const chunks = [Buffer.from('<metadata>'), Buffer.from('</metadata>')];
				const response = Object.assign(Readable.from(chunks, { objectMode: false }), { statusCode: 200, headers: {} });
				// like Node with --experimental-network-inspection, which reports the byteLength of each chunk
				EventEmitter.prototype.on.call(response, 'data', (chunk: Uint8Array) => {
					if (typeof chunk.byteLength !== 'number') {
						throw new Error('Missing dataLength in event');
					}
				});
				callback(response as unknown as IncomingMessage);
				return new EventEmitter();
			},
			configurable: true,
		});

		try {
			expect(await fetchText('https://central.sonatype.com/repository/maven-snapshots/maven-metadata.xml')).to.equal('<metadata></metadata>');
		} finally {
			Object.defineProperty(https, 'get', { value: originalGet, configurable: true });
		}
	});

	test('uses the pinned release by default', () => {
		const downloader = new CamelLspServerDownloader(storageDir);

		expect(downloader.getVersion()).to.equal(CAMEL_LSP_SERVER_VERSION);
		expect(downloader.getDownloadUrl()).to.match(/\/camel-lsp-server\/\d+\.\d+\.\d+\/camel-lsp-server-\d+\.\d+\.\d+\.jar$/);
	});
});
