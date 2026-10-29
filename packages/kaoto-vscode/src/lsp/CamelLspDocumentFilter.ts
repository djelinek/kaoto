import * as vscode from 'vscode';
import { DocumentFilter } from 'vscode-languageclient';

/**
 * Document selectors for Camel-specific files.
 * The LSP client will activate only for files matching these patterns.
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
] satisfies DocumentFilter[];

/**
 * The selectors of the files which start the LSP server when they are opened. Application properties files
 * are not specific to Camel: they are served once the server runs, but they don't start it.
 */
export const CAMEL_LSP_START_SELECTORS = CAMEL_LSP_DOCUMENT_SELECTORS.filter((selector) => selector.language !== 'properties');

export function isCamelLspStartDocument(document: vscode.TextDocument): boolean {
	return vscode.languages.match(CAMEL_LSP_START_SELECTORS, document) > 0;
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
