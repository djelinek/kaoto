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
import { commands, FileType, Uri, window, workspace, WorkspaceEdit } from 'vscode';
import { basename, extname } from 'path'; // NOSONAR
import { CONTEXT_FILES_CAN_PASTE } from '../../constants';
import { KaotoOutputChannel } from '../../extension/KaotoOutputChannel';
import { DropHandler } from './KaotoFilesProvider';

type Clipboard = { uris: Uri[]; cut: boolean };

/**
 * File operations of the Kaoto Files view.
 *
 * All changes go through the VS Code workspace APIs (`WorkspaceEdit` and `workspace.fs`) rather than Node.js `fs`, so:
 * - they work in remote, WSL, virtual and web workspaces like the native Explorer
 * - other extensions are told about renames and moves (for example to update imports or references)
 * - the file system watchers of the native Explorer and other views pick up the changes
 */
export class KaotoFileOperations implements DropHandler {
	private clipboard: Clipboard | undefined;

	/**
	 * Ask for a name and create a new file in a folder. Nested paths like `a/b/c.camel.yaml` create the missing folders.
	 */
	async newFile(folder: Uri): Promise<Uri | undefined> {
		const name = await this.askForNewName(folder, 'File name', 'Enter the name of the new file (use / to create folders)');
		if (!name) {
			return undefined;
		}
		const target = Uri.joinPath(folder, name);
		const edit = new WorkspaceEdit();
		edit.createFile(target, { ignoreIfExists: false, overwrite: false });
		if (!(await workspace.applyEdit(edit))) {
			window.showErrorMessage(`Unable to create the file '${name}'.`);
			return undefined;
		}
		await commands.executeCommand('vscode.open', target);
		return target;
	}

	/**
	 * Ask for a name and create a new folder in a folder
	 */
	async newFolder(folder: Uri): Promise<Uri | undefined> {
		const name = await this.askForNewName(folder, 'Folder name', 'Enter the name of the new folder (use / to create nested folders)');
		if (!name) {
			return undefined;
		}
		const target = Uri.joinPath(folder, name);
		try {
			await workspace.fs.createDirectory(target);
			return target;
		} catch (error) {
			window.showErrorMessage(`Unable to create the folder '${name}': ${error}`);
			return undefined;
		}
	}

	/**
	 * Ask for a new name and rename a file or folder
	 */
	async rename(uri: Uri): Promise<Uri | undefined> {
		const oldName = basename(uri.path);
		const parent = Uri.joinPath(uri, '..');
		const extensionStart = this.getNameWithoutExtension(oldName).length;
		const newName = await window.showInputBox({
			title: `Rename '${oldName}'`,
			value: oldName,
			valueSelection: [0, extensionStart],
			validateInput: async (value) => (value === oldName ? undefined : await this.validateName(parent, value)),
		});
		if (!newName || newName === oldName) {
			return undefined;
		}
		const target = Uri.joinPath(parent, newName);
		const edit = new WorkspaceEdit();
		edit.renameFile(uri, target, { overwrite: false });
		if (!(await workspace.applyEdit(edit))) {
			window.showErrorMessage(`Unable to rename '${oldName}' to '${newName}'.`);
			return undefined;
		}
		return target;
	}

	/**
	 * Delete files and folders after a confirmation, moving them to the trash when the file system supports it
	 */
	async delete(uris: Uri[]): Promise<void> {
		if (uris.length === 0) {
			return;
		}
		const message =
			uris.length === 1
				? `Are you sure you want to delete '${basename(uris[0].path)}'?`
				: `Are you sure you want to delete the following ${uris.length} files?`;
		const detail = uris.length === 1 ? 'You can restore this file from the Trash.' : uris.map((uri) => basename(uri.path)).join('\n');
		const moveToTrash = 'Move to Trash';
		const answer = await window.showWarningMessage(message, { modal: true, detail }, moveToTrash);
		if (answer !== moveToTrash) {
			return;
		}
		for (const uri of uris) {
			try {
				await workspace.fs.delete(uri, { recursive: true, useTrash: true });
			} catch {
				await this.deletePermanently(uri);
			}
		}
	}

	private async deletePermanently(uri: Uri): Promise<void> {
		const deletePermanently = 'Delete Permanently';
		const answer = await window.showWarningMessage(
			`Unable to move '${basename(uri.path)}' to the Trash. Do you want to permanently delete it instead?`,
			{ modal: true, detail: 'This action is irreversible!' },
			deletePermanently,
		);
		if (answer === deletePermanently) {
			try {
				await workspace.fs.delete(uri, { recursive: true, useTrash: false });
			} catch (error) {
				window.showErrorMessage(`Unable to delete '${basename(uri.path)}': ${error}`);
			}
		}
	}

	/**
	 * Remember files for a later paste
	 * @param cut true to move the files on paste, false to copy them
	 */
	async setClipboard(uris: Uri[], cut: boolean): Promise<void> {
		this.clipboard = uris.length > 0 ? { uris, cut } : undefined;
		await commands.executeCommand('setContext', CONTEXT_FILES_CAN_PASTE, !!this.clipboard);
	}

