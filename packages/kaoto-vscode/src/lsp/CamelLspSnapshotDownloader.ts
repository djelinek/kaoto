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
import * as fs from 'fs'; // NOSONAR
import * as path from 'path'; // NOSONAR
import { downloadFile, DownloadProgress, downloadVerifiedFile, fetchText, FileDownload, removeOtherVersions, TextFetch } from './CamelLspServerDownloader';

/** The Maven Central repository where the main branch of the Camel Language Server publishes its snapshots. */
const MAVEN_SNAPSHOTS_URL = 'https://central.sonatype.com/repository/maven-snapshots/com/github/camel-tooling/camel-lsp-server';
const SNAPSHOT_SUFFIX = '-SNAPSHOT';
/** The time and the number that a build puts in place of -SNAPSHOT, as in 1.36.0-20261030.152716-14 */
const BUILD_SUFFIX = /-(\d{8}\.\d{6})-(\d+)$/;

/** A snapshot build of the Camel Language Server. */
export interface SnapshotBuild {
	/** the snapshot version, such as 1.36.0-SNAPSHOT */
	version: string;
	/** the version of the files of the build, such as 1.36.0-20261030.152716-14 */
	buildVersion: string;
}

/**
 * Downloads the latest snapshot of the Camel Language Server, which its main branch publishes to the Maven Central
 * snapshot repository, into the extension storage. Every build has new content, so its JAR cannot be pinned like
 * the release: it is only kept when it matches the SHA-1 that the repository publishes with it.
 */
export class CamelLspSnapshotDownloader {
	private readonly snapshotDir: string;

	constructor(
		storageDir: string,
		private readonly fetch: TextFetch = fetchText,
		private readonly download: FileDownload = downloadFile,
	) {
		this.snapshotDir = path.join(storageDir, 'camel-lsp-server-snapshot');
	}

	/**
	 * @returns the latest build of the highest snapshot version, the one of the main branch
	 */
	async findLatestBuild(): Promise<SnapshotBuild> {
		const version = findHighestSnapshotVersion(await this.fetch(`${MAVEN_SNAPSHOTS_URL}/maven-metadata.xml`));
		const buildVersion = findJarBuildVersion(await this.fetch(`${MAVEN_SNAPSHOTS_URL}/${version}/maven-metadata.xml`), version);
		return { version, buildVersion };
	}

	/**
	 * @returns the latest build in the storage, to run when the repository cannot be reached; undefined when there is none
	 */
	findDownloadedBuild(): SnapshotBuild | undefined {
		if (!fs.existsSync(this.snapshotDir)) {
			return undefined;
		}
		return fs
			.readdirSync(this.snapshotDir)
			.filter((name) => BUILD_SUFFIX.test(name))
			.map((buildVersion) => ({ version: buildVersion.replace(BUILD_SUFFIX, SNAPSHOT_SUFFIX), buildVersion }))
			.filter((build) => this.isDownloaded(build))
			.sort((a, b) => buildOrder(a.buildVersion).localeCompare(buildOrder(b.buildVersion)))
			.pop();
	}

	getJarPath(build: SnapshotBuild): string {
		return path.join(this.snapshotDir, build.buildVersion, `camel-lsp-server-${build.buildVersion}.jar`);
	}

	getDownloadUrl(build: SnapshotBuild): string {
		return `${MAVEN_SNAPSHOTS_URL}/${build.version}/camel-lsp-server-${build.buildVersion}.jar`;
	}

	isDownloaded(build: SnapshotBuild): boolean {
		return fs.existsSync(this.getJarPath(build));
	}

	/**
	 * @returns the path of the JAR of the build, downloaded first when it is not in the storage yet
	 */
	async ensureServerJar(build: SnapshotBuild, onProgress?: DownloadProgress): Promise<string> {
		const jarPath = this.getJarPath(build);
		if (fs.existsSync(jarPath)) {
			return jarPath;
		}

		const url = this.getDownloadUrl(build);
		const sha1 = parseSha1(await this.fetch(`${url}.sha1`), url);
		await downloadVerifiedFile(this.download, url, jarPath, { algorithm: 'sha1', value: sha1 }, onProgress);
		await removeOtherVersions(this.snapshotDir, build.buildVersion);
		return jarPath;
	}
}

/**
 * @returns the snapshot version of a build with the number and the time of the build,
 * such as 1.36.0-SNAPSHOT build 14 (2026-10-30 15:27 UTC)
 */
export function describeSnapshotBuild(build: SnapshotBuild): string {
	const match = BUILD_SUFFIX.exec(build.buildVersion);
	if (!match) {
		return `${build.version} (${build.buildVersion})`;
	}
	// Maven writes the time of the build in UTC, as yyyyMMdd.HHmmss
	const [, time, buildNumber] = match;
	const date = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
	return `${build.version} build ${buildNumber} (${date} ${time.slice(9, 11)}:${time.slice(11, 13)} UTC)`;
}

/**
 * @returns the highest snapshot version in the metadata of the artifact: the one of the main branch,
 * even when a maintenance branch deployed its snapshot later
 */
function findHighestSnapshotVersion(metadata: string): string {
	const versions = Array.from(metadata.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g), (match) => match[1]).filter((version) =>
		version.endsWith(SNAPSHOT_SUFFIX),
	);
	if (versions.length === 0) {
		throw new Error(`No snapshot of the Camel Language Server is published in ${MAVEN_SNAPSHOTS_URL}`);
	}
	return versions.reduce((highest, version) => (compareVersions(version, highest) > 0 ? version : highest));
}

/** Compares the numbers of two versions, so that 1.36.0-SNAPSHOT comes after 1.9.0-SNAPSHOT. */
function compareVersions(a: string, b: string): number {
	const numbersOf = (version: string) =>
		version
			.split(/[.-]/)
			.map((part) => Number.parseInt(part, 10))
			.filter((part) => !Number.isNaN(part));
	const [numbersA, numbersB] = [numbersOf(a), numbersOf(b)];
	for (let i = 0; i < Math.max(numbersA.length, numbersB.length); i++) {
		const difference = (numbersA[i] ?? 0) - (numbersB[i] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

/**
 * @returns the version of the JAR in the metadata of a snapshot version, such as 1.36.0-20261030.152716-14
 */
function findJarBuildVersion(metadata: string, version: string): string {
	for (const [, snapshotVersion] of metadata.matchAll(/<snapshotVersion>([\s\S]*?)<\/snapshotVersion>/g)) {
		// the sources, the javadoc and the other JARs of the build have a classifier
		if (!snapshotVersion.includes('<classifier>') && /<extension>\s*jar\s*<\/extension>/.test(snapshotVersion)) {
			const buildVersion = /<value>\s*([^<\s]+)\s*<\/value>/.exec(snapshotVersion)?.[1];
			if (buildVersion) {
				return buildVersion;
			}
		}
	}
	throw new Error(`No JAR of the Camel Language Server ${version} is published in ${MAVEN_SNAPSHOTS_URL}`);
}

/** @returns the time and the number of a build, as text that sorts in the order of the builds */
function buildOrder(buildVersion: string): string {
	const match = BUILD_SUFFIX.exec(buildVersion);
	return match ? `${match[1]}-${match[2].padStart(10, '0')}` : '';
}

/** @returns the SHA-1 of a checksum file, which can be followed by the name of the file */
function parseSha1(checksumFile: string, url: string): string {
	const sha1 = checksumFile.trim().split(/\s+/)[0].toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(sha1)) {
		throw new Error(`No SHA-1 is published for ${url}`);
	}
	return sha1;
}
