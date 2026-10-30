/*
 * Model of a Kaoto run configuration: one `"type": "kaoto"` entry of `.vscode/launch.json`.
 * This file is shared with the Run Configurations webview, so it must not import `vscode`.
 */

export const KAOTO_DEBUG_TYPE = 'kaoto';

export type RunConfigurationAction = 'run' | 'export' | 'deploy';

export type RunConfigurationExecutor = 'jbang' | 'camel-launcher' | 'kompanion';

export type ExportRuntime = 'quarkus' | 'spring-boot' | 'camel-main';

/**
 * A `kaoto` launch configuration. Every field except `type`, `request` and `name` is optional:
 * a missing field falls back to the Kaoto settings, so a minimal entry behaves like the Run button.
 * Keep it in sync with `contributes.debuggers[].configurationAttributes` in package.json.
 */
export interface KaotoRunConfiguration {
	type: typeof KAOTO_DEBUG_TYPE;
	request: 'launch';
	name: string;
	/** `run`, `export` (Maven project) or `deploy` (`camel kubernetes run`) */
	action?: RunConfigurationAction;
	/** Camel file or folder, usually with `${workspaceFolder}` or `${file}` */
	target?: string;
	executor?: RunConfigurationExecutor;
	/** Kaoto catalog name, for example `Camel Main 4.14.9`; the status bar selection when missing */
	catalog?: string;
	dev?: boolean;
	loggingLevel?: string;
	/** Start Debugging (F5) attaches the Camel route debugger only when this is true */
	debugRoutes?: boolean;
	/** Fixed management port; a free port is picked at launch when missing */
	managementPort?: number;
	propertiesFiles?: string[];
	dependencies?: string[];
	localKameletDirectories?: string[];
	env?: Record<string, string>;
	/** Extra arguments, appended unchanged */
	args?: string[];
	runtime?: ExportRuntime;
	gav?: string;
	outputDirectory?: string;
	kubernetes?: boolean;
	clusterType?: string;
	openProject?: boolean;
	/** Set by VS Code for Run Without Debugging */
	noDebug?: boolean;
	/** Other launch.json attributes, such as `preLaunchTask`, are kept as they are */
	[attribute: string]: unknown;
}

/**
 * The options that a settings value such as `--dev --logging-level=info *.xsl` contains
 */
export interface ArgumentDefaults {
	dev?: boolean;
	loggingLevel?: string;
	clusterType?: string;
	/** The other arguments, in their original order */
	args: string[];
}

export const LOGGING_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'off'];

export const CLUSTER_TYPES = ['openshift', 'kubernetes', 'minikube', 'kind'];

export const DEFAULT_GAV = 'com.acme:myproject:1.0-SNAPSHOT';

/**
 * Split the arguments of a Kaoto setting into the options that have their own field and the rest
 */
export function splitArguments(args: readonly string[] = []): ArgumentDefaults {
	const result: ArgumentDefaults = { args: [] };
	for (const arg of args) {
		if (arg === '--dev' || arg === '--dev=true') {
			result.dev = true;
		} else if (arg === '--dev=false') {
			result.dev = false;
		} else if (arg.startsWith('--logging-level=')) {
			result.loggingLevel = arg.substring('--logging-level='.length);
		} else if (arg.startsWith('--cluster-type=')) {
			result.clusterType = arg.substring('--cluster-type='.length);
		} else {
			result.args.push(arg);
		}
	}
	return result;
}

/**
 * Split a command line typed in a single field into arguments, keeping quoted parts together
 */
export function parseCommandLine(text: string): string[] {
	const args: string[] = [];
	let current = '';
	let quote: string | undefined;
	let hasArgument = false;
	for (const char of text) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			hasArgument = true;
		} else if (/\s/.test(char)) {
			if (hasArgument) {
				args.push(current);
				current = '';
				hasArgument = false;
			}
		} else {
			current += char;
			hasArgument = true;
		}
	}
	if (hasArgument) {
		args.push(current);
	}
	return args;
}

/**
 * Join arguments into one line, quoting the ones that a shell would split
 */
export function formatCommandLine(args: readonly string[]): string {
	return args.map(quoteArgument).join(' ');
}

export function quoteArgument(arg: string): string {
	if (arg === '') {
		return "''";
	}
	if (/^[\w@%+=:,./<>${}-]+$/.test(arg)) {
		return arg;
	}
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Parse `KEY=value` lines into environment variables
 */
export function parseEnvironment(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const separator = trimmed.indexOf('=');
		if (separator > 0) {
			env[trimmed.substring(0, separator).trim()] = trimmed.substring(separator + 1);
		}
	}
	return env;
}

export function formatEnvironment(env: Record<string, string> = {}): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');
}

/**
 * Split a list typed in a single field (commas or new lines) into its entries
 */
export function parseList(text: string): string[] {
	return text
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function getAction(configuration: KaotoRunConfiguration): RunConfigurationAction {
	return configuration.action ?? 'run';
}
