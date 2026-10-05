// Tests for the beads migration planner.
//
//   node --test ops/gc/test/beads-migration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_LABEL,
  beadIssueId,
  clampPriority,
  issueLabel,
  mapIssue,
  planBeadActions,
  renderPlan,
  toBeadCommands,
} from '../beads-migration.mjs';

const issues = [
  { id: 'iss-1', title: 'First', priority: 2, type: 'task', labels: ['feature'] },
  { id: 'iss-2', title: 'Second renamed', priority: 1, type: 'chore' },
  { id: 'iss-3', title: 'Third', priority: 3 },
];

const beads = [
  { id: 'me-1', title: 'First', priority: 2, labels: [BRIDGE_LABEL, issueLabel('iss-1')] },
  { id: 'me-2', title: 'Second old name', priority: 1, labels: [BRIDGE_LABEL, issueLabel('iss-2')] },
];

test('mapIssue normalizes the bead fields', () => {
  const mapped = mapIssue({ id: 'x', title: ' X ', priority: 9, type: 'chore', labels: ['a', 'a'] });
  assert.equal(mapped.title, 'X');
  assert.equal(mapped.priority, 4);
  assert.equal(mapped.type, 'chore');
  assert.deepEqual(mapped.labels, ['a', BRIDGE_LABEL, issueLabel('x')]);
  assert.throws(() => mapIssue({}), /issue.id is required/);
  assert.throws(() => mapIssue({ id: 'x' }), /issue.title is required/);
});

test('clampPriority keeps values in 1..4', () => {
  assert.equal(clampPriority(0), 1);
  assert.equal(clampPriority(9), 4);
  assert.equal(clampPriority('nope'), 2);
});

test('beadIssueId reads the bridge label', () => {
  assert.equal(beadIssueId({ labels: [issueLabel('iss-7')] }), 'iss-7');
  assert.equal(beadIssueId({ labels: ['other'] }), null);
  assert.equal(beadIssueId({}), null);
});

test('the plan splits create, update, and skip', () => {
  const plan = planBeadActions(issues, beads);
  assert.deepEqual(plan.create.map((c) => c.issue), ['iss-3']);
  assert.deepEqual(plan.update.map((u) => [u.issue, u.beadId, u.reasons.join(',')]), [['iss-2', 'me-2', 'title']]);
  assert.deepEqual(plan.skip.map((s) => [s.issue, s.beadId]), [['iss-1', 'me-1']]);
});

test('a synced store produces only skips (idempotency)', () => {
  const synced = issues.map((issue) => ({ id: `me-${issue.id}`, title: issue.title, priority: issue.priority, labels: [BRIDGE_LABEL, issueLabel(issue.id)] }));
  const plan = planBeadActions(issues, synced);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.update.length, 0);
  assert.equal(plan.skip.length, 3);
});

test('the commands are bd argument lists', () => {
  const commands = toBeadCommands(planBeadActions(issues, beads));
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(0, 6), ['bd', 'create', '--title', 'Third', '--type', 'task']);
  assert.ok(commands[0].includes('--label'));
  assert.deepEqual(commands[1].slice(0, 4), ['bd', 'update', 'me-2', '--title']);
});

test('the plan renders a dry run and an applied run', () => {
  const plan = planBeadActions(issues, beads);
  const dry = renderPlan(plan, { applied: false });
  assert.match(dry, /^Dry run\. create 1 · update 1 · skip 1$/m);
  assert.match(dry, /## Create/);
  assert.match(dry, /`iss-3` → Third/);
  const applied = renderPlan(plan, { applied: true });
  assert.match(applied, /^Applied\. create 1/m);
});

test('a missing title in a bead still counts as a difference', () => {
  const plan = planBeadActions([{ id: 'iss-9', title: 'T' }], [{ id: 'me-9', title: '', priority: 2, labels: [issueLabel('iss-9')] }]);
  assert.equal(plan.update.length, 1);
  assert.deepEqual(plan.update[0].reasons, ['title']);
});
