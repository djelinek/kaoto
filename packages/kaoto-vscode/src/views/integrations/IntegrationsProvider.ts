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
import { commands, Event, EventEmitter, FileSystemWatcher, TreeDataProvider, TreeItem, TreeItemLabel, Uri, workspace } from 'vscode';
import { basename, join, relative, sep } from 'path'; // NOSONAR
import { Integration } from './Integration';
import { Folder } from './Folder';
import { File } from './File';
import { IntegrationFiles } from './IntegrationFiles';
import { CONTEXT_INTEGRATION_EXISTS, KAOTO_EXCLUDE_PATTERN, KAOTO_INTEGRATIONS_FILES_REGEXP_SETTING_ID } from '../../constants';

type TreeItemType = TreeItem | undefined | null | void;

export class IntegrationsProvider implements TreeDataProvider<TreeItem> {
	private readonly _onDidChangeTreeData: EventEmitter<TreeItemType> = new EventEmitter<TreeItemType>();
	readonly onDidChangeTreeData: Event<TreeItemType> = this._onDidChangeTreeData.event;

	public static readonly EXCLUDE_PATTERN = KAOTO_EXCLUDE_PATTERN;

	private fileWatcher: FileSystemWatcher;
	private filePattern: string;
	private readonly integrationFiles: IntegrationFiles;

