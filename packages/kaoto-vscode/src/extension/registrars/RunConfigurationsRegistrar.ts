import * as vscode from 'vscode';
import { TelemetryService } from '@redhat-developer/vscode-redhat-telemetry';
import { COMMAND_RUN_CONFIGURATIONS_OPEN, COMMAND_RUN_CONFIGURATIONS_OPEN_FOR_TARGET } from '../../constants';
import { PortManager } from '../../services/PortManager';
import { Folder } from '../../views/integrations/Folder';
import { Integration } from '../../views/integrations/Integration';
import { CamelFileTracker } from '../../run-configurations/CamelFileTracker';
import { KaotoDebugAdapter } from '../../run-configurations/KaotoDebugAdapter';
import { KaotoDebugConfigurationProvider, KaotoDynamicDebugConfigurationProvider } from '../../run-configurations/KaotoDebugConfigurationProvider';
import { KAOTO_DEBUG_TYPE } from '../../run-configurations/RunConfigurationModel';
import { RunConfigurationLauncher } from '../../run-configurations/RunConfigurationLauncher';
import { RunConfigurationsPanel } from '../../run-configurations/RunConfigurationsPanel';
import { RunConfigurationStore } from '../../run-configurations/RunConfigurationStore';
import { sendCommandTrackingEvent } from './TrackingEvent';
import { IRegistrar } from './IRegistrar';

/**
 * Run configurations: the `kaoto` debug type of launch.json and the Run Configurations screen
 */
export class RunConfigurationsRegistrar implements IRegistrar {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly telemetryService: TelemetryService,
		private readonly portManager: PortManager,
	) {}

	register(): void {
		const camelFileTracker = new CamelFileTracker();
		const store = new RunConfigurationStore();
		const launcher = new RunConfigurationLauncher(this.context.extensionUri, this.portManager, camelFileTracker);
		const extensionUri = this.context.extensionUri;

		this.context.subscriptions.push(
			camelFileTracker,
			store,
			vscode.debug.registerDebugAdapterDescriptorFactory(KAOTO_DEBUG_TYPE, {
				createDebugAdapterDescriptor: (session) => new vscode.DebugAdapterInlineImplementation(new KaotoDebugAdapter(session, launcher)),
			}),
			vscode.debug.registerDebugConfigurationProvider(KAOTO_DEBUG_TYPE, new KaotoDebugConfigurationProvider(camelFileTracker)),
			vscode.debug.registerDebugConfigurationProvider(
				KAOTO_DEBUG_TYPE,
				new KaotoDynamicDebugConfigurationProvider(launcher),
				vscode.DebugConfigurationProviderTriggerKind.Dynamic,
			),
			vscode.commands.registerCommand(COMMAND_RUN_CONFIGURATIONS_OPEN, async () => {
				RunConfigurationsPanel.show(extensionUri, store, launcher);
				await sendCommandTrackingEvent(this.telemetryService, COMMAND_RUN_CONFIGURATIONS_OPEN);
			}),
			vscode.commands.registerCommand(COMMAND_RUN_CONFIGURATIONS_OPEN_FOR_TARGET, async (item?: Integration | Folder | vscode.Uri) => {
				const target =
					item instanceof vscode.Uri ? item : item instanceof Folder ? item.folderUri : (item?.filepath ?? camelFileTracker.getLastCamelFile());
				if (target) {
					const isFolder = item instanceof Folder || (await vscode.workspace.fs.stat(target)).type === vscode.FileType.Directory;
					RunConfigurationsPanel.showForTarget(extensionUri, store, launcher, target, isFolder);
				} else {
					RunConfigurationsPanel.show(extensionUri, store, launcher);
				}
				await sendCommandTrackingEvent(this.telemetryService, COMMAND_RUN_CONFIGURATIONS_OPEN_FOR_TARGET);
			}),
		);
	}
}
