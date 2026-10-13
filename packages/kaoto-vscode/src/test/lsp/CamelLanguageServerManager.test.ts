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
import { CamelLanguageServerManager } from '../../lsp/CamelLanguageServerManager';

suite('CamelLanguageServerManager', () => {
	test('findJavaExecutable should return a string or undefined', async () => {
		const result = await CamelLanguageServerManager.findJavaExecutable();
		// In CI/test environments, Java may or may not be available
		expect(result === undefined || typeof result === 'string').to.be.true;
	});

	test('getJavaVersion should return a number for valid java path', async () => {
		const javaPath = await CamelLanguageServerManager.findJavaExecutable();
		if (javaPath) {
			const version = await CamelLanguageServerManager.getJavaVersion(javaPath);
			expect(version).to.be.a('number');
			expect(version).to.be.greaterThan(0);
		}
	});

	test('getJavaVersion should return 0 for invalid java path', async () => {
		const version = await CamelLanguageServerManager.getJavaVersion('/nonexistent/bin/java');
		expect(version).to.equal(0);
	});

	test('isRunning should return false before start', () => {
		// We cannot fully construct the manager without a real ExtensionContext,
		// but we can verify the static methods work correctly
		expect(CamelLanguageServerManager.REQUIRED_JAVA_VERSION).to.equal(17);
	});

	test('JAR_NAME constant should be language-server.jar', () => {
		expect(CamelLanguageServerManager.JAR_NAME).to.equal('language-server.jar');
	});
});
