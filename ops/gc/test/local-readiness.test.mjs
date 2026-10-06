// Tests for the local readiness check.
//
//   node --test ops/gc/test/local-readiness.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateReadiness,
  missingDist,
  renderReadiness,
  shippedFromDist,
  workspaceEntries,
} from '../local-readiness.mjs';

test('shippedFromDist sees a dist entry point', () => {
  assert.equal(shippedFromDist({ main: 'dist/index.js' }), true);
  assert.equal(shippedFromDist({ exports: { '.': { import: './dist/index.js' } } }), true);
  assert.equal(shippedFromDist({ types: 'dist/index.d.ts' }), true);
  assert.equal(shippedFromDist({ main: 'src/index.ts' }), false);
  assert.equal(shippedFromDist(undefined), false);
});

test('missingDist ignores a directory without a package.json', () => {
  assert.deepEqual(missingDist('/definitely/not/here', ['packages/ghost']), []);
});

test('workspaceEntries tolerates a missing group', () => {
  assert.deepEqual(workspaceEntries('/definitely/not/here'), []);
});

test('a ready machine has no blockers', () => {
  const verdict = evaluateReadiness({
    prismaClient: true,
    distMissing: [],
    gcInstalled: true,
    store: { ok: true, reason: 'city port 49943' },
  });
  assert.deepEqual(verdict, { ok: true, blockers: [] });
});

test('the Prisma client is a blocker, with the reason', () => {
  const verdict = evaluateReadiness({ prismaClient: false, distMissing: [], gcInstalled: true });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blockers, [
    'the Prisma client is not generated, so `pnpm --filter @mergecrew/api typecheck` cannot pass here',
  ]);
});

test('missing dist entries are named', () => {
  const verdict = evaluateReadiness({ prismaClient: true, distMissing: ['@mergecrew/skills', '@mergecrew/eventlog'], gcInstalled: true });
  assert.match(verdict.blockers[0], /2 workspace package\(s\) have no dist: @mergecrew\/skills, @mergecrew\/eventlog/);
});

test('a missing gc and a broken store are blockers', () => {
  const verdict = evaluateReadiness({ prismaClient: true, distMissing: [], gcInstalled: false, store: { ok: false, reason: 'no city port file' } });
  assert.deepEqual(verdict.blockers, ['gc is not on PATH', 'the store is not ready: no city port file']);
});

test('the report points at CI when a blocker exists', () => {
  const report = renderReadiness({
    prismaClient: false,
    distMissing: ['@mergecrew/skills'],
    gcInstalled: true,
    store: null,
    verdict: evaluateReadiness({ prismaClient: false, distMissing: ['@mergecrew/skills'], gcInstalled: true }),
  });
  assert.match(report, /^Prisma client generated: no$/m);
  assert.match(report, /Workspace packages without dist: 1 \(@mergecrew\/skills\)/);
  assert.match(report, /Run the heavy gates in CI\. The blockers:/);
  assert.match(report, /these are provisioning gaps, not code defects\. See `me-kgy`\./);
});

test('the report says the machine is ready when nothing blocks', () => {
  const report = renderReadiness({ prismaClient: true, distMissing: [], gcInstalled: true, store: { ok: true, reason: 'ok' }, verdict: { ok: true, blockers: [] } });
  assert.match(report, /The heavy gates can run on this machine\./);
});
