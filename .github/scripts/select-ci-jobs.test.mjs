import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { git } from './git-client.mjs';
import { lastFinishedPushRun, listWorkspaces, selectsEveryWorkspace } from './select-ci-jobs.mjs';

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

describe('lastFinishedPushRun', () => {
  const environment = {
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_REPOSITORY: 'KaotoIO/kaoto',
    GITHUB_WORKFLOW_REF: 'KaotoIO/kaoto/.github/workflows/build-lint-test.yml@refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_TOKEN: 'token',
  };

  /** A fetch that answers with runs of the given conclusions, the newest first, and records the request. */
  function runs(...conclusions) {
    const fetchRuns = async (url, options) => {
      Object.assign(fetchRuns, { url: url.href, options });
      const workflowRuns = conclusions.map((conclusion, index) => ({ conclusion, head_sha: `commit${index}` }));
      return { ok: true, json: async () => ({ workflow_runs: workflowRuns }) };
    };
    return fetchRuns;
  }

  test("asks for the finished push runs of the run's workflow on the pushed branch", async () => {
    const fetchRuns = runs();
    await lastFinishedPushRun(environment, fetchRuns);
    assert.equal(
      fetchRuns.url,
      'https://api.github.com/repos/KaotoIO/kaoto/actions/workflows/build-lint-test.yml/runs?branch=main&event=push&status=completed&per_page=100',
    );
    assert.equal(fetchRuns.options.headers.Authorization, 'Bearer token');
  });

  test('returns the commit of the newest run that passed or failed', async () => {
    assert.equal(
      await lastFinishedPushRun(environment, runs('cancelled', 'cancelled', 'failure', 'success')),
      'commit2',
    );
    assert.equal(await lastFinishedPushRun(environment, runs('success', 'failure')), 'commit0');
  });

  test('returns nothing without such a run, so that every workspace is selected', async () => {
    assert.equal(await lastFinishedPushRun(environment, runs()), '');
    assert.equal(await lastFinishedPushRun(environment, runs('cancelled')), '');
  });

  test("returns nothing if the runs can't be listed", async () => {
    assert.equal(await lastFinishedPushRun(environment, async () => ({ ok: false, status: 403 })), '');
    assert.equal(
      await lastFinishedPushRun(environment, async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }),
      '',
    );
  });
});
