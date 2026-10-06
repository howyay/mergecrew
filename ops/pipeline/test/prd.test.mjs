/**
 * Tests for PRD generation and forge detection.
 *
 * These lock the two properties the pipeline depends on: a PRD says nothing the
 * idea did not already say (no invented paths, no invented criteria), and
 * regenerating it from the same inputs produces the same bytes. Forge detection
 * is exercised with an injected `execImpl`, so no test touches a real remote.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acceptanceFor, buildPrd, detectForge, writePrd } from '../lib/prd.mjs';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/** The exact idea the pipeline is expected to handle, evidence and all. */
const idea = () => ({
  id: 'idea-740f1748',
  fingerprint: 'disabled-check:pnpm-filter-mergecrew-domain-test',
  title: '启用被注释掉的 CI 检查：pnpm --filter @mergecrew/domain test',
  source: 'disabled-check',
  evidence: ['ops/ci/checks.conf:12 pnpm --filter @mergecrew/domain test'],
  rationale:
    'ops/ci/checks.conf 第 12 行把这条检查注释掉了——它是被刻意跳过的门禁，不是不存在的门禁。',
  effortHint: 'small',
  features: { impact: 22, confidence: 14, effort: 20, risk: 12 },
  score: 68,
  band: 'should',
  status: 'accepted',
  createdAt: '2025-12-31T00:00:00.000Z',
  decidedAt: '2025-12-31T01:00:00.000Z',
});

/** Run `fn` with FORGEJO_URL set (or deleted), then restore the environment. */
const withForgejoUrl = async (value, fn) => {
  const previous = process.env.FORGEJO_URL;
  if (value === undefined) delete process.env.FORGEJO_URL;
  else process.env.FORGEJO_URL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FORGEJO_URL;
    else process.env.FORGEJO_URL = previous;
  }
};

const makeRepo = () => mkdtemp(path.join(tmpdir(), 'mergecrew-prd-'));

const SECTION_ORDER = [
  '## Summary',
  '## Problem',
  '## Evidence',
  '## Proposed change',
  '## Acceptance criteria',
  '## Out of scope',
  '## Risks',
  '## Verification',
];

const sectionOf = (prd, heading) => {
  const start = prd.indexOf(heading);
  const rest = prd.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
};

test('detectForge recognises an https github remote', () => {
  const calls = [];
  const forge = detectForge({
    repo: '/repo',
    remote: 'origin',
    execImpl: (remote, repo) => {
      calls.push([remote, repo]);
      return 'https://github.com/howyay/mergecrew.git\n';
    },
  });
  assert.deepEqual(calls, [['origin', '/repo']]);
  assert.equal(forge.provider, 'github');
  assert.equal(forge.remote, 'origin');
  assert.equal(forge.owner, 'howyay');
  assert.equal(forge.name, 'mergecrew', 'a trailing .git must be stripped');
  assert.equal(forge.host, 'github.com');
  assert.equal(forge.url, 'https://github.com');
  assert.equal(typeof forge.reason, 'string');
});

test('detectForge recognises the scp-style ssh form and the named remote', () => {
  const seen = [];
  const forge = detectForge({
    remote: 'upstream',
    execImpl: (remote) => {
      seen.push(remote);
      return { status: 0, stdout: 'git@github.com:mergecrew/mergecrew.git\n', stderr: '' };
    },
  });
  assert.deepEqual(seen, ['upstream'], 'the fork/main choice is the remote name');
  assert.equal(forge.provider, 'github');
  assert.equal(forge.owner, 'mergecrew');
  assert.equal(forge.name, 'mergecrew');
  assert.equal(forge.remote, 'upstream');
});

test('detectForge treats a non-github host as forgejo', async () => {
  // Pinned to the default: these assertions describe what happens with no API
  // base configured, and the pipeline service exports a FORGEJO_URL of its own.
  await withForgejoUrl(undefined, () => {
    const local = detectForge({ execImpl: () => 'http://localhost:3000/acme/widgets.git' });
    assert.equal(local.provider, 'forgejo');
    assert.equal(local.host, 'localhost:3000');
    assert.equal(local.url, 'http://localhost:3000', 'the API base keeps the real scheme and port');
    assert.equal(local.owner, 'acme');
    assert.equal(local.name, 'widgets');

    const custom = detectForge({ execImpl: () => 'https://git.example.com/team/project.git' });
    assert.equal(custom.provider, 'forgejo');
    assert.equal(custom.url, 'https://git.example.com');

    const mounted = detectForge({
      execImpl: () => 'https://forge.example.com/forgejo/team/project.git',
    });
    assert.equal(mounted.provider, 'forgejo');
    assert.equal(
      mounted.url,
      'https://forge.example.com/forgejo',
      'a /forgejo mount is part of the API base',
    );
    assert.equal(mounted.owner, 'team');
    assert.equal(mounted.name, 'project');
  });
});

