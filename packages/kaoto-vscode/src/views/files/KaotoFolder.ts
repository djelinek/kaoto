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
import { ThemeIcon, Uri } from 'vscode';
import { Folder } from '../integrations/Folder';

export type KaotoFolderContent = {
	/** the folder contains Camel files, so it can be run or exported */
	hasCamelFiles: boolean;
	/** the folder contains test files, so its tests can be run */
	hasTestFiles: boolean;
};

/**
 * Folder item of the Kaoto Files view.
 * It keeps the Integrations view folder behavior (Maven root detection, run and export actions) and uses
 * the folder icon of the user's file icon theme like the native Explorer does, also for Maven and workspace roots.
 *
 * The context value is `<folder context>;camel;tests`, where the `camel` and `tests` flags are only present
 * when the folder contains such files, for example `folder;camel` or `folder-maven-root;tests`.
 */
export class KaotoFolder extends Folder {
	constructor(labelName: string, folderUri: Uri, isUnderMavenRoot: boolean, isMavenRoot: boolean, isWorkspaceRoot: boolean, content: KaotoFolderContent) {
		super(labelName, folderUri, undefined, isUnderMavenRoot, isMavenRoot, isWorkspaceRoot);
		this.id = folderUri.toString();
		// the file icon theme decides, so folders take the same space as in the native Explorer (no icon with Seti)
		this.iconPath = ThemeIcon.Folder;
		if (isMavenRoot) {
			this.description = 'Maven project';
			this.tooltip = `Maven project (pom.xml)\n${folderUri.fsPath}`;
		}
		const flags = [content.hasCamelFiles ? 'camel' : undefined, content.hasTestFiles ? 'tests' : undefined].filter(Boolean);
		this.contextValue = [this.contextValue, ...flags].join(';');
	}
}
