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

/**
 * Minimal glob support for matching workspace relative paths, following the VS Code glob syntax
 * used by `files.exclude` and `search.exclude`:
 * - `*` matches any characters inside one path segment
 * - `?` matches one character inside one path segment
 * - `**` matches any number of path segments, including none
 * - `{a,b}` matches any of the alternatives (alternatives may contain globs and nested groups)
 * - `[abc]` / `[a-z]` / `[!abc]` match one character from (or outside) the range
 *
 * Paths always use `/` as separator. A pattern without a leading `**` is anchored to the root.
 */
export function globToRegExp(glob: string): RegExp {
	let pattern = glob.trim().replaceAll('\\', '/');
	if (pattern.startsWith('/')) {
		pattern = pattern.substring(1);
	}
	if (pattern.endsWith('/')) {
		pattern = pattern.substring(0, pattern.length - 1);
	}
	return new RegExp(`^${translate(pattern)}$`);
}

function translate(pattern: string): string {
	let result = '';
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				const atSegmentStart = i === 0 || pattern[i - 1] === '/';
				const followedBySlash = pattern[i + 2] === '/';
				if (atSegmentStart && followedBySlash) {
					// "**/" matches zero or more leading segments
					result += '(?:[^/]*/)*';
					i += 3;
					continue;
				}
				result += '.*';
				i += 2;
				continue;
			}
			result += '[^/]*';
			i++;
		} else if (char === '?') {
			result += '[^/]';
			i++;
		} else if (char === '{') {
			const end = findClosingBrace(pattern, i);
			if (end === -1) {
				result += '\\{';
				i++;
				continue;
			}
			const alternatives = splitAlternatives(pattern.substring(i + 1, end));
			result += `(?:${alternatives.map((alternative) => translate(alternative)).join('|')})`;
			i = end + 1;
		} else if (char === '[') {
			const end = pattern.indexOf(']', i + 1);
			if (end === -1) {
				result += '\\[';
				i++;
				continue;
			}
			let range = pattern.substring(i + 1, end);
			if (range.startsWith('!')) {
				range = '^' + range.substring(1);
			}
			result += `[${range.replaceAll('\\', '\\\\')}]`;
			i = end + 1;
		} else {
			result += escapeRegExp(char);
			i++;
		}
	}
	return result;
}

function findClosingBrace(pattern: string, start: number): number {
	let depth = 0;
	for (let i = start; i < pattern.length; i++) {
		if (pattern[i] === '{') {
			depth++;
		} else if (pattern[i] === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function splitAlternatives(group: string): string[] {
	const alternatives: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of group) {
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
		} else if (char === ',' && depth === 0) {
			alternatives.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	alternatives.push(current);
	return alternatives;
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.+^$()|\\]/g, String.raw`\$&`);
}

/**
 * Matches workspace relative paths against a set of exclude globs.
 * A path is excluded when the path itself or any of its parent folders matches one of the globs,
 * which is how VS Code applies `files.exclude` to folders.
 */
export class GlobExcludeMatcher {
	private readonly regExps: RegExp[];

	constructor(globs: readonly string[]) {
		this.regExps = globs.filter((glob) => glob.trim().length > 0).map((glob) => globToRegExp(glob));
	}

	get isEmpty(): boolean {
		return this.regExps.length === 0;
	}

	/**
	 * @param relativePath path relative to the workspace folder, using `/` as separator
	 */
	isExcluded(relativePath: string): boolean {
		if (this.regExps.length === 0 || relativePath.length === 0) {
			return false;
		}
		const segments = relativePath.split('/');
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (this.regExps.some((regExp) => regExp.test(current))) {
				return true;
			}
		}
		return false;
	}
}

/**
 * Returns the globs of a `files.exclude` like setting whose value is `true`.
 * Conditional entries (`{ "when": ... }`) are not supported and are ignored.
 */
export function enabledGlobs(excludeSetting: Record<string, unknown> | undefined): string[] {
	if (!excludeSetting) {
		return [];
	}
	return Object.entries(excludeSetting)
		.filter(([, enabled]) => enabled === true)
		.map(([glob]) => glob);
}
