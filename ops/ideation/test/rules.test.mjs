import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { deriveUntestedAreas, scanCiConfig } from '../lib/signals.mjs';
import { heuristicIdeas } from '../lib/generator.mjs';

const signals = (over = {}) => ({
  collectedAt: '2026-01-01T00:00:00.000Z',
  head: 'deadbeef',
  branch: 'main',
  recentCommits: [],
  commitCount: 10,
  fixishCommits: [],
  fixishRatio: 0,
  todos: { filesScanned: 0, total: 0, clusters: [] },
  backlog: null,
  ci: { status: 'pass', head: 'deadbeef', finishedAt: '2026-01-01T00:00:00.000Z', failedChecks: [] },
  ciConfig: { file: 'ops/ci/checks.conf', disabledChecks: [], deployHook: true, deployExample: true },
  untestedAreas: [],
  ...over,
});

test('deriveUntestedAreas finds ops areas without tests and ignores tested ones', () => {
  const files = [
    'ops/ci/ci-loop.mjs',
    'ops/execution/sandcastle-runner.mjs',
    'ops/execution/helper.sh',
    'ops/ideation/lib/signals.mjs',
    'ops/ideation/lib/generator.mjs',
    'ops/ideation/test/signals.test.mjs',
    'ops/README.md',
    'apps/api/src/x.ts',
    'packages/domain/src/y.ts',
  ];
  const areas = deriveUntestedAreas(files);
  assert.deepEqual(
    areas.map((a) => a.dir),
    ['ops/execution', 'ops/ci'],
    'sorted by source count, tested areas excluded',
  );
  assert.deepEqual(areas[0].sourceFiles, ['ops/execution/helper.sh', 'ops/execution/sandcastle-runner.mjs']);
  assert.equal(areas[0].sourceCount, 2);
  assert.equal(areas.some((a) => a.dir === 'ops/ideation'), false, 'ops/ideation has test/');
  assert.equal(areas.some((a) => a.dir === 'apps/api'), false, 'only ops/ is considered');
  assert.deepEqual(deriveUntestedAreas([]), []);
});

test('scanCiConfig reports commented-out checks and the deploy hook state', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'ciconf-'));
  try {
    await mkdir(path.join(repo, 'ops', 'ci'), { recursive: true });
    await writeFile(
      path.join(repo, 'ops', 'ci', 'checks.conf'),
      ['# primitive CI checks, one shell command per line', '', 'node --test "x/*.test.mjs"', '', '# pnpm -w typecheck  # slow but real', '# pnpm --filter @mergecrew/domain test'].join('\n'),
    );
    await writeFile(path.join(repo, 'ops', 'ci', 'deploy.sh.example'), '#!/bin/sh\n');

    const cfg = await scanCiConfig(repo);
    assert.equal(cfg.file, 'ops/ci/checks.conf');
    assert.deepEqual(cfg.disabledChecks, [
      { line: 5, command: 'pnpm -w typecheck' },
      { line: 6, command: 'pnpm --filter @mergecrew/domain test' },
    ]);
    assert.equal(cfg.deployHook, false);
    assert.equal(cfg.deployExample, true);
    assert.equal(await scanCiConfig(repo, { checksFile: 'ops/ci/nope.conf' }), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a disabled check becomes an idea with line-precise evidence', () => {
  const ideas = heuristicIdeas(
    signals({
      ciConfig: {
        file: 'ops/ci/checks.conf',
        disabledChecks: [{ line: 5, command: 'pnpm -w typecheck' }],
        deployHook: true,
        deployExample: true,
      },
    }),
  );
  const idea = ideas.find((i) => i.source === 'disabled-check');
  assert.ok(idea, 'expected a disabled-check idea');
  assert.equal(idea.evidence[0], 'ops/ci/checks.conf:5 pnpm -w typecheck');
  assert.match(idea.title, /pnpm -w typecheck/);
  assert.equal(idea.band, 'should', `score ${idea.score}`);
  assert.notEqual(idea.band, 'must', 'housekeeping must not outrank a red trunk');
});

test('an unused deploy hook becomes an idea, and disappears once enabled', () => {
  const missing = heuristicIdeas(
    signals({ ciConfig: { file: 'ops/ci/checks.conf', disabledChecks: [], deployHook: false, deployExample: true } }),
  );
  const idea = missing.find((i) => i.source === 'deploy-hook');
  assert.ok(idea, 'expected a deploy-hook idea');
  assert.deepEqual(idea.evidence, ['ops/ci/deploy.sh.example exists', 'ops/ci/deploy.sh missing']);

  const enabled = heuristicIdeas(
    signals({ ciConfig: { file: 'ops/ci/checks.conf', disabledChecks: [], deployHook: true, deployExample: true } }),
  );
  assert.equal(enabled.some((i) => i.source === 'deploy-hook'), false);

  const noExample = heuristicIdeas(
    signals({ ciConfig: { file: 'ops/ci/checks.conf', disabledChecks: [], deployHook: false, deployExample: false } }),
  );
  assert.equal(noExample.some((i) => i.source === 'deploy-hook'), false, 'nothing to enable without the example');
});

test('untested ops areas become ideas citing the real source files', () => {
  const ideas = heuristicIdeas(
    signals({
      untestedAreas: [
        { dir: 'ops/execution', sourceFiles: ['ops/execution/a.mjs', 'ops/execution/b.mjs'], sourceCount: 2 },
        { dir: 'ops/ci', sourceFiles: ['ops/ci/ci-loop.mjs'], sourceCount: 1 },
      ],
    }),
  );
  const areas = ideas.filter((i) => i.source === 'untested-area');
  assert.equal(areas.length, 2);
  assert.match(areas[0].title, /ops\/execution/);
  assert.deepEqual(areas[0].evidence, ['ops/execution/a.mjs', 'ops/execution/b.mjs']);
  assert.equal(areas[0].effortHint, 'medium');
  assert.equal(areas[1].effortHint, 'small');
});

test('a green trunk with a clean config still produces evidence-backed ideas', () => {
  const ideas = heuristicIdeas(
    signals({
      ciConfig: {
        file: 'ops/ci/checks.conf',
        disabledChecks: [{ line: 5, command: 'pnpm -w typecheck' }],
        deployHook: false,
        deployExample: true,
      },
      untestedAreas: [{ dir: 'ops/ci', sourceFiles: ['ops/ci/ci-loop.mjs'], sourceCount: 1 }],
    }),
  );
  assert.ok(ideas.length >= 3, `expected a non-empty deck, got ${ideas.length}`);
  for (const idea of ideas) {
    assert.ok(idea.evidence.length > 0, `${idea.source} must cite evidence`);
    assert.ok(idea.score > 0 && idea.score <= 100);
    assert.notEqual(idea.source, 'ci-failure', 'trunk is green');
  }
  // a green trunk must not produce a "fix the failing check" idea
  assert.equal(ideas.some((i) => i.source === 'ci-failure'), false);
});
