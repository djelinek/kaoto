import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { git } from './git-client.mjs';
import { listWorkspaces, selectsEveryWorkspace } from './select-ci-jobs.mjs';

describe('selectsEveryWorkspace', () => {
  const root = process.cwd();
  let repo;
  let edits = 0;

  /** Commits the given files to the test repository and returns the commit. */
  function commit(...files) {
    for (const file of files) {
      edits += 1;
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), `edit ${edits}\n`);
    }
    git(['add', '--all'], { cwd: repo });
    git(['commit', '--quiet', '--message', files.join(' ')], { cwd: repo });
    return git(['rev-parse', 'HEAD'], { cwd: repo }).trim();
  }

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'select-ci-jobs-'));
    git(['init', '--quiet'], { cwd: repo });
    git(['config', 'user.name', 'Test'], { cwd: repo });
    git(['config', 'user.email', 'test@example.com'], { cwd: repo });
    commit('package.json', 'packages/ui/package.json');
    process.chdir(repo);
  });

  after(() => {
    process.chdir(root);
    rmSync(repo, { recursive: true, force: true });
  });

  test('a run with nothing to compare selects every workspace', () => {
    assert.equal(selectsEveryWorkspace('', 'workflow_dispatch'), true);
    assert.equal(selectsEveryWorkspace('0000000000000000000000000000000000000000', 'push'), true);
  });

  test('changes in workspaces and documentation leave the selection to Yarn', () => {
    const base = commit('packages/ui/package.json');
    commit('packages/ui/src/app.ts', 'README.md', 'docs/ci.md', '.github/ISSUE_TEMPLATE/bug.yml');
    assert.equal(selectsEveryWorkspace(base, 'pull_request'), false);
    assert.equal(selectsEveryWorkspace(base, 'push'), false);
  });

  test('a change outside the workspaces selects every workspace', () => {
    for (const file of ['yarn.lock', 'package.json', '.github/workflows/build-lint-test.yml']) {
      const base = commit('packages/ui/package.json');
      commit(file);
      assert.equal(selectsEveryWorkspace(base, 'pull_request'), true, file);
    }
  });

  test('a push that rewrote history selects every workspace', () => {
    const base = commit('packages/ui/src/app.ts');
    git(['commit', '--quiet', '--amend', '--message', 'amended'], { cwd: repo });
    assert.equal(selectsEveryWorkspace(base, 'push'), true);
  });

  test("a base that git doesn't know selects every workspace", () => {
    assert.equal(selectsEveryWorkspace('f'.repeat(40), 'push'), true);
    assert.equal(selectsEveryWorkspace('f'.repeat(40), 'pull_request'), true);
  });
});

test('listWorkspaces lists the workspaces by name, without the root', () => {
  const workspaces = listWorkspaces([]);
  assert.ok(workspaces.includes('@kaoto/kaoto'));
  assert.ok(workspaces.includes('vscode-kaoto'));
  assert.ok(!workspaces.includes('kaoto'));
});
