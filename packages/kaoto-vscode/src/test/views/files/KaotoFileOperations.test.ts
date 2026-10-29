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
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KaotoFileOperations } from '../../../views/files/KaotoFileOperations';

suite('KaotoFileOperations', () => {
	let tmpDir: vscode.Uri;
	const operations = new KaotoFileOperations();

	const write = async (relativePath: string, content = '') => {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(tmpDir, relativePath), new TextEncoder().encode(content));
	};

	const exists = async (relativePath: string) => {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(tmpDir, relativePath));
			return true;
		} catch {
			return false;
		}
	};

	setup(async () => {
		tmpDir = vscode.Uri.file(path.join(os.tmpdir(), `kaoto-file-operations-${Math.random().toString(36).slice(2)}`));
		await vscode.workspace.fs.createDirectory(tmpDir);
	});

	teardown(async () => {
		await operations.setClipboard([], false);
		try {
			await vscode.workspace.fs.delete(tmpDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	suite('validateName', () => {
		test('accepts a new name, including nested paths', async () => {
			assert.isUndefined(await operations.validateName(tmpDir, 'route.camel.yaml'));
			assert.isUndefined(await operations.validateName(tmpDir, 'src/main/route.camel.yaml'));
		});

		test('rejects empty, relative and invalid names', async () => {
			assert.isDefined(await operations.validateName(tmpDir, '  '));
			assert.isDefined(await operations.validateName(tmpDir, '../outside.txt'));
			assert.isDefined(await operations.validateName(tmpDir, 'bad:name.txt'));
		});

		test('rejects the name of an existing file', async () => {
			await write('existing.txt');
			assert.include(await operations.validateName(tmpDir, 'existing.txt'), 'already exists');
		});
	});

	suite('copy', () => {
		test('copies into another folder', async () => {
			await write('a.txt', 'a');
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(tmpDir, 'target'));
			await operations.copy([vscode.Uri.joinPath(tmpDir, 'a.txt')], vscode.Uri.joinPath(tmpDir, 'target'));
			assert.isTrue(await exists('target/a.txt'));
			assert.isTrue(await exists('a.txt'));
		});

		test('adds a copy suffix when the name is taken, keeping the Camel extension', async () => {
			await write('route.camel.yaml', 'x');
			await operations.copy([vscode.Uri.joinPath(tmpDir, 'route.camel.yaml')], tmpDir);
			await operations.copy([vscode.Uri.joinPath(tmpDir, 'route.camel.yaml')], tmpDir);
			assert.isTrue(await exists('route copy.camel.yaml'));
			assert.isTrue(await exists('route copy 2.camel.yaml'));
		});
	});

	suite('move and paste', () => {
		test('moves files into a folder', async () => {
			await write('a.txt', 'a');
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(tmpDir, 'target'));
			await operations.move([vscode.Uri.joinPath(tmpDir, 'a.txt')], vscode.Uri.joinPath(tmpDir, 'target'));
			assert.isTrue(await exists('target/a.txt'));
			assert.isFalse(await exists('a.txt'));
		});

		test('does not move a folder into itself', async () => {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(tmpDir, 'folder', 'child'));
			await operations.move([vscode.Uri.joinPath(tmpDir, 'folder')], vscode.Uri.joinPath(tmpDir, 'folder', 'child'));
			assert.isTrue(await exists('folder/child'));
		});

		test('cut and paste moves, copy and paste copies', async () => {
			await write('cut.txt');
			await write('copied.txt');
			const target = vscode.Uri.joinPath(tmpDir, 'target');
			await vscode.workspace.fs.createDirectory(target);

			await operations.setClipboard([vscode.Uri.joinPath(tmpDir, 'cut.txt')], true);
			await operations.paste(target);
			assert.isTrue(await exists('target/cut.txt'));
			assert.isFalse(await exists('cut.txt'));

			await operations.setClipboard([vscode.Uri.joinPath(tmpDir, 'copied.txt')], false);
			await operations.paste(target);
			assert.isTrue(await exists('target/copied.txt'));
			assert.isTrue(await exists('copied.txt'));
		});
	});
});
