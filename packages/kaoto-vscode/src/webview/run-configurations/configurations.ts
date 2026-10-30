import {
	ArgumentDefaults,
	DEFAULT_GAV,
	ExportRuntime,
	getAction,
	KAOTO_DEBUG_TYPE,
	KaotoRunConfiguration,
	RunConfigurationAction,
} from '../../run-configurations/RunConfigurationModel';
import { NewConfigurationRequest, RunConfigurationsState } from '../../run-configurations/RunConfigurationProtocol';

/**
 * A configuration in the list: a launch.json entry, or a new one that is not saved yet
 */
export interface ConfigurationItem {
	/** `<folder uri>|<saved name>` for a saved entry, `new:<n>` for a new one */
	key: string;
	folder: string;
	original?: { index: number; name: string };
	saved?: KaotoRunConfiguration;
	draft: KaotoRunConfiguration;
	running: boolean;
}

export const ACTIONS: { value: RunConfigurationAction; label: string; icon: string; verb: string }[] = [
	{ value: 'run', label: 'Run', icon: 'play', verb: 'Run' },
	{ value: 'export', label: 'Export', icon: 'package', verb: 'Export' },
	{ value: 'deploy', label: 'Deploy', icon: 'cloud-upload', verb: 'Deploy' },
];

export const EXECUTORS = [
	{ value: 'jbang', label: 'Camel CLI (JBang)', description: 'jbang camel@apache/camel' },
	{ value: 'camel-launcher', label: 'Camel Launcher', description: 'java -jar camel-launcher.jar, downloaded on first use' },
	{ value: 'kompanion', label: 'Kaoto Kompanion (preview)', description: 'POST /v1/executions, request preview only' },
];

export const RUNTIMES: { value: ExportRuntime; label: string }[] = [
	{ value: 'quarkus', label: 'Camel Quarkus' },
	{ value: 'spring-boot', label: 'Camel Spring Boot' },
	{ value: 'camel-main', label: 'Camel Main' },
];

export function savedKey(folder: string, name: string): string {
	return `${folder}|${name}`;
}

export function isDirty(item: ConfigurationItem): boolean {
	return !item.saved || JSON.stringify(item.saved) !== JSON.stringify(item.draft);
}

export function isFolderTarget(target: string | undefined): boolean {
	return !!target && !/\.(ya?ml|xml)$/.test(target);
}

/**
 * Settings values a field falls back to for this configuration
 */
export function getArgumentDefaults(state: RunConfigurationsState, configuration: KaotoRunConfiguration): ArgumentDefaults {
	switch (getAction(configuration)) {
		case 'run':
			return isFolderTarget(configuration.target) ? state.defaults.runFolder : state.defaults.run;
		case 'export':
			return state.defaults.export;
		case 'deploy':
			return state.defaults.deploy;
	}
}

export function uniqueName(base: string, takenNames: string[]): string {
	let name = base;
	for (let counter = 2; takenNames.includes(name); counter++) {
		name = `${base} (${counter})`;
	}
	return name;
}

function targetLabel(target: string): string {
	const label = target.replace(/^\$\{workspaceFolder\}\/?/, '');
	if (target === '${file}') {
		return 'current file';
	}
	return label.split('/').pop() || 'workspace';
}

function runtimeOfCatalog(state: RunConfigurationsState, catalogName: string | undefined): ExportRuntime {
	const runtime = state.catalogs.find((catalog) => catalog.name === catalogName)?.runtime.toLowerCase();
	if (runtime?.includes('spring')) {
		return 'spring-boot';
	}
	return runtime === 'main' ? 'camel-main' : 'quarkus';
}

/**
 * A new configuration, pre-filled from the Kaoto settings
 */
export function createConfiguration(state: RunConfigurationsState, request: NewConfigurationRequest, takenNames: string[]): KaotoRunConfiguration {
	const action = request.action ?? 'run';
	const verb = ACTIONS.find((candidate) => candidate.value === action)?.verb ?? 'Run';
	const base: KaotoRunConfiguration = {
		type: KAOTO_DEBUG_TYPE,
		request: 'launch',
		name: uniqueName(`${verb} ${targetLabel(request.target)}`, takenNames),
		action,
		target: request.target,
		executor: state.defaults.executor,
	};
	switch (action) {
		case 'run': {
			const defaults = request.isFolder ? state.defaults.runFolder : state.defaults.run;
			return { ...base, dev: defaults.dev ?? false, loggingLevel: defaults.loggingLevel ?? 'info', args: defaults.args };
		}
		case 'export': {
			const artifactId = DEFAULT_GAV.split(':')[1];
			return {
				...base,
				runtime: runtimeOfCatalog(state, state.defaults.catalog),
				gav: DEFAULT_GAV,
				outputDirectory: `\${workspaceFolder}/../${artifactId}`,
				kubernetes: true,
				clusterType: state.defaults.export.clusterType ?? 'openshift',
				openProject: true,
				args: state.defaults.export.args,
			};
		}
		case 'deploy':
			return {
				...base,
				clusterType: state.defaults.deploy.clusterType ?? 'openshift',
				dev: state.defaults.deploy.dev ?? false,
				args: state.defaults.deploy.args,
			};
	}
}

/**
 * Rebuild the list from a new state, keeping unsaved edits and new configurations
 */
export function mergeItems(state: RunConfigurationsState, previous: ConfigurationItem[]): ConfigurationItem[] {
	const previousByKey = new Map(previous.map((item) => [item.key, item]));
	const savedItems = state.entries.map((entry): ConfigurationItem => {
		const key = savedKey(entry.folder, entry.configuration.name);
		const earlier = previousByKey.get(key);
		const keepDraft = earlier && isDirty(earlier);
		return {
			key,
			folder: entry.folder,
			original: { index: entry.index, name: entry.configuration.name },
			saved: entry.configuration,
			draft: keepDraft ? earlier.draft : entry.configuration,
			running: state.running.includes(entry.id),
		};
	});
	const newItems = previous.filter((item) => !item.saved);
	return [...savedItems, ...newItems];
}

/**
 * Drop the attributes a field cleared, so that they fall back to the settings again
 */
export function cleanConfiguration(configuration: KaotoRunConfiguration): KaotoRunConfiguration {
	return Object.fromEntries(Object.entries(configuration).filter(([, value]) => value !== undefined && value !== '')) as KaotoRunConfiguration;
}
