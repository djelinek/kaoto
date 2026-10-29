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
import { expect } from 'chai';
import * as vscode from 'vscode';
import {
	CAMEL_LSP_DOCUMENT_SELECTORS,
	CAMEL_LSP_FILE_WATCHER_GLOBS,
	CAMEL_LSP_START_SELECTORS,
	isCamelLspStartDocument,
} from '../../lsp/CamelLspDocumentFilter';

suite('CamelLspDocumentFilter', () => {
	test('should define document selectors for Camel YAML files', () => {
		const yamlSelectors = CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language === 'yaml');
		expect(yamlSelectors.length).to.be.greaterThan(0);

		const patterns = yamlSelectors.map((s) => s.pattern);
		expect(patterns).to.include('**/*.camel.{yaml,yml}');
		expect(patterns).to.include('**/*.kamelet.{yaml,yml}');
		expect(patterns).to.include('**/*.pipe.{yaml,yml}');
		expect(patterns).to.include('**/*-pipe.{yaml,yml}');
	});

	test('should define document selectors for Camel XML files', () => {
		const xmlSelectors = CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language === 'xml');
		expect(xmlSelectors.length).to.be.greaterThan(0);

		const patterns = xmlSelectors.map((s) => s.pattern);
		expect(patterns).to.include('**/*.camel.xml');
	});

	test('should define document selectors for properties files', () => {
		const propsSelectors = CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language === 'properties');
		expect(propsSelectors.length).to.be.greaterThan(0);

		const patterns = propsSelectors.map((s) => s.pattern);
		expect(patterns).to.include('**/application*.properties');
	});

	test('should define file watcher globs matching Kaoto file patterns', () => {
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.be.an('array');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.camel.yaml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.camel.yml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.camel.xml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.kamelet.yaml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.kamelet.yml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.pipe.yaml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*.pipe.yml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*-pipe.yaml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/*-pipe.yml');
		expect(CAMEL_LSP_FILE_WATCHER_GLOBS).to.include('**/application*.properties');
	});

	test('should NOT include broad yaml/xml selectors (non-Camel files)', () => {
		const broadYaml = CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language === 'yaml' && (!s.pattern || s.pattern === '**/*.yaml'));
		expect(broadYaml.length).to.equal(0);

		const broadXml = CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language === 'xml' && (!s.pattern || s.pattern === '**/*.xml'));
		expect(broadXml.length).to.equal(0);
	});

	test('should start the server for all the Camel selectors except the application properties', () => {
		expect(CAMEL_LSP_START_SELECTORS.map((s) => s.pattern)).to.deep.equal(
			CAMEL_LSP_DOCUMENT_SELECTORS.filter((s) => s.language !== 'properties').map((s) => s.pattern),
		);
	});

	suite('isCamelLspStartDocument', () => {
		const openFixtureDocument = (...pathSegments: string[]): Thenable<vscode.TextDocument> => {
			const fixtureFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!fixtureFolder) {
				throw new Error('No workspace folder available for testing');
			}
			return vscode.workspace.openTextDocument(vscode.Uri.joinPath(fixtureFolder, ...pathSegments));
		};

		test('should start the server for a Camel route', async () => {
			const route = await openFixtureDocument('suggestions', 'route.camel.yaml');

			expect(isCamelLspStartDocument(route)).to.be.true;
		});

		test('should not start the server for application properties, which the running server serves', async () => {
			const properties = await openFixtureDocument('suggestions', 'application.properties');

			expect(isCamelLspStartDocument(properties)).to.be.false;
			expect(vscode.languages.match(CAMEL_LSP_DOCUMENT_SELECTORS, properties)).to.be.greaterThan(0);
		});

		test('should not start the server for other XML files', async () => {
			const pom = await openFixtureDocument('camel-maven-main-project', 'pom.xml');

			expect(isCamelLspStartDocument(pom)).to.be.false;
		});
	});
});
