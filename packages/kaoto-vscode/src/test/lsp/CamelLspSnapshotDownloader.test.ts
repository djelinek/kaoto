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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileDownload, TextFetch } from '../../lsp/CamelLspServerDownloader';
import { CamelLspSnapshotDownloader, describeSnapshotBuild, SnapshotBuild } from '../../lsp/CamelLspSnapshotDownloader';

const REPOSITORY_URL = 'https://central.sonatype.com/repository/maven-snapshots/com/github/camel-tooling/camel-lsp-server';
const BUILD: SnapshotBuild = { version: '1.36.0-SNAPSHOT', buildVersion: '1.36.0-20261030.152716-14' };
const JAR_URL = `${REPOSITORY_URL}/1.36.0-SNAPSHOT/camel-lsp-server-1.36.0-20261030.152716-14.jar`;
const JAR_CONTENT = 'camel-lsp-server snapshot jar content';
const JAR_SHA1 = crypto.createHash('sha1').update(JAR_CONTENT).digest('hex');

// 1.35.1-SNAPSHOT was deployed last, from a maintenance branch: the main branch has the highest version
const ARTIFACT_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.github.camel-tooling</groupId>
  <artifactId>camel-lsp-server</artifactId>
  <versioning>
    <latest>1.35.1-SNAPSHOT</latest>
    <versions>
      <version>1.9.0-SNAPSHOT</version>
      <version>1.36.0-SNAPSHOT</version>
      <version>1.35.1-SNAPSHOT</version>
    </versions>
    <lastUpdated>20261030152716</lastUpdated>
  </versioning>
</metadata>`;

// the sources and the signature of the JAR come from other builds, to tell them from the JAR
const VERSION_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata modelVersion="1.1.0">
  <groupId>com.github.camel-tooling</groupId>
  <artifactId>camel-lsp-server</artifactId>
  <version>1.36.0-SNAPSHOT</version>
  <versioning>
    <snapshot>
      <timestamp>20261030.152716</timestamp>
      <buildNumber>14</buildNumber>
    </snapshot>
    <lastUpdated>20261030152716</lastUpdated>
    <snapshotVersions>
      <snapshotVersion>
        <classifier>sources</classifier>
        <extension>jar</extension>
        <value>1.36.0-20261030.141502-13</value>
        <updated>20261030141502</updated>
      </snapshotVersion>
      <snapshotVersion>
        <extension>jar.asc</extension>
        <value>1.36.0-20261030.141502-13</value>
        <updated>20261030141502</updated>
      </snapshotVersion>
      <snapshotVersion>
        <extension>jar</extension>
        <value>1.36.0-20261030.152716-14</value>
        <updated>20261030152716</updated>
      </snapshotVersion>
      <snapshotVersion>
        <extension>pom</extension>
        <value>1.36.0-20261030.152716-14</value>
        <updated>20261030152716</updated>
      </snapshotVersion>
    </snapshotVersions>
  </versioning>
</metadata>`;

async function getRejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('The promise was expected to be rejected');
}

