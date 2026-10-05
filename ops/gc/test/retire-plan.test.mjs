// Tests for the engine retirement inventory.
//
//   node --test ops/gc/test/retire-plan.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TARGETS,
  buildInventory,
  findReferences,
  renderPlan,
  retireOrder,
} from '../retire-plan.mjs';

const files = [
  'apps/orchestrator/src/run.ts',
  'apps/orchestrator/src/index.ts',
  'packages/agent-runtime/src/step.ts',
  'apps/api/src/modules/run/run.service.ts',
  'apps/runner/src/main.ts',
  'apps/web/src/page.tsx',
];

const contents = new Map([
  ['apps/orchestrator/src/run.ts', `import { step } from '@mergecrew/agent-runtime';\n`],
  ['apps/orchestrator/src/index.ts', `export * from './run';\n`],
  ['packages/agent-runtime/src/step.ts', `export const step = 1;\n`],
  ['apps/api/src/modules/run/run.service.ts', `import { run } from '../../../../apps/orchestrator/src/index';\n`],
  ['apps/runner/src/main.ts', `import type { x } from '@mergecrew/agent-runtime';\n`],
  ['apps/web/src/page.tsx', `export default function Page() { return null; }\n`],
]);

test('findReferences sees a package import and a relative path', () => {
  const refs = findReferences(files, contents, 'packages/agent-runtime');
  assert.deepEqual(refs.map((r) => r.from), ['apps/orchestrator/src/run.ts', 'apps/runner/src/main.ts']);

  const rel = findReferences(files, contents, 'apps/orchestrator');
  assert.deepEqual(rel.map((r) => r.from), ['apps/api/src/modules/run/run.service.ts']);
});

test('findReferences does not count a module against itself', () => {
  const refs = findReferences(files, contents, 'apps/orchestrator');
  assert.ok(!refs.some((r) => r.from.startsWith('apps/orchestrator/')));
});

test('buildInventory reports size and references per target', () => {
  const inventory = buildInventory({
    files,
    contents,
    targets: ['apps/orchestrator', 'packages/agent-runtime'],
    lineCount: () => 10,
  });
  const orchestrator = inventory.find((i) => i.target === 'apps/orchestrator');
  assert.equal(orchestrator.files, 2);
  assert.equal(orchestrator.lines, 20);
  assert.equal(orchestrator.inbound, 1);
});

test('retireOrder puts the consumer before the module it imports', () => {
  const inventory = buildInventory({
    files,
    contents,
    targets: ['apps/orchestrator', 'packages/agent-runtime'],
    lineCount: () => 10,
  });
  const order = retireOrder(inventory);
  // The orchestrator imports the runtime. Nothing inside the target set imports the orchestrator,
  // so the orchestrator goes first and the runtime loses its last internal consumer.
  assert.deepEqual(order.map((o) => o.target), ['apps/orchestrator', 'packages/agent-runtime']);
  assert.equal(order[0].internalRefs, 0);
  assert.equal(order[1].internalRefs, 1);
});

test('retireOrder reports a module with no internal edge first even when many outside files use it', () => {
  const inventory = [
    { target: 'a', files: 5, lines: 100, inbound: 40, references: [] },
    { target: 'b', files: 5, lines: 100, inbound: 0, references: [] },
  ];
  assert.deepEqual(retireOrder(inventory).map((o) => o.target), ['b', 'a']);
});

test('renderPlan lists the table, the order, and the blockers', () => {
  const inventory = buildInventory({ files, contents, targets: ['apps/orchestrator', 'packages/agent-runtime'], lineCount: () => 10 });
  const plan = renderPlan(inventory, retireOrder(inventory));
  assert.match(plan, /^\| Module \| Files \| Lines \| Inbound refs \| Internal refs \|$/m);
  assert.match(plan, /## Retirement order/);
  assert.match(plan, /1\. `apps\/orchestrator` — internal refs 0, outside refs 1/);
  assert.match(plan, /2\. `packages\/agent-runtime` — internal refs 1, outside refs 2/);
  assert.match(plan, /## Blockers/);
  assert.match(plan, /`apps\/orchestrator` is referenced by 1 file\(s\)/);
});

test('renderPlan states none when the targets are self-contained', () => {
  const plan = renderPlan([{ target: 'x', files: 1, lines: 1, inbound: 0, references: [] }], [
    { step: 1, target: 'x', internalRefs: 0, inbound: 0 },
  ]);
  assert.match(plan, /None\. No file outside a target module references a target module\./);
});

test('the default target list covers the duplicated orchestration stack', () => {
  assert.deepEqual(DEFAULT_TARGETS, [
    'apps/orchestrator',
    'packages/agent-runtime',
    'apps/runner',
    'apps/runner-agent',
    'apps/worker-cron',
  ]);
});
