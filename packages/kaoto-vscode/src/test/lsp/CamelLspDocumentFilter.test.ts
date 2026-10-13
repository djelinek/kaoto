import { expect } from 'chai';
import { CAMEL_LSP_DOCUMENT_SELECTORS, CAMEL_LSP_FILE_WATCHER_GLOBS } from '../../lsp/CamelLspDocumentFilter';

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
});
