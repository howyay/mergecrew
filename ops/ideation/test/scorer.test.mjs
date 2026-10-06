import assert from 'node:assert/strict';
import test from 'node:test';
import { RUBRIC, bandFor, scoreFromIdea, scoreIdea } from '../lib/scorer.mjs';

test('bandFor uses the documented thresholds', () => {
  assert.equal(bandFor(100), 'must');
  assert.equal(bandFor(75), 'must');
  assert.equal(bandFor(74), 'should');
  assert.equal(bandFor(55), 'should');
  assert.equal(bandFor(54), 'could');
  assert.equal(bandFor(35), 'could');
  assert.equal(bandFor(34), 'wont');
  assert.equal(bandFor(0), 'wont');
});

test('scoreIdea sums the four axes and clamps to each ceiling', () => {
  const exact = scoreIdea({ impact: 40, confidence: 20, effort: 20, risk: 20 });
  assert.equal(exact.score, 100);
  assert.equal(exact.band, 'must');

  const oversized = scoreIdea({ impact: 999, confidence: 999, effort: 999, risk: 999 });
  assert.deepEqual(oversized.features, RUBRIC);
  assert.equal(oversized.score, 100);
});

test('scoreIdea clamps negatives and non-numeric input to 0', () => {
  const scored = scoreIdea({ impact: -50, confidence: 'nonsense', effort: undefined, risk: null });
  assert.deepEqual(scored.features, { impact: 0, confidence: 0, effort: 0, risk: 0 });
  assert.equal(scored.score, 0);
  assert.equal(scored.band, 'wont');
});

test('scoreIdea is pure: same input, same output, input untouched', () => {
  const input = { impact: 30, confidence: 12, effort: 8, risk: 15 };
  const snapshot = { ...input };
  assert.deepEqual(scoreIdea(input), scoreIdea(input));
  assert.deepEqual(input, snapshot);
});

test('scoreFromIdea ranks a failing CI above a small TODO cleanup', () => {
  const ci = scoreFromIdea({
    source: 'ci-failure',
    evidence: ['ops/ci/state/last-run.json status=fail', 'failed=pnpm test'],
    effortHint: 'small',
  });
  const todo = scoreFromIdea({ source: 'todo-cluster', evidence: ['a.ts:1 x'], effortHint: 'large' });
  assert.ok(ci.score > todo.score, `expected ci ${ci.score} > todo ${todo.score}`);
  assert.equal(ci.band, 'must');
  assert.ok(todo.score < 75);
});

test('scoreFromIdea rewards more cited evidence with more confidence', () => {
  const thin = scoreFromIdea({ source: 'llm', evidence: [], effortHint: 'medium' });
  const rich = scoreFromIdea({
    source: 'llm',
    evidence: ['docs/04-roadmap.md:12 x', 'a.ts:3 y', 'b.ts:9 z'],
    effortHint: 'medium',
  });
  assert.ok(rich.features.confidence > thin.features.confidence);
  assert.equal(rich.features.confidence, 20);
});

test('scoreFromIdea is deterministic for the same idea', () => {
  const idea = { source: 'backlog', evidence: ['UX-BACKLOG.md open=3'], effortHint: 'medium' };
  assert.deepEqual(scoreFromIdea(idea), scoreFromIdea({ ...idea }));
});
