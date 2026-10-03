/**
 * Stage 5: the artifact a human reads at the review gate.
 *
 * What the deliverable *is* depends on who the change is for:
 *
 *   feature     a demo — the recording QA just made, the acceptance criteria it
 *               was standing on, and where to look. A user-facing change that
 *               cannot be watched is not delivered, it is claimed.
 *   chore       a changelog entry — what moved, why, and what proved it. A chore
 *               has no product surface: QA ran the repository's own checks, so
 *               there is no recording, and inventing one would cost a browser
 *               run to prove nothing.
 *   refactor    the same changelog, for the same reason: behaviour is meant to
 *               be unchanged, and the suite is what says so.
 *
 * The kind travels with the artifact (`deliverKind`) rather than being reduced to
 * "feature or not", because the deck has to label it for the human: a chore is
 * not a technical change that lost its label.
 *
 * Rendering is a pure function of the records the previous stages wrote, so the
 * markdown can never be richer than what actually happened: a missing demo stays
 * missing, and an unreadable agent report stays unread.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeKind, workflowFor } from '../../ideation/lib/kinds.mjs';

/** `technical` stays listed: it is the word older records still carry. */
export const DELIVER_KINDS = ['feature', 'chore', 'refactor', 'technical'];

/** Which deliverable an idea gets: the kind decides, and the kind is the record. */
export function deliverKind(idea = {}) {
  return normalizeKind(idea.kind);
}

/**
 * The agent report is free prose. Pull the part that describes the change and
 * give up honestly when there is nothing to pull.
 */
