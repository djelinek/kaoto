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
import { enabledGlobs, GlobExcludeMatcher, globToRegExp } from '../../utils/Glob';

suite('Glob', () => {
	suite('globToRegExp', () => {
		test('* matches inside one path segment', () => {
			const regExp = globToRegExp('*.camel.yaml');
			assert.isTrue(regExp.test('route.camel.yaml'));
			assert.isFalse(regExp.test('folder/route.camel.yaml'));
			assert.isFalse(regExp.test('route.camel.yml'));
		});

		test('**/ matches any number of folders, including none', () => {
			const regExp = globToRegExp('**/node_modules');
			assert.isTrue(regExp.test('node_modules'));
			assert.isTrue(regExp.test('a/b/node_modules'));
			assert.isFalse(regExp.test('a/node_modules_backup'));
		});

		test('a pattern without ** is anchored to the workspace folder', () => {
			const regExp = globToRegExp('target');
			assert.isTrue(regExp.test('target'));
			assert.isFalse(regExp.test('module/target'));
		});

		test('trailing ** matches everything below a folder', () => {
			const regExp = globToRegExp('**/dist/**');
			assert.isTrue(regExp.test('dist/main.js'));
			assert.isTrue(regExp.test('a/dist/b/c.js'));
		});

		test('braces, nested braces and character ranges', () => {
			assert.isTrue(globToRegExp('**/*.{xsd,{yaml,yml}}').test('a/b.yml'));
			assert.isTrue(globToRegExp('**/*.{xsd,{yaml,yml}}').test('b.xsd'));
			assert.isFalse(globToRegExp('**/*.{xsd,{yaml,yml}}').test('b.json'));
			assert.isTrue(globToRegExp('file[0-9].txt').test('file7.txt'));
			assert.isFalse(globToRegExp('file[!0-9].txt').test('file7.txt'));
			assert.isTrue(globToRegExp('file?.txt').test('file1.txt'));
		});

		test('regular expression characters are matched literally', () => {
			const regExp = globToRegExp('application+(dev).properties');
			assert.isTrue(regExp.test('application+(dev).properties'));
			assert.isFalse(regExp.test('applicationXdev).properties'));
		});

		test('dot files are matched like other files', () => {
			assert.isTrue(globToRegExp('.kaoto').test('.kaoto'));
			assert.isTrue(globToRegExp('**/.kaoto').test('a/.kaoto'));
		});
	});

	suite('GlobExcludeMatcher', () => {
		test('excludes a path when one of its folders matches', () => {
			const matcher = new GlobExcludeMatcher(['**/.git', 'build']);
			assert.isTrue(matcher.isExcluded('.git'));
			assert.isTrue(matcher.isExcluded('.git/config'));
			assert.isTrue(matcher.isExcluded('module/.git/HEAD'));
			assert.isTrue(matcher.isExcluded('build/out.jar'));
			assert.isFalse(matcher.isExcluded('module/build/out.jar'));
			assert.isFalse(matcher.isExcluded('src/route.camel.yaml'));
		});

		test('an empty matcher excludes nothing', () => {
			const matcher = new GlobExcludeMatcher(['', '  ']);
			assert.isTrue(matcher.isEmpty);
			assert.isFalse(matcher.isExcluded('anything'));
		});
	});

	test('enabledGlobs keeps only the globs set to true', () => {
		assert.deepEqual(enabledGlobs({ '**/.git': true, '**/.DS_Store': false, '**/*.js': { when: '$(basename).ts' } }), ['**/.git']);
		assert.deepEqual(enabledGlobs(undefined), []);
	});
});
