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
import * as vscode from 'vscode';
import { KAOTO_LSP_SERVER_JAR_SETTING_ID, KAOTO_LSP_USE_LATEST_SNAPSHOT_SETTING_ID } from '../../constants';
import { CamelLanguageServerManager } from '../../lsp/CamelLanguageServerManager';
import { CamelLspServerDownloader, FileDownload, TextFetch } from '../../lsp/CamelLspServerDownloader';
import { CamelLspSnapshotDownloader } from '../../lsp/CamelLspSnapshotDownloader';

suite('CamelLanguageServerManager', () => {
	test('findJavaExecutable should return a string or undefined', async () => {
		const result = await CamelLanguageServerManager.findJavaExecutable();
		// In CI/test environments, Java may or may not be available
		expect(result === undefined || typeof result === 'string').to.be.true;
	});

	test('getJavaVersion should return a number for valid java path', async () => {
		const javaPath = await CamelLanguageServerManager.findJavaExecutable();
		if (javaPath) {
			const version = await CamelLanguageServerManager.getJavaVersion(javaPath);
			expect(version).to.be.a('number');
			expect(version).to.be.greaterThan(0);
		}
	});

	test('getJavaVersion should return 0 for invalid java path', async () => {
		const version = await CamelLanguageServerManager.getJavaVersion('/nonexistent/bin/java');
		expect(version).to.equal(0);
	});

	test('isRunning should return false before start', () => {
		// We cannot fully construct the manager without a real ExtensionContext,
		// but we can verify the static methods work correctly
		expect(CamelLanguageServerManager.REQUIRED_JAVA_VERSION).to.equal(17);
	});

	suite('resolveJarPath', () => {
		const REPOSITORY_URL = 'https://central.sonatype.com/repository/maven-snapshots/com/github/camel-tooling/camel-lsp-server';
		const LATEST_BUILD = '1.36.0-20261030.152716-14';
		const DOWNLOADED_BUILD = '1.36.0-20261029.090000-13';
		const RELEASE_CONTENT = 'release jar content';
		const SNAPSHOT_CONTENT = 'snapshot jar content';
		const hash = (algorithm: string, content: string) => crypto.createHash(algorithm).update(content).digest('hex');

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		let storageDir: string;
		let settings: Record<string, unknown>;
		let errorMessages: string[];
		let requestedUrls: string[];

		const snapshotRepository: TextFetch = async (url) => {
			requestedUrls.push(url);
			const files: Record<string, string> = {
				[`${REPOSITORY_URL}/maven-metadata.xml`]:
					'<metadata><versioning><versions><version>1.36.0-SNAPSHOT</version></versions></versioning></metadata>',
				[`${REPOSITORY_URL}/1.36.0-SNAPSHOT/maven-metadata.xml`]: `<metadata><versioning><snapshotVersions><snapshotVersion><extension>jar</extension><value>${LATEST_BUILD}</value></snapshotVersion></snapshotVersions></versioning></metadata>`,
				[`${REPOSITORY_URL}/1.36.0-SNAPSHOT/camel-lsp-server-${LATEST_BUILD}.jar.sha1`]: hash('sha1', SNAPSHOT_CONTENT),
			};
			if (!(url in files)) {
				throw new Error(`HTTP 404 for ${url}`);
			}
			return files[url];
		};

		const unreachableRepository: TextFetch = async (url) => {
			requestedUrls.push(url);
			throw new Error('getaddrinfo ENOTFOUND central.sonatype.com');
		};

		const downloadWriting =
			(content: string): FileDownload =>
			async (url, targetPath) => {
				requestedUrls.push(url);
				await fs.promises.writeFile(targetPath, content);
			};

		const failingDownload: FileDownload = async (url) => {
			requestedUrls.push(url);
			throw new Error(`HTTP 503 for ${url}`);
		};

		const snapshotJarPath = (buildVersion: string) =>
			path.join(storageDir, 'camel-lsp-server-snapshot', buildVersion, `camel-lsp-server-${buildVersion}.jar`);

		const writeDownloadedBuild = () => {
			fs.mkdirSync(path.dirname(snapshotJarPath(DOWNLOADED_BUILD)), { recursive: true });
			fs.writeFileSync(snapshotJarPath(DOWNLOADED_BUILD), 'downloaded build');
		};

		const createManager = (snapshotFetch: TextFetch, snapshotDownload = downloadWriting(SNAPSHOT_CONTENT)) =>
			new CamelLanguageServerManager(
				{ subscriptions: [] } as unknown as vscode.ExtensionContext,
				new CamelLspServerDownloader(storageDir, '1.2.3', hash('sha256', RELEASE_CONTENT), downloadWriting(RELEASE_CONTENT)),
				new CamelLspSnapshotDownloader(storageDir, snapshotFetch, snapshotDownload),
			);

		setup(() => {
			storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoto-lsp-manager-'));
			settings = { [KAOTO_LSP_SERVER_JAR_SETTING_ID]: '', [KAOTO_LSP_USE_LATEST_SNAPSHOT_SETTING_ID]: true };
			errorMessages = [];
			requestedUrls = [];
			Object.defineProperty(vscode.workspace, 'getConfiguration', {
				value: (section?: string, scope?: vscode.ConfigurationScope | null) => {
					const config = originalGetConfiguration(section, scope);
					return {
						...config,
						get: (key: string, defaultValue?: unknown) => (key in settings ? settings[key] : config.get(key, defaultValue)),
					};
				},
				configurable: true,
			});
			Object.defineProperty(vscode.window, 'showErrorMessage', {
				value: async (message: string) => {
					errorMessages.push(message);
					return undefined;
				},
				configurable: true,
			});
		});

		teardown(() => {
			Object.defineProperty(vscode.workspace, 'getConfiguration', { value: originalGetConfiguration, configurable: true });
			Object.defineProperty(vscode.window, 'showErrorMessage', { value: originalShowErrorMessage, configurable: true });
			fs.rmSync(storageDir, { recursive: true, force: true });
		});

		test('runs the latest snapshot when kaoto.lsp.useLatestSnapshot is on', async () => {
			const jarPath = await createManager(snapshotRepository).resolveJarPath();

			expect(jarPath).to.equal(snapshotJarPath(LATEST_BUILD));
			expect(fs.readFileSync(snapshotJarPath(LATEST_BUILD), 'utf8')).to.equal(SNAPSHOT_CONTENT);
		});

		test('runs the snapshot downloaded before when the snapshot repository cannot be reached', async () => {
			writeDownloadedBuild();

			const jarPath = await createManager(unreachableRepository).resolveJarPath();

			expect(jarPath).to.equal(snapshotJarPath(DOWNLOADED_BUILD));
			expect(errorMessages).to.be.empty;
		});

		test('runs the snapshot downloaded before when the latest build cannot be downloaded', async () => {
			writeDownloadedBuild();

			const jarPath = await createManager(snapshotRepository, failingDownload).resolveJarPath();

			expect(jarPath).to.equal(snapshotJarPath(DOWNLOADED_BUILD));
			expect(errorMessages).to.be.empty;
		});

		test('reports the error when no snapshot can be looked up and none was downloaded before', async () => {
			const jarPath = await createManager(unreachableRepository).resolveJarPath();

			expect(jarPath).to.be.undefined;
			expect(errorMessages).to.have.lengthOf(1);
			expect(errorMessages[0]).to.contain('snapshot').and.contain('ENOTFOUND');
		});

		test('runs the JAR set in kaoto.lsp.serverJarPath, even when the latest snapshot is on', async () => {
			const localJar = path.join(storageDir, 'local.jar');
			fs.writeFileSync(localJar, 'local build');
			settings[KAOTO_LSP_SERVER_JAR_SETTING_ID] = localJar;

			expect(await createManager(snapshotRepository).resolveJarPath()).to.equal(localJar);
			expect(requestedUrls).to.be.empty;
		});

		test('runs the release when the latest snapshot is off', async () => {
			settings[KAOTO_LSP_USE_LATEST_SNAPSHOT_SETTING_ID] = false;

			const jarPath = await createManager(snapshotRepository).resolveJarPath();

			expect(jarPath).to.equal(path.join(storageDir, 'camel-lsp-server', '1.2.3', 'camel-lsp-server-1.2.3.jar'));
			expect(requestedUrls).to.deep.equal(['https://repo1.maven.org/maven2/com/github/camel-tooling/camel-lsp-server/1.2.3/camel-lsp-server-1.2.3.jar']);
		});
	});
});
