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
import { KAOTO_CATALOG_URL_SETTING_ID } from '../constants';

/**
 * File glob patterns for each Camel file type and the schema key they map to.
 */
const SCHEMA_ASSOCIATIONS: { globs: string[]; schemaKey: string }[] = [
	{ globs: ['*.camel.yaml', '*.camel.yml'], schemaKey: 'camelYamlDsl' },
	{ globs: ['*.kamelet.yaml', '*.kamelet.yml'], schemaKey: 'Kamelet' },
	{ globs: ['*.pipe.yaml', '*.pipe.yml', '*-pipe.yaml', '*-pipe.yml'], schemaKey: 'Pipe' },
];

/**
 * Manages YAML schema associations between Kaoto Camel file patterns and the
 * Camel YAML DSL / CRD JSON schemas bundled in the catalog.
 *
 * Integrates with the `redhat.vscode-yaml` extension by setting the `yaml.schemas`
 * VS Code configuration.
 */
export class CamelYamlSchemaManager {
	private readonly catalogBasePath: string;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.catalogBasePath = path.join(context.extensionPath, 'dist', 'webview', 'editors', 'kaoto', 'camel-catalog');
	}

	/**
	 * Apply YAML schema associations for the currently selected catalog.
	 * Reads the catalog index to find schema files and maps them to Kaoto file patterns.
	 */
	async applySchemaAssociations(catalogService: KaotoCatalogService): Promise<void> {
		const catalog = await catalogService.getSelectedIntegrationCatalog();
		if (!catalog) {
			KaotoOutputChannel.logWarning('No catalog selected, skipping YAML schema association.');
			return;
		}

		const catalogIndexPath = this.resolveCatalogIndexPath(catalog.fileName);
		if (!catalogIndexPath) {
			KaotoOutputChannel.logWarning(`Catalog index not found for ${catalog.name}, skipping YAML schema association.`);
			return;
		}

		try {
			const indexContent = await fs.promises.readFile(catalogIndexPath, 'utf-8');
			const catalogIndex = JSON.parse(indexContent);
			const schemas = catalogIndex.schemas as Record<string, { file: string }> | undefined;

			if (!schemas) {
				KaotoOutputChannel.logWarning(`No schemas found in catalog index for ${catalog.name}.`);
				return;
			}

			const yamlSchemas: Record<string, string | string[]> = {};

			for (const association of SCHEMA_ASSOCIATIONS) {
				const schemaInfo = schemas[association.schemaKey];
				if (schemaInfo?.file) {
					const schemaFilePath = path.join(path.dirname(catalogIndexPath), schemaInfo.file);
					if (fs.existsSync(schemaFilePath)) {
						const schemaUri = vscode.Uri.file(schemaFilePath).toString();
						yamlSchemas[schemaUri] = association.globs;
					}
				}
			}

			if (Object.keys(yamlSchemas).length === 0) {
				KaotoOutputChannel.logWarning(`No matching schema files found for catalog ${catalog.name}.`);
				return;
			}

			await this.mergeYamlSchemas(yamlSchemas);

			KaotoOutputChannel.logInfo(`YAML schema associations applied for ${catalog.name}: ${Object.keys(yamlSchemas).length} schema(s)`);
		} catch (error) {
			KaotoOutputChannel.logError('Failed to apply YAML schema associations', error);
		}
	}

	/**
	 * Register listeners that update schema associations when the custom catalog URL changes.
	 * We intentionally do NOT listen for kaoto.runtimeCatalogName changes here because the
	 * yaml.schemas workspace config update interferes with KaotoCatalogService's "Reopen editor"
	 * notification. The YAML DSL schema structure is stable across catalog versions.
	 */
	registerListeners(catalogService: KaotoCatalogService): void {
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (event) => {
				if (event.affectsConfiguration(KAOTO_CATALOG_URL_SETTING_ID)) {
					await this.applySchemaAssociations(catalogService);
				}
			}),
		);
	}

	/**
	 * Merge our schema associations into the existing yaml.schemas setting
	 * without overwriting user-defined associations.
	 */
	private async mergeYamlSchemas(newSchemas: Record<string, string | string[]>): Promise<void> {
		const config = vscode.workspace.getConfiguration('yaml');
		const existing = config.get<Record<string, string | string[]>>('schemas') ?? {};

		const merged = { ...existing };

		// Remove any previous Kaoto-managed associations (those pointing to our catalog path)
		for (const key of Object.keys(merged)) {
			if (key.includes('camel-catalog')) {
				delete merged[key];
			}
		}

		// Add new associations
		Object.assign(merged, newSchemas);

		await config.update('schemas', merged, vscode.ConfigurationTarget.Workspace);
	}

	/**
	 * Resolve the absolute path to a catalog's index.json file.
	 * The catalog fileName is relative, e.g. "camel-main/4.22.1/index-bc828f90.json"
	 */
	private resolveCatalogIndexPath(catalogFileName: string): string | undefined {
		const fullPath = path.join(this.catalogBasePath, catalogFileName);
		if (fs.existsSync(fullPath)) {
			return fullPath;
		}
		return undefined;
	}
}
