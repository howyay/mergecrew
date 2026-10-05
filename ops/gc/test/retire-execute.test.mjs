// Tests for the retirement executor.
//
//   node --test ops/gc/test/retire-execute.test.mjs
//
// The tests use a fake tree, so nothing on disk is touched.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBatch,
  buildBatch,
  referencesTarget,
  renderBatch,
} from '../retire-execute.mjs';

/** A fake tree: relative path to contents. Directories are implied by the paths. */
function fakeRoot(files) {
  const reads = [];
  return {
    reads,
    readFile: (path) => {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      reads.push(path);
      return files[path];
    },
  };
}

test('referencesTarget finds a package import and a relative import', () => {
  assert.equal(referencesTarget(`import { x } from '@mergecrew/agent-runtime';`, 'packages/agent-runtime'), true);
  assert.equal(referencesTarget(`const x = require('../../apps/runner/src/main');`, 'apps/runner'), true);
  assert.equal(referencesTarget(`import { y } from './local';`, 'apps/runner'), false);
});

test('referencesTarget does not treat a path inside a string as a reference', () => {
  const text = `export const FIXTURE = 'apps/runner/src/main.ts';\n`;
  assert.equal(referencesTarget(text, 'apps/runner'), false);
});

test('a batch holds only the modules that nothing outside imports', () => {
  const files = {
    'apps/api/src/app.ts': `import { run } from '../../apps/runner/src/main';\n`,
    'scripts/keep.mjs': 'export const keep = 1;\n',
  };
  const plan = buildBatch({
    root: '/fake',
    targets: ['apps/runner', 'apps/worker-cron'],
    readFile: (p) => files[p] ?? '',
    listOutside: () => Object.keys(files),
    listTarget: (name) => [`${name}/src/main.ts`],
  });
  assert.deepEqual(plan.batch.map((b) => b.target), ['apps/worker-cron']);
  assert.deepEqual(plan.blocked.map((b) => [b.target, b.by]), [['apps/runner', ['apps/api/src/app.ts']]]);
});

test('the batch respects the module cap', () => {
  const plan = buildBatch({
    root: '/fake',
    targets: ['a', 'b', 'c'],
    maxModules: 2,
    readFile: () => '',
    listOutside: () => [],
    listTarget: (name) => [`${name}/x.ts`],
  });
  assert.deepEqual(plan.batch.map((b) => b.target), ['a', 'b']);
  assert.deepEqual(plan.blocked, []);
});

test('a module with no files is still a valid batch entry', () => {
  const plan = buildBatch({
    root: '/fake',
    targets: ['empty'],
    readFile: () => '',
    listOutside: () => [],
    listTarget: () => [],
  });
  assert.deepEqual(plan.batch, [{ target: 'empty', files: [] }]);
});

test('renderBatch prints the batch, the files, and the blockers', () => {
  const report = renderBatch(
    {
      batch: [{ target: 'apps/runner', files: ['apps/runner/src/main.ts', 'apps/runner/src/other.ts'] }],
      blocked: [{ target: 'apps/worker-cron', by: ['apps/api/src/app.ts'] }],
    },
    { applied: false },
  );
  assert.match(report, /^Dry run\. Modules 1 · files 2 · blocked 1$/m);
  assert.match(report, /- `apps\/runner` \(2 files\)/);
  assert.match(report, /- `apps\/worker-cron` is imported by 1 file\(s\): `apps\/api\/src\/app.ts`/);
});

test('renderBatch states an applied run', () => {
  const report = renderBatch({ batch: [], blocked: [] }, { applied: true });
  assert.match(report, /^Applied\. Modules 0/m);
  assert.match(report, /None\. Every candidate is still imported\./);
});

test('applyBatch refuses a path outside the target', () => {
  const plan = { batch: [{ target: 'apps/runner', files: ['apps/runner/ok.ts', 'apps/api/other.ts'] }], blocked: [] };
  assert.throws(() => applyBatch('/fake', plan), /refusing to delete "apps\/api\/other.ts" outside "apps\/runner"/);
});
