/**
 * Print `key=<sha256>` of what `yarn install` reads, for the node_modules cache of kaoto-setup-workspace.
 *
 * The hash covers yarn.lock, Yarn's settings and release, and the fields of each package.json that decide what Yarn
 * installs and links. The other fields, such as the scripts, the version or the VS Code extension's contributions,
 * don't change node_modules, so changing them keeps the key.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const FIELDS = [
  'name',
  'packageManager',
  'workspaces',
  'resolutions',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'dependenciesMeta',
  'peerDependenciesMeta',
  'bin',
];
const hash = createHash('sha256');
const add = (name, content) => hash.update(name).update('\0').update(content).update('\0');
const list = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

for (const file of ['yarn.lock', '.yarnrc.yml', ...list('.yarn/releases').map((name) => `.yarn/releases/${name}`)]) {
  if (existsSync(file)) add(file, readFileSync(file));
}
for (const file of ['package.json', ...list('packages').map((name) => `packages/${name}/package.json`)]) {
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  add(file, JSON.stringify(FIELDS.map((field) => manifest[field] ?? null)));
}
console.log(`key=${hash.digest('hex')}`);
