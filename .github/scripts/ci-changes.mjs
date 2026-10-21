import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { git } from './git-client.mjs';

/**
 * Select the existing CI jobs that need to run for a monorepo change.
 *
 * The `changes` job in build-lint-test.yml runs this script before any package builds.
 * This script only selects jobs; the workflows still own their build, lint and test commands.
 * Keep existing package validation intact when adjusting these rules. Package isolation and
 * the standard/deployment split follow the current expectations in KaotoIO/kaoto#3852.
 */

/**
 * The jobs that validate each workspace, named after the outputs declared by build-lint-test.yml.
 *
 * `jobs` run when a file inside one of the `workspaces` changes, and also when a workspace they depend
 * on changes, directly or through other workspaces; `dependencyJobs` replaces them in that second case.
 * Which workspaces depend on which comes from the Yarn workspace graph, not from this table.
 *
 * `ui` includes validation of both the UI and UI-tests sources. `vscode-smoke` runs only the settings
 * and editor integration groups, `vscode-full` runs all four groups, and `deploy` adds Minikube tests on
 * top of `vscode-full`. `web`, `e2e` and `chromatic` select the web package, Cypress and Storybook.
 */
const WORKSPACE_JOBS = [
  { workspaces: ['packages/ui'], jobs: ['ui'] },
  // Preserve this package's existing checks instead of narrowing them by test folder:
  // Cypress also ran on story/config changes, and Chromatic only has the PR exception below.
  { workspaces: ['packages/ui-tests'], jobs: ['ui', 'e2e', 'chromatic'] },
  {
    // One reusable workflow builds the extension and runs its ExTester UI tests, so a change to either
    // exercises all four integration groups and deployment tests. That workflow still builds the
    // prerequisite UI library; it does not run UI checks.
    workspaces: ['packages/kaoto-vscode', 'packages/ui-tests-vscode'],
    jobs: ['vscode-full', 'deploy'],
    // The extension embeds the UI library. Validate the embedded UI with a reduced set of
    // integration groups (settings + editor only) without starting a deployment cluster.
    dependencyJobs: ['vscode-smoke'],
  },
  {
    workspaces: ['packages/kaoto-web'],
    jobs: ['web'],
    // The web package declares the UI library as a dependency but does not import it yet,
    // so UI changes do not run web validation.
    dependencyJobs: [],
  },
];

/**
 * Map repository-relative Git paths to the output names declared by build-lint-test.yml.
 *
 * A changed file selects the `jobs` of its workspace and the dependency jobs of every workspace that
 * depends on that workspace. Files outside the package workspaces are shared inputs.
 *
 * @param {string[] | null} files Changed paths, including deletions. null means the diff is
 *   unknown and all jobs must run; [] means a known empty diff and selects no package jobs.
 * @param {string} eventName GitHub event name; defaults to PR behavior for direct callers.
 * @param {{ location: string, workspaceDependencies: string[] }[]} workspaces Workspaces as printed by
 *   `yarn workspaces list --verbose --json`; defaults to this checkout's for direct callers.
 * @returns {Record<string, boolean>} Union of the jobs required by every changed path.
 */
export function selectJobs(files, eventName = 'pull_request', workspaces = readWorkspaces()) {
  const jobs = { ui: false, web: false, 'vscode-smoke': false, 'vscode-full': false, deploy: false, e2e: false, chromatic: false };
  const all = () => Object.fromEntries(Object.keys(jobs).map((key) => [key, true]));
  if (files === null) return all();

  // Preserve Chromatic's previous PR paths-ignore rule: skip only when EVERY changed
  // file is inside cypress/. It never excluded cypress.config.ts or Cypress-only pushes.
  const skipChromatic =
    eventName === 'pull_request' && files.every((file) => file.startsWith('packages/ui-tests/cypress/'));

  const changed = new Set();
  for (const file of files) {
    // Yarn lists the repository root as workspace '.', which prefixes no Git path: root files are shared inputs.
    const workspace = workspaces.find(({ location }) => file.startsWith(`${location}/`));
    if (workspace) {
      changed.add(workspace.location);
    } else if (
      !file.startsWith('docs/') &&
      !file.startsWith('assets/readme/') &&
      !file.startsWith('.github/ISSUE_TEMPLATE/') &&
      !file.startsWith('.github/PULL_REQUEST_TEMPLATE/') &&
      !file.startsWith('.vscode/') &&
      !/^[^/]+\.md$/.test(file)
    ) {
      // Only known documentation/template paths outside packages can avoid package checks.
      // Everything else (lockfile, lint config, Yarn release, CI files, unknown packages)
      // selects all current jobs so a new shared input cannot silently lose validation.
      return all();
    }
  }

  const ruleFor = (location) => WORKSPACE_JOBS.find((rule) => rule.workspaces.includes(location));
  const select = (names) => {
    for (const name of names) jobs[name] = true;
  };
  // Accumulate requirements across the whole diff. For example, UI + extension changes
  // must include deployment tests even though a UI-only change does not need them.
  for (const location of changed) {
    const rule = ruleFor(location);
    // No job is known to validate this workspace (a new package, for example), so it is a shared input too.
    if (!rule) return all();
    select(rule.jobs);
    for (const dependent of dependentsOf(location, workspaces)) {
      const dependentRule = ruleFor(dependent);
      // Workspaces without rules have no job to run; workspaces sharing a rule already run its `jobs`.
      if (dependentRule && dependentRule !== rule) select(dependentRule.dependencyJobs ?? dependentRule.jobs);
    }
  }
  if (skipChromatic) jobs.chromatic = false;
  return jobs;
}

