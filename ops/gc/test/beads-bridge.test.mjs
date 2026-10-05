// Tests for the MergeCrew <-> beads bridge. Zero dependencies: node --test.
//
//   node --test ops/gc/test/beads-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_LABEL,
  beadRef,
  buildDescription,
  clampPriority,
  issueLabel,
  issueRef,
  mapIssueToBead,
  parseBeadsJson,
  reconcile,
} from '../beads-bridge.mjs';

test('clampPriority keeps values in 1..4 and defaults to 2', () => {
  assert.equal(clampPriority(1), 1);
  assert.equal(clampPriority(3), 3);
  assert.equal(clampPriority(0), 1);
  assert.equal(clampPriority(9), 4);
  assert.equal(clampPriority(undefined), 2);
  assert.equal(clampPriority('2'), 2);
  assert.equal(clampPriority('nope'), 2);
});

test('mapIssueToBead produces stable bead fields', () => {
  const bead = mapIssueToBead({
    id: 'iss-42',
    title: 'Add swipe gate to the ideation pipeline',
    description: 'The gate must record the decision.',
    priority: 1,
    labels: ['feature'],
  });
  assert.equal(bead.title, 'Add swipe gate to the ideation pipeline');
  assert.equal(bead.priority, 1);
  assert.deepEqual(bead.labels.sort(), [BRIDGE_LABEL, issueLabel('iss-42'), 'feature'].sort());
  assert.equal(bead.externalRef, issueRef('iss-42'));
  assert.match(bead.description, /MergeCrew issue iss-42/);
  assert.match(bead.description, /mergecrew:issue:iss-42/);
});

test('mapIssueToBead rejects incomplete rows', () => {
  assert.throws(() => mapIssueToBead(null), /issue.id is required/);
  assert.throws(() => mapIssueToBead({ id: 'x' }), /issue.title is required/);
});

test('buildDescription tolerates a missing body', () => {
  const text = buildDescription({ id: 'iss-7', type: 'chore' });
  assert.match(text, /iss-7 \(chore\)/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test('beadRef reads the external ref first, then the label', () => {
  assert.equal(beadRef({ external_ref: 'mergecrew:issue:iss-1' }), 'mergecrew:issue:iss-1');
  assert.equal(beadRef({ labels: ['x', issueLabel('iss-2')] }), 'mergecrew:issue:iss-2');
  assert.equal(beadRef({ labels: ['unrelated'] }), null);
  assert.equal(beadRef({}), null);
});

test('reconcile reports missing beads, missing issues, and drift', () => {
  const issues = [
    { id: 'iss-1', title: 'One', priority: 2 },
    { id: 'iss-2', title: 'Two renamed', priority: 1 },
    { id: 'iss-3', title: 'Three', priority: 3 },
  ];
  const beads = [
    { id: 'me-11', title: 'One', priority: 2, external_ref: issueRef('iss-1'), labels: [BRIDGE_LABEL, issueLabel('iss-1')] },
    { id: 'me-12', title: 'Two old name', priority: 2, labels: [BRIDGE_LABEL, issueLabel('iss-2')] },
    { id: 'me-99', title: 'Orphan bead', priority: 2, labels: [BRIDGE_LABEL, issueLabel('iss-99')] },
  ];

  const report = reconcile(issues, beads);

  assert.deepEqual(report.counts, { issues: 3, beads: 3, onlyInIssues: 1, onlyInBeads: 1, differing: 1 });
  assert.equal(report.onlyInIssues[0].ref, issueRef('iss-3'));
  assert.equal(report.onlyInBeads[0].beadId, 'me-99');
  assert.equal(report.differing[0].beadId, 'me-12');
  assert.deepEqual(report.differing[0].diffs.sort(), ['priority', 'title']);
});

test('reconcile reports no drift when fields agree', () => {
  const issue = { id: 'iss-5', title: 'Same', priority: 4 };
  const bead = {
    id: 'me-55',
    title: 'Same',
    priority: 4,
    external_ref: issueRef('iss-5'),
    labels: [BRIDGE_LABEL, issueLabel('iss-5')],
  };
  const report = reconcile([issue], [bead]);
  assert.deepEqual(report.counts, { issues: 1, beads: 1, onlyInIssues: 0, onlyInBeads: 0, differing: 0 });
});

test('reconcile flags a bead that lost the bridge label', () => {
  const issue = { id: 'iss-6', title: 'Same', priority: 2 };
  const bead = { id: 'me-66', title: 'Same', priority: 2, external_ref: issueRef('iss-6'), labels: [] };
  const report = reconcile([issue], [bead]);
  assert.equal(report.counts.differing, 1);
  assert.deepEqual(report.differing[0].diffs, ['labels']);
});

test('parseBeadsJson accepts the shapes bd returns', () => {
  assert.deepEqual(parseBeadsJson('[{"id":"a"}]'), [{ id: 'a' }]);
  assert.deepEqual(parseBeadsJson('{"issues":[{"id":"b"}]}'), [{ id: 'b' }]);
  assert.deepEqual(parseBeadsJson('{"schema_version":1}'), []);
});
