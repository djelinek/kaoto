/**
 * Copyright 2026 Red Hat, Inc. and/or its affiliates.
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
import { TreeItemCollapsibleState, Uri, workspace } from 'vscode';
import { basename, join } from 'path'; // NOSONAR
import { parse } from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import { KaotoOutputChannel } from '../../extension/KaotoOutputChannel';
import { Integration } from './Integration';
import { Route } from './Route';
import { IntegrationFile, IntegrationFileDSL, IntegrationFileIcon, IntegrationFileIconType } from '../../types/IntegrationTreeItemType';

/**
 * Shared knowledge about Camel integration files (routes, kamelets, pipes), used by every view that lists them.
 */
export class IntegrationFiles {
	private static readonly INTEGRATION_FILE_SUFFIXES = ['.camel.yaml', '.camel.xml', '.kamelet.yaml', '.pipe.yaml', '-pipe.yaml'];

	constructor(private readonly extensionUriPath: string) {}

	/**
	 * Check if a file name is a Camel integration file shown as an Integration item (route, kamelet or pipe)
	 * @param fileName The name of the file
	 */
	static isIntegrationFile(fileName: string): boolean {
		return IntegrationFiles.INTEGRATION_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
	}

	/**
	 * Create an Integration tree item for an integration file
	 * @param file The file to convert
	 * @param isUnderMavenRoot Whether the file is under a Maven root
	 * @param isTopLevelWithinWorkspace Whether the file is a top level within the workspace
	 */
	async createIntegrationItem(file: Uri, isUnderMavenRoot: boolean, isTopLevelWithinWorkspace: boolean): Promise<Integration> {
		const filename = basename(file.fsPath);
		const { dsl, type, name, icon, description } = this.getFileType(filename);
		let collapsibleState = TreeItemCollapsibleState.None;
		// if the file is a route integration file, get the routes inside the file and set the collapsible state accordingly
		if (type === 'route') {
			const routes = await this.getRoutesInsideIntegrationFile(dsl, file);
			collapsibleState = routes.length > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
		}
		return new Integration(name, filename, file, collapsibleState, type, dsl, icon, description, isUnderMavenRoot, isTopLevelWithinWorkspace);
	}

	/**
	 * Get the routes of an integration item
	 * @param integration The integration to get the routes for
	 */
	async getRoutes(integration: Integration): Promise<Route[]> {
		if (integration.type !== 'route') {
			return [];
		}
		return (await this.getRoutesInsideIntegrationFile(integration.dsl, integration.filepath)) || [];
	}

	/**
	 * Get the file type of an integration file
	 * @param fileName The name of the file
	 * @returns The file type
	 */
	getFileType(fileName: string): IntegrationFile {
		if (fileName.endsWith('.kamelet.yaml')) {
			return { dsl: 'yaml', type: 'kamelet', name: basename(fileName, '.kamelet.yaml'), icon: this.getIcon('kamelet'), description: 'Kamelet' };
		}
		if (fileName.endsWith('-pipe.yaml')) {
			return { dsl: 'yaml', type: 'pipe', name: basename(fileName, '-pipe.yaml'), icon: this.getIcon('pipe'), description: 'Pipe' };
		}
		if (fileName.endsWith('.pipe.yaml')) {
			return { dsl: 'yaml', type: 'pipe', name: basename(fileName, '.pipe.yaml'), icon: this.getIcon('pipe'), description: 'Pipe' };
		}
		if (fileName.endsWith('.camel.xml')) {
			return { dsl: 'xml', type: 'route', name: basename(fileName, '.camel.xml'), icon: this.getIcon('route'), description: 'Camel Route' };
		}
		// every unknown integration file is considered as Route integration file
		return { dsl: 'yaml', type: 'route', name: basename(fileName, '.camel.yaml'), icon: this.getIcon('route'), description: 'Camel Route' };
	}