	constructor(readonly extensionUriPath: string) {
		this.integrationFiles = new IntegrationFiles(extensionUriPath);
		this.filePattern = this.getFilePattern();
		this.fileWatcher = workspace.createFileSystemWatcher(this.filePattern);

		this.fileWatcher.onDidChange(this.refresh.bind(this));
		this.fileWatcher.onDidCreate(this.refresh.bind(this));
		this.fileWatcher.onDidDelete(this.refresh.bind(this));

		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(KAOTO_INTEGRATIONS_FILES_REGEXP_SETTING_ID)) {
				this.filePattern = this.getFilePattern();
				this.fileWatcher.dispose();

				this.fileWatcher = workspace.createFileSystemWatcher(this.filePattern);
				this.fileWatcher.onDidChange(this.refresh.bind(this));
				this.fileWatcher.onDidCreate(this.refresh.bind(this));
				this.fileWatcher.onDidDelete(this.refresh.bind(this));

				this.refresh();
			}
		});
	}

	/**
	 * Get the file pattern for the integrations view
	 * @returns The file pattern
	 */
	private getFilePattern(): string {
		const filesRegexp: string[] = workspace.getConfiguration().get(KAOTO_INTEGRATIONS_FILES_REGEXP_SETTING_ID) as string[];
		return '{' + filesRegexp.map((r) => '**/' + r).join(',') + '}';
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		this.fileWatcher?.dispose();
	}

	getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

	async getChildren(element?: TreeItem): Promise<TreeItem[]> {
		if (element instanceof Integration) {
			return await this.getRouteChildren(element);
		}
		const files = await workspace.findFiles(this.filePattern, IntegrationsProvider.EXCLUDE_PATTERN);
		this.setContext(files.length > 0);
		if (!element) {
			return await this.getRootChildren(files);
		}
		if (element instanceof Folder) {
			return await this.getFolderChildren(files, element);
		}
		return [];
	}

	/**
	 * Get the children for a route
	 * @param integration The integration to get the children for
	 * @returns The children
	 */
	private async getRouteChildren(integration: Integration): Promise<TreeItem[]> {
		return await this.integrationFiles.getRoutes(integration);
	}

	/**
	 * Get the children for the root
	 * @param files The files to build children for
	 * @returns The children
	 */
	private async getRootChildren(files: readonly Uri[]): Promise<TreeItem[]> {
		const wfs = workspace.workspaceFolders || [];
		if (wfs.length === 1) {
			return await this.buildChildrenForPath(files, wfs[0].uri.fsPath, false, true);
		}
		const folders = wfs
			.filter((wf) => files.some((f) => f.fsPath.startsWith(wf.uri.fsPath + sep)))
			.map(
				(wf) =>
					new Folder(
						wf.name,
						wf.uri,
						undefined,
						false,
						files.some((f) => f.fsPath === join(wf.uri.fsPath, 'pom.xml')),
						true,
					),
			);
		return folders;
	}

	/**
	 * Get the children for a folder
	 * @param files The files to build children for
	 * @param folder The folder to get the children for
	 * @returns The children
	 */
	private async getFolderChildren(files: readonly Uri[], folder: Folder): Promise<TreeItem[]> {
		return await this.buildChildrenForPath(files, folder.folderUri.fsPath, folder.isUnderMavenRoot, false);
	}

	/**
	 * Build children for a path
	 * @param files The files to build children for
	 * @param parentPath The parent path
	 * @param ancestorUnderMavenRoot Whether the ancestor is under a Maven root
	 * @param parentIsWorkspaceRoot Whether the parent is a workspace root
	 * @returns The children
	 */
	private async buildChildrenForPath(
		files: readonly Uri[],
		parentPath: string,
		ancestorUnderMavenRoot: boolean,
		parentIsWorkspaceRoot: boolean,
	): Promise<TreeItem[]> {
		const directFiles: Uri[] = [];
		const subfolderNames = new Set<string>();
		const filePathSet = new Set<string>(files.map((f) => f.fsPath));
		const prefix = parentPath + sep;

		// filter the files to only include those that are direct files or subfolders
		for (const file of files) {
			if (!file.fsPath.startsWith(prefix)) {
				continue;
			}
			const parts = relative(parentPath, file.fsPath).split(sep);
			if (parts.length === 1) {
				directFiles.push(file);
			} else {
				subfolderNames.add(parts[0]);
			}
		}

		// check if the current path has a pom.xml file
		const hasPomXml = directFiles.some((f) => basename(f.fsPath) === 'pom.xml');
		// if the current path is under a Maven root or has a pom.xml file, set the underMavenRootForChildren flag to true
		const underMavenRootForChildren = ancestorUnderMavenRoot || hasPomXml;

		// build subfolders for the current path
		const subfolders = Array.from(subfolderNames.values())
			.sort((a, b) => a.localeCompare(b))
			.map((name) => {
				const childPath = join(parentPath, name);
				const isChildMavenRoot = filePathSet.has(join(childPath, 'pom.xml'));
				return new Folder(name, Uri.file(childPath), undefined, underMavenRootForChildren, isChildMavenRoot);
			});

		// build file items for the current path
		const sortedDirectFiles = directFiles.slice().sort((a, b) => a.fsPath.localeCompare(b.fsPath));
		const fileItems = await Promise.all(
			sortedDirectFiles.map(async (file) => this.toTreeItemForFile(file, underMavenRootForChildren, parentIsWorkspaceRoot && !underMavenRootForChildren)),
		);

		// sort the items alphabetically
		const items: TreeItem[] = [...subfolders, ...fileItems];
		items.sort((a, b) => {
			// Folders first, then files/integrations, both alphabetically
			const aIsFolder = a instanceof Folder;
			const bIsFolder = b instanceof Folder;
			if (aIsFolder !== bIsFolder) {
				return aIsFolder ? -1 : 1;
			}
			const aLabel = this.getItemLabel(a).toLowerCase();
			const bLabel = this.getItemLabel(b).toLowerCase();
			return aLabel.localeCompare(bLabel);
		});

		return items;
	}

	/**
	 * Get the label of an item
	 * @param item The item to get the label for
	 * @returns The label
	 */
	private getItemLabel(item: TreeItem): string {
		// if the item has a label property that is a string, return it (for example, a MarkdownString)
		if (typeof item.label === 'string') {
			return item.label;
		}
		// if the item has a label property that is a TreeItemLabel, return the label
		if (this.isTreeItemLabel(item.label)) {
			return item.label.label;
		}
		return '';
	}

	/**
	 * Check if a value is a TreeItemLabel
	 * @param value The value to check
	 * @returns True if the value is a TreeItemLabel, false otherwise
	 */
	private isTreeItemLabel(value: unknown): value is TreeItemLabel {
		return !!value && typeof (value as TreeItemLabel).label === 'string';
	}

	/**
	 * Set the context for the integrations view
	 * @param value The value to set the context for
	 */
	private setContext(value: boolean): void {
		commands.executeCommand('setContext', CONTEXT_INTEGRATION_EXISTS, value);
	}

	/**
	 * Convert a file to a tree item for the integrations view
	 * @param file The file to convert
	 * @param isUnderMavenRoot Whether the file is under a Maven root
	 * @param isTopLevelWithinWorkspace Whether the file is a top level within the workspace
	 * @returns The tree item
	 */
	private async toTreeItemForFile(file: Uri, isUnderMavenRoot: boolean = false, isTopLevelWithinWorkspace: boolean = true): Promise<TreeItem> {
		const filename = basename(file.fsPath);
		// Treat Camel, Kamelet and Pipe files as Integration items; others as plain files
		if (IntegrationFiles.isIntegrationFile(filename)) {
			return await this.integrationFiles.createIntegrationItem(file, isUnderMavenRoot, isTopLevelWithinWorkspace);
		}
		return new File(file, filename);
	}
}