/** The locations of every workspace that depends on `location`, directly or through other workspaces. */
function dependentsOf(location, workspaces) {
  const dependents = new Set();
  const pending = [location];
  while (pending.length > 0) {
    const dependency = pending.pop();
    for (const workspace of workspaces) {
      if (workspace.workspaceDependencies.includes(dependency) && !dependents.has(workspace.location)) {
        dependents.add(workspace.location);
        pending.push(workspace.location);
      }
    }
  }
  return dependents;
}

let checkoutWorkspaces;

/**
 * Read the workspaces of this checkout and their direct workspace dependencies from Yarn, once.
 * Listing workspaces only reads package manifests, so the `changes` job needs no `yarn install`.
 */
function readWorkspaces() {
  if (!checkoutWorkspaces) {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    // Run the Yarn release pinned in .yarnrc.yml with this Node binary instead of resolving `yarn` from PATH.
    const [, yarnPath] = /^yarnPath:\s*(\S+)/m.exec(readFileSync(join(root, '.yarnrc.yml'), 'utf8'));
    checkoutWorkspaces = execFileSync(
      process.execPath,
      [join(root, yarnPath), 'workspaces', 'list', '--verbose', '--json'],
      { cwd: root, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
  return checkoutWorkspaces;
}

// Importing selectJobs in unit tests must not read Actions files or invoke Git.
// This block runs only when Node executes ci-changes.mjs as the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pullRequest = event.pull_request;
  // Use the event's PR head rather than the synthetic merge commit checked out by Actions.
  // For pushes, before/after cover every commit in the push, not just the last commit.
  const base = pullRequest?.base.sha ?? event.before;
  const head = pullRequest?.head.sha ?? event.after;
  // Manual dispatch has no comparison pair; the first push has an all-zero before SHA.
  // Leave files unknown in both cases so selectJobs conservatively selects everything.
  let files = null;
  if (base && head && !/^0+$/.test(base)) {
    try {
      // PR three-dot diff: changes since the merge base, excluding unrelated base-branch work.
      // Push two-dot diff: difference between the before and after trees.
      // --no-renames reports a move as deletion + addition, selecting both affected packages.
      // -z separates paths with NUL bytes so spaces, tabs and newlines in names remain intact.
      files = git([
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        `${base}${pullRequest ? '...' : '..'}${head}`,
        '--',
      ])
        .split('\0')
        .filter(Boolean);
    } catch {
      // Missing history or an unavailable commit must not make required validation disappear.
      console.warn('Unable to compare commits; running all CI jobs.');
    }
  }
  // Attribute the changed files to workspaces with this checkout's Yarn graph. Like a failed
  // comparison, a graph that cannot be read must not make required validation disappear.
  let workspaces = [];
  if (files !== null) {
    try {
      workspaces = readWorkspaces();
    } catch {
      console.warn('Unable to read the Yarn workspaces; running all CI jobs.');
      files = null;
    }
  }
  const jobs = selectJobs(files, process.env.GITHUB_EVENT_NAME, workspaces);
  // Actions step outputs are strings. The workflow compares these values with 'true' when
  // selecting jobs. Even when all are false, its aggregate `build` check still completes.
  const output = Object.entries(jobs)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  // Also show the selection in the job log for troubleshooting unexpected runs or skips.
  console.log(output);
}