test('detectForge honours an explicit FORGEJO_URL and never overrides github.com', async () => {
  await withForgejoUrl('https://forge.internal/', () => {
    const forge = detectForge({ execImpl: () => 'https://git.example.com/team/project.git' });
    assert.equal(forge.provider, 'forgejo');
    assert.equal(forge.url, 'https://forge.internal', 'trailing slash trimmed');
    assert.match(forge.reason, /FORGEJO_URL/);

    const ssh = detectForge({ execImpl: () => 'git@git.example.com:team/project.git' });
    assert.equal(ssh.provider, 'forgejo');
    assert.equal(
      ssh.url,
      'https://forge.internal',
      'ssh gives no http base, so the override supplies it',
    );

    const github = detectForge({ execImpl: () => 'git@github.com:howyay/mergecrew.git' });
    assert.equal(github.provider, 'github');
    assert.equal(github.url, 'https://github.com');
  });
});

test('detectForge reports none with the real reason', async () => {
  // Same pin as above: the ssh case asserts there is no API base to fall back
  // to, which only means anything if this process has none either.
  await withForgejoUrl(undefined, () => {
    const missing = detectForge({
      execImpl: () => ({ status: 128, stdout: '', stderr: 'error: No such remote' }),
    });
    assert.equal(missing.provider, 'none');
    assert.equal(missing.url, null);
    assert.match(missing.reason, /No such remote/);

    const threw = detectForge({
      execImpl: () => {
        throw new Error('not a git repository');
      },
    });
    assert.equal(threw.provider, 'none');
    assert.match(threw.reason, /not a git repository/);

    const localPath = detectForge({ execImpl: () => '/srv/git/mergecrew.git' });
    assert.equal(localPath.provider, 'none');
    assert.match(localPath.reason, /local path/);

    const noOwner = detectForge({ execImpl: () => 'git@github.com:mergecrew.git' });
    assert.equal(noOwner.provider, 'none');
    assert.match(noOwner.reason, /owner\/name/);

    const sshForgeWithoutBase = detectForge({
      execImpl: () => 'git@git.example.com:team/project.git',
    });
    assert.equal(sshForgeWithoutBase.provider, 'forgejo');
    assert.equal(sshForgeWithoutBase.url, null, 'an ssh remote must not fabricate an http base');
    assert.match(sshForgeWithoutBase.reason, /FORGEJO_URL/);
  });
});

test('buildPrd emits every required section in order', () => {
  const prd = buildPrd(idea(), { repo: '/srv/mergecrew', now: FIXED_NOW });
  assert.ok(prd.startsWith('# 启用被注释掉的 CI 检查'), 'the H1 is the idea title');
  let cursor = -1;
  for (const heading of SECTION_ORDER) {
    const at = prd.indexOf(`\n${heading}\n`);
    assert.ok(at > cursor, `${heading} must appear after the previous section`);
    cursor = at;
  }
});

