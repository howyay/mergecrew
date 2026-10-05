// Tests for the pull-request packet renderer.
//
//   node --test ops/gc/test/pr-packet.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { REVIEW_CHECKLIST, renderPacket } from '../pr-packet.mjs';

const base = {
  branch: 'gc/orders-export',
  base: 'main',
  commit: '678e6c4abcdef1234567890',
  files: ['ops/gc/orders-export.mjs', 'ops/gc/test/orders-export.test.mjs'],
  tests: [{ file: 'ops/gc/test/orders-export.test.mjs', passed: 8, failed: 0 }],
  summary: 'feat(gc): export MergeCrew schedules as Gas City orders',
  createdAt: '2026-10-05',
};

test('the packet names the branch, the base, and the commit', () => {
  const text = renderPacket(base);
  assert.match(text, /^# `gc\/orders-export`$/m);
  assert.match(text, /Base: `main` · Commit: `678e6c4abcde`/);
});

test('the packet lists the files and the check results', () => {
  const text = renderPacket(base);
  assert.match(text, /`ops\/gc\/orders-export\.mjs`/);
  assert.match(text, /\*\*PASS\*\* `ops\/gc\/test\/orders-export\.test\.mjs` — 8 passed, 0 failed/);
});

test('the packet carries the review checklist', () => {
  const text = renderPacket(base);
  for (const item of REVIEW_CHECKLIST) assert.ok(text.includes(`- [ ] ${item}`), `missing: ${item}`);
  assert.match(text, /five minutes/);
});

test('a passing run gives a ready conclusion', () => {
  const text = renderPacket(base);
  assert.match(text, /\*\*Ready for review\.\*\* Every recorded check passed\./);
  assert.doesNotMatch(text, /Needs revision/);
});

test('a failing run blocks the conclusion', () => {
  const text = renderPacket({ ...base, tests: [{ file: 'ops/gc/test/x.test.mjs', passed: 3, failed: 1 }] });
  assert.match(text, /\*\*FAIL\*\* `ops\/gc\/test\/x\.test\.mjs` — 3 passed, 1 failed/);
  assert.match(text, /\*\*Needs revision\.\*\* A test failed/);
});

test('an empty run states the gap instead of claiming success', () => {
  const text = renderPacket({ ...base, tests: [], files: [] });
  assert.match(text, /No test file ran\. State the reason/);
  assert.match(text, /No file changes were found\./);
});

test('the renderer requires a branch and a commit', () => {
  assert.throws(() => renderPacket({ commit: 'abc' }), /branch is required/);
  assert.throws(() => renderPacket({ branch: 'x' }), /commit is required/);
});

test('a missing summary is stated, not invented', () => {
  const text = renderPacket({ ...base, summary: '   ' });
  assert.match(text, /No commit summary was found\./);
});