	/**
	 * Get the icon for an integration type
	 * @param type The type of the integration
	 * @returns The icon
	 */
	getIcon(type: IntegrationFileIconType): IntegrationFileIcon {
		const basePath = join(this.extensionUriPath, 'icons', 'integrations');
		switch (type) {
			case 'kamelet':
				return { light: Uri.file(join(basePath, 'kamelets-file-icon-light.png')), dark: Uri.file(join(basePath, 'kamelets-file-icon-dark.png')) };
			case 'pipe':
				return { light: Uri.file(join(basePath, 'pipes-file-icon-light.png')), dark: Uri.file(join(basePath, 'pipes-file-icon-dark.png')) };
			case 'route':
				return { light: Uri.file(join(basePath, 'routes-file-icon-light.png')), dark: Uri.file(join(basePath, 'routes-file-icon-dark.png')) };
			case 'route-child':
				return { light: Uri.file(join(basePath, 'route-black.svg')), dark: Uri.file(join(basePath, 'route-white.svg')) };
			// every unknown is considered as Route integration file
			default:
				return { light: Uri.file(join(basePath, 'routes-file-icon-light.png')), dark: Uri.file(join(basePath, 'routes-file-icon-dark.png')) };
		}
	}

	/**
	 * Get the routes inside an integration file
	 * @param dsl The DSL of the integration file
	 * @param filePath The Uri path to the integration file
	 * @returns The routes
	 */
	async getRoutesInsideIntegrationFile(dsl: IntegrationFileDSL, filePath: Uri): Promise<Route[]> {
		// parse the integration file based on the DSL
		switch (dsl) {
			case 'yaml':
				return await this.parseYamlFile(filePath);
			case 'xml':
				return await this.parseXmlFile(filePath);
			default:
				return [];
		}
	}

	/**
	 * Parse a YAML integration file and return the routes
	 * @param filePath The Uri path to the YAML file
	 * @returns The routes
	 */
	private async parseYamlFile(filePath: Uri): Promise<Route[]> {
		try {
			const fileBuffer = await workspace.fs.readFile(filePath);
			const content = new TextDecoder('utf-8').decode(fileBuffer);
			const parsedYaml = parse(content);

			// skip empty YAML files
			if (!parsedYaml || typeof parsedYaml !== 'object') {
				return [];
			}

			return Object.values(parsedYaml)
				.filter((item: any) => item.route)
				.map((item: any) => new Route(item.route.id, item.route.description, this.getIcon('route-child')));
		} catch (error) {
			KaotoOutputChannel.logError(`Error parsing YAML file: ${filePath.fsPath}`, error);
			return [];
		}
	}

	/**
	 * Parse a XML integration file and return the routes
	 * @param filePath The Uri path to the XML file
	 * @returns The routes
	 */
	private async parseXmlFile(filePath: Uri): Promise<Route[]> {
		try {
			const fileBuffer = await workspace.fs.readFile(filePath);
			if (!fileBuffer || fileBuffer.length === 0) {
				// skip empty XML file
				return [];
			}

			const fileContent = fileBuffer.toString().trim(); // remove unnecessary whitespaces

			const parser = new XMLParser({
				ignoreAttributes: false,
				attributeNamePrefix: '',
				parseAttributeValue: true,
				trimValues: true,
				isArray: (name) => name === 'route', // force route to always be an array
			});

			const parsedXml = parser.parse(fileContent);
			if (!parsedXml || typeof parsedXml !== 'object') {
				KaotoOutputChannel.logWarning(`Invalid XML structure: ${filePath.fsPath}`);
				return [];
			}

			// normalize route structure (handling JBang init vs Kaoto XML)
			let routes: any[] = [];
			if (parsedXml.routes?.route) {
				routes = Array.isArray(parsedXml.routes.route) ? parsedXml.routes.route : [parsedXml.routes.route];
			} else if (parsedXml.camel?.route) {
				routes = Array.isArray(parsedXml.camel.route) ? parsedXml.camel.route : [parsedXml.camel.route];
			} else {
				KaotoOutputChannel.logWarning(`No <route> elements found in XML: ${filePath.fsPath}`);
				return [];
			}

			return routes.map((route) => new Route(route.id, route.description, this.getIcon('route-child')));
		} catch (error) {
			KaotoOutputChannel.logError(`Error parsing XML file: ${filePath.fsPath}`, error);
			return [];
		}
	}
}