test('buildPrd quotes the evidence verbatim and adds the CI head when signals exist', () => {
  const plain = buildPrd(idea(), { now: FIXED_NOW });
  for (const line of idea().evidence)
    assert.ok(plain.includes(`- ${line}`), `evidence verbatim: ${line}`);

  const withCi = buildPrd(idea(), {
    now: FIXED_NOW,
    signals: {
      ci: {
        status: 'fail',
        head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        finishedAt: '2025-12-31T23:00:00.000Z',
        failedChecks: ['node --test "ops/ideation/test/*.test.mjs"'],
      },
    },
  });
  assert.match(withCi, /CI head `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` \(status fail/);
  assert.match(withCi, /CI failing check: `node --test "ops\/ideation\/test\/\*\.test\.mjs"`/);

  const noCi = buildPrd(idea(), { now: FIXED_NOW, signals: { ci: null } });
  assert.ok(!noCi.includes('CI head'), 'a missing CI signal invents nothing');
  assert.ok(!noCi.includes('CI failing check'));
});

test('buildPrd acceptance criteria come only from the evidence and the rubric', () => {
  const current = idea();
  const prd = buildPrd(current, { now: FIXED_NOW });
  const section = sectionOf(prd, '## Acceptance criteria');
  const boxes = section.split('\n').filter((l) => l.startsWith('- [ ] '));
  assert.equal(boxes.length, acceptanceFor(current).length);
  assert.equal(
    boxes.length,
    current.evidence.length + 4,
    'one box per evidence line and per rubric axis',
  );
  for (const line of current.evidence) assert.ok(section.includes(line));
  assert.ok(section.includes('impact 22/40'), 'rubric axes are quoted with their ceilings');
  assert.ok(!/src\/|apps\/|packages\//.test(section), 'no path that the idea did not cite');
  assert.ok(!prd.includes('src/'), 'the document invents no files the evidence does not name');
});

test('acceptanceFor traces every entry to one recorded input', () => {
  const entries = acceptanceFor(idea());
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    assert.match(entry, /^(Evidence resolved: |Rubric axis preserved: )/);
  }
  assert.ok(entries[0].includes(idea().evidence[0]));

  // With stored reasons, those exact strings are used instead of derived axes.
  const stored = acceptanceFor({ ...idea(), scoreReasons: ['impact 22/40', 'confidence 14/20'] });
  assert.deepEqual(stored.slice(1), [
    'Rubric axis preserved: impact 22/40',
    'Rubric axis preserved: confidence 14/20',
  ]);

  // No evidence and no rubric inputs must stay empty: padding would look approved.
  assert.deepEqual(acceptanceFor({ id: 'idea-x', title: 't' }), []);
  const emptyPrd = buildPrd({ id: 'idea-x', title: 't', rationale: 'r' }, { now: FIXED_NOW });
  assert.match(sectionOf(emptyPrd, '## Acceptance criteria'), /cannot be called done/);
});

test('buildPrd is deterministic for a fixed now and records the metadata', () => {
  const first = buildPrd(idea(), { repo: '/srv/mergecrew', now: FIXED_NOW });
  const second = buildPrd(idea(), { repo: '/srv/mergecrew', now: FIXED_NOW });
  assert.equal(first, second);
  assert.ok(first.endsWith('\n'));
  assert.ok(first.includes('- idea: `idea-740f1748`'));
  assert.ok(first.includes('- source: `disabled-check`'));
  assert.ok(first.includes('- score: 68 (band `should`)'));
  assert.ok(first.includes('- generated: 2026-01-01T00:00:00.000Z'));

  const later = buildPrd(idea(), {
    repo: '/srv/mergecrew',
    now: new Date('2026-01-02T00:00:00.000Z'),
  });
  assert.notEqual(later, first, 'the timestamp is the only thing the clock may change');
  assert.equal(later.replace('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), first);

  assert.throws(() => buildPrd(idea(), { now: 'not a date' }), /invalid now: not a date/);
});

test('buildPrd verification defaults to the repo gate and keeps it for custom commands', () => {
  const fallback = sectionOf(buildPrd(idea(), { now: FIXED_NOW }), '## Verification');
  assert.ok(fallback.includes('node --test "ops/**/test/*.test.mjs"'));
  assert.ok(fallback.includes('node ops/ci/ci-loop.mjs --once'));
  assert.ok(fallback.includes('```bash'));

  const custom = sectionOf(
    buildPrd(idea(), { now: FIXED_NOW, verifyCommands: ['pnpm --filter @mergecrew/domain test'] }),
    '## Verification',
  );
  assert.ok(custom.includes('pnpm --filter @mergecrew/domain test'));
  assert.ok(!custom.includes('ops/**/test'), 'custom commands replace the default glob');
  assert.ok(
    custom.includes('node ops/ci/ci-loop.mjs --once'),
    'the primitive CI run always applies',
  );
});

test('buildPrd falls back to a generic plan for an unknown source', () => {
  const prd = buildPrd({ ...idea(), source: 'mystery-signal' }, { now: FIXED_NOW });
  assert.match(prd, /Implement the smallest change that makes the evidence above stop being true/);
  assert.ok(
    !prd.includes('Un-comment the check'),
    'a source-specific plan is not reused for another source',
  );
});

test('writePrd round-trips byte-identically and leaves no tmp file', async () => {
  const repo = await makeRepo();
  try {
    const prd = buildPrd(idea(), { repo, now: FIXED_NOW });
    const { file, bytes } = await writePrd({ repo, idea: idea(), prd });
    assert.equal(file, 'ops/pipeline/prd/idea-740f1748.md');
    assert.equal(bytes, Buffer.byteLength(prd, 'utf8'));
    assert.equal(await readFile(path.join(repo, file), 'utf8'), prd);
    await assert.rejects(
      stat(`${path.join(repo, file)}.tmp`),
      'the .tmp file must be renamed away',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('writePrd refuses to write an anonymous PRD', async () => {
  await assert.rejects(writePrd({ idea: {}, prd: 'x' }), /idea\.id is required/);
  await assert.rejects(writePrd({ idea: { id: 'idea-1' }, prd: null }), /prd must be a string/);
});