suite('CamelLspSnapshotDownloader', () => {
	let storageDir: string;
	let requestedUrls: string[];

	const fetchFrom =
		(files: Record<string, string>): TextFetch =>
		async (url) => {
			requestedUrls.push(url);
			if (!(url in files)) {
				throw new Error(`HTTP 404 for ${url}`);
			}
			return files[url];
		};

	const repositoryFiles = (): Record<string, string> => ({
		[`${REPOSITORY_URL}/maven-metadata.xml`]: ARTIFACT_METADATA,
		[`${REPOSITORY_URL}/1.36.0-SNAPSHOT/maven-metadata.xml`]: VERSION_METADATA,
		[`${JAR_URL}.sha1`]: `${JAR_SHA1}\n`,
	});

	const downloadWriting =
		(content: string): FileDownload =>
		async (url, targetPath, onProgress) => {
			requestedUrls.push(url);
			await fs.promises.writeFile(targetPath, content);
			onProgress?.(content.length, content.length);
		};

	const snapshotDir = () => path.join(storageDir, 'camel-lsp-server-snapshot');

	const writeJar = (jarPath: string, content: string) => {
		fs.mkdirSync(path.dirname(jarPath), { recursive: true });
		fs.writeFileSync(jarPath, content);
	};

	const createDownloader = (files = repositoryFiles(), content = JAR_CONTENT) =>
		new CamelLspSnapshotDownloader(storageDir, fetchFrom(files), downloadWriting(content));

	setup(() => {
		storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoto-lsp-snapshot-'));
		requestedUrls = [];
	});

	teardown(() => {
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	test('finds the latest build of the highest snapshot version in the Maven Central snapshot repository', async () => {
		const downloader = createDownloader();

		expect(await downloader.findLatestBuild()).to.deep.equal(BUILD);
		expect(requestedUrls).to.deep.equal([`${REPOSITORY_URL}/maven-metadata.xml`, `${REPOSITORY_URL}/1.36.0-SNAPSHOT/maven-metadata.xml`]);
	});

	test('fails when no snapshot is published', async () => {
		const files = { [`${REPOSITORY_URL}/maven-metadata.xml`]: ARTIFACT_METADATA.replace(/-SNAPSHOT/g, '') };

		const error = await getRejection(createDownloader(files).findLatestBuild());

		expect(error.message).to.contain('No snapshot of the Camel Language Server');
	});

	test('fails when the latest snapshot has no JAR', async () => {
		const files = repositoryFiles();
		files[`${REPOSITORY_URL}/1.36.0-SNAPSHOT/maven-metadata.xml`] = VERSION_METADATA.replace(
			'<extension>jar</extension>\n        <value>1.36.0-20261030.152716-14',
			'<extension>war</extension>\n        <value>1.36.0-20261030.152716-14',
		);

		const error = await getRejection(createDownloader(files).findLatestBuild());

		expect(error.message).to.contain('No JAR').and.contain('1.36.0-SNAPSHOT');
	});

	test('downloads the JAR of a build when it matches the published SHA-1', async () => {
		const downloader = createDownloader();

		const jarPath = await downloader.ensureServerJar(BUILD);

		expect(jarPath).to.equal(path.join(snapshotDir(), BUILD.buildVersion, `camel-lsp-server-${BUILD.buildVersion}.jar`));
		expect(fs.readFileSync(jarPath, 'utf8')).to.equal(JAR_CONTENT);
		expect(downloader.getDownloadUrl(BUILD)).to.equal(JAR_URL);
		expect(requestedUrls).to.deep.equal([`${JAR_URL}.sha1`, JAR_URL]);
		expect(fs.readdirSync(path.dirname(jarPath))).to.deep.equal([path.basename(jarPath)]);
	});

	test('reuses a downloaded build', async () => {
		const downloader = createDownloader();
		expect(downloader.isDownloaded(BUILD)).to.be.false;

		const jarPath = await downloader.ensureServerJar(BUILD);

		expect(downloader.isDownloaded(BUILD)).to.be.true;
		expect(await downloader.ensureServerJar(BUILD)).to.equal(jarPath);
		expect(requestedUrls).to.have.lengthOf(2);
	});

	test('rejects a JAR that does not match the published SHA-1 and keeps nothing', async () => {
		const downloader = createDownloader(repositoryFiles(), 'tampered content');

		const error = await getRejection(downloader.ensureServerJar(BUILD));

		expect(error.message).to.contain('Checksum mismatch').and.contain(JAR_SHA1);
		expect(downloader.isDownloaded(BUILD)).to.be.false;
		expect(fs.readdirSync(path.join(snapshotDir(), BUILD.buildVersion))).to.be.empty;
	});

	test('removes the other builds after a download, and keeps the release', async () => {
		const previousBuildJar = path.join(snapshotDir(), '1.36.0-20261029.090000-13', 'camel-lsp-server-1.36.0-20261029.090000-13.jar');
		writeJar(previousBuildJar, 'previous build');
		const releaseJar = path.join(storageDir, 'camel-lsp-server', '1.35.0', 'camel-lsp-server-1.35.0.jar');
		writeJar(releaseJar, 'release');

		await createDownloader().ensureServerJar(BUILD);

		expect(fs.readdirSync(snapshotDir())).to.deep.equal([BUILD.buildVersion]);
		expect(fs.existsSync(releaseJar)).to.be.true;
	});

	test('finds the build downloaded last, without the repository', () => {
		writeJar(path.join(snapshotDir(), '1.36.0-20261028.120000-12', 'camel-lsp-server-1.36.0-20261028.120000-12.jar'), 'build 12');
		writeJar(path.join(snapshotDir(), '1.36.0-20261029.090000-13', 'camel-lsp-server-1.36.0-20261029.090000-13.jar'), 'build 13');
		// an interrupted download leaves the directory of its build without a JAR
		fs.mkdirSync(path.join(snapshotDir(), BUILD.buildVersion), { recursive: true });
		const downloader = createDownloader();

		const build = downloader.findDownloadedBuild();

		expect(build).to.deep.equal({ version: '1.36.0-SNAPSHOT', buildVersion: '1.36.0-20261029.090000-13' });
		expect(build && downloader.getJarPath(build)).to.equal(
			path.join(snapshotDir(), '1.36.0-20261029.090000-13', 'camel-lsp-server-1.36.0-20261029.090000-13.jar'),
		);
		expect(requestedUrls).to.be.empty;
	});

	test('finds no downloaded build in an empty storage', () => {
		expect(createDownloader().findDownloadedBuild()).to.be.undefined;
	});

	test('describes a build with its snapshot version, number and time', () => {
		expect(describeSnapshotBuild(BUILD)).to.equal('1.36.0-SNAPSHOT build 14 (2026-10-30 15:27 UTC)');
	});
});
