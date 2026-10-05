// Tests for the session contract gate.
//
//   node --test ops/gc/test/session-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_STATES,
  findStuckRouting,
  liveSessions,
  renderGate,
  routedBeads,
  runGate,
  stateSummary,
} from '../session-gate.mjs';

const now = Date.parse('2026-10-05T07:00:00Z');

const beads = [
  { id: 'me-1', status: 'open', metadata: { 'gc.routed_to': 'mergecrew/gastown.polecat' }, updated_at: '2026-10-05T06:50:00Z' },
  { id: 'me-2', status: 'open', metadata: { 'gc.routed_to': 'mergecrew/gastown.polecat' }, updated_at: '2026-10-05T06:30:00Z' },
  { id: 'me-3', status: 'open', metadata: { 'gc.routed_to': 'gastown.mayor' }, updated_at: '2026-10-05T06:58:00Z' },
  { id: 'me-4', status: 'closed', metadata: { 'gc.routed_to': 'mergecrew/gastown.polecat' }, updated_at: '2026-10-05T06:00:00Z' },
  { id: 'me-5', status: 'open', metadata: {} },
];

const sessions = [
  { id: 'ga-a', template: 'mergecrew/gastown.polecat', state: 'active' },
  { id: 'ga-b', template: 'mergecrew/gastown.witness', state: 'asleep' },
];

test('routedBeads keeps open work that names a target', () => {
  assert.deepEqual(routedBeads(beads).map((b) => b.id), ['me-1', 'me-2', 'me-3']);
});

test('liveSessions matches the target and a live state', () => {
  assert.deepEqual(liveSessions(sessions, 'mergecrew/gastown.polecat').map((s) => s.id), ['ga-a']);
  assert.deepEqual(liveSessions(sessions, 'gastown.mayor'), []);
  assert.deepEqual(LIVE_STATES, ['active', 'start-pending']);
});

test('a routed bead with a live session and a fresh stamp is fine', () => {
  const stuck = findStuckRouting({ beads: [beads[0]], sessions, now });
  assert.deepEqual(stuck, []);
});

test('a routed bead that waits too long is stuck even with a live session', () => {
  const stuck = findStuckRouting({ beads: [beads[1]], sessions, now, maxWaitingMinutes: 15 });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].bead, 'me-2');
  assert.match(stuck[0].reason, /waiting 30 minute\(s\) while 1 session\(s\) stay live/);
});

test('a routed bead with no live session is stuck', () => {
  const stuck = findStuckRouting({ beads: [beads[2]], sessions, now });
  assert.equal(stuck.length, 1);
  assert.match(stuck[0].reason, /no live session for the target after 2 minute\(s\)/);
});

test('a closed bead is not checked', () => {
  assert.deepEqual(findStuckRouting({ beads: [beads[3]], sessions, now }), []);
});

test('a bead without routing is not checked', () => {
  assert.deepEqual(findStuckRouting({ beads: [beads[4]], sessions, now }), []);
});

test('a session in start-pending counts as live', () => {
  const pending = [{ id: 'ga-c', template: 'mergecrew/gastown.polecat', state: 'start-pending' }];
  assert.deepEqual(findStuckRouting({ beads: [beads[0]], sessions: pending, now }), []);
});

test('stateSummary counts the states', () => {
  assert.deepEqual(stateSummary(sessions), { active: 1, asleep: 1 });
  assert.deepEqual(stateSummary([]), {});
});

test('runGate combines the sections', () => {
  const result = runGate({ beads, sessions, now, maxWaitingMinutes: 15 });
  assert.equal(result.routed.length, 3);
  assert.deepEqual(result.stuck.map((s) => s.bead), ['me-2', 'me-3']);
  assert.match(result.report, /Routed work items: 3/);
  assert.match(result.report, /`me-2` → mergecrew\/gastown\.polecat/);
});

test('a healthy city reports no stuck work', () => {
  const result = runGate({ beads: [beads[0]], sessions, now });
  assert.deepEqual(result.stuck, []);
  assert.match(renderGate({ routed: [], stuck: [], states: {}, maxWaitingMinutes: 15 }), /None\. Every routed work item has a live session\./);
});
