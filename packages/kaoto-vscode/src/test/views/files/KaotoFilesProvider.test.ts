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
import { assert } from 'chai';
import * as vscode from 'vscode';
import { KaotoFilesProvider } from '../../../views/files/KaotoFilesProvider';
import { KaotoFolder } from '../../../views/files/KaotoFolder';
import { Integration } from '../../../views/integrations/Integration';
import { File } from '../../../views/integrations/File';
import { Test } from '../../../views/tests/Test';
import { OpenApiFile } from '../../../views/openapi/OpenApiFile';
import { KAOTO_FILES_EXCLUDE_SETTING_ID } from '../../../constants';

const ROUTE = `- route:
    id: route-1
    from:
      uri: timer:tick
      steps:
        - log:
            message: hello
`;

const OPENAPI = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: OK
`;

suite('KaotoFilesProvider', () => {
	let root: vscode.Uri;
	let provider: KaotoFilesProvider | undefined;

	const write = async (relativePath: string, content = '') => {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, relativePath), new TextEncoder().encode(content));
	};

	const label = (item: vscode.TreeItem) => (typeof item.label === 'string' ? item.label : (item.label?.label ?? ''));

	/** list the children of the test folder, opening the tree from the workspace root like VS Code does */
	const listTestFolder = async (current: KaotoFilesProvider, relativePath = ''): Promise<vscode.TreeItem[]> => {
		let children = await current.getChildren();
		const segments = [root.path.split('/').pop()!, ...relativePath.split('/').filter(Boolean)];
		for (const segment of segments) {
			const folder = children.find((item) => item instanceof KaotoFolder && label(item) === segment);
			assert.isDefined(folder, `folder '${segment}' should be listed, found: ${children.map(label).join(', ')}`);
			children = await current.getChildren(folder);
		}
		return children;
	};

	setup(async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders![0].uri;
		root = vscode.Uri.joinPath(workspaceFolder, `kaoto-files-${Math.random().toString(36).slice(2)}`);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'tests'));
		await write('my.camel.yaml', ROUTE);
		await write('schema.xsd', '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>');
		await write('message.json', '{}');
		await write('notes.txt', 'notes');
		await write('pets-openapi.yaml', OPENAPI);
		await write('tests/my.citrus.yaml', 'name: test');
	});

	teardown(async () => {
		provider?.dispose();
		provider = undefined;
		await vscode.workspace.getConfiguration().update(KAOTO_FILES_EXCLUDE_SETTING_ID, undefined, vscode.ConfigurationTarget.Workspace);
		await vscode.workspace.fs.delete(root, { recursive: true });
	});

	test('the all filter lists every file with Kaoto items for Kaoto files', async () => {
		provider = new KaotoFilesProvider('', 'all');
		const children = await listTestFolder(provider);

		assert.deepEqual(children.map(label), ['tests', 'message.json', 'my.camel.yaml', 'notes.txt', 'pets-openapi.yaml', 'schema.xsd']);
		assert.instanceOf(children[0], KaotoFolder);
		assert.instanceOf(
			children.find((item) => label(item) === 'my.camel.yaml'),
			Integration,
		);
		assert.instanceOf(
			children.find((item) => label(item) === 'pets-openapi.yaml'),
			OpenApiFile,
		);
		assert.instanceOf(
			children.find((item) => label(item) === 'notes.txt'),
			File,
		);
	});

	test('folders are flagged by the Kaoto files they contain', async () => {
		provider = new KaotoFilesProvider('', 'all');
		const children = await listTestFolder(provider);
		const testsFolder = children.find((item) => label(item) === 'tests')!;
		assert.strictEqual(testsFolder.contextValue, 'folder;tests');
	});

	test('the camel filter lists Camel files and their supporting files only', async () => {
		provider = new KaotoFilesProvider('', 'camel');
		const children = await listTestFolder(provider);
		assert.deepEqual(children.map(label), ['my.camel.yaml', 'schema.xsd']);
	});

	test('the tests filter lists test files with their run state', async () => {
		provider = new KaotoFilesProvider('', 'tests');
		const children = await listTestFolder(provider, 'tests');
		assert.deepEqual(children.map(label), ['my.citrus.yaml']);
		assert.instanceOf(children[0], Test);
	});

	test('the openapi filter only lists valid OpenAPI documents', async () => {
		await write('broken-openapi.yaml', 'not: openapi');
		provider = new KaotoFilesProvider('', 'openapi');
		const children = await listTestFolder(provider);
		assert.deepEqual(children.map(label), ['pets-openapi.yaml']);
		assert.strictEqual((children[0] as OpenApiFile).version, '3.0.3');
	});

	test('changing the filter changes the listed files', async () => {
		provider = new KaotoFilesProvider('', 'camel');
		assert.lengthOf(await listTestFolder(provider), 2);
		provider.setFilter('all');
		assert.strictEqual(provider.currentFilter, 'all');
		assert.lengthOf(await listTestFolder(provider), 6);
	});

	test('kaoto.files.exclude hides files in every filter', async () => {
		await vscode.workspace.getConfiguration().update(KAOTO_FILES_EXCLUDE_SETTING_ID, ['**/*.txt', '**/*.xsd'], vscode.ConfigurationTarget.Workspace);
		provider = new KaotoFilesProvider('', 'all');
		const all = await listTestFolder(provider);
		assert.notInclude(all.map(label), 'notes.txt');
		assert.notInclude(all.map(label), 'schema.xsd');

		provider.setFilter('camel');
		assert.deepEqual((await listTestFolder(provider)).map(label), ['my.camel.yaml']);
	});

	test('routes of a Camel file are listed under it and know their parent', async () => {
		provider = new KaotoFilesProvider('', 'all');
		const integration = (await listTestFolder(provider)).find((item) => item instanceof Integration)!;
		const routes = await provider.getChildren(integration);
		assert.deepEqual(routes.map(label), ['route-1']);
		assert.strictEqual(await provider.getParent(routes[0]), integration);
	});

	test('a file can be found for reveal, and its parent is its folder', async () => {
		provider = new KaotoFilesProvider('', 'all');
		const fileUri = vscode.Uri.joinPath(root, 'tests', 'my.citrus.yaml');
		const item = await provider.getItemForFile(fileUri);
		assert.instanceOf(item, Test);
		const parent = await provider.getParent(item!);
		assert.instanceOf(parent, KaotoFolder);
		assert.strictEqual((parent as KaotoFolder).folderUri.toString(), vscode.Uri.joinPath(root, 'tests').toString());
	});

	test('a file hidden by the current filter is not found for reveal', async () => {
		provider = new KaotoFilesProvider('', 'camel');
		assert.isUndefined(await provider.getItemForFile(vscode.Uri.joinPath(root, 'notes.txt')));
	});
});
