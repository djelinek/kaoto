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
import { CamelLspConfigurationSync } from '../../lsp/CamelLspConfigurationSync';

suite('CamelLspConfigurationSync', () => {
	suite('mapRuntimeToLspProvider', () => {
		test('should map "Main" to "DEFAULT"', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('Main')).to.equal('DEFAULT');
		});

		test('should map "Quarkus" to "QUARKUS"', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('Quarkus')).to.equal('QUARKUS');
		});

		test('should map "Spring Boot" to "SPRINGBOOT"', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('Spring Boot')).to.equal('SPRINGBOOT');
		});

		test('should default to "DEFAULT" for unknown runtimes', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('Unknown')).to.equal('DEFAULT');
		});

		test('should handle case-insensitive "quarkus"', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('quarkus')).to.equal('QUARKUS');
		});

		test('should handle case-insensitive "spring boot"', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('spring boot')).to.equal('SPRINGBOOT');
		});

		test('should handle "Camel Main" as DEFAULT', () => {
			expect(CamelLspConfigurationSync.mapRuntimeToLspProvider('Camel Main')).to.equal('DEFAULT');
		});
	});

	suite('buildCamelSettingsFromCatalog', () => {
		test('should send plain version and runtime provider for Main catalog', () => {
			const catalog = {
				name: 'Camel Main 4.22.1',
				version: '4.22.1',
				runtime: 'Main',
				fileName: 'camel-main/4.22.1/index.json',
				camelCatalogVersion: '4.22.1',
				executorVersion: '4.22.1',
				runtimeProviderVersion: '',
				frameworkVersion: '',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			expect(settings).to.have.property('camel');

			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.equal('4.22.1');
			expect(camelSettings['Camel catalog runtime provider']).to.equal('DEFAULT');
		});

		test('should use camelCatalogVersion (Camel version) for Quarkus, not Quarkus version', () => {
			const catalog = {
				name: 'Camel Quarkus 3.35.0',
				version: '3.35.0',
				runtime: 'Quarkus',
				fileName: 'camel-quarkus/3.35.0/index.json',
				camelCatalogVersion: '4.14.7',
				executorVersion: '4.14.7',
				runtimeProviderVersion: '3.35.0',
				frameworkVersion: '3.35.2',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.equal('4.14.7');
			expect(camelSettings['Camel catalog runtime provider']).to.equal('QUARKUS');
			expect(camelSettings['Camel catalog runtime provider version']).to.equal('3.35.0');
		});

		test('should send the Camel Spring Boot version as runtime provider version', () => {
			const catalog = {
				name: 'Camel Spring Boot 4.18.3.redhat-00006',
				version: '4.18.3.redhat-00006',
				runtime: 'Spring Boot',
				fileName: 'camel-springboot/4.18.3.redhat-00006/index.json',
				camelCatalogVersion: '4.18.3.redhat-00005',
				executorVersion: '4.18.3.redhat-00005',
				runtimeProviderVersion: '4.18.3.redhat-00006',
				frameworkVersion: '3.5.11',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.equal('4.18.3.redhat-00005');
			expect(camelSettings['Camel catalog runtime provider']).to.equal('SPRINGBOOT');
			expect(camelSettings['Camel catalog runtime provider version']).to.equal('4.18.3.redhat-00006');
		});

		test('should not send a runtime provider version for Main catalog', () => {
			const catalog = {
				name: 'Camel Main 4.22.1',
				version: '4.22.1',
				runtime: 'Main',
				fileName: 'camel-main/4.22.1/index.json',
				camelCatalogVersion: '4.22.1',
				runtimeProviderVersion: '4.22.1',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings).to.not.have.property('Camel catalog runtime provider version');
		});

		test('should not send Citrus catalog to the Camel LSP', () => {
			const catalog = {
				name: 'Citrus 4.10.1',
				version: '4.10.1',
				runtime: 'Citrus',
				fileName: 'citrus/4.10.1/index.json',
				camelCatalogVersion: '4.10.1',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			expect(settings['camel']).to.deep.equal({});
		});

		test('should fall back to version when camelCatalogVersion is empty', () => {
			const catalog = {
				name: 'Camel Main 4.22.1',
				version: '4.22.1',
				runtime: 'Main',
				fileName: 'camel-main/4.22.1/index.json',
				camelCatalogVersion: '',
				executorVersion: '4.22.1',
				runtimeProviderVersion: '',
				frameworkVersion: '',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.equal('4.22.1');
		});

		test('should handle RedHat versioned catalog', () => {
			const catalog = {
				name: 'Camel Main 4.18.1.redhat-00019',
				version: '4.18.1.redhat-00019',
				runtime: 'Main',
				fileName: 'camel-main/4.18.1.redhat-00019/index.json',
				camelCatalogVersion: '4.18.1.redhat-00019',
				executorVersion: '4.18.1.redhat-00016',
				runtimeProviderVersion: '',
				frameworkVersion: '',
			};

			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(catalog);
			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.equal('4.18.1.redhat-00019');
			expect(camelSettings['Camel catalog runtime provider']).to.equal('DEFAULT');
		});

		test('should return empty camel settings for undefined catalog', () => {
			const settings = CamelLspConfigurationSync.buildCamelSettingsFromCatalog(undefined);
			expect(settings).to.have.property('camel');

			const camelSettings = settings['camel'] as Record<string, unknown>;
			expect(camelSettings['Camel catalog version']).to.be.undefined;
			expect(camelSettings['Camel catalog runtime provider']).to.be.undefined;
		});
	});
});
