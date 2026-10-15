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
import * as vscode from 'vscode';
import * as path from 'path'; // NOSONAR
import * as fs from 'fs'; // NOSONAR
import { execFile } from 'child_process';
import { Executable, LanguageClient, LanguageClientOptions } from 'vscode-languageclient/node';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import { CAMEL_LSP_DOCUMENT_SELECTORS, CAMEL_LSP_FILE_WATCHER_GLOBS } from './CamelLspDocumentFilter';

const LANGUAGE_CLIENT_ID = 'LANGUAGE_ID_APACHE_CAMEL_KAOTO';
const LANGUAGE_CLIENT_NAME = 'Camel Language Server (Kaoto)';

type StatusBarState = 'starting' | 'running' | 'error';

/**
 * Manages the lifecycle of the Camel Language Server: Java detection, JAR resolution,
 * and starting/stopping the underlying `LanguageClient`.
 */
export class CamelLanguageServerManager {
	static readonly REQUIRED_JAVA_VERSION = 17;
	static readonly JAR_NAME = 'language-server.jar';

	private languageClient: LanguageClient | undefined;
	private statusBarItem: vscode.StatusBarItem | undefined;
	private fileWatchers: vscode.FileSystemWatcher[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {}

	/**
	 * Start the Camel Language Server.
	 * @param initializationOptions Optional settings to send to the server on startup
	 */
	async start(initializationOptions?: Record<string, unknown>): Promise<void> {
		this.createStatusBar();
		this.updateStatusBar('starting');

		const javaExecutable = await CamelLanguageServerManager.findJavaExecutable();
		if (!javaExecutable) {
			this.showJavaNotFoundWarning();
			return;
		}

		const javaVersion = await CamelLanguageServerManager.getJavaVersion(javaExecutable);
		if (javaVersion < CamelLanguageServerManager.REQUIRED_JAVA_VERSION) {
			this.showJavaVersionWarning(javaVersion);
			return;
		}

		const jarPath = this.resolveJarPath();
		if (!jarPath) {
			KaotoOutputChannel.logError('Camel LSP server JAR not found. LSP features will not be available.');
			return;
		}

		KaotoOutputChannel.logInfo(`Starting Camel Language Server with Java ${javaVersion} at ${javaExecutable}`);
		KaotoOutputChannel.logInfo(`Camel LSP server JAR: ${jarPath} (${this.getJarFileSize(jarPath)})`);

		const serverOptions: Executable = {
			command: javaExecutable,
			args: ['-jar', jarPath],
		};

		this.fileWatchers = CAMEL_LSP_FILE_WATCHER_GLOBS.map((glob) => vscode.workspace.createFileSystemWatcher(glob));

		const clientOptions: LanguageClientOptions = {
			documentSelector: CAMEL_LSP_DOCUMENT_SELECTORS,
			synchronize: {
				configurationSection: ['camel'],
				fileEvents: this.fileWatchers,
			},
			initializationOptions: initializationOptions ?? undefined,
			middleware: {
				workspace: {
					didChangeConfiguration: async () => {
						// Suppress the default vscode-languageclient behavior which reads
						// the (non-existent) 'camel' VS Code configuration section and
						// would send an empty/stale settings object, overwriting the
						// catalog-derived settings pushed by CamelLspConfigurationSync.
					},
				},
			},
		};

		this.languageClient = new LanguageClient(LANGUAGE_CLIENT_ID, LANGUAGE_CLIENT_NAME, serverOptions, clientOptions);

		try {
			await this.languageClient.start();
			this.updateStatusBar('running');
			this.logServerInfo();
			KaotoOutputChannel.logInfo('Camel Language Server started successfully.');
		} catch (error) {
			this.updateStatusBar('error');
			KaotoOutputChannel.logError('Failed to start Camel Language Server', error);
		}
	}

	/**
	 * Stop the Camel Language Server.
	 */
	async stop(): Promise<void> {
		if (this.languageClient) {
			try {
				await this.languageClient.stop();
				KaotoOutputChannel.logInfo('Camel Language Server stopped.');
			} catch (error) {
				KaotoOutputChannel.logError('Error stopping Camel Language Server', error);
			}
			this.languageClient = undefined;
		}
		for (const watcher of this.fileWatchers) {
			watcher.dispose();
		}
		this.fileWatchers = [];
		this.statusBarItem?.dispose();
		this.statusBarItem = undefined;
	}

	/**
	 * Check if the language client is running.
	 */
	isRunning(): boolean {
		return this.languageClient?.isRunning() ?? false;
	}

	/**
	 * Get the underlying LanguageClient for sending notifications.
	 */
	getClient(): LanguageClient | undefined {
		return this.languageClient;
	}

	/**
	 * Find a Java executable on the system.
	 * Checks JAVA_HOME first, then falls back to java on PATH.
	 */
	static async findJavaExecutable(): Promise<string | undefined> {
		const javaHome = process.env['JAVA_HOME'];
		if (javaHome) {
			const javaPath = path.join(javaHome, 'bin', 'java');
			if (fs.existsSync(javaPath)) {
				return javaPath;
			}
		}

		// Fall back to java on PATH
		try {
			const version = await CamelLanguageServerManager.getJavaVersion('java');
			if (version > 0) {
				return 'java';
			}
		} catch {
			// java not on PATH
		}

		return undefined;
	}

	/**
	 * Get the major Java version by running java -version.
	 * Returns 0 if the version cannot be determined.
	 */
	static async getJavaVersion(javaPath: string): Promise<number> {
		return new Promise<number>((resolve) => {
			execFile(javaPath, ['-version'], { timeout: 10000 }, (_error, stdout, stderr) => {
				// java -version writes to stderr
				const output = stderr || stdout || '';
				const match = output.match(/version\s+"(\d+)(?:\.(\d+))?/);
				if (match) {
					let major = parseInt(match[1], 10);
					// Handle legacy 1.x format
					if (major === 1 && match[2]) {
						major = parseInt(match[2], 10);
					}
					resolve(major);
				} else {
					resolve(0);
				}
			});
		});
	}

	private resolveJarPath(): string | undefined {
		const jarPath = path.join(this.context.extensionPath, 'jars', CamelLanguageServerManager.JAR_NAME);
		if (fs.existsSync(jarPath)) {
			return jarPath;
		}

		// Also check dist/jars (webpack bundle location)
		const distJarPath = path.join(this.context.extensionPath, 'dist', 'jars', CamelLanguageServerManager.JAR_NAME);
		if (fs.existsSync(distJarPath)) {
			return distJarPath;
		}

		return undefined;
	}

	private createStatusBar(): void {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MIN_VALUE);
		this.statusBarItem.name = 'Camel Language Server';
		this.context.subscriptions.push(this.statusBarItem);
	}

	private updateStatusBar(state: StatusBarState): void {
		if (!this.statusBarItem) {
			return;
		}

		switch (state) {
			case 'starting':
				this.statusBarItem.text = '$(sync~spin) Camel LS';
				this.statusBarItem.tooltip = 'Camel Language Server is starting...';
				this.statusBarItem.show();
				break;
			case 'running':
				this.statusBarItem.text = '$(check) Camel LS';
				this.statusBarItem.tooltip = 'Camel Language Server is running';
				this.statusBarItem.show();
				break;
			case 'error':
				this.statusBarItem.text = '$(warning) Camel LS';
				this.statusBarItem.tooltip = 'Camel Language Server failed to start';
				this.statusBarItem.show();
				break;
		}
	}

	private logServerInfo(): void {
		if (!this.languageClient) {
			return;
		}
		const serverInfo = this.languageClient.initializeResult?.serverInfo;
		if (serverInfo) {
			const version = serverInfo.version ? ` v${serverInfo.version}` : '';
			KaotoOutputChannel.logInfo(`Camel Language Server info: ${serverInfo.name}${version}`);
		}
	}

	private getJarFileSize(jarPath: string): string {
		try {
			const stats = fs.statSync(jarPath);
			const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
			return `${sizeMB} MB`;
		} catch {
			return 'unknown size';
		}
	}

	private showJavaNotFoundWarning(): void {
		const msg =
			'Java 17+ is required for Camel Language Server features (completion, hover, validation). ' +
			'Please install a JDK and set JAVA_HOME, or add java to your PATH.';
		KaotoOutputChannel.logWarning(msg);
		void vscode.window.showWarningMessage(msg, 'Install JDK').then((selection) => {
			if (selection === 'Install JDK') {
				void vscode.env.openExternal(vscode.Uri.parse('https://adoptium.net/installation/'));
			}
		});
		this.updateStatusBar('error');
	}

	private showJavaVersionWarning(foundVersion: number): void {
		const msg = `Java ${CamelLanguageServerManager.REQUIRED_JAVA_VERSION}+ is required for Camel Language Server, but found Java ${foundVersion}.`;
		KaotoOutputChannel.logWarning(msg);
		void vscode.window.showWarningMessage(msg);
		this.updateStatusBar('error');
	}
}
