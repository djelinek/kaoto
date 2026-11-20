/**
 * Builds the matrix of the VS Code UI tests (kaoto-vscode-ui-tests.yml) from the `ciTestGroups` field in the
 * package.json of @kaoto/ui-tests-vscode: one entry per test group and OS, which also says whether the group needs
 * Java and JBang (see that package's README).
 *
 * - FULL=true runs every group in `all`, and any other run the groups in `smoke`.
 * - ALL_OS=true runs them on Linux, macOS and Windows, and any other run on Windows. The groups in `linuxOnly` run on
 *   Linux only.
 * - The groups in `withoutJBang` run without Java and JBang.
 *
 * Prints one line per job and writes the matrix to GITHUB_OUTPUT as `matrix`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { pathToFileURL } from 'node:url';

export function buildMatrix(ciTestGroups, { full, allOs }) {
  const all = ciTestGroups?.all ?? [];
  const smoke = ciTestGroups?.smoke ?? [];
  const linuxOnly = ciTestGroups?.linuxOnly ?? [];
  const withoutJBang = ciTestGroups?.withoutJBang ?? [];

  if (smoke.length === 0) {
    throw new Error('ciTestGroups.smoke lists no group');
  }
  const unlisted = [...smoke, ...linuxOnly, ...withoutJBang].filter((group) => !all.includes(group));
  if (unlisted.length > 0) {
    throw new Error(
      `ciTestGroups.all is missing groups named in smoke, linuxOnly or withoutJBang: ${unlisted.join(', ')}`,
    );
  }

  const oses = allOs ? ['ubuntu-latest', 'macos-latest', 'windows-latest'] : ['windows-latest'];
  return {
    include: (full ? all : smoke).flatMap((group) =>
      (linuxOnly.includes(group) ? ['ubuntu-latest'] : oses).map((os) => ({
        group,
        os,
        jbang: !withoutJBang.includes(group),
      })),
    ),
  };
}

function main() {
  const { ciTestGroups } = JSON.parse(readFileSync('packages/ui-tests-vscode/package.json', 'utf8'));
  let matrix;
  try {
    matrix = buildMatrix(ciTestGroups, { full: env.FULL === 'true', allOs: env.ALL_OS === 'true' });
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const { group, os, jbang } of matrix.include) {
    console.log(`${group} (${os})${jbang ? '' : ', without JBang'}`);
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
