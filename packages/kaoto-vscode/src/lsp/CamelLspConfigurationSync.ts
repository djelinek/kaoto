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
import { LanguageClient } from 'vscode-languageclient/node';
import { DidChangeConfigurationNotification } from 'vscode-languageclient';
import { CatalogLibraryEntry } from '@kaoto/camel-catalog/types';
import { KaotoCatalogService } from '../services/KaotoCatalogService';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import {
	KAOTO_CATALOG_URL_SETTING_ID,
	KAOTO_LSP_EXTRA_COMPONENTS_SETTING_ID,
	KAOTO_LSP_YAML_SCHEMA_SETTING_ID,
	KAOTO_LSP_XML_SCHEMA_SETTING_ID,
	KAOTO_RUNTIME_CATALOG_NAME_SETTING_ID,
	KAOTO_TESTING_CATALOG_NAME_SETTING_ID,
} from '../constants';

/**
 * Bridges Kaoto's catalog selection to the Camel LSP server's configuration protocol.
 * Reads the selected catalog from KaotoCatalogService, maps it to camel.* settings,
 * and pushes updates to the LanguageClient via DidChangeConfigurationNotification.
 */
export class CamelLspConfigurationSync {
	constructor(private readonly catalogService: KaotoCatalogService) {}

	/**
	 * Build initial settings to pass to the LSP server at startup via initializationOptions.
	 */
	async getInitialSettings(): Promise<Record<string, unknown>> {
		const catalog = await this.catalogService.getSelectedIntegrationCatalog();
		const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);

		this.mergeUserLspSettings(settings);

		KaotoOutputChannel.logInfo(
			`LSP initial settings: catalog=${catalog?.name ?? 'default'}, version=${(settings['camel'] as Record<string, unknown>)?.['Camel catalog version'] ?? 'none'}`,
		);

		return settings;
	}

	/**
	 * Push updated settings to a running LanguageClient.
	 */
	async pushSettingsToClient(client: LanguageClient): Promise<void> {
		if (!client.isRunning()) {
			KaotoOutputChannel.logWarning('Cannot push settings: Language client is not running.');
			return;
		}

		const catalog = await this.catalogService.getSelectedIntegrationCatalog();
		const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);

		this.mergeUserLspSettings(settings);

		await client.sendNotification(DidChangeConfigurationNotification.type, { settings });

		KaotoOutputChannel.logInfo(
			`LSP settings pushed: catalog=${catalog?.name ?? 'default'}, version=${(settings['camel'] as Record<string, unknown>)?.['Camel catalog version'] ?? 'none'}`,
		);
	}

	/**
	 * Register VS Code configuration change listeners that auto-push settings.
	 *
	 * Returns the Disposable for the registered listener so callers can dispose it
	 * explicitly (e.g. when the LSP is restarted) in addition to the automatic cleanup
	 * via context.subscriptions on extension deactivation.
	 */
	registerListeners(context: vscode.ExtensionContext, client: LanguageClient): vscode.Disposable {
		const disposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
			const affectsLsp =
				event.affectsConfiguration(KAOTO_RUNTIME_CATALOG_NAME_SETTING_ID) ||
				event.affectsConfiguration(KAOTO_TESTING_CATALOG_NAME_SETTING_ID) ||
				event.affectsConfiguration(KAOTO_CATALOG_URL_SETTING_ID) ||
				event.affectsConfiguration(KAOTO_LSP_EXTRA_COMPONENTS_SETTING_ID) ||
				event.affectsConfiguration(KAOTO_LSP_YAML_SCHEMA_SETTING_ID) ||
				event.affectsConfiguration(KAOTO_LSP_XML_SCHEMA_SETTING_ID);

			if (affectsLsp) {
				KaotoOutputChannel.logInfo('LSP-relevant configuration changed, pushing updated settings.');
				await this.pushSettingsToClient(client);
			}
		});
		context.subscriptions.push(disposable);
		return disposable;
	}

	/**
	 * Map a Kaoto runtime name to the LSP server's runtime provider constant.
	 *
	 * Camel LSP server expects: "DEFAULT", "QUARKUS", or "SPRINGBOOT"
	 * Kaoto catalog uses: "Main", "Quarkus", "Spring Boot"
	 */
	static mapRuntimeToLspProvider(runtime: string): string {
		const normalized = runtime.toLowerCase().trim();
		if (normalized.includes('quarkus')) {
			return 'QUARKUS';
		}
		if (normalized.includes('spring')) {
			return 'SPRINGBOOT';
		}
		return 'DEFAULT';
	}

	/**
	 * Build the camel.* settings object from a catalog entry.
	 * This is the format the Camel LSP server expects.
	 *
	 * The LSP server supports two settings:
	 * - 'Camel catalog version': triggers a Maven download of camel-catalog via MavenVersionManager.
	 *   This requires MIMA runtime on the server classpath — which fails in the 1.35.0 Spring Boot
	 *   uber JAR (ServiceLoader cannot find the MIMA Runtime implementation in BOOT-INF/lib/).
	 *   See CamelTextDocumentService.updateCatalogVersion() — any non-empty version triggers the
	 *   MavenVersionManager constructor, which crashes with "No Runtime implementation found".
	 *   We intentionally omit this setting so the server uses its built-in default catalog.
	 *
	 * - 'Camel catalog runtime provider': one of 'DEFAULT', 'SPRINGBOOT', 'QUARKUS'.
	 *   This switches the in-memory RuntimeProvider without any Maven download — safe to send.
	 *
	 * TODO: Re-enable catalog version sync once the camel-lsp-server JAR properly bundles the
	 * MIMA runtime, or once the server supports a version-update path that doesn't require Maven.
	 */
	static buildCamelSettingsFromCatalog(catalog: CatalogLibraryEntry | undefined): Record<string, unknown> {
		const camelSettings: Record<string, unknown> = {};

		if (catalog) {
			camelSettings['Camel catalog runtime provider'] = CamelLspConfigurationSync.mapRuntimeToLspProvider(catalog.runtime);
		}

		return { camel: camelSettings };
	}

	/**
	 * Merge user-configured LSP settings (extra-components, schemas) into the settings object.
	 */
	private mergeUserLspSettings(settings: Record<string, unknown>): void {
		const config = vscode.workspace.getConfiguration();
		const camelSettings = settings['camel'] as Record<string, unknown>;

		const extraComponents = config.get<unknown[]>(KAOTO_LSP_EXTRA_COMPONENTS_SETTING_ID);
		if (extraComponents && Array.isArray(extraComponents) && extraComponents.length > 0) {
			camelSettings['extra-components'] = extraComponents;
		}

		const yamlSchema = config.get<Record<string, string>>(KAOTO_LSP_YAML_SCHEMA_SETTING_ID);
		if (yamlSchema && Object.keys(yamlSchema).length > 0) {
			camelSettings['Camel catalog YAML schema'] = yamlSchema;
		}

		const xmlSchema = config.get<Record<string, string>>(KAOTO_LSP_XML_SCHEMA_SETTING_ID);
		if (xmlSchema && Object.keys(xmlSchema).length > 0) {
			camelSettings['Camel catalog XML schema'] = xmlSchema;
		}
	}
}
