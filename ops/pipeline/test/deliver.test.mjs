/**
 * The deliverable is what a human actually reads at the review gate, so the
 * property under test is honesty: the markdown must never claim more than the
 * earlier stages recorded. A missing recording stays missing, a missing agent
 * report stays missing, and a technical change is never dressed up as a demo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DELIVER_KINDS, deliverKind, deliverPath, deliverable, readAgentReport, summarizeReport } from '../lib/deliver.mjs';

const AT = '2026-10-03T10:00:00.000Z';

const featureIdea = {
  id: 'idea-abc12345',
  title: 'Late invoices',
  kind: 'feature',
  rationale: 'Finance chases these by hand every month.',
};

const featureStages = {
  prd: { acceptance: ['The list shows invoices older than 30 days', 'A reminder can be sent from the row'] },
  issue: { url: 'https://git.yay.how/haoye/mergecrew/issues/7' },
  worktree: { dir: '.worktrees/idea-abc12345', branch: 'idea/abc12345-late-invoices' },
  dev: { status: 'done', commit: '2f67d76498e3c51731e4c35709f24b077e2fafaf', commitFiles: 3, report: 'ops/pipeline/state/agent-reports/idea-abc12345.md' },
  qa: { verdict: 'pass', demo: 'ops/pipeline/uat/idea-abc12345/demo.png', report: 'ops/pipeline/uat/idea-abc12345/uat.md' },
};

test('deliverKind decides from who the change is for', () => {
  assert.deepEqual(DELIVER_KINDS, ['feature', 'technical']);
  assert.equal(deliverKind({ kind: 'feature' }), 'feature');
  assert.equal(deliverKind({ kind: 'technical' }), 'technical');
  assert.equal(deliverKind({ kind: 'refactor' }), 'technical');
  // A proposal that never declared a kind is a feature by default: an
  // undeclared refactor is the exception, not the rule.
  assert.equal(deliverKind({}), 'feature');
});

test('a feature deliverable shows the recording and the criteria it was standing on', () => {
  const out = deliverable({ idea: featureIdea, stages: featureStages, at: AT });

  assert.equal(out.kind, 'feature');
  assert.equal(out.demo, 'ops/pipeline/uat/idea-abc12345/demo.png');
  assert.equal(out.changelog, false);
  assert.match(out.markdown, /^# Demo: Late invoices$/m);
  assert.match(out.markdown, /## What to look at/);
  assert.match(out.markdown, /!\[demo\]\(demo\.png\)/);
  // Every criterion appears as an unchecked box — the human ticks them.
  assert.match(out.markdown, /- \[ \] The list shows invoices older than 30 days/);
  assert.match(out.markdown, /- \[ \] A reminder can be sent from the row/);
  // The recording is not evidence that the criteria hold, and the markdown says so.
  assert.match(out.markdown, /it does not assert this list/);
  assert.match(out.markdown, /- UAT: pass/);
  assert.match(out.markdown, /- Branch: `\.worktrees\/idea-abc12345` at 2f67d76498e3/);
  assert.match(out.markdown, /- Issue: https:\/\/git\.yay\.how\/haoye\/mergecrew\/issues\/7/);
  assert.match(out.markdown, /- Agent report: `ops\/pipeline\/state\/agent-reports\/idea-abc12345\.md`/);
  assert.match(out.markdown, /- UAT report: `ops\/pipeline\/uat\/idea-abc12345\/uat\.md`/);
  assert.match(out.markdown, /- delivered: 2026-10-03T10:00:00\.000Z/);
});

test('a feature with no recording says so instead of looking delivered', () => {
  const out = deliverable({
    idea: featureIdea,
    stages: { ...featureStages, qa: { verdict: 'blocked', demo: null } },
    at: AT,
  });

  assert.equal(out.demo, null);
  assert.match(out.markdown, /_No recording was made, so there is nothing to watch\._/);
  assert.match(out.markdown, /- Demo: none recorded/);
  assert.match(out.markdown, /- UAT: blocked/);
  assert.doesNotMatch(out.markdown, /!\[demo\]/);
});

test('a feature deliverable without acceptance criteria admits the PRD was empty', () => {
  const out = deliverable({ idea: featureIdea, stages: { ...featureStages, prd: {} }, at: AT });
  assert.match(out.markdown, /_The PRD carried no acceptance criteria\._/);
});

test('a technical deliverable is a changelog built from the agent own report', () => {
  const report = [
    'idea: idea-abc12345',
    'agent: dsh',
    'branch: idea/abc12345-late-invoices',
    '',
    '## Summary',
    '',
    'Moved the ageing window behind a policy read so per-project settings apply.',
    '',
    '## Verification',
    '',
    'node --test: 164 pass',
  ].join('\n');

  const out = deliverable({
    idea: { ...featureIdea, kind: 'technical' },
    stages: featureStages,
    reportText: report,
    at: AT,
  });

  assert.equal(out.kind, 'technical');
  assert.equal(out.changelog, true);
  // A refactor has no screenshot to show, and must not silently reuse one.
  assert.equal(out.demo, null);
  assert.match(out.markdown, /^# Changelog: Late invoices$/m);
  assert.match(out.markdown, /Moved the ageing window behind a policy read so per-project settings apply\./);
  assert.match(out.markdown, /## Why/);
  assert.match(out.markdown, /Finance chases these by hand every month\./);
  assert.match(out.markdown, /- Touches: 3 file\(s\)/);
  assert.doesNotMatch(out.markdown, /!\[demo\]/);
  assert.doesNotMatch(out.markdown, /## What to look at/);
  // The summary must stop at the next heading, not swallow the run log.
  assert.doesNotMatch(out.markdown, /node --test: 164 pass/);
});

test('a technical deliverable admits when the agent report is gone', () => {
  const out = deliverable({ idea: { ...featureIdea, kind: 'technical' }, stages: featureStages, reportText: null, at: AT });
  assert.equal(out.summary, null);
  assert.match(out.markdown, /_The agent report was missing or unreadable\._/);
});

test('summarizeReport pulls the summary section and stops at the next heading', () => {
  const text = [
    '## Summary',
    'Fixed the parked check.',
    'It now runs in CI.',
    '',
    '## Evidence',
    '7 files, 105 tests',
  ].join('\n');
  const summary = summarizeReport(text);
  assert.match(summary, /Fixed the parked check\./);
  assert.match(summary, /It now runs in CI\./);
  assert.doesNotMatch(summary, /Evidence/);
  assert.doesNotMatch(summary, /7 files, 105 tests/);
});

test('a summary section that opens with a subsection keeps its content', () => {
  // The real shape a dev agent writes: the section is one file, described one
  // level deeper. Stopping at the first heading returned nothing at all.
  const text = [
    '# AGENT_REPORT — idea-abc12345',
    '',
    '## What changed (file by file)',
    '### `ops/ci/checks.conf` (only source file changed)',
    '',
    'Before, the last two checks were parked behind a "Heavier suites" comment:',
    '',
    '## Real verification output',
    '7 files, 105 tests',
  ].join('\n');
  const summary = summarizeReport(text);
  assert.match(summary, /only source file changed/);
  assert.match(summary, /Before, the last two checks were parked/);
  assert.doesNotMatch(summary, /verification output/);
  assert.doesNotMatch(summary, /7 files, 105 tests/);
});

test('a report with no summary heading yields its opening, not "missing"', () => {
  const text = '# AGENT_REPORT — idea-abc12345\n\nEnable the parked check in ops/ci/checks.conf.';
  assert.match(summarizeReport(text), /Enable the parked check/);
  // An excerpt that ends on a fence opener must not swallow the changelog into
  // an empty code block.
  const fenced = summarizeReport('## Summary\nBefore:\n```', { maxLines: 2 });
  assert.doesNotMatch(fenced, /```/);
});

test('summarizeReport skips the report template meta and gives up on nothing', () => {
  assert.equal(summarizeReport(''), null);
  assert.equal(summarizeReport('   \n\n  '), null);
  assert.equal(summarizeReport(null), null);
  // Only the template header was filled in: that is not a description of work.
  assert.equal(summarizeReport('idea: idea-abc12345\nagent: dsh\nbranch: x\ndate: 2026-10-03'), null);
  const capped = summarizeReport(`## Summary\n${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}`, { maxLines: 3 });
  assert.equal(capped.split('\n').length, 4);
});

test('deliverPath keeps deliverables out of the agent worktree', () => {
  assert.equal(deliverPath('/repo', 'idea-abc12345'), '/repo/ops/pipeline/deliver/idea-abc12345.md');
});

test('readAgentReport reads the dev stage report from the repo, or returns null', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'deliver-read-'));
  try {
    await mkdir(path.join(repo, 'ops/pipeline/state/agent-reports'), { recursive: true });
    await writeFile(path.join(repo, 'ops/pipeline/state/agent-reports/idea-abc12345.md'), 'the agent said this\n');

    const found = await readAgentReport(repo, featureStages);
    assert.equal(found, 'the agent said this\n');

    assert.equal(await readAgentReport(repo, { dev: { report: 'ops/pipeline/state/agent-reports/gone.md' } }), null);
    assert.equal(await readAgentReport(repo, { dev: {} }), null);
    assert.equal(await readAgentReport(repo, {}), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
