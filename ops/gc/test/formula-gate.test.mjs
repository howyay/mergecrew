// Tests for the formula gate.
//
//   node --test ops/gc/test/formula-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCity,
  checkFormula,
  defaultExpectation,
  findCycle,
  renderGate,
} from '../formula-gate.mjs';

/** A compiled formula shaped like `gc formula show <name> --json`. */
function compiled(overrides = {}) {
  return {
    ok: true,
    name: 'mol-mc-demo',
    steps: [
      { id: 'mol-mc-demo', is_root: true, title: 'root', description: 'root step' },
      { id: 'mol-mc-demo.plan', title: 'plan', description: 'plan step' },
      { id: 'mol-mc-demo.build', title: 'build', description: 'build step' },
    ],
    deps: [
      { step_id: 'mol-mc-demo.plan', depends_on_id: 'mol-mc-demo', type: 'blocks' },
      { step_id: 'mol-mc-demo.build', depends_on_id: 'mol-mc-demo.plan', type: 'blocks' },
    ],
    ...overrides,
  };
}

test('a well formed formula passes', () => {
  assert.deepEqual(checkFormula(compiled()), []);
});

test('a formula that did not compile fails', () => {
  assert.deepEqual(checkFormula({ ok: false }), ['the formula did not compile']);
  assert.deepEqual(checkFormula(null), ['the formula did not compile']);
});

test('the root must be unique and named after the formula', () => {
  const none = compiled({ steps: compiled().steps.map(({ is_root, ...rest }) => rest) });
  assert.match(checkFormula(none).join(' '), /exactly one root, and it has 0/);

  const wrong = compiled({ steps: compiled().steps.map((s, i) => (i === 0 ? { ...s, id: 'other' } : s)) });
  assert.match(checkFormula(wrong).join(' '), /root id "other" does not match the formula name "mol-mc-demo"/);
});

test('duplicate ids and missing text are problems', () => {
  const steps = [
    { id: 'mol-mc-demo', is_root: true, title: '', description: '' },
    { id: 'mol-mc-demo', title: 'x', description: 'y' },
  ];
  const problems = checkFormula(compiled({ steps, deps: [] }));
  assert.match(problems.join(' '), /a step id repeats/);
  assert.match(problems.join(' '), /has no title/);
  assert.match(problems.join(' '), /has no description/);
});

test('a dependency on an unknown step is a problem', () => {
  const deps = [{ step_id: 'mol-mc-demo.build', depends_on_id: 'mol-mc-demo.ghost', type: 'blocks' }];
  const problems = checkFormula(compiled({ deps }));
  assert.match(problems.join(' '), /unknown target "mol-mc-demo.ghost"/);
  assert.match(problems.join(' '), /unreachable from the root/);
});

test('a self dependency is a problem', () => {
  const deps = [{ step_id: 'mol-mc-demo.plan', depends_on_id: 'mol-mc-demo.plan', type: 'blocks' }];
  assert.match(checkFormula(compiled({ deps })).join(' '), /depends on itself/);
});

test('a cycle is found', () => {
  const deps = [
    { step_id: 'a', depends_on_id: 'b' },
    { step_id: 'b', depends_on_id: 'a' },
  ];
  const steps = [{ id: 'a', is_root: true, title: 'a', description: 'a' }, { id: 'b', title: 'b', description: 'b' }];
  assert.deepEqual(findCycle(steps, deps), ['a', 'b', 'a']);
  assert.match(checkFormula(compiled({ steps, deps })).join(' '), /the graph has a cycle/);
  assert.deepEqual(findCycle(steps, []), []);
});

test('a step with no incoming dependency is an entry point, not an orphan', () => {
  // This is the live shape: the root and the first work step both carry no incoming dependency.
  const steps = [
    ...compiled().steps,
    { id: 'mol-mc-demo.side', title: 'side', description: 'side' },
  ];
  assert.deepEqual(checkFormula(compiled({ steps })), []);
});

test('a step is unreachable when its only dependency names an unknown step', () => {
  const steps = [
    { id: 'mol-mc-demo', is_root: true, title: 'root', description: 'root' },
    { id: 'mol-mc-demo.lost', title: 'lost', description: 'lost' },
  ];
  const deps = [{ step_id: 'mol-mc-demo.lost', depends_on_id: 'mol-mc-demo.ghost' }];
  const problems = checkFormula(compiled({ steps, deps })).join(' ');
  assert.match(problems, /unknown target/);
  assert.match(problems, /unreachable from the root: mol-mc-demo.lost/);
});

test('the city check reports an absent formula', () => {
  assert.deepEqual(checkCity(['mol-mc-demo'], [{ name: 'mol-mc-demo' }]), []);
  assert.deepEqual(checkCity(['mol-mc-demo', 'mol-mc-gone'], [{ name: 'mol-mc-demo' }]), [
    'mol-mc-gone: the formula is absent from the city',
  ]);
});

test('the expectation defaults to the exported formulas', () => {
  const available = [{ name: 'mol-mc-demo' }, { name: 'mol-polecat-base' }, 'mol-mc-other'];
  assert.deepEqual(defaultExpectation(available), ['mol-mc-demo', 'mol-mc-other']);
});

test('the report lists the counts and the problems', () => {
  const report = renderGate({
    expected: ['mol-mc-demo'],
    reports: [{ name: 'mol-mc-demo', steps: 3, deps: 2, problems: [] }],
  });
  assert.match(report, /- ok · 3 steps · 2 dependencies/);
  assert.match(report, /Formulas checked: 1 of 1 expected\. Problems: 0\./);
});

test('the root connects to the entry steps, which carry no dependency themselves', () => {
  // The live shape: the root has no incoming dep, and the first work step has none either.
  const steps = [
    { id: 'mol-mc-demo', is_root: true, title: 'root', description: 'root' },
    { id: 'mol-mc-demo.plan', title: 'plan', description: 'plan' },
    { id: 'mol-mc-demo.build', title: 'build', description: 'build' },
  ];
  const deps = [{ step_id: 'mol-mc-demo.build', depends_on_id: 'mol-mc-demo.plan' }];
  assert.deepEqual(checkFormula(compiled({ steps, deps })), []);
});

test('a compiler finalize step needs no description', () => {
  const steps = [
    { id: 'mol-mc-demo', is_root: true, title: 'root', description: 'root' },
    { id: 'mol-mc-demo.plan', title: 'plan', description: 'plan' },
    { id: 'mol-mc-demo.workflow-finalize', title: 'Finalize', description: '' },
  ];
  const deps = [{ step_id: 'mol-mc-demo.workflow-finalize', depends_on_id: 'mol-mc-demo.plan' }];
  assert.deepEqual(checkFormula(compiled({ steps, deps })), []);
});
