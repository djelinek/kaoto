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
import {
	CancellationToken,
	DataTransfer,
	DataTransferItem,
	Disposable,
	Event,
	EventEmitter,
	FileSystemWatcher,
	FileType,
	TreeDataProvider,
	TreeDragAndDropController,
	TreeItem,
	TreeItemLabel,
	Uri,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import { basename, join, sep } from 'path'; // NOSONAR
import { KAOTO_EXCLUDE_PATTERN, KAOTO_FILES_EXCLUDE_SETTING_ID } from '../../constants';
import { KaotoOutputChannel } from '../../extension/KaotoOutputChannel';
import { OpenApiImportService } from '../../services/OpenApiImportService';
import { enabledGlobs, GlobExcludeMatcher } from '../../utils/Glob';
import { File } from '../integrations/File';
import { Integration } from '../integrations/Integration';
import { IntegrationFiles } from '../integrations/IntegrationFiles';
import { Route } from '../integrations/Route';
import { OpenApiFile } from '../openapi/OpenApiFile';
import { Test } from '../tests/Test';
import { TestResult } from '../../types/TestTreeItemType';
import { getFilterSearchPattern, KAOTO_FILES_FILTERS, KaotoFileNameMatcher, KaotoFilesFilter } from './KaotoFilesFilter';
import { KaotoFolder } from './KaotoFolder';

type TreeItemType = TreeItem | undefined | null | void;

type DirectoryEntry = { name: string; uri: Uri; isDirectory: boolean };

/**
 * Source of the running state and results of tests (implemented by the Tests view provider).
 */
export interface TestStateSource {
	readonly onDidChangeTestState: Event<string | undefined>;
	getTestResult(filePath: string): TestResult;
	isTestRunning(filePath: string): boolean;
}

/**
 * Moves and copies files dropped on the view (implemented by the file operations).
 */
export interface DropHandler {
	move(sources: Uri[], targetFolder: Uri): Promise<void>;
	copy(sources: Uri[], targetFolder: Uri): Promise<void>;
}

/**
 * Tree data provider of the Kaoto Files view: a workspace file explorer which knows about Kaoto files.
 *
 * - the `all` filter lists folders lazily, one folder at a time, like the native Explorer
 * - the `camel`, `tests` and `openapi` filters search the workspace for matching files and only show folders containing them
 * - `files.exclude` and `kaoto.files.exclude` hide files in every filter
 * - Camel, test and OpenAPI files get the same tree items (and so the same actions) as in the dedicated views
 */
export class KaotoFilesProvider implements TreeDataProvider<TreeItem>, TreeDragAndDropController<TreeItem>, Disposable {
	public static readonly TREE_MIME_TYPE = 'application/vnd.code.tree.kaoto.files';
	private static readonly URI_LIST_MIME_TYPE = 'text/uri-list';
	private static readonly REFRESH_DEBOUNCE_MS = 300;
	private static readonly KAOTO_METADATA_FILE = '.kaoto';

	readonly dragMimeTypes = [KaotoFilesProvider.URI_LIST_MIME_TYPE];
	readonly dropMimeTypes = [KaotoFilesProvider.TREE_MIME_TYPE, KaotoFilesProvider.URI_LIST_MIME_TYPE];

	private readonly _onDidChangeTreeData = new EventEmitter<TreeItemType>();
	readonly onDidChangeTreeData: Event<TreeItemType> = this._onDidChangeTreeData.event;

	private readonly integrationFiles: IntegrationFiles;
	private readonly openApiService = new OpenApiImportService();
	private readonly fileNameMatcher = new KaotoFileNameMatcher();
	private readonly builtInExcludeMatcher = new GlobExcludeMatcher(['**/.git', '**/.citrus-jbang*', '**/.camel-jbang*']);
	private readonly disposables: Disposable[] = [];
	private readonly fileWatcher: FileSystemWatcher;

	/** tree items by id (the uri), used to find parents and to refresh single items */
	private readonly items = new Map<string, TreeItem>();
	private showRoutes = false;
	/** parent integration of each route item */
	private readonly routeParents = new WeakMap<TreeItem, Integration>();
	/** search results of the Camel, Tests and OpenAPI filters (file system paths) */
	private readonly matches = new Map<KaotoFilesFilter, Promise<Set<string>>>();
	/** OpenAPI version of the files whose content is a valid OpenAPI document */
	private readonly openApiVersions = new Map<string, string | undefined>();
	private readonly pomXmlCache = new Map<string, Promise<boolean>>();
	private readonly excludeMatchers = new Map<string, GlobExcludeMatcher>();

	private refreshTimer?: NodeJS.Timeout;
	private dropHandler?: DropHandler;

	constructor(
		extensionUriPath: string,
		private filter: KaotoFilesFilter,
		private readonly testStateSource?: TestStateSource,
	) {
		this.integrationFiles = new IntegrationFiles(extensionUriPath);

		this.fileWatcher = workspace.createFileSystemWatcher('**/*');
		this.fileWatcher.onDidCreate((uri) => this.onFileCreatedOrDeleted(uri));
		this.fileWatcher.onDidDelete((uri) => this.onFileCreatedOrDeleted(uri));
		this.fileWatcher.onDidChange((uri) => this.onFileChanged(uri));
		this.disposables.push(this.fileWatcher);

		this.disposables.push(
			workspace.onDidChangeConfiguration((event) => {
				const filterSettingChanged = Object.values(KAOTO_FILES_FILTERS).some(
					(definition) => definition.settingId && event.affectsConfiguration(definition.settingId),
				);
				if (filterSettingChanged) {
					this.fileNameMatcher.reload();
				}
				if (filterSettingChanged || event.affectsConfiguration('files.exclude') || event.affectsConfiguration(KAOTO_FILES_EXCLUDE_SETTING_ID)) {
					this.refresh();
				}
			}),
			workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
		);

		if (testStateSource) {
			this.disposables.push(testStateSource.onDidChangeTestState((filePath) => this.onTestStateChanged(filePath)));
		}
	}

	get currentFilter(): KaotoFilesFilter {
		return this.filter;
	}

	setFilter(filter: KaotoFilesFilter): void {
		if (this.filter === filter) {
			return;
		}
		this.filter = filter;
		this.refreshNow();
	}

	/**
	 * Show the routes of Camel files as their children.
	 * Off by default: VS Code only lines files up under the folder twisty like the native Explorer when no sibling
	 * can expand and has its own icon, so expandable Camel files push the other files of their folder to the right.
	 */
	setShowRoutes(showRoutes: boolean): void {
		if (this.showRoutes === showRoutes) {
			return;
		}
		this.showRoutes = showRoutes;
		this.refreshNow();
	}

	setDropHandler(dropHandler: DropHandler): void {
		this.dropHandler = dropHandler;
	}

	/**
	 * Refresh the whole tree, debounced to group bursts of file system events
	 */
	refresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => this.refreshNow(), KaotoFilesProvider.REFRESH_DEBOUNCE_MS);
	}

	private refreshNow(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.items.clear();
		this.matches.clear();
		this.openApiVersions.clear();
		this.pomXmlCache.clear();
		this.excludeMatchers.clear();
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.disposables.forEach((disposable) => disposable.dispose());
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

	async getChildren(element?: TreeItem): Promise<TreeItem[]> {
		try {
			if (!element) {
				return await this.getRootChildren();
			}
			if (element instanceof Integration) {
				return await this.getRouteChildren(element);
			}
			if (element instanceof KaotoFolder) {
				return await this.getFolderChildren(element.folderUri, element.isUnderMavenRoot || element.isMavenRoot, element.isWorkspaceRoot);
			}
		} catch (error) {
			KaotoOutputChannel.logError('Error listing files for the Kaoto Files view', error);
		}
		return [];
	}

	async getParent(element: TreeItem): Promise<TreeItem | undefined> {
		if (element instanceof Route) {
			return this.routeParents.get(element);
		}
		const uri = element.resourceUri;
		if (!uri) {
			return undefined;
		}
		const workspaceFolder = workspace.getWorkspaceFolder(uri);
		if (!workspaceFolder || this.isSameUri(uri, workspaceFolder.uri)) {
			return undefined;
		}
		const parentUri = Uri.joinPath(uri, '..');
		if (this.isSameUri(parentUri, workspaceFolder.uri)) {
			return this.isMultiRoot() ? await this.getOrCreateFolderItem(parentUri, workspaceFolder) : undefined;
		}
		return await this.getOrCreateFolderItem(parentUri, workspaceFolder);
	}

	/**
	 * Get the tree item of a file so it can be revealed, or undefined when the file is not shown with the current filter
	 */
	async getItemForFile(uri: Uri): Promise<TreeItem | undefined> {
		const workspaceFolder = workspace.getWorkspaceFolder(uri);
		if (!workspaceFolder || this.isExcluded(uri, workspaceFolder)) {
			return undefined;
		}
		if (this.filter !== 'all' && !(await this.getMatches(this.filter)).has(uri.fsPath)) {
			return undefined;
		}
		const cached = this.items.get(uri.toString());
		if (cached) {
			return cached;
		}
		const parentUri = Uri.joinPath(uri, '..');
		const underMavenRoot = await this.isUnderMavenRoot(parentUri, workspaceFolder, true);
		const isTopLevel = this.isSameUri(parentUri, workspaceFolder.uri) && !underMavenRoot;
		return await this.toFileItem(uri, underMavenRoot, isTopLevel);
	}

	/**
	 * Refresh the item of a file (for example after its test state changed)
	 */
	refreshFile(uri: Uri): void {
		const item = this.items.get(uri.toString());
		if (item) {
			this._onDidChangeTreeData.fire(item);
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// drag and drop

	handleDrag(source: readonly TreeItem[], dataTransfer: DataTransfer, _token: CancellationToken): void {
		const uris = source
			.filter((item) => !(item instanceof Route))
			.map((item) => item.resourceUri)
			.filter((uri): uri is Uri => !!uri);
		if (uris.length > 0) {
			// lets the files be dropped into editors, the terminal or other views
			dataTransfer.set(KaotoFilesProvider.URI_LIST_MIME_TYPE, new DataTransferItem(uris.map((uri) => uri.toString()).join('\r\n')));
		}
	}

	async handleDrop(target: TreeItem | undefined, dataTransfer: DataTransfer, _token: CancellationToken): Promise<void> {
		if (!this.dropHandler) {
			return;
		}
		const targetFolder = this.getDropTargetFolder(target);
		if (!targetFolder) {
			return;
		}
		const uriList = await dataTransfer.get(KaotoFilesProvider.URI_LIST_MIME_TYPE)?.asString();
		const droppedUris = (uriList ?? '')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'))
			.map((line) => Uri.parse(line));

		// items dragged inside this view are moved, like in the native Explorer
		const treeTransferItem = dataTransfer.get(KaotoFilesProvider.TREE_MIME_TYPE);
		if (treeTransferItem) {
			const treeItems = Array.isArray(treeTransferItem.value) ? (treeTransferItem.value as unknown[]) : [];
			const treeUris = treeItems
				.filter((item): item is TreeItem => item instanceof TreeItem && !(item instanceof Route))
				.map((item) => item.resourceUri)
				.filter((uri): uri is Uri => !!uri);
			await this.dropHandler.move(treeUris.length > 0 ? treeUris : droppedUris, targetFolder);
			return;
		}
		// files dropped from the OS or other views are copied
		if (droppedUris.length > 0) {
			await this.dropHandler.copy(droppedUris, targetFolder);
		}
	}

	private getDropTargetFolder(target: TreeItem | undefined): Uri | undefined {
		if (target instanceof KaotoFolder) {
			return target.folderUri;
		}
		if (target instanceof Route) {
			const integration = this.routeParents.get(target);
			return integration ? Uri.joinPath(integration.filepath, '..') : undefined;
		}
		if (target?.resourceUri) {
			return Uri.joinPath(target.resourceUri, '..');
		}
		const folders = workspace.workspaceFolders ?? [];
		return folders.length === 1 ? folders[0].uri : undefined;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// tree building

	private async getRootChildren(): Promise<TreeItem[]> {
		const workspaceFolders = workspace.workspaceFolders ?? [];
		if (workspaceFolders.length === 1) {
			return await this.getFolderChildren(workspaceFolders[0].uri, false, true);
		}
		const roots: TreeItem[] = [];
		for (const workspaceFolder of workspaceFolders) {
			if (this.filter !== 'all' && !(await this.containsMatches(this.filter, workspaceFolder.uri))) {
				continue;
			}
			roots.push(await this.createFolderItem(workspaceFolder.name, workspaceFolder.uri, false, true));
		}
		return roots;
	}

	private async getRouteChildren(integration: Integration): Promise<TreeItem[]> {
		const routes = await this.integrationFiles.getRoutes(integration);
		routes.forEach((route, index) => {
			route.id = `${integration.filepath.toString()}#route-${index}`;
			this.routeParents.set(route, integration);
		});
		return routes;
	}

	private async getFolderChildren(folderUri: Uri, underMavenRoot: boolean, isWorkspaceRoot: boolean): Promise<TreeItem[]> {
		const workspaceFolder = workspace.getWorkspaceFolder(folderUri);
		if (!workspaceFolder) {
			return [];
		}
		const entries = this.filter === 'all' ? await this.readDirectory(folderUri, workspaceFolder) : await this.getMatchingEntries(folderUri);

		const folders: TreeItem[] = [];
		const files: TreeItem[] = [];
		for (const entry of entries) {
			if (entry.isDirectory) {
				folders.push(await this.createFolderItem(entry.name, entry.uri, underMavenRoot, false));
			} else {
				files.push(await this.toFileItem(entry.uri, underMavenRoot, isWorkspaceRoot && !underMavenRoot));
			}
		}
		const byLabel = (a: TreeItem, b: TreeItem) =>
			this.getItemLabel(a).localeCompare(this.getItemLabel(b), undefined, { numeric: true, sensitivity: 'base' });
		return [...folders.sort(byLabel), ...files.sort(byLabel)];
	}

	private async readDirectory(folderUri: Uri, workspaceFolder: WorkspaceFolder): Promise<DirectoryEntry[]> {
		const entries = await workspace.fs.readDirectory(folderUri);
		return entries
			.map(([name, type]) => ({ name, uri: Uri.joinPath(folderUri, name), isDirectory: (type & FileType.Directory) === FileType.Directory }))
			.filter((entry) => !this.isExcluded(entry.uri, workspaceFolder));
	}

	private async getMatchingEntries(folderUri: Uri): Promise<DirectoryEntry[]> {
		const matches = await this.getMatches(this.filter);
		const prefix = folderUri.fsPath + sep;
		const files = new Map<string, DirectoryEntry>();
		const folders = new Map<string, DirectoryEntry>();
		for (const path of matches) {
			if (!path.startsWith(prefix)) {
				continue;
			}
			const parts = path.substring(prefix.length).split(sep);
			if (parts.length === 1) {
				files.set(parts[0], { name: parts[0], uri: Uri.joinPath(folderUri, parts[0]), isDirectory: false });
			} else if (!folders.has(parts[0])) {
				folders.set(parts[0], { name: parts[0], uri: Uri.joinPath(folderUri, parts[0]), isDirectory: true });
			}
		}
		return [...folders.values(), ...files.values()];
	}

	private async createFolderItem(name: string, folderUri: Uri, underMavenRoot: boolean, isWorkspaceRoot: boolean): Promise<KaotoFolder> {
		const [isMavenRoot, hasCamelFiles, hasTestFiles] = await Promise.all([
			this.hasPomXml(folderUri),
			this.containsMatches('camel', folderUri),
			this.containsMatches('tests', folderUri),
		]);
		const folder = new KaotoFolder(name, folderUri, underMavenRoot, isMavenRoot, isWorkspaceRoot, { hasCamelFiles, hasTestFiles });
		this.items.set(folder.id!, folder);
		return folder;
	}

	private async getOrCreateFolderItem(folderUri: Uri, workspaceFolder: WorkspaceFolder): Promise<TreeItem> {
		const cached = this.items.get(folderUri.toString());
		if (cached) {
			return cached;
		}
		const isWorkspaceRoot = this.isSameUri(folderUri, workspaceFolder.uri);
		const name = isWorkspaceRoot ? workspaceFolder.name : basename(folderUri.path);
		const underMavenRoot = isWorkspaceRoot ? false : await this.isUnderMavenRoot(Uri.joinPath(folderUri, '..'), workspaceFolder, true);
		return await this.createFolderItem(name, folderUri, underMavenRoot, isWorkspaceRoot);
	}

	/**
	 * Convert a file to a tree item, reusing the items of the Integrations, Tests and OpenAPI views for Kaoto files
	 */
	private async toFileItem(uri: Uri, underMavenRoot: boolean, isTopLevelWithinWorkspace: boolean): Promise<TreeItem> {
		const fileName = basename(uri.path);
		let item: TreeItem;
		if (IntegrationFiles.isIntegrationFile(fileName)) {
			item = await this.integrationFiles.createIntegrationItem(uri, underMavenRoot, isTopLevelWithinWorkspace, this.showRoutes);
		} else if (this.fileNameMatcher.isRunnableTest(fileName)) {
			item = this.createTestItem(uri, underMavenRoot);
		} else if (this.fileNameMatcher.matches('openapi', fileName) && (await this.getOpenApiVersion(uri)) !== undefined) {
			item = new OpenApiFile(fileName, uri.fsPath, (await this.getOpenApiVersion(uri))!);
		} else if (fileName === KaotoFilesProvider.KAOTO_METADATA_FILE) {
			item = new File(uri, fileName);
			item.description = 'Kaoto metadata';
			item.tooltip = `Kaoto metadata (data mapper and editor settings)\n${uri.fsPath}`;
		} else {
			item = new File(uri, fileName);
		}
		item.id = uri.toString();
		this.items.set(item.id, item);
		return item;
	}

	private createTestItem(uri: Uri, underMavenRoot: boolean): Test {
		const test = new Test(uri, underMavenRoot);
		if (this.testStateSource) {
			test.setResult(this.testStateSource.getTestResult(uri.fsPath));
			if (this.testStateSource.isTestRunning(uri.fsPath)) {
				test.setRunning(true);
			}
		}
		return test;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// filters, excludes and caches

	private getMatches(filter: KaotoFilesFilter): Promise<Set<string>> {
		let matches = this.matches.get(filter);
		if (!matches) {
			matches = this.searchMatches(filter);
			this.matches.set(filter, matches);
		}
		return matches;
	}

	private async searchMatches(filter: KaotoFilesFilter): Promise<Set<string>> {
		if (filter === 'all') {
			return new Set();
		}
		const found = await workspace.findFiles(getFilterSearchPattern(filter), KAOTO_EXCLUDE_PATTERN);
		const visible = found.filter((uri) => {
			const workspaceFolder = workspace.getWorkspaceFolder(uri);
			return !workspaceFolder || !this.isExcluded(uri, workspaceFolder);
		});
		if (filter !== 'openapi') {
			return new Set(visible.map((uri) => uri.fsPath));
		}
		const openApiFiles = await Promise.all(visible.map(async (uri) => ((await this.getOpenApiVersion(uri)) === undefined ? undefined : uri.fsPath)));
		return new Set(openApiFiles.filter((path): path is string => !!path));
	}

	private async containsMatches(filter: KaotoFilesFilter, folderUri: Uri): Promise<boolean> {
		const prefix = folderUri.fsPath + sep;
		for (const path of await this.getMatches(filter)) {
			if (path.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	private async getOpenApiVersion(uri: Uri): Promise<string | undefined> {
		if (this.openApiVersions.has(uri.fsPath)) {
			return this.openApiVersions.get(uri.fsPath);
		}
		let version: string | undefined;
		try {
			const content = new TextDecoder('utf-8').decode(await workspace.fs.readFile(uri));
			version = this.openApiService.parseOpenApiSpec(content).openapi;
		} catch {
			// not a valid OpenAPI document
		}
		this.openApiVersions.set(uri.fsPath, version);
		return version;
	}

	private isExcluded(uri: Uri, workspaceFolder: WorkspaceFolder): boolean {
		const relativePath = workspace.asRelativePath(uri, false);
		if (this.builtInExcludeMatcher.isExcluded(relativePath)) {
			return true;
		}
		return this.getExcludeMatcher(workspaceFolder).isExcluded(relativePath);
	}

	private getExcludeMatcher(workspaceFolder: WorkspaceFolder): GlobExcludeMatcher {
		const key = workspaceFolder.uri.toString();
		let matcher = this.excludeMatchers.get(key);
		if (!matcher) {
			const filesExclude = enabledGlobs(workspace.getConfiguration('files', workspaceFolder.uri).get<Record<string, unknown>>('exclude'));
			const kaotoExclude = workspace.getConfiguration(undefined, workspaceFolder.uri).get<string[]>(KAOTO_FILES_EXCLUDE_SETTING_ID) ?? [];
			matcher = new GlobExcludeMatcher([...filesExclude, ...kaotoExclude]);
			this.excludeMatchers.set(key, matcher);
		}
		return matcher;
	}

	private hasPomXml(folderUri: Uri): Promise<boolean> {
		let result = this.pomXmlCache.get(folderUri.fsPath);
		if (!result) {
			result = Promise.resolve(workspace.fs.stat(Uri.file(join(folderUri.fsPath, 'pom.xml')))).then(
				() => true,
				() => false,
			);
			this.pomXmlCache.set(folderUri.fsPath, result);
		}
		return result;
	}

	/**
	 * Check if a folder, or one of its parents up to the workspace folder, is a Maven root
	 */
	private async isUnderMavenRoot(folderUri: Uri, workspaceFolder: WorkspaceFolder, includeSelf: boolean): Promise<boolean> {
		let current = includeSelf ? folderUri : Uri.joinPath(folderUri, '..');
		while (current.fsPath.startsWith(workspaceFolder.uri.fsPath)) {
			if (await this.hasPomXml(current)) {
				return true;
			}
			if (this.isSameUri(current, workspaceFolder.uri)) {
				break;
			}
			current = Uri.joinPath(current, '..');
		}
		return false;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// events

	private onFileCreatedOrDeleted(uri: Uri): void {
		if (this.builtInExcludeMatcher.isExcluded(workspace.asRelativePath(uri, false))) {
			return;
		}
		this.refresh();
	}

	private onFileChanged(uri: Uri): void {
		// only the content of Camel and OpenAPI files changes what the tree shows (routes, OpenAPI version)
		const item = this.items.get(uri.toString());
		if (item instanceof Integration || item instanceof OpenApiFile || this.openApiVersions.has(uri.fsPath)) {
			this.refresh();
		}
	}

	private onTestStateChanged(filePath: string | undefined): void {
		if (!filePath) {
			this.refresh();
			return;
		}
		const item = this.items.get(Uri.file(filePath).toString());
		if (item instanceof Test && this.testStateSource) {
			item.setResult(this.testStateSource.getTestResult(filePath));
			item.setRunning(this.testStateSource.isTestRunning(filePath));
			this._onDidChangeTreeData.fire(item);
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// helpers

	private isMultiRoot(): boolean {
		return (workspace.workspaceFolders?.length ?? 0) > 1;
	}

	private isSameUri(a: Uri, b: Uri): boolean {
		return a.toString() === b.toString();
	}

	private getItemLabel(item: TreeItem): string {
		if (typeof item.label === 'string') {
			return item.label;
		}
		if (item.label && typeof (item.label as TreeItemLabel).label === 'string') {
			return (item.label as TreeItemLabel).label;
		}
		return item.resourceUri ? basename(item.resourceUri.path) : '';
	}
}
