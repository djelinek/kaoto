/*
 * Messages between the extension and the Run Configurations webview.
 * This file is shared with the webview, so it must not import `vscode`.
 */
import { ArgumentDefaults, KaotoRunConfiguration } from './RunConfigurationModel';

/**
 * A `kaoto` entry of a workspace folder's launch.json
 */
export interface RunConfigurationEntry {
	/** `<folder uri>#<index in the configurations array>` */
	id: string;
	/** URI of the workspace folder that owns the launch.json */
	folder: string;
	/** Index in the folder's `configurations` array, counting every debug type */
	index: number;
	configuration: KaotoRunConfiguration;
}

export interface TargetOption {
	/** Value stored in launch.json, for example `${workspaceFolder}/orders.camel.yaml` */
	value: string;
	/** Path relative to the workspace folder */
	label: string;
	kind: 'file' | 'folder';
}

export interface WorkspaceFolderInfo {
	uri: string;
	name: string;
	path: string;
	targets: TargetOption[];
}

export interface CatalogOption {
	name: string;
	runtime: string;
	version: string;
	/** Whether a Camel Launcher JAR exists for this catalog */
	launcherAvailable: boolean;
}

/**
 * Values that a field takes when a configuration leaves it out, read from the Kaoto settings
 */
export interface RunConfigurationDefaults {
	executor: 'jbang' | 'camel-launcher';
	/** Catalog selected in the status bar */
	catalog?: string;
	run: ArgumentDefaults;
	runFolder: ArgumentDefaults;
	export: ArgumentDefaults;
	deploy: ArgumentDefaults;
	localKameletDirectories: string[];
}

export interface RunConfigurationsState {
	entries: RunConfigurationEntry[];
	folders: WorkspaceFolderInfo[];
	catalogs: CatalogOption[];
	defaults: RunConfigurationDefaults;
	camelDebuggerInstalled: boolean;
	/** Ids of the entries whose session is running */
	running: string[];
}

export interface Problem {
	severity: 'error' | 'warning';
	/** Configuration attribute the problem belongs to */
	field?: string;
	message: string;
}

export interface PreviewResult {
	requestId: number;
	/** Command line that Run executes, built by the same code */
	commandLine?: string;
	cwd?: string;
	env?: Record<string, string>;
	/** Body of the `POST /v1/executions` request, for the Kaoto Kompanion executor */
	kompanionRequest?: string;
	problems: Problem[];
}

export type BrowseField = 'target' | 'outputDirectory' | 'propertiesFiles' | 'localKameletDirectories';

/**
 * A new configuration the screen should create and select, for example from the Integrations view
 */
export interface NewConfigurationRequest {
	folder: string;
	target: string;
	isFolder: boolean;
	action?: 'run' | 'export' | 'deploy';
}

export type ExtensionMessage =
	| { type: 'state'; state: RunConfigurationsState }
	| { type: 'select'; folder: string; name: string }
	| { type: 'create'; request: NewConfigurationRequest }
	| { type: 'preview'; result: PreviewResult }
	| { type: 'browsed'; field: BrowseField; values: string[] }
	| { type: 'saved'; folder: string; name: string };

export interface SaveRequest {
	folder: string;
	/** The launch.json entry this configuration was loaded from, missing for a new one */
	original?: { index: number; name: string };
	configuration: KaotoRunConfiguration;
}

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'preview'; requestId: number; folder: string; configuration: KaotoRunConfiguration }
	| ({ type: 'save' } & SaveRequest)
	| { type: 'delete'; folder: string; index: number; name: string }
	| ({ type: 'launch'; noDebug: boolean; save: boolean } & SaveRequest)
	| { type: 'browse'; field: BrowseField; folder: string }
	| { type: 'copy'; text: string }
	| { type: 'openLaunchJson'; folder: string }
	| { type: 'installCamelDebugger' };
