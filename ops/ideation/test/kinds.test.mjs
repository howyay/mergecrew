/**
 * The kinds table is the one place that says what a kind of work buys. The
 * specifier, the runner, the deliverable and the deck all read it, so a wrong
 * answer here is wrong in four places at once — which is why it is asserted
 * directly instead of only through its consumers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHORE_SOURCES,
  KINDS,
  KIND_INPUTS,
  LEGACY_KINDS,
  kindForSource,
  needsPrd,
  needsSpecification,
  normalizeKind,
  qaModeFor,
  workflowFor,
} from '../lib/kinds.mjs';

test('normalizeKind accepts the current words, the old word, and nothing else', () => {
  assert.deepEqual([...KINDS], ['feature', 'chore', 'refactor']);
  for (const kind of KINDS) assert.equal(normalizeKind(kind), kind);

  // `technical` was the old word for a chore. It is still on disk, in old state
  // files and in delivered artifacts, so every reader has to resolve it the
  // same way — including when a hand-edited file carries it in another case.
  assert.deepEqual(LEGACY_KINDS, { technical: 'chore' });
  assert.equal(normalizeKind('technical'), 'chore');
  assert.equal(normalizeKind('Technical'), 'chore');
  assert.equal(normalizeKind(' CHORE '), 'chore');

  // A card that never declared a kind is product work: an undeclared refactor
  // is the exception, not the rule.
  for (const nothing of ['', '   ', 'nonsense', undefined, null]) {
    assert.equal(normalizeKind(nothing), 'feature');
  }
});

test('the API accepts exactly the kinds the table can render', () => {
  assert.deepEqual([...KIND_INPUTS], ['feature', 'chore', 'refactor', 'technical']);
  for (const input of KIND_INPUTS) {
    assert.ok(KINDS.includes(normalizeKind(input)), `${input} must normalise to a real kind`);
    assert.equal(workflowFor(input).label.length > 0, true, `${input} must render as a label`);
  }
});

test('the workflow table answers spec, PRD, oracle and artifact in one place', () => {
  assert.deepEqual(workflowFor('feature'), {
    kind: 'feature',
    label: 'Feature',
    specification: 'full',
    prd: true,
    qa: 'uat',
    deliverable: 'demo',
  });
  assert.deepEqual(workflowFor('refactor'), {
    kind: 'refactor',
    label: 'Refactor',
    specification: 'full',
    prd: true,
    qa: 'checks',
    deliverable: 'changelog',
  });
  // The workflow the user's complaint asked for: no specification, no PRD, no
  // browser, and a changelog instead of a recording nobody would watch.
  assert.deepEqual(workflowFor('chore'), {
    kind: 'chore',
    label: 'Chore',
    specification: 'none',
    prd: false,
    qa: 'checks',
    deliverable: 'changelog',
  });

  // The legacy spelling reads as the chore it means, so an old record cannot
  // fall out of the workflow table.
  assert.deepEqual(workflowFor('technical'), workflowFor('chore'));
  assert.equal(workflowFor('nonsense').kind, 'feature');
});

test('the reachable questions are answered from the same table', () => {
  assert.equal(needsSpecification('feature'), true);
  assert.equal(needsSpecification('refactor'), true);
  assert.equal(needsSpecification('chore'), false);
  assert.equal(needsSpecification('technical'), false, 'the old word must skip the specifier too');

  assert.equal(needsPrd('feature'), true);
  assert.equal(needsPrd('refactor'), true);
  assert.equal(needsPrd('chore'), false);

  assert.equal(qaModeFor('feature'), 'uat');
  assert.equal(qaModeFor('refactor'), 'checks');
  assert.equal(qaModeFor('chore'), 'checks');
});

test('kindForSource sends maintenance signals to the chore workflow', () => {
  assert.equal(kindForSource('product-feature'), 'feature');
  assert.equal(kindForSource('product-in-progress'), 'feature');
  assert.equal(kindForSource('human'), 'feature');
  assert.equal(kindForSource('llm'), 'feature');
  assert.equal(kindForSource(undefined), 'feature');

  for (const source of CHORE_SOURCES) {
    assert.equal(kindForSource(source), 'chore', `${source} is maintenance work`);
    assert.equal(needsSpecification(kindForSource(source)), false);
  }
  assert.equal(CHORE_SOURCES.has('ci-failure'), true);
  assert.equal(CHORE_SOURCES.has('todo-cluster'), true);
});
