import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const turbo = json('turbo.json');
const cli = json('cli/package.json');
test('one pinned pnpm lockfile and deliberately separate development/runtime engines', () => {
  assert.equal(json('package.json').packageManager, 'pnpm@10.34.9');
  assert.equal(json('package.json').engines.node, '^22.12.0 || >=24.0.0');
  for (const name of ['api', 'cli'])
    assert.equal(json(`${name}/package.json`).engines.node, '>=22');
  assert(existsSync(path.join(root, 'pnpm-lock.yaml')));
  for (const file of ['yarn.lock', 'package-lock.json', 'cli/package-lock.json'])
    assert(!existsSync(path.join(root, file)));
  const workspace = read('pnpm-workspace.yaml');
  assert.match(workspace, /onlyBuiltDependencies:\n  - sqlite3/);
  assert.doesNotMatch(workspace, /shamefullyHoist|dangerouslyAllowAllBuilds/);
  assert.match(workspace, /injectWorkspacePackages: true/);
});
test('CLI build explicitly depends on both copied services and caches every output', () => {
  const build = turbo.tasks['omnikey-cli#build'];
  assert.deepEqual(build.dependsOn, ['omnikey-ai-api#build', 'telegram#build']);
  assert.deepEqual(build.outputs, ['dist/**', 'backend-dist/**', 'telegram-client-dist/**']);
  for (const task of ['dev', 'format', 'clean', 'test', 'test:types'])
    assert.equal(turbo.tasks[task].cache, false);
  assert.equal(turbo.tasks.dev.persistent, true);
  assert(turbo.globalDependencies.includes('eslint.config.mjs'));
  assert(turbo.globalDependencies.includes('**/tsconfig*.json'));
  assert(turbo.globalEnv.includes('NODE_ENV'));
});
test('published CLI declares every bundled service production dependency', () => {
  for (const name of ['api', 'telegram']) {
    for (const dependency of Object.keys(json(`${name}/package.json`).dependencies)) {
      assert.equal(
        cli.dependencies[dependency],
        json(`${name}/package.json`).dependencies[dependency],
        `${name}: bundled ${dependency} range must match CLI`,
      );
    }
  }
  for (const output of ['dist', 'backend-dist', 'telegram-client-dist'])
    assert(cli.files.includes(output));
});
test('source imports resolve through declared workspace dependencies, not hoisting', () => {
  const require = createRequire(path.join(root, 'package.json'));
  const ts = require('typescript');
  for (const name of ['api', 'cli', 'telegram']) {
    const manifest = json(`${name}/package.json`);
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const file of ts.sys.readDirectory(path.join(root, name, 'src'), ['.ts'])) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        let specifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier;
        else if (
          ts.isCallExpression(node) &&
          (node.expression.getText(source) === 'require' ||
            node.expression.kind === ts.SyntaxKind.ImportKeyword)
        )
          specifier = node.arguments[0];
        if (specifier && ts.isStringLiteral(specifier)) {
          const value = specifier.text;
          if (
            !value.startsWith('.') &&
            !value.startsWith('node:') &&
            !builtinModules.includes(value)
          ) {
            const dependency = value.startsWith('@')
              ? value.split('/').slice(0, 2).join('/')
              : value.split('/')[0];
            assert(declared[dependency], `${file}: undeclared ${dependency}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
});
test('CI and release installs are frozen, portable staging is verified', () => {
  for (const name of ['ci.yml', 'release.yml', 'publish-cli.yaml']) {
    const workflow = read(`.github/workflows/${name}`);
    assert.match(workflow, /pnpm\/action-setup@v4/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(workflow, /\byarn\b/);
  }
  assert.match(read('.github/workflows/release.yml'), /deploy --prod/);
  assert.match(read('.github/workflows/release.yml'), /scripts\/verify-cli-bundle.mjs/);
  assert.match(read('.github/workflows/publish-cli.yaml'), /npm publish --access public/);
  assert.match(read('Dockerfile'), /pnpm install --frozen-lockfile/);
  assert.match(read('Dockerfile'), /CMD \["node", "api\/dist\/index.js"\]/);
});

test('Telegram uses the Cypress request client after removing the obsolete request peer', async () => {
  const require = createRequire(path.join(root, 'telegram/package.json'));
  const TelegramBot = require('node-telegram-bot-api');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(new URL(request.url, 'http://localhost').pathname);
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { message_id: 1, text: 'hello' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const bot = new TelegramBot('test-token', {
      polling: false,
      baseApiUrl: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal((await bot.sendMessage(123, 'hello')).message_id, 1);
    assert.equal(
      (
        await bot.sendDocument(
          123,
          Buffer.from('test'),
          {},
          {
            filename: 'test.txt',
            contentType: 'text/plain',
          },
        )
      ).message_id,
      1,
    );
    assert.deepEqual(requests, ['/bottest-token/sendMessage', '/bottest-token/sendDocument']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Sequelize UUID defaults and transactions work with the patched CommonJS UUID dependency', async () => {
  const require = createRequire(path.join(root, 'api/package.json'));
  const { Sequelize, DataTypes } = require('sequelize');
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    const Model = db.define('Probe', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      legacyId: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV1 },
    });
    await db.sync();
    await db.transaction(async (transaction) => {
      const row = await Model.create({}, { transaction });
      assert.match(row.id, /^[0-9a-f-]{36}$/i);
      assert.match(row.legacyId, /^[0-9a-f-]{36}$/i);
    });
    assert.equal(await Model.count(), 1);
  } finally {
    await db.close();
  }
});

test('development workers can resolve their explicit ts-node preload', () => {
  const require = createRequire(path.join(root, 'api/package.json'));
  assert(json('api/package.json').devDependencies['ts-node']);
  assert(require.resolve('ts-node/register/transpile-only'));
});
