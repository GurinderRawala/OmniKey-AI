// Run only in a disposable checkout: this deliberately deletes build outputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const cache = mkdtempSync(path.join(os.tmpdir(), 'omnikey-turbo-'));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (...args) =>
  execFileSync(pnpm, ['exec', 'turbo', 'run', 'build', '--cache-dir', cache, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const dry = () => JSON.parse(run('--dry=json')).tasks.filter((task) => task.task === 'build');
const outputs = [
  'api/dist',
  'telegram/dist',
  'cli/dist',
  'cli/backend-dist',
  'cli/telegram-client-dist',
];
const cli = (tasks) => tasks.find((task) => task.taskId === 'omnikey-cli#build');
const edits = new Map();
try {
  const before = dry();
  assert.deepEqual(cli(before).dependencies.sort(), [
    'omnikey-ai-api#build',
    'omnikey-cli#clean',
    'telegram#build',
  ]);
  console.log(run());
  assert(
    dry().every((task) => task.cache.status === 'HIT'),
    'second build must hit all caches',
  );
  const expected = new Map(outputs.map((dir) => [dir, readFileSync(`${dir}/index.js`)]));
  for (const dir of outputs) rmSync(dir, { recursive: true });
  console.log(run());
  for (const [dir, content] of expected)
    assert.deepEqual(readFileSync(`${dir}/index.js`), content, `restore ${dir}`);
  for (const workspace of ['api', 'telegram', 'cli']) {
    const file = `${workspace}/src/omnikey-turbo-cache-probe.ts`;
    assert(!existsSync(file), `probe already exists: ${file}`);
    edits.set(file, null);
    writeFileSync(file, `export const cacheProbe = '${workspace}';\n`);
    const changed = dry();
    assert.notEqual(
      cli(changed).hash,
      cli(before).hash,
      `${workspace} changes must invalidate CLI`,
    );
    console.log(run());
    const bundled =
      workspace === 'api'
        ? 'backend-dist'
        : workspace === 'telegram'
          ? 'telegram-client-dist'
          : 'dist';
    assert.match(readFileSync(`cli/${bundled}/omnikey-turbo-cache-probe.js`, 'utf8'), /cacheProbe/);
    const renamed = file.replace('-probe.ts', '-renamed.ts');
    assert(!existsSync(renamed), `probe already exists: ${renamed}`);
    edits.set(renamed, null);
    writeFileSync(renamed, readFileSync(file));
    rmSync(file);
    edits.delete(file);
    console.log(run());
    assert(
      !existsSync(`cli/${bundled}/omnikey-turbo-cache-probe.js`),
      'renamed output must be removed',
    );
    assert(
      existsSync(`cli/${bundled}/omnikey-turbo-cache-renamed.js`),
      'renamed output must be bundled',
    );
    rmSync(renamed);
    edits.delete(renamed);
    // Restoring an earlier cached build must remove obsolete output as well.
    console.log(run());
    assert(
      !existsSync(`${workspace}/dist/omnikey-turbo-cache-renamed.js`),
      'deleted source must leave no compiled output',
    );
    assert(
      !existsSync(`cli/${bundled}/omnikey-turbo-cache-renamed.js`),
      'cache restore must not retain deleted bundle code',
    );
  }
  for (const file of ['api/tsconfig.json', 'telegram/tsconfig.json', 'eslint.config.mjs']) {
    const original = readFileSync(file);
    edits.set(file, original);
    writeFileSync(file, Buffer.concat([original, Buffer.from('\n')]));
    assert.notEqual(cli(dry()).hash, cli(before).hash, `${file} must invalidate CLI`);
    writeFileSync(file, original);
    edits.delete(file);
  }
  console.log(
    'Turbo ordering, cache hits, restoration, source/config invalidation, rename/deletion cleanup: PASS',
  );
} finally {
  for (const [file, original] of edits) {
    if (original === null) rmSync(file, { force: true });
    else writeFileSync(file, original);
  }
  // Remove probe compilation artifacts before restoring the original build.
  for (const dir of outputs) rmSync(dir, { recursive: true, force: true });
  try {
    run();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}
