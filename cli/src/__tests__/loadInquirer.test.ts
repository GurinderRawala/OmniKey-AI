import { execFileSync } from 'child_process';
import path from 'path';
import { expect, it } from 'vitest';

it('loads the ESM prompt module through a native Node import outside the Vitest VM', () => {
  // Vitest's VM has no dynamic-import callback for new Function. Exercise the
  // actual CommonJS compilation in a real Node process instead.
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `const fs = require('fs');
       const ts = require('typescript');
       const Module = require('module');
       const filename = require('path').resolve('src/loadInquirer.ts');
       const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
         compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
       }).outputText;
       const mod = new Module(filename, module);
       mod.filename = filename;
       mod.paths = Module._nodeModulePaths(require('path').dirname(filename));
       mod._compile(compiled, filename);
       Promise.all([mod.exports.loadInquirer(), mod.exports.loadInquirer()]).then(([a,b]) => {
         if (a !== b || typeof a.prompt !== 'function' || typeof a.createPromptModule !== 'function') process.exit(1);
         console.log('ok');
       });`,
    ],
    { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10_000 },
  );
  expect(output.trim()).toBe('ok');
});
