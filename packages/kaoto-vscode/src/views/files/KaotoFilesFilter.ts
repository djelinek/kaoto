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
import { workspace } from 'vscode';
import {
	DEFAULT_KAOTO_OPENAPI_FILES_REGEXP,
	KAOTO_INTEGRATIONS_FILES_REGEXP_SETTING_ID,
	KAOTO_OPENAPI_FILES_REGEXP_SETTING_ID,
	KAOTO_TESTS_FILES_REGEXP_SETTING_ID,
} from '../../constants';
import { globToRegExp } from '../../utils/Glob';

export type KaotoFilesFilter = 'all' | 'camel' | 'tests' | 'openapi';

export type KaotoFilesFilterDefinition = {
	/** label shown as the view description when the filter is active */
	label: string;
	/** setting holding the file name globs of the filter, undefined for 'all' */
	settingId?: string;
	/** used when the setting has no value */
	defaultGlobs: string[];
};

export const KAOTO_FILES_FILTERS: Record<KaotoFilesFilter, KaotoFilesFilterDefinition> = {
	all: { label: 'All files', defaultGlobs: [] },
	camel: {
		label: 'Camel files',
		settingId: KAOTO_INTEGRATIONS_FILES_REGEXP_SETTING_ID,
		defaultGlobs: [
			'*.camel.yaml',
			'*.camel.xml',
			'*.kamelet.yaml',
			'*.pipe.yaml',
			'*-pipe.yaml',
			'application*.properties',
			'*.xsl',
			'*.xslt',
			'*.xsd',
			'.kaoto',
			'pom.xml',
		],
	},
	tests: {
		label: 'Test files',
		settingId: KAOTO_TESTS_FILES_REGEXP_SETTING_ID,
		defaultGlobs: [
			'*.citrus.yaml',
			'*.citrus.test.yaml',
			'*.citrus.it.yaml',
			'*.citrus-test.yaml',
			'*.citrus-it.yaml',
			'jbang.properties',
			'citrus*.properties',
		],
	},
	openapi: {
		label: 'OpenAPI files',
		settingId: KAOTO_OPENAPI_FILES_REGEXP_SETTING_ID,
		defaultGlobs: DEFAULT_KAOTO_OPENAPI_FILES_REGEXP,
	},
};

/** Test files which can be run (the properties files listed by the tests filter are only supporting files) */
const RUNNABLE_TEST_FILE = /\.citrus(\.test|\.it|-test|-it)?\.yaml$/;

export function isKaotoFilesFilter(value: unknown): value is KaotoFilesFilter {
	return typeof value === 'string' && Object.keys(KAOTO_FILES_FILTERS).includes(value);
}

/**
 * Get the file name globs of a filter, as configured by the user
 */
export function getFilterGlobs(filter: KaotoFilesFilter): string[] {
	const definition = KAOTO_FILES_FILTERS[filter];
	if (!definition.settingId) {
		return [];
	}
	const configured = workspace.getConfiguration().get<string[]>(definition.settingId);
	return configured && configured.length > 0 ? configured : definition.defaultGlobs;
}

/**
 * Get the workspace search pattern of a filter, for example `{**\/*.camel.yaml,**\/pom.xml}`
 */
export function getFilterSearchPattern(filter: KaotoFilesFilter): string {
	return (
		'{' +
		getFilterGlobs(filter)
			.map((glob) => '**/' + glob)
			.join(',') +
		'}'
	);
}

/**
 * Matches file names against the globs of the Camel, Tests and OpenAPI filters.
 */
export class KaotoFileNameMatcher {
	private readonly regExps = new Map<KaotoFilesFilter, RegExp[]>();

	constructor() {
		this.reload();
	}

	reload(): void {
		this.regExps.clear();
		for (const filter of ['camel', 'tests', 'openapi'] as KaotoFilesFilter[]) {
			this.regExps.set(
				filter,
				getFilterGlobs(filter).map((glob) => globToRegExp(glob)),
			);
		}
	}

	matches(filter: KaotoFilesFilter, fileName: string): boolean {
		if (filter === 'all') {
			return true;
		}
		return (this.regExps.get(filter) ?? []).some((regExp) => regExp.test(fileName));
	}

	isRunnableTest(fileName: string): boolean {
		return RUNNABLE_TEST_FILE.test(fileName) && this.matches('tests', fileName);
	}
}
