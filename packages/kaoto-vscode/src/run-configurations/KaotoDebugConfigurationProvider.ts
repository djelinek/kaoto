import * as path from 'path'; // NOSONAR
import { commands, DebugConfiguration, DebugConfigurationProvider, window, WorkspaceFolder } from 'vscode';
import { COMMAND_RUN_CONFIGURATIONS_OPEN } from '../constants';
import { CamelFileTracker } from './CamelFileTracker';
import { KAOTO_DEBUG_TYPE } from './RunConfigurationModel';
import { RunConfigurationLauncher } from './RunConfigurationLauncher';

/**
 * Fills in `kaoto` launch configurations: the launch.json starter entry, F5 without a launch.json, and missing attributes
 */
export class KaotoDebugConfigurationProvider implements DebugConfigurationProvider {
	constructor(private readonly camelFileTracker: CamelFileTracker) {}

	provideDebugConfigurations(): DebugConfiguration[] {
		return [{ type: KAOTO_DEBUG_TYPE, request: 'launch', name: 'Kaoto: Run current Camel file', action: 'run', target: '${file}' }];
	}

	resolveDebugConfiguration(_folder: WorkspaceFolder | undefined, configuration: DebugConfiguration): DebugConfiguration | undefined {
		if (!configuration.type && !configuration.request && !configuration.name) {
			// F5 without a launch.json: run the active Camel file
			const file = this.camelFileTracker.getLastCamelFile();
			if (!file) {
				void window.showInformationMessage('Open a Camel file to run it with Kaoto.');
				return undefined;
			}
			return { type: KAOTO_DEBUG_TYPE, request: 'launch', name: `Run ${path.basename(file.fsPath)}`, action: 'run', target: file.fsPath };
		}
		return {
			...configuration,
			request: configuration.request ?? 'launch',
			action: configuration.action ?? 'run',
			target: configuration.target ?? '${file}',
		};
	}

	resolveDebugConfigurationWithSubstitutedVariables(_folder: WorkspaceFolder | undefined, configuration: DebugConfiguration): DebugConfiguration | undefined {
		if (configuration.executor === 'kompanion') {
			const open = 'Open Run Configurations';
			void window
				.showInformationMessage(
					'Kaoto Kompanion cannot launch integrations yet. The Run Configurations screen shows the request it would receive.',
					open,
				)
				.then((choice) => (choice === open ? commands.executeCommand(COMMAND_RUN_CONFIGURATIONS_OPEN) : undefined));
			return undefined;
		}
		return configuration;
	}
}

/**
 * Lists a Run configuration for every Camel file in the "Select and Start Debugging" picker
 */
export class KaotoDynamicDebugConfigurationProvider implements DebugConfigurationProvider {
	constructor(private readonly launcher: RunConfigurationLauncher) {}

	async provideDebugConfigurations(folder: WorkspaceFolder | undefined): Promise<DebugConfiguration[]> {
		if (!folder) {
			return [];
		}
		const targets = await this.launcher.findTargets(folder);
		return targets
			.filter((target) => target.kind === 'file')
			.map((target) => ({ type: KAOTO_DEBUG_TYPE, request: 'launch', name: `Run ${target.label}`, action: 'run', target: target.value }));
	}
}
