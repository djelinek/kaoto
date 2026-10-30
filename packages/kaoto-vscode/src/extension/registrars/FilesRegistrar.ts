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
import * as vscode from 'vscode';
import { TelemetryService } from '@redhat-developer/vscode-redhat-telemetry';
import {
	COMMAND_FILES_COMPARE_WITH_SELECTED,
	COMMAND_FILES_COPY,
	COMMAND_FILES_COPY_PATH,
	COMMAND_FILES_COPY_RELATIVE_PATH,
	COMMAND_FILES_CUT,
	COMMAND_FILES_DELETE,
	COMMAND_FILES_FILTER_ALL,
	COMMAND_FILES_FILTER_CAMEL,
	COMMAND_FILES_FILTER_OPENAPI,
	COMMAND_FILES_FILTER_TESTS,
	COMMAND_FILES_FIND_IN_FOLDER,
	COMMAND_FILES_NEW_FILE,
	COMMAND_FILES_NEW_FOLDER,
	COMMAND_FILES_OPEN_IN_TERMINAL,
	COMMAND_FILES_OPEN_TO_SIDE,
	COMMAND_FILES_PASTE,
	COMMAND_FILES_PASTE_IN_ROOT,
	COMMAND_FILES_REFRESH,
	COMMAND_FILES_RENAME,
	COMMAND_FILES_REVEAL_IN_EXPLORER,
	COMMAND_FILES_REVEAL_IN_OS,
	COMMAND_FILES_SELECT_FOR_COMPARE,
	CONTEXT_FILES_FILTER,
	STATE_FILES_FILTER,
	VIEW_FILES,
} from '../../constants';
import { KaotoFilesProvider, TestStateSource } from '../../views/files/KaotoFilesProvider';
import { KaotoFileOperations } from '../../views/files/KaotoFileOperations';
import { isKaotoFilesFilter, KAOTO_FILES_FILTERS, KaotoFilesFilter } from '../../views/files/KaotoFilesFilter';
import { KaotoFolder } from '../../views/files/KaotoFolder';
import { sendCommandTrackingEvent } from './TrackingEvent';
import { IRegistrar } from './IRegistrar';

/** The context key telling a file was selected for compare */
const CONTEXT_FILES_COMPARE_SELECTED = 'kaoto.files.compareSelected';

/**
 * Registers the Kaoto Files view: a workspace file explorer with Kaoto filters, file operations and Kaoto actions.
 */