	/**
	 * Paste the files remembered by cut or copy into a folder
	 */
	async paste(folder: Uri): Promise<void> {
		if (!this.clipboard) {
			return;
		}
		const { uris, cut } = this.clipboard;
		if (cut) {
			await this.move(uris, folder);
			await this.setClipboard([], false);
		} else {
			await this.copy(uris, folder);
		}
	}

	/**
	 * Move files and folders into a folder, asking before replacing existing ones
	 */
	async move(sources: Uri[], targetFolder: Uri): Promise<void> {
		const edit = new WorkspaceEdit();
		for (const source of sources) {
			if (this.isSameOrParent(source, targetFolder)) {
				window.showErrorMessage(`Cannot move '${basename(source.path)}' into itself.`);
				continue;
			}
			if (this.isSameUri(Uri.joinPath(source, '..'), targetFolder)) {
				continue; // dropped on its own folder
			}
			const target = Uri.joinPath(targetFolder, basename(source.path));
			let overwrite = false;
			if (await this.exists(target)) {
				const replace = 'Replace';
				const answer = await window.showWarningMessage(
					`A file or folder with the name '${basename(target.path)}' already exists in the destination folder. Do you want to replace it?`,
					{ modal: true, detail: 'This action is irreversible!' },
					replace,
				);
				if (answer !== replace) {
					continue;
				}
				overwrite = true;
			}
			edit.renameFile(source, target, { overwrite });
		}
		if (edit.size > 0 && !(await workspace.applyEdit(edit))) {
			window.showErrorMessage('Unable to move the selected files.');
		}
	}

	/**
	 * Copy files and folders into a folder. Name clashes get a `copy` suffix like in the native Explorer.
	 */
	async copy(sources: Uri[], targetFolder: Uri): Promise<void> {
		for (const source of sources) {
			try {
				const target = await this.findAvailableName(targetFolder, basename(source.path));
				await workspace.fs.copy(source, target, { overwrite: false });
			} catch (error) {
				KaotoOutputChannel.logError(`Unable to copy '${source.toString()}'`, error);
				window.showErrorMessage(`Unable to copy '${basename(source.path)}': ${error}`);
			}
		}
	}

	private async askForNewName(folder: Uri, title: string, prompt: string): Promise<string | undefined> {
		const name = await window.showInputBox({
			title,
			prompt,
			validateInput: async (value) => await this.validateName(folder, value),
		});
		return name?.trim().replace(/^\/+/, '');
	}

	/**
	 * Validate a new file or folder name, returning an error message or undefined when the name is valid
	 */
	async validateName(folder: Uri, value: string): Promise<string | undefined> {
		const name = value.trim().replace(/^\/+/, '');
		if (name.length === 0) {
			return 'A file or folder name must be provided.';
		}
		if (name.split('/').some((segment) => segment === '.' || segment === '..')) {
			return `The name '${name}' is not valid.`;
		}
		if (/[\\:*?"<>|]/.test(name)) {
			return `The name '${name}' contains characters which are not allowed in file names.`;
		}
		if (await this.exists(Uri.joinPath(folder, name))) {
			return `A file or folder '${name}' already exists at this location. Please choose a different name.`;
		}
		return undefined;
	}

	private async findAvailableName(folder: Uri, name: string): Promise<Uri> {
		let candidate = Uri.joinPath(folder, name);
		if (!(await this.exists(candidate))) {
			return candidate;
		}
		const isFolder = ((await workspace.fs.stat(candidate)).type & FileType.Directory) === FileType.Directory;
		const base = isFolder ? name : this.getNameWithoutExtension(name);
		const extension = isFolder ? '' : name.substring(base.length);
		for (let index = 1; ; index++) {
			const suffix = index === 1 ? ' copy' : ` copy ${index}`;
			candidate = Uri.joinPath(folder, `${base}${suffix}${extension}`);
			if (!(await this.exists(candidate))) {
				return candidate;
			}
		}
	}

	/**
	 * `route.camel.yaml` -> `route`, `pom.xml` -> `pom`, `.kaoto` -> `.kaoto`
	 */
	private getNameWithoutExtension(name: string): string {
		if (name.startsWith('.') && name.indexOf('.', 1) === -1) {
			return name;
		}
		const camelSuffix = /\.(camel|kamelet|pipe|citrus)(\.(test|it))?\.(yaml|yml|xml)$/.exec(name);
		if (camelSuffix) {
			return name.substring(0, camelSuffix.index);
		}
		const extension = extname(name);
		return extension ? name.substring(0, name.length - extension.length) : name;
	}

	private async exists(uri: Uri): Promise<boolean> {
		try {
			await workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private isSameUri(a: Uri, b: Uri): boolean {
		return a.toString() === b.toString();
	}

	/**
	 * Check if `parent` is `child` or one of its parent folders
	 */
	private isSameOrParent(parent: Uri, child: Uri): boolean {
		const parentPath = parent.toString();
		const childPath = child.toString();
		return childPath === parentPath || childPath.startsWith(parentPath + '/');
	}
}
