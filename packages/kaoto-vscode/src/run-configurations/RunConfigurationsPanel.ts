import * as path from 'path'; // NOSONAR
import { randomBytes } from 'crypto'; // NOSONAR
import {
	commands,
	debug,
	DebugSession,
	Disposable,
	env,
	extensions,
	OpenDialogOptions,
	RelativePattern,
	Uri,
	ViewColumn,
	WebviewPanel,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import { confirmFileDeleteDialog } from '../utils/Modals';
import { CamelFileTracker } from './CamelFileTracker';
import { KAOTO_DEBUG_TYPE, KaotoRunConfiguration } from './RunConfigurationModel';
import { BrowseField, ExtensionMessage, NewConfigurationRequest, RunConfigurationsState, SaveRequest, WebviewMessage } from './RunConfigurationProtocol';
import { CAMEL_DEBUG_ADAPTER_EXTENSION_ID, RunConfigurationLauncher } from './RunConfigurationLauncher';
import { RunConfigurationStore } from './RunConfigurationStore';

/**
 * The Kaoto: Run Configurations editor tab
 */
export class RunConfigurationsPanel implements Disposable {
	public static readonly VIEW_TYPE = 'kaoto.runConfigurations';
	private static current: RunConfigurationsPanel | undefined;

	private readonly panel: WebviewPanel;
	private readonly disposables: Disposable[] = [];
	private readonly sessions = new Set<DebugSession>();
	private ready = false;
	private readonly queue: ExtensionMessage[] = [];

	static show(extensionUri: Uri, store: RunConfigurationStore, launcher: RunConfigurationLauncher, message?: ExtensionMessage): void {
		if (RunConfigurationsPanel.current) {
			RunConfigurationsPanel.current.panel.reveal();
		} else {
			RunConfigurationsPanel.current = new RunConfigurationsPanel(extensionUri, store, launcher);
		}
		if (message) {
			RunConfigurationsPanel.current.post(message);
		}
	}

	/**
	 * Open the screen on the configuration of a file or folder, or on a new one for it
	 */
	static showForTarget(extensionUri: Uri, store: RunConfigurationStore, launcher: RunConfigurationLauncher, target: Uri, isFolder: boolean): void {
		const folder = workspace.getWorkspaceFolder(target);
		if (!folder) {
			void window.showWarningMessage(`${target.fsPath} is not in an open workspace folder.`);
			return;
		}
		const relativeTarget = path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join('/');
		const targetValue = relativeTarget ? `\${workspaceFolder}/${relativeTarget}` : '${workspaceFolder}';
		const existing = store.getEntries().find((entry) => {
			const entryTarget = entry.configuration.target ?? '';
			return (
				entry.folder === folder.uri.toString() && (entryTarget === targetValue || launcher.substituteVariables(entryTarget, folder) === target.fsPath)
			);
		});
		const request: NewConfigurationRequest = { folder: folder.uri.toString(), target: targetValue, isFolder };
		RunConfigurationsPanel.show(
			extensionUri,
			store,
			launcher,
			existing ? { type: 'select', folder: existing.folder, name: existing.configuration.name } : { type: 'create', request },
		);
	}

	private constructor(
		extensionUri: Uri,
		private readonly store: RunConfigurationStore,
		private readonly launcher: RunConfigurationLauncher,
	) {
		const webviewRoot = Uri.joinPath(extensionUri, 'dist', 'webview');
		this.panel = window.createWebviewPanel(RunConfigurationsPanel.VIEW_TYPE, 'Run Configurations', ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [webviewRoot],
		});
		this.panel.iconPath = Uri.joinPath(extensionUri, 'icons', 'kaoto.png');
		this.panel.webview.html = this.getHtml(webviewRoot);

		const camelFiles = workspace.createFileSystemWatcher('**/*.{yaml,yml,xml}', false, true, false);
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message)),
			this.store.onDidChange(() => this.postState()),
			workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('kaoto') && this.postState()),
			extensions.onDidChange(() => this.postState()),
			camelFiles,
			camelFiles.onDidCreate((uri) => CamelFileTracker.isCamelFile(uri) && this.postState()),
			camelFiles.onDidDelete((uri) => CamelFileTracker.isCamelFile(uri) && this.postState()),
			debug.onDidStartDebugSession((session) => this.trackSession(session, true)),
			debug.onDidTerminateDebugSession((session) => this.trackSession(session, false)),
		);
		if (debug.activeDebugSession) {
			this.trackSession(debug.activeDebugSession, true);
		}
	}

	dispose(): void {
		RunConfigurationsPanel.current = undefined;
		this.disposables.forEach((disposable) => disposable.dispose());
		this.panel.dispose();
	}

	private post(message: ExtensionMessage): void {
		if (this.ready) {
			void this.panel.webview.postMessage(message);
		} else {
			this.queue.push(message);
		}
	}

	private trackSession(session: DebugSession, started: boolean): void {
		if (session.type !== KAOTO_DEBUG_TYPE) {
			return;
		}
		if (started) {
			this.sessions.add(session);
		} else {
			this.sessions.delete(session);
		}
		void this.postState();
	}

	private async buildState(): Promise<RunConfigurationsState> {
		const folders = workspace.workspaceFolders ?? [];
		const entries = this.store.getEntries();
		const running = entries
			.filter((entry) =>
				[...this.sessions].some(
					(session) => session.workspaceFolder?.uri.toString() === entry.folder && session.configuration.name === entry.configuration.name,
				),
			)
			.map((entry) => entry.id);
		return {
			entries,
			folders: await Promise.all(
				folders.map(async (folder) => ({
					uri: folder.uri.toString(),
					name: folder.name,
					path: folder.uri.fsPath,
					targets: await this.launcher.findTargets(folder),
				})),
			),
			catalogs: this.launcher.getCatalogOptions(),
			defaults: await this.launcher.readDefaults(),
			camelDebuggerInstalled: !!extensions.getExtension(CAMEL_DEBUG_ADAPTER_EXTENSION_ID),
			running,
		};
	}

	private async postState(): Promise<void> {
		if (this.ready) {
			void this.panel.webview.postMessage({ type: 'state', state: await this.buildState() } satisfies ExtensionMessage);
		}
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					await this.panel.webview.postMessage({ type: 'state', state: await this.buildState() } satisfies ExtensionMessage);
					this.ready = true;
					this.queue.splice(0).forEach((queued) => this.post(queued));
					break;
				case 'preview': {
					const folder = this.store.getFolder(message.folder);
					this.post({ type: 'preview', result: await this.launcher.preview(message.configuration, folder, message.requestId) });
					break;
				}
				case 'save':
					await this.save(message);
					break;
				case 'delete':
					if (await confirmFileDeleteDialog(message.name)) {
						await this.store.delete(message.folder, { index: message.index, name: message.name });
					}
					break;
				case 'launch':
					await this.launch(message, message.noDebug, message.save);
					break;
				case 'browse':
					await this.browse(message.field, this.store.getFolder(message.folder));
					break;
				case 'copy':
					await env.clipboard.writeText(message.text);
					break;
				case 'openLaunchJson':
					await this.openLaunchJson(this.store.getFolder(message.folder));
					break;
				case 'installCamelDebugger':
					await commands.executeCommand('extension.open', CAMEL_DEBUG_ADAPTER_EXTENSION_ID);
					break;
			}
		} catch (error) {
			KaotoOutputChannel.logError(`Run Configurations: ${message.type} failed`, error);
			void window.showErrorMessage(`Kaoto: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async save(request: SaveRequest): Promise<void> {
		await this.store.save(request);
		this.post({ type: 'saved', folder: request.folder, name: request.configuration.name });
	}

	private async launch(request: SaveRequest, noDebug: boolean, save: boolean): Promise<void> {
		if (save) {
			await this.save(request);
		}
		const folder = this.store.getFolder(request.folder);
		// ${file} would be this tab while the screen has the focus, so it means the last Camel file instead
		const lastCamelFile = this.launcher.substituteVariables('${file}', folder);
		const configuration: KaotoRunConfiguration = {
			...request.configuration,
			target: request.configuration.target?.replaceAll('${file}', lastCamelFile),
		};
		await debug.startDebugging(folder, configuration, { noDebug });
	}

	private async browse(field: BrowseField, folder: WorkspaceFolder): Promise<void> {
		const options: Record<BrowseField, OpenDialogOptions> = {
			target: { canSelectFiles: true, canSelectFolders: true, title: 'Select a Camel file or folder', filters: { Camel: ['yaml', 'yml', 'xml'] } },
			outputDirectory: { canSelectFiles: false, canSelectFolders: true, title: 'Select the folder of the exported project' },
			propertiesFiles: { canSelectFiles: true, canSelectMany: true, title: 'Select properties files', filters: { Properties: ['properties'] } },
			localKameletDirectories: { canSelectFiles: false, canSelectFolders: true, canSelectMany: true, title: 'Select Kamelet directories' },
		};
		const selection = await window.showOpenDialog({ defaultUri: folder.uri, openLabel: 'Select', ...options[field] });
		if (!selection) {
			return;
		}
		const values = selection.map((uri) => {
			const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
			if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
				return uri.fsPath;
			}
			return relativePath ? `\${workspaceFolder}/${relativePath.split(path.sep).join('/')}` : '${workspaceFolder}';
		});
		this.post({ type: 'browsed', field, values });
	}

	private async openLaunchJson(folder: WorkspaceFolder): Promise<void> {
		const launchJson = await workspace.findFiles(new RelativePattern(folder, '.vscode/launch.json'), undefined, 1);
		if (launchJson.length === 0) {
			void window.showInformationMessage(`${folder.name} has no .vscode/launch.json yet. Saving a configuration creates it.`);
			return;
		}
		await window.showTextDocument(launchJson[0]);
	}

	private getHtml(webviewRoot: Uri): string {
		const webview = this.panel.webview;
		const nonce = randomBytes(16).toString('base64');
		const scriptUri = webview.asWebviewUri(Uri.joinPath(webviewRoot, 'RunConfigurationsApp.js'));
		const codiconsUri = webview.asWebviewUri(Uri.joinPath(webviewRoot, 'run-configurations', 'codicon.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${codiconsUri}" id="vscode-codicon-stylesheet">
	<title>Run Configurations</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
