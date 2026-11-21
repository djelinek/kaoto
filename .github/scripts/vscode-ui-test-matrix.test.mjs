import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildMatrix } from './vscode-ui-test-matrix.mjs';

const ciTestGroups = {
  all: ['editor', 'views', 'deploy'],
  smoke: ['editor'],
  linuxOnly: ['deploy'],
  withoutJBang: ['editor'],
};

test('a run that is not full gets the smoke groups', () => {
  assert.deepEqual(buildMatrix(ciTestGroups, { full: false, allOs: false }).include, [
    { group: 'editor', os: 'windows-latest', jbang: false },
  ]);
});

test('a full run gets every group, and the Linux-only ones on Linux', () => {
  assert.deepEqual(buildMatrix(ciTestGroups, { full: true, allOs: false }).include, [
    { group: 'editor', os: 'windows-latest', jbang: false },
    { group: 'views', os: 'windows-latest', jbang: true },
    { group: 'deploy', os: 'ubuntu-latest', jbang: true },
  ]);
});

test('a run on every OS gets each group on Linux, macOS and Windows', () => {
  assert.deepEqual(buildMatrix(ciTestGroups, { full: true, allOs: true }).include, [
    { group: 'editor', os: 'ubuntu-latest', jbang: false },
    { group: 'editor', os: 'macos-latest', jbang: false },
    { group: 'editor', os: 'windows-latest', jbang: false },
    { group: 'views', os: 'ubuntu-latest', jbang: true },
    { group: 'views', os: 'macos-latest', jbang: true },
    { group: 'views', os: 'windows-latest', jbang: true },
    { group: 'deploy', os: 'ubuntu-latest', jbang: true },
  ]);
});

test('every group must be listed in all, and smoke must list one', () => {
  assert.throws(() => buildMatrix({ ...ciTestGroups, smoke: [] }, { full: true, allOs: true }), /smoke lists no group/);
  assert.throws(
    () => buildMatrix({ ...ciTestGroups, linuxOnly: ['deploy', 'debug'] }, { full: true, allOs: true }),
    /ciTestGroups.all is missing groups named in smoke, linuxOnly or withoutJBang: debug/,
  );
});

test('the groups of @kaoto/ui-tests-vscode are valid', () => {
  const packageJson = JSON.parse(readFileSync('packages/ui-tests-vscode/package.json', 'utf8'));
  assert.ok(buildMatrix(packageJson.ciTestGroups, { full: true, allOs: true }).include.length > 0);
});
