// Verify a deployed or npm-installed CLI without relying on workspace resolution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const root = realpathSync(process.argv[2]);
// npm installs hoist dependencies beside the CLI; deploy keeps them beneath it.
const boundary = realpathSync(process.argv[3] || root);
const inside = (file) => file === boundary || file.startsWith(boundary + path.sep);
assert(inside(root), 'CLI must be inside the installation boundary');
function checkLinks(directory) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) assert(inside(realpathSync(file)), `Escaping symlink: ${file}`);
    else if (stat.isDirectory()) checkLinks(file);
  }
}
checkLinks(boundary);
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const output of ['dist', 'backend-dist', 'telegram-client-dist']) {
  const require = createRequire(path.join(root, output, 'index.js'));
  assert(inside(realpathSync(path.join(root, output, 'index.js'))));
  for (const dependency of Object.keys(manifest.dependencies)) {
    // Some dependencies are ESM-only or export subpaths rather than a root.
    const directory = require.resolve
      .paths(dependency)
      .map((base) => path.join(base, dependency))
      .find((candidate) => existsSync(path.join(candidate, 'package.json')));
    assert(
      directory && inside(realpathSync(directory)),
      `${output}: external/missing ${dependency}`,
    );
  }
  require('sqlite3');
}
const version = execFileSync(process.execPath, ['dist/index.js', '--version'], {
  cwd: root,
  env: { ...process.env, NODE_PATH: '' },
  encoding: 'utf8',
}).trim();
assert.equal(version, manifest.version);
// Interactive commands must resolve Inquirer from the installed CLI, not the
// user's current directory. --version does not exercise this lazy ESM loader.
execFileSync(
  process.execPath,
  [
    '-e',
    `
  require(${JSON.stringify(path.join(root, 'dist', 'loadInquirer.js'))}).loadInquirer()
    .then((module) => {
      if (typeof module.prompt !== 'function') process.exitCode = 1;
    }, (error) => { console.error(error); process.exitCode = 1; });
`,
  ],
  {
    cwd: os.tmpdir(),
    env: { ...process.env, NODE_PATH: '' },
    timeout: 10_000,
    stdio: 'pipe',
  },
);
console.log(
  `Standalone CLI ${version}: dependencies, sqlite3 (${process.arch}) and internal symlinks verified`,
);
