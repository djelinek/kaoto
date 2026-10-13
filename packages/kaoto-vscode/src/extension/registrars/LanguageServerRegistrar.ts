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
import { KAOTO_LSP_ENABLED_SETTING_ID } from '../../constants';
import { CamelLanguageServerManager } from '../../lsp/CamelLanguageServerManager';
import { CamelLspConfigurationSync } from '../../lsp/CamelLspConfigurationSync';
import { KaotoOutputChannel } from '../KaotoOutputChannel';
import { KaotoCatalogService } from '../../services/KaotoCatalogService';
import { IRegistrar } from './IRegistrar';

export class LanguageServerRegistrar implements IRegistrar {
	private lspManager: CamelLanguageServerManager | undefined;
	private configSync: CamelLspConfigurationSync | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly catalogService: KaotoCatalogService,
	) {}

	async register(): Promise<void> {
		this.configSync = new CamelLspConfigurationSync(this.catalogService);
		this.lspManager = new CamelLanguageServerManager(this.context);

		// Register enable/disable toggle listener unconditionally — this must happen before the
		// early return below so that re-enabling at runtime also works when the LSP was disabled
		// at activation time (otherwise no listener would exist to catch the change).
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (event.affectsConfiguration(KAOTO_LSP_ENABLED_SETTING_ID)) {
					const isNowEnabled = vscode.workspace.getConfiguration().get<boolean>(KAOTO_LSP_ENABLED_SETTING_ID, true);
					if (isNowEnabled && !this.lspManager?.isRunning()) {
						KaotoOutputChannel.logInfo('Camel Language Server re-enabled, starting...');
						await this.startLsp();
					} else if (!isNowEnabled && this.lspManager?.isRunning()) {
						KaotoOutputChannel.logInfo('Camel Language Server disabled, stopping...');
						await this.lspManager.stop();
					}
				}
			}),
		);

		const isEnabled = vscode.workspace.getConfiguration().get<boolean>(KAOTO_LSP_ENABLED_SETTING_ID, true);
		if (!isEnabled) {
			KaotoOutputChannel.logInfo('Camel Language Server is disabled via kaoto.lsp.enabled setting.');
			return;
		}

		// Start LSP in background — do not block extension activation
		this.startLsp().catch((error) => {
			KaotoOutputChannel.logError('Background LSP startup failed', error);
		});
	}

	private async startLsp(): Promise<void> {
		if (!this.lspManager || !this.configSync) {
			return;
		}

		const initialSettings = await this.configSync.getInitialSettings();
		await this.lspManager.start(initialSettings);

		// Register config change listeners after successful start
		const client = this.lspManager.getClient();
		if (client && this.lspManager.isRunning()) {
			this.configSync.registerListeners(this.context, client);
		}
	}

	/**
	 * Stop the language server. Called from extension.ts deactivate().
	 */
	async stop(): Promise<void> {
		if (this.lspManager) {
			await this.lspManager.stop();
		}
	}

	/**
	 * Get the underlying LSP manager.
	 */
	getLspManager(): CamelLanguageServerManager | undefined {
		return this.lspManager;
	}
}
