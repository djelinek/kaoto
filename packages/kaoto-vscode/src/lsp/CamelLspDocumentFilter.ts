import * as vscode from 'vscode';
import { DocumentFilter } from 'vscode-languageclient';

/**
 * Document selectors for Camel-specific files.
 * The LSP client will activate only for files matching these patterns.
 * The application properties files are also matched with the language ids that the Quarkus and Spring Boot
 * extensions give them.
 */
// `satisfies` (rather than a `: DocumentFilter[]` annotation) validates each entry against the
// `DocumentFilter` union while keeping the narrower inferred element type (`{ language, pattern }`)
// so consumers (and this module's tests) can rely on `pattern` always being present.
export const CAMEL_LSP_DOCUMENT_SELECTORS = [
	{ language: 'yaml', pattern: '**/*.camel.{yaml,yml}' },
	{ language: 'yaml', pattern: '**/*.kamelet.{yaml,yml}' },
	{ language: 'yaml', pattern: '**/*.pipe.{yaml,yml}' },
	{ language: 'yaml', pattern: '**/*-pipe.{yaml,yml}' },
	{ language: 'xml', pattern: '**/*.camel.xml' },
	{ language: 'properties', pattern: '**/application*.properties' },
	{ language: 'quarkus-properties', pattern: '**/application*.properties' },
	{ language: 'spring-boot-properties', pattern: '**/application*.properties' },
] satisfies DocumentFilter[];

/**
 * @returns whether the LSP serves the document; the LSP server is started when the first one is opened
 */
export function isCamelLspDocument(document: vscode.TextDocument): boolean {
	return vscode.languages.match(CAMEL_LSP_DOCUMENT_SELECTORS, document) > 0;
}

/**
 * File watcher glob patterns for Camel-specific files.
 * The LSP server is notified when files matching these globs change on disk.
 */
export const CAMEL_LSP_FILE_WATCHER_GLOBS: string[] = [
	'**/*.camel.yaml',
	'**/*.camel.yml',
	'**/*.camel.xml',
	'**/*.kamelet.yaml',
	'**/*.kamelet.yml',
	'**/*.pipe.yaml',
	'**/*.pipe.yml',
	'**/*-pipe.yaml',
	'**/*-pipe.yml',
	'**/application*.properties',
];
