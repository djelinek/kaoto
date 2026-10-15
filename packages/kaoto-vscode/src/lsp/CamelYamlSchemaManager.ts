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
import * as path from 'path'; // NOSONAR
import * as fs from 'fs'; // NOSONAR
import { KaotoCatalogService } from '../services/KaotoCatalogService';
import { KaotoOutputChannel } from '../extension/KaotoOutputChannel';
import { KAOTO_RUNTIME_CATALOG_NAME_SETTING_ID, KAOTO_CATALOG_URL_SETTING_ID } from '../constants';

const CONTRIBUTOR_ID = 'kaoto-camel-yaml';

/**
 * File pattern matchers and their corresponding schema keys in the catalog index.
 */
const SCHEMA_MAPPINGS: { pattern: RegExp; schemaKey: string }[] = [
	{ pattern: /\.camel\.(yaml|yml)$/, schemaKey: 'camelYamlDsl' },
	{ pattern: /\.kamelet\.(yaml|yml)$/, schemaKey: 'Kamelet' },
	{ pattern: /\.pipe\.(yaml|yml)$/, schemaKey: 'Pipe' },
	{ pattern: /-pipe\.(yaml|yml)$/, schemaKey: 'Pipe' },
];

/**
 * Manages YAML schema associations between Kaoto Camel file patterns and the
 * Camel YAML DSL / CRD JSON schemas bundled in the catalog.
 *
 * Uses the redhat.vscode-yaml extension's programmatic schema contributor API
 * instead of writing to yaml.schemas workspace settings (which interferes with
 * VS Code's active editor tracking and the catalog service's notifications).
 */
export class CamelYamlSchemaManager {
	private readonly catalogBasePath: string;
	private schemaUris: Map<string, string> = new Map();

	constructor(context: vscode.ExtensionContext) {
		this.catalogBasePath = path.join(context.extensionPath, 'dist', 'webview', 'editors', 'kaoto', 'camel-catalog');
	}

	/**
	 * Register as a schema contributor with the vscode-yaml extension.
	 * Uses file:// URIs pointing to the bundled schema files directly.
	 */
	async registerSchemaContributor(catalogService: KaotoCatalogService): Promise<void> {
		await this.loadSchemaUris(catalogService);

		const yamlExtension = vscode.extensions.getExtension('redhat.vscode-yaml');
		if (!yamlExtension) {
			KaotoOutputChannel.logInfo('YAML extension (redhat.vscode-yaml) not installed, skipping schema association.');
			return;
		}

		try {
			const yamlApi = await yamlExtension.activate();
			if (!yamlApi || typeof yamlApi.registerContributor !== 'function') {
				KaotoOutputChannel.logWarning('YAML extension API not available or missing registerContributor.');
				return;
			}

			yamlApi.registerContributor(CONTRIBUTOR_ID, this.requestSchema.bind(this), this.requestSchemaContent.bind(this));

			KaotoOutputChannel.logInfo('YAML schema contributor registered with vscode-yaml:');
			for (const [schemaKey, schemaUri] of this.schemaUris) {
				const patterns = SCHEMA_MAPPINGS.filter((m) => m.schemaKey === schemaKey).map((m) => m.pattern.source);
				KaotoOutputChannel.logInfo(`  ${schemaKey} → ${schemaUri} (patterns: ${patterns.join(', ')})`);
			}
		} catch (error) {
			KaotoOutputChannel.logError('Failed to register YAML schema contributor', error);
		}
	}

	/**
	 * Register listeners that reload the schema URIs when the catalog changes.
	 */
	registerListeners(context: vscode.ExtensionContext, catalogService: KaotoCatalogService): void {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (event.affectsConfiguration(KAOTO_RUNTIME_CATALOG_NAME_SETTING_ID) || event.affectsConfiguration(KAOTO_CATALOG_URL_SETTING_ID)) {
					this.schemaUris.clear();
					await this.loadSchemaUris(catalogService);
				}
			}),
		);
	}

	/**
	 * Called by vscode-yaml for each opened YAML file.
	 * Returns a file:// URI to the schema if the file matches a Kaoto pattern.
	 */
	private requestSchema(resource: string): string | undefined {
		for (const mapping of SCHEMA_MAPPINGS) {
			if (mapping.pattern.test(resource)) {
				return this.schemaUris.get(mapping.schemaKey);
			}
		}
		return undefined;
	}

	/**
	 * Called by vscode-yaml to load schema content for a URI.
	 * Since we use file:// URIs, vscode-yaml reads the file directly.
	 * This callback is only needed as a fallback.
	 */
	private requestSchemaContent(schemaUri: string): string {
		try {
			const filePath = vscode.Uri.parse(schemaUri).fsPath;
			if (fs.existsSync(filePath)) {
				return fs.readFileSync(filePath, 'utf-8');
			}
		} catch {
			// fall through
		}
		KaotoOutputChannel.logWarning(`Cannot read schema content for: ${schemaUri}`);
		return '{}';
	}

	/**
	 * Load schema file URIs from the bundled catalog.
	 */
	private async loadSchemaUris(catalogService: KaotoCatalogService): Promise<void> {
		const catalog = await catalogService.getSelectedIntegrationCatalog();
		if (!catalog) {
			KaotoOutputChannel.logWarning('No integration catalog selected, cannot load YAML schemas.');
			return;
		}

		const catalogIndexPath = path.join(this.catalogBasePath, catalog.fileName);
		if (!fs.existsSync(catalogIndexPath)) {
			KaotoOutputChannel.logWarning(`Catalog index not found at ${catalogIndexPath}`);
			return;
		}

		try {
			const indexContent = await fs.promises.readFile(catalogIndexPath, 'utf-8');
			const catalogIndex = JSON.parse(indexContent);
			const schemas = catalogIndex.schemas as Record<string, { file: string }> | undefined;

			if (!schemas) {
				return;
			}

			const catalogDir = path.dirname(catalogIndexPath);
			KaotoOutputChannel.logInfo(`Loading YAML schemas from catalog: ${catalog.name}`);
			for (const mapping of SCHEMA_MAPPINGS) {
				const schemaInfo = schemas[mapping.schemaKey];
				if (schemaInfo?.file) {
					const schemaFilePath = path.join(catalogDir, schemaInfo.file);
					if (fs.existsSync(schemaFilePath)) {
						const fileUri = vscode.Uri.file(schemaFilePath).toString();
						this.schemaUris.set(mapping.schemaKey, fileUri);
						KaotoOutputChannel.logInfo(`  ${mapping.schemaKey} → ${schemaFilePath}`);
					}
				}
			}
		} catch (error) {
			KaotoOutputChannel.logError('Failed to load YAML schema URIs', error);
		}
	}
}