export class FilesRegistrar implements IRegistrar {
	private provider!: KaotoFilesProvider;
	private treeView!: vscode.TreeView<vscode.TreeItem>;
	private readonly operations = new KaotoFileOperations();
	private selectedForCompare: vscode.Uri | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly telemetryService: TelemetryService | undefined,
		private readonly getTestStateSource: () => TestStateSource | undefined = () => undefined,
	) {}

	register(): void {
		this.registerFilesView();
		this.registerFilterCommands();
		this.registerFileOperationCommands();
		this.registerPathAndRevealCommands();
		this.registerAutoReveal();
	}

	private registerFilesView(): void {
		const storedFilter = this.context.workspaceState.get<string>(STATE_FILES_FILTER);
		const filter: KaotoFilesFilter = isKaotoFilesFilter(storedFilter) ? storedFilter : 'all';

		this.provider = new KaotoFilesProvider(this.context.extensionUri.path, filter, this.getTestStateSource());
		this.provider.setDropHandler(this.operations);
		this.treeView = vscode.window.createTreeView(VIEW_FILES, {
			treeDataProvider: this.provider,
			dragAndDropController: this.provider,
			canSelectMany: true,
			showCollapseAll: true,
		});
		this.updateFilterPresentation(filter);

		this.context.subscriptions.push(
			this.treeView,
			this.provider,
			vscode.commands.registerCommand(COMMAND_FILES_REFRESH, () => this.provider.refresh()),
		);
	}

	private registerFilterCommands(): void {
		const filterCommands: [string, KaotoFilesFilter][] = [
			[COMMAND_FILES_FILTER_ALL, 'all'],
			[COMMAND_FILES_FILTER_CAMEL, 'camel'],
			[COMMAND_FILES_FILTER_TESTS, 'tests'],
			[COMMAND_FILES_FILTER_OPENAPI, 'openapi'],
		];
		for (const [commandId, filter] of filterCommands) {
			this.context.subscriptions.push(
				vscode.commands.registerCommand(commandId, async () => {
					this.provider.setFilter(filter);
					this.updateFilterPresentation(filter);
					await this.context.workspaceState.update(STATE_FILES_FILTER, filter);
					await sendCommandTrackingEvent(this.telemetryService, commandId);
				}),
			);
		}
	}

	private updateFilterPresentation(filter: KaotoFilesFilter): void {
		this.treeView.description = filter === 'all' ? undefined : KAOTO_FILES_FILTERS[filter].label;
		vscode.commands.executeCommand('setContext', CONTEXT_FILES_FILTER, filter);
	}

	private registerFileOperationCommands(): void {
		this.registerItemCommand(COMMAND_FILES_NEW_FILE, async (items) => {
			const folder = await this.getTargetFolder(items[0]);
			const created = folder ? await this.operations.newFile(folder) : undefined;
			if (created) {
				await this.reveal(created);
			}
		});
		this.registerItemCommand(COMMAND_FILES_NEW_FOLDER, async (items) => {
			const folder = await this.getTargetFolder(items[0]);
			if (folder) {
				await this.operations.newFolder(folder);
			}
		});
		this.registerItemCommand(COMMAND_FILES_RENAME, async (items) => {
			const uri = this.getResourceUris(items)[0];
			if (uri) {
				await this.operations.rename(uri);
			}
		});
		this.registerItemCommand(COMMAND_FILES_DELETE, async (items) => {
			await this.operations.delete(this.getResourceUris(items));
		});
		this.registerItemCommand(COMMAND_FILES_CUT, async (items) => {
			await this.operations.setClipboard(this.getResourceUris(items), true);
		});
		this.registerItemCommand(COMMAND_FILES_COPY, async (items) => {
			await this.operations.setClipboard(this.getResourceUris(items), false);
		});
		this.registerItemCommand(COMMAND_FILES_PASTE, async (items) => {
			const folder = await this.getTargetFolder(items[0]);
			if (folder) {
				await this.operations.paste(folder);
			}
		});

		// a single folder workspace has no root item (like the native Explorer), and extensions cannot add a context menu
		// to the empty space of a view, so the view title offers a paste into the workspace folder
		this.context.subscriptions.push(
			vscode.commands.registerCommand(COMMAND_FILES_PASTE_IN_ROOT, async () => {
				const folder = await this.getTargetFolder(undefined);
				if (folder) {
					await this.operations.paste(folder);
				}
				await sendCommandTrackingEvent(this.telemetryService, COMMAND_FILES_PASTE_IN_ROOT);
			}),
		);
	}

	private registerPathAndRevealCommands(): void {
		this.registerItemCommand(COMMAND_FILES_OPEN_TO_SIDE, async (items) => {
			for (const uri of this.getResourceUris(items)) {
				await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: items.length > 1 });
			}
		});
		// the following built-in commands accept a file uri, so the native Explorer behavior is reused as is
		this.registerItemCommand(COMMAND_FILES_REVEAL_IN_OS, async (items) => {
			await this.executeForFirstUri(items, 'revealFileInOS');
		});
		this.registerItemCommand(COMMAND_FILES_REVEAL_IN_EXPLORER, async (items) => {
			await this.executeForFirstUri(items, 'revealInExplorer');
		});
		this.registerItemCommand(COMMAND_FILES_OPEN_IN_TERMINAL, async (items) => {
			await this.executeForFirstUri(items, 'openInIntegratedTerminal');
		});
		this.registerItemCommand(COMMAND_FILES_FIND_IN_FOLDER, async (items) => {
			const folders = this.getResourceUris(items).map((uri) =>
				vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1),
			);
			await vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: folders.join(', '), triggerSearch: false });
		});
		this.registerItemCommand(COMMAND_FILES_COPY_PATH, async (items) => {
			await vscode.env.clipboard.writeText(
				this.getResourceUris(items)
					.map((uri) => uri.fsPath)
					.join('\n'),
			);
		});
		this.registerItemCommand(COMMAND_FILES_COPY_RELATIVE_PATH, async (items) => {
			const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
			await vscode.env.clipboard.writeText(
				this.getResourceUris(items)
					.map((uri) => vscode.workspace.asRelativePath(uri, multiRoot))
					.join('\n'),
			);
		});
		this.registerItemCommand(COMMAND_FILES_SELECT_FOR_COMPARE, async (items) => {
			this.selectedForCompare = this.getResourceUris(items)[0];
			await vscode.commands.executeCommand('setContext', CONTEXT_FILES_COMPARE_SELECTED, !!this.selectedForCompare);
		});
		this.registerItemCommand(COMMAND_FILES_COMPARE_WITH_SELECTED, async (items) => {
			const right = this.getResourceUris(items)[0];
			const left = this.selectedForCompare;
			if (left && right) {
				const title = `${vscode.workspace.asRelativePath(left)} ↔ ${vscode.workspace.asRelativePath(right)}`;
				await vscode.commands.executeCommand('vscode.diff', left, right, title);
			}
		});
	}

	/**
	 * Select the file of the active editor in the view, following the `explorer.autoReveal` setting of the native Explorer
	 */
	private registerAutoReveal(): void {
		this.context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(async (editor) => {
				if (editor) {
					await this.revealIfEnabled(editor.document.uri);
				}
			}),
			vscode.window.tabGroups.onDidChangeTabs(async () => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				// custom editors (like the Kaoto editor) are not text editors, so they are followed through the tabs
				if (input instanceof vscode.TabInputCustom) {
					await this.revealIfEnabled(input.uri);
				}
			}),
		);
	}

	private async revealIfEnabled(uri: vscode.Uri): Promise<void> {
		const autoReveal = vscode.workspace.getConfiguration('explorer').get<boolean | string>('autoReveal', true);
		if (autoReveal === false || !this.treeView.visible || uri.scheme !== 'file') {
			return;
		}
		await this.reveal(uri, autoReveal !== 'focusNoScroll');
	}

	private async reveal(uri: vscode.Uri, scroll = true): Promise<void> {
		const item = await this.provider.getItemForFile(uri);
		if (!item) {
			return;
		}
		try {
			if (scroll || !this.treeView.selection.includes(item)) {
				await this.treeView.reveal(item, { select: true, focus: false, expand: false });
			}
		} catch {
			// the item may disappear while revealing (for example a file deleted right after its creation)
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// helpers

	/**
	 * Register a command run from the view: a context menu passes the clicked item and the selected items,
	 * a keybinding passes nothing and the view selection is used.
	 */
	private registerItemCommand(commandId: string, handler: (items: vscode.TreeItem[]) => Promise<void>): void {
		this.context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (item?: vscode.TreeItem, selected?: vscode.TreeItem[]) => {
				let items: vscode.TreeItem[];
				if (selected && selected.length > 0) {
					items = selected;
				} else if (item instanceof vscode.TreeItem) {
					items = [item];
				} else {
					items = [...this.treeView.selection];
				}
				await handler(items);
				await sendCommandTrackingEvent(this.telemetryService, commandId);
			}),
		);
	}

	private getResourceUris(items: vscode.TreeItem[]): vscode.Uri[] {
		return items.map((item) => item.resourceUri).filter((uri): uri is vscode.Uri => !!uri);
	}

	private async executeForFirstUri(items: vscode.TreeItem[], commandId: string): Promise<void> {
		const uri = this.getResourceUris(items)[0];
		if (uri) {
			await vscode.commands.executeCommand(commandId, uri);
		}
	}

	/**
	 * Get the folder in which new or pasted files go: the selected folder, the folder of the selected file,
	 * or the workspace folder (picked by the user in a multi-root workspace)
	 */
	private async getTargetFolder(item: vscode.TreeItem | undefined): Promise<vscode.Uri | undefined> {
		if (item instanceof KaotoFolder) {
			return item.folderUri;
		}
		if (item?.resourceUri) {
			return vscode.Uri.joinPath(item.resourceUri, '..');
		}
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		if (workspaceFolders.length <= 1) {
			return workspaceFolders[0]?.uri;
		}
		return (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the workspace folder' }))?.uri;
	}
}
