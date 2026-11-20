/**
 * Selects the jobs of a CI run (the `changes` job of build-lint-test.yml). Every other job runs when a workspace it
 * validates is affected: Yarn lists the workspaces that hold a file changed since the base commit, and with
 * `--recursive` also every workspace that depends on them, so a new package or a new dependency between packages
 * needs no change here.
 *
 * Writes the two lists to GITHUB_OUTPUT as JSON arrays of workspace names, `changed` and `affected`, and prints them.
 * BASE is the base commit: the upstream base of a pull request, or the commit before a push. Without GITHUB_OUTPUT it
 * only prints them, so it can be run locally from the repository's root:
 *
 *   BASE=$(git merge-base origin/main HEAD) node .github/scripts/select-ci-jobs.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

import { git } from './git-client.mjs';

/** Changes outside `packages/` that no job validates. */
const DOCUMENTATION = [
  '*.md',
  'docs/',
  '_context/',
  'assets/readme/',
  '.vscode/',
  '.github/ISSUE_TEMPLATE/',
  '.github/PULL_REQUEST_TEMPLATE/',
];

/** Whether git exits with 0. */
function gitSucceeds(args) {
  try {
    git(args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Yarn ignores files outside the workspaces, such as yarn.lock, root configs and workflows, so a change to one of them
 * that isn't documentation selects every workspace. So does a run with nothing to compare (a manual run or the first
 * push of a branch) and a push that rewrote history: Yarn compares with the merge base, so it can't see the changes
 * that such a push removed.
 */
export function selectsEveryWorkspace(base, event) {
  const outsideWorkspaces = ['.', ':(exclude)packages/', ...DOCUMENTATION.map((path) => `:(exclude)${path}`)];
  return (
    /^0*$/.test(base) ||
    (event === 'push' && !gitSucceeds(['merge-base', '--is-ancestor', base, 'HEAD'])) ||
    !gitSucceeds(['diff', '--quiet', `${base}...HEAD`, '--', ...outsideWorkspaces])
  );
}

/**
 * The workspaces that `yarn workspaces list` prints with the given options, without the root. A workspace without a
 * package name is listed by its path, which `--include` matches as well. Yarn runs from the release that .yarnrc.yml
 * names, with this Node.js, so no command is looked up in PATH. If Yarn fails, this throws, so that the job fails
 * rather than select no jobs.
 */
export function listWorkspaces(options) {
  const yarn = /^yarnPath:\s*(\S+)/m.exec(readFileSync('.yarnrc.yml', 'utf8'))[1];
  return execFileSync(process.execPath, [yarn, 'workspaces', 'list', ...options, '--json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((workspace) => workspace.location !== '.')
    .map((workspace) => workspace.name ?? workspace.location);
}

function main() {
  const base = env.BASE ?? '';
  const since = selectsEveryWorkspace(base, env.GITHUB_EVENT_NAME) ? [] : [`--since=${base}`];
  const output = [
    `changed=${JSON.stringify(listWorkspaces(since))}`,
    `affected=${JSON.stringify(listWorkspaces([...since, '--recursive']))}`,
  ].join('\n');

  console.log(output);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${output}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
