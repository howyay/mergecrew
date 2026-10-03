import assert from 'node:assert/strict';
import test from 'node:test';
import { generateIdeas, heuristicIdeas, ideaId, llmIdeas } from '../lib/generator.mjs';
import { RUBRIC } from '../lib/scorer.mjs';

const signals = (over = {}) => ({
  collectedAt: '2026-01-01T00:00:00.000Z',
  head: 'deadbeef',
  branch: 'main',
  recentCommits: ['fix: a', 'feat: b'],
  commitCount: 10,
  fixishCommits: ['fix: a'],
  fixishRatio: 0.3,
  todos: {
    filesScanned: 5,
    total: 4,
    clusters: [
      { dir: 'apps/api', count: 4, samples: ['apps/api/a.ts:1 TODO x'] },
      { dir: 'tiny', count: 2, samples: ['tiny/b.ts:3 FIXME y'] },
    ],
  },
  backlog: { file: 'UX-BACKLOG.md', open: 2, samples: ['ship A', 'ship B'] },
  ci: { status: 'fail', head: 'deadbeef', finishedAt: '2026-01-01T00:00:00.000Z', failedChecks: ['pnpm test'] },
  ...over,
});

test('ideaId is deterministic and source-qualified', () => {
  assert.equal(ideaId('backlog', 'Ship A'), ideaId('backlog', 'Ship A'));
  assert.notEqual(ideaId('backlog', 'Ship A'), ideaId('todo-cluster', 'Ship A'));
  assert.match(ideaId('backlog', 'Ship A'), /^idea-[0-9a-f]{8}$/);
});

test('a failing CI produces the top idea with a real failing command as evidence', () => {
  const ideas = heuristicIdeas(signals());
  const ci = ideas.find((i) => i.source === 'ci-failure');
  assert.ok(ci, 'expected a ci-failure idea');
  assert.match(ci.title, /pnpm test/);
  assert.ok(ci.evidence.some((e) => e.includes('status=fail')));
  assert.equal(ci.status, 'pending');
  assert.equal(ci.execution, null);
});

test('a missing CI record is its own idea (no silent "green branch" claim)', () => {
  const ideas = heuristicIdeas(signals({ ci: null }));
  assert.ok(ideas.some((i) => i.source === 'ci-missing'));
  assert.ok(!ideas.some((i) => i.source === 'ci-failure'));
});

test('TODO clusters below the threshold of 3 are not proposed', () => {
  const ideas = heuristicIdeas(signals());
  const dirs = ideas.filter((i) => i.source === 'todo-cluster').map((i) => i.title);
  assert.ok(dirs.some((t) => t.includes('apps/api')));
  assert.ok(!dirs.some((t) => t.includes('tiny')));
});

test('backlog items become ideas, each citing the backlog file', () => {
  const ideas = heuristicIdeas(signals());
  const backlog = ideas.filter((i) => i.source === 'backlog');
  assert.equal(backlog.length, 2);
  assert.ok(backlog.every((i) => i.evidence.includes('UX-BACKLOG.md open=2')));
});

test('fix churn produces a regression-test idea only above 25%', () => {
  assert.ok(heuristicIdeas(signals({ fixishRatio: 0.3 })).some((i) => i.source === 'fix-churn'));
  assert.ok(!heuristicIdeas(signals({ fixishRatio: 0.1 })).some((i) => i.source === 'fix-churn'));
});

test('every heuristic idea carries evidence, a bounded score and a band', () => {
  for (const idea of heuristicIdeas(signals())) {
    assert.ok(idea.evidence.length > 0, `${idea.title} has no evidence`);
    assert.ok(idea.score >= 0 && idea.score <= 100);
    assert.ok(['must', 'should', 'could', 'wont'].includes(idea.band));
    assert.deepEqual(Object.keys(idea.features).sort(), Object.keys(RUBRIC).sort());
  }
});

test('generation is deterministic and respects the limit', () => {
  const a = heuristicIdeas(signals());
  const b = heuristicIdeas(signals());
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  assert.equal(heuristicIdeas(signals(), { limit: 2 }).length, 2);
});

test('auto mode without LLM credentials uses the heuristic generator', async () => {
  delete process.env.IDEA_LLM_BASE_URL;
  delete process.env.IDEA_LLM_API_KEY;
  delete process.env.IDEA_LLM_MODEL;
  const result = await generateIdeas(signals(), { mode: 'auto' });
  assert.equal(result.generator, 'heuristic');
  assert.equal(result.fallbackReason, null);
  assert.ok(result.ideas.length > 0);
});

test('llm mode without credentials falls back and records why', async () => {
  delete process.env.IDEA_LLM_BASE_URL;
  delete process.env.IDEA_LLM_API_KEY;
  delete process.env.IDEA_LLM_MODEL;
  const result = await generateIdeas(signals(), { mode: 'llm' });
  assert.equal(result.generator, 'heuristic');
  assert.match(result.fallbackReason, /llm failed/);
  assert.ok(result.ideas.length > 0);
});

test('llmIdeas parses fenced JSON and clamps over-eager features', async () => {
  process.env.IDEA_LLM_BASE_URL = 'http://llm.invalid/v1';
  process.env.IDEA_LLM_API_KEY = 'test-key';
  process.env.IDEA_LLM_MODEL = 'test-model';

  let seenUrl = null;
  let seenBody = null;
  const fakeFetch = async (url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '```json\n{"ideas":[{"title":"Tighten retry budget","rationale":"because","evidence":["a.ts:1 x"],"effortHint":"small","features":{"impact":999,"confidence":15,"effort":10,"risk":5}}]}\n```',
            },
          },
        ],
      }),
    };
  };

  const ideas = await llmIdeas(signals(), { fetchImpl: fakeFetch });
  assert.equal(seenUrl, 'http://llm.invalid/v1/chat/completions');
  assert.equal(seenBody.model, 'test-model');
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].source, 'llm');
  assert.equal(ideas[0].features.impact, RUBRIC.impact);
  assert.equal(ideas[0].score, 40 + 15 + 10 + 5);
  assert.equal(ideas[0].band, 'should');

  delete process.env.IDEA_LLM_BASE_URL;
  delete process.env.IDEA_LLM_API_KEY;
  delete process.env.IDEA_LLM_MODEL;
});

test('an LLM http error falls back to heuristic instead of throwing', async () => {
  process.env.IDEA_LLM_BASE_URL = 'http://llm.invalid/v1';
  process.env.IDEA_LLM_API_KEY = 'test-key';
  process.env.IDEA_LLM_MODEL = 'test-model';

  const result = await generateIdeas(signals(), { mode: 'llm', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(result.generator, 'heuristic');
  assert.match(result.fallbackReason, /llm http 503/);
  assert.ok(result.ideas.some((i) => i.source === 'ci-failure'));

  delete process.env.IDEA_LLM_BASE_URL;
  delete process.env.IDEA_LLM_API_KEY;
  delete process.env.IDEA_LLM_MODEL;
});
