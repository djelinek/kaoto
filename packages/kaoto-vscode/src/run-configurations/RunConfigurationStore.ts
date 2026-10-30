import { ConfigurationTarget, Disposable, EventEmitter, workspace, WorkspaceFolder } from 'vscode';
import { KAOTO_DEBUG_TYPE, KaotoRunConfiguration } from './RunConfigurationModel';
import { RunConfigurationEntry, SaveRequest } from './RunConfigurationProtocol';

type LaunchConfiguration = { type?: string; name?: string; [attribute: string]: unknown };

/**
 * Reads and writes the `kaoto` entries of each workspace folder's `.vscode/launch.json`.
 * Entries of other debug types are kept as they are.
 */
export class RunConfigurationStore implements Disposable {
	private readonly onDidChangeEmitter = new EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private readonly disposables: Disposable[] = [this.onDidChangeEmitter];

	constructor() {
		this.disposables.push(
			workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('launch')) {
					this.onDidChangeEmitter.fire();
				}
			}),
			workspace.onDidChangeWorkspaceFolders(() => this.onDidChangeEmitter.fire()),
		);
	}

	getEntries(): RunConfigurationEntry[] {
		return (workspace.workspaceFolders ?? []).flatMap((folder) =>
			this.readConfigurations(folder).flatMap((configuration, index) =>
				configuration?.type === KAOTO_DEBUG_TYPE
					? [{ id: `${folder.uri.toString()}#${index}`, folder: folder.uri.toString(), index, configuration: configuration as KaotoRunConfiguration }]
					: [],
			),
		);
	}

	async save(request: SaveRequest): Promise<void> {
		const folder = this.getFolder(request.folder);
		const configurations = [...this.readConfigurations(folder)];
		const index = request.original ? this.findIndex(configurations, request.original) : -1;
		if (index >= 0) {
			configurations[index] = request.configuration;
		} else {
			configurations.push(request.configuration);
		}
		await this.writeConfigurations(folder, configurations);
	}

	async delete(folderUri: string, original: { index: number; name: string }): Promise<void> {
		const folder = this.getFolder(folderUri);
		const configurations = [...this.readConfigurations(folder)];
		const index = this.findIndex(configurations, original);
		if (index >= 0) {
			configurations.splice(index, 1);
			await this.writeConfigurations(folder, configurations);
		}
	}

	getFolder(folderUri: string): WorkspaceFolder {
		const folder = workspace.workspaceFolders?.find((candidate) => candidate.uri.toString() === folderUri);
		if (!folder) {
			throw new Error(`The workspace folder ${folderUri} is not open.`);
		}
		return folder;
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	/**
	 * Find the entry at its known index, or by name when launch.json changed in the meantime
	 */
	private findIndex(configurations: LaunchConfiguration[], original: { index: number; name: string }): number {
		const candidate = configurations[original.index];
		if (candidate?.type === KAOTO_DEBUG_TYPE && candidate.name === original.name) {
			return original.index;
		}
		return configurations.findIndex((configuration) => configuration?.type === KAOTO_DEBUG_TYPE && configuration.name === original.name);
	}

	private readConfigurations(folder: WorkspaceFolder): LaunchConfiguration[] {
		const value = this.readFolderValue<LaunchConfiguration[]>(folder, 'configurations');
		return Array.isArray(value) ? value : [];
	}

	private async writeConfigurations(folder: WorkspaceFolder, configurations: LaunchConfiguration[]): Promise<void> {
		const launch = workspace.getConfiguration('launch', folder.uri);
		if (this.readFolderValue(folder, 'version') === undefined) {
			await launch.update('version', '0.2.0', ConfigurationTarget.WorkspaceFolder);
		}
		await launch.update('configurations', configurations, ConfigurationTarget.WorkspaceFolder);
	}

	/**
	 * Value of the folder's own launch.json. In a single-folder workspace that file is the workspace configuration.
	 */
	private readFolderValue<T>(folder: WorkspaceFolder, key: string): T | undefined {
		const inspected = workspace.getConfiguration('launch', folder.uri).inspect<T>(key);
		return inspected?.workspaceFolderValue ?? (workspace.workspaceFile ? undefined : inspected?.workspaceValue);
	}
}
