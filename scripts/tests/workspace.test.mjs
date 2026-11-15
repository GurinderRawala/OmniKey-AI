import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
      assert(cli.dependencies[dependency], `${name}: missing ${dependency} from CLI`);
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
