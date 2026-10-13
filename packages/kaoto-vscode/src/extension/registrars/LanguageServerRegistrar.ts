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
import { KaotoOutputChannel } from '../KaotoOutputChannel';
import { KaotoCatalogService } from '../../services/KaotoCatalogService';
import { IRegistrar } from './IRegistrar';

export class LanguageServerRegistrar implements IRegistrar {
	private lspManager: CamelLanguageServerManager | undefined;

	// `_catalogService` is accepted here (but not yet read) so that the constructor signature
	// already matches what the upcoming catalog <-> LSP settings sync wiring will need to consume.
	constructor(
		private readonly context: vscode.ExtensionContext,
		_catalogService: KaotoCatalogService,
	) {}

	async register(): Promise<void> {
		const isEnabled = vscode.workspace.getConfiguration().get<boolean>(KAOTO_LSP_ENABLED_SETTING_ID, true);

		if (!isEnabled) {
			KaotoOutputChannel.logInfo('Camel Language Server is disabled via kaoto.lsp.enabled setting.');
			return;
		}

		this.lspManager = new CamelLanguageServerManager(this.context);

		// Start LSP in background — do not block extension activation
		this.startLsp().catch((error) => {
			KaotoOutputChannel.logError('Background LSP startup failed', error);
		});
	}

	private async startLsp(): Promise<void> {
		if (!this.lspManager) {
			return;
		}

		await this.lspManager.start();
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
	 * Get the underlying LSP manager (for catalog sync wiring in Task 3).
	 */
	getLspManager(): CamelLanguageServerManager | undefined {
		return this.lspManager;
	}
}