export function summarizeReport(text = '', { maxLines = 14 } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split('\n').map((l) => l.trimEnd());
  const start = lines.findIndex((l) => /^#{1,3}\s*(summary|what changed|what i did|change)\b/i.test(l));

  // Read one region into bullets. `stopAtLevel` is the heading depth that ends
  // it: a subsection inside the section we asked for is still the section
  // (`## What changed` / `### \`ops/ci/checks.conf\`` is one change, described).
  const read = (from, stopAtLevel) => {
    const kept = [];
    for (const line of lines.slice(from)) {
      const heading = line.match(/^(#{1,6})\s/);
      if (stopAtLevel && heading && heading[1].length <= stopAtLevel) break;
      if (!line.trim()) {
        if (kept.length) kept.push('');
        continue;
      }
      // Skip the meta header the report template starts with.
      if (/^\s*(idea|task|agent|provider|branch|worktree|date)\s*:/i.test(line)) continue;
      kept.push(line.trim());
      if (kept.length > maxLines) break;
    }
    return kept.join('\n').trim();
  };

  // An excerpt can end mid-code-block; left alone it would swallow the rest of
  // the changelog into a fence.
  const closeFences = (body) => {
    if (!body) return body;
    const kept = body.split('\n');
    const fences = kept.filter((l) => /^\s*```/.test(l)).length;
    if (fences % 2 === 0) return body;
    // The cut landed exactly on an opening fence: drop it rather than emit an
    // empty code block, otherwise close the block we are inside.
    if (/^\s*```/.test(kept[kept.length - 1])) return kept.slice(0, -1).join('\n').trim();
    return `${body}\n\`\`\``;
  };

  if (start !== -1) {
    const level = lines[start].match(/^(#+)/)?.[1].length ?? 1;
    const section = read(start + 1, level);
    if (section) return closeFences(section);
  }
  // No summary heading, or a section that was nothing but headings: fall back to
  // the opening of the report. It is still the agent's own first account of what
  // it did, which beats a changelog that says "missing".
  return closeFences(read(0, 0)) || null;
}

export function deliverable({ idea = {}, stages = {}, reportText = null, at = new Date().toISOString() } = {}) {
  const kind = deliverKind(idea);
  const workflow = workflowFor(kind);
  // The recording is the deliverable only when the workflow's deliverable *is* a
  // demo. A card that has a demo but a changelog deliverable (a chore re-classed
  // from a feature) must not ship the demo as its artifact.
  const isDemo = workflow.deliverable === 'demo';
  const checksRan = stages.qa?.mode === 'checks';
  const title = idea.title ?? idea.id;
  const demo = stages.qa?.demo ?? null;
  const branch = stages.worktree?.dir ?? null;
  const commit = stages.dev?.commit ?? null;
  const issue = stages.issue?.url ?? stages.issue?.file ?? null;
  const acceptance = stages.prd?.acceptance ?? [];
  const summary = summarizeReport(reportText);
  const bullets = [];

  // What was actually proved, named as the thing that proved it: "pass" from a
  // browser run and "pass" from the check list are different evidence, and the
  // human at the gate is entitled to know which one is in front of them.
  const qaSaid = checksRan ? 'Checks' : 'UAT';
  if (isDemo) {
    bullets.push(`Demo: ${demo ? `\`${demo}\`` : 'none recorded'}`);
    bullets.push(`${qaSaid}: ${stages.qa?.verdict ?? 'not run'}${stages.qa?.source === 'manual' ? ' (manual run)' : ''}`);
    bullets.push(`Branch: \`${branch ?? 'none'}\`${commit ? ` at ${commit.slice(0, 12)}` : ''}`);
  } else {
    const ran = (stages.qa?.results ?? []).filter((r) => r.status === 'passed').length;
    const skipped = (stages.qa?.skipped ?? []).length;
    bullets.push(
      `${qaSaid}: ${stages.qa?.verdict ?? 'not run'}${checksRan && ran ? ` (${ran} check(s) passed${skipped ? `, ${skipped} skipped` : ''})` : ''}`,
    );
    bullets.push(`Branch: \`${branch ?? 'none'}\`${commit ? ` at ${commit.slice(0, 12)}` : ''}`);
    bullets.push(`Touches: ${stages.dev?.commitFiles ?? 'unknown'} file(s)`);
  }
  if (issue) bullets.push(`Issue: ${issue}`);

  const lines = [`# ${isDemo ? 'Demo' : 'Changelog'}: ${title}`, ''];
  lines.push(`- idea: ${idea.id}`);
  lines.push(`- kind: ${kind}`);
  lines.push(`- delivered: ${at}`);
  lines.push('');

  if (isDemo) {
    lines.push('## What to look at', '');
    lines.push(demo ? `![demo](${path.basename(demo)})` : '_No recording was made, so there is nothing to watch._');
    lines.push('');
    lines.push('## Acceptance criteria', '');
    for (const item of acceptance) lines.push(`- [ ] ${item}`);
    if (!acceptance.length) lines.push('_The PRD carried no acceptance criteria._');
    lines.push('');
    lines.push('> The checkboxes are for the human at the review gate: the UAT drives the');
    lines.push('> product surface, it does not assert this list.');
  } else {
    lines.push('## What changed', '');
    lines.push(summary ?? '_The agent report was missing or unreadable._');
    lines.push('');
    lines.push('## Why', '');
    lines.push(
      idea.rationale ??
        idea.spec?.summary ??
        (stages.prd?.skipped ? stages.prd.reason : null) ??
        '_No rationale was recorded._',
    );
    if (checksRan && (stages.qa?.results ?? []).length) {
      lines.push('');
      lines.push('## Checks', '');
      lines.push('Run in the worktree, by `ops/ci/checks.conf` — the same list CI runs:');
      lines.push('');
      for (const r of stages.qa.results) lines.push(`- ${r.status === 'passed' ? '✅' : '❌'} \`${r.command}\``);
      for (const s of stages.qa.skipped ?? []) lines.push(`- ⏭️ \`${s.command}\` — ${s.reason}`);
    }
  }

  lines.push('', '## Evidence', '');
  for (const bullet of bullets) lines.push(`- ${bullet}`);
  if (stages.dev?.report) lines.push(`- Agent report: \`${stages.dev.report}\``);
  if (stages.qa?.report) lines.push(`- UAT report: \`${stages.qa.report}\``);

  return { kind, title, summary, bullets, demo: isDemo ? demo : null, changelog: !isDemo, markdown: `${lines.join('\n')}\n` };
}

export function deliverPath(repo, ideaId) {
  return path.join(repo, 'ops/pipeline/deliver', `${ideaId}.md`);
}

/** Read the agent report the dev stage wrote, if it is still there. */
export async function readAgentReport(repo, stages = {}) {
  const rel = stages.dev?.report;
  if (!rel) return null;
  try {
    return await readFile(path.join(repo, rel), 'utf8');
  } catch {
    return null;
  }
}
