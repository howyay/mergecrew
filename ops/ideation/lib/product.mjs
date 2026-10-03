/**
 * Product-feature signals.
 *
 * The pipeline's job is product features. `docs/00-product/05-features.md` is
 * the product's own inventory: one table row per feature, with the persona it
 * serves and an implementation status. A row that says `Planned` is a feature
 * the product intends to have and does not — which is exactly the kind of idea
 * this pipeline should be proposing, with the doc line as its evidence.
 *
 * Two honesty rules, both learned the hard way:
 *
 *   1. The status is a *claim in a document*. It can be stale in either
 *      direction, so the specifier's verification stage checks the code before a
 *      human sees the card — nothing here asserts that a feature is missing.
 *   2. "Implemented (GitHub OAuth); email + Google Planned" is neither
 *      implemented nor planned: it is partially landed, and it is generated as
 *      its own source so the deck can say so.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const FEATURE_DOC_CANDIDATES = ['docs/00-product/05-features.md', 'docs/00-product/features.md'];

/**
 * Classify a status cell.
 *
 * Precedence, and why it matters: a cell that describes *any* partial landing
 * wins over the other words in it ("In progress (API endpoint exists, UI
 * Planned)" is in progress, not planned), and a cell that mixes something done
 * with something promised is partially landed, not done. Reading a half-built
 * feature as done is how a feature request gets silently dropped.
 */
export function classifyStatus(cell) {
  const s = String(cell ?? '').toLowerCase();
  if (!s.trim()) return 'unknown';
  const partial = /in progress|in-progress|partial|partially|wip/.test(s);
  const planned = /planned|not yet|todo/.test(s);
  const implemented = /implemented|shipped|done|working/.test(s);
  if (partial) return 'partial';
  if (planned && implemented) return 'partial';
  if (planned) return 'planned';
  if (implemented) return 'implemented';
  return 'unknown';
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Parse the feature inventory into rows.
 *
 * Pure, so the parsing rules are unit-testable without a repo: a feature table
 * that silently stopped parsing would look exactly like "no features left to
 * build", which is the worst possible failure for this source.
 */
export function parseFeatureDoc(markdown, { file = FEATURE_DOC_CANDIDATES[0] } = {}) {
  const rows = [];
  const sections = [];
  let section = null;
  let inTable = false;
  let header = null;

  String(markdown ?? '')
    .split('\n')
    .forEach((line, idx) => {
      const lineNo = idx + 1;
      const heading = /^##\s+(.+?)\s*$/.exec(line);
      if (heading) {
        section = { title: heading[1], line: lineNo };
        sections.push(section);
        inTable = false;
        header = null;
        return;
      }
      if (!line.trim().startsWith('|')) {
        inTable = false;
        header = null;
        return;
      }
      const cells = splitRow(line);
      if (isSeparator(cells)) return;
      if (!inTable) {
        inTable = true;
        header = cells.map((c) => c.toLowerCase());
        return;
      }
      const statusIdx = header.indexOf('status');
      const personaIdx = header.indexOf('persona');
      if (statusIdx === -1 || cells.length <= statusIdx) return;
      const feature = cells[0];
      if (!feature) return;
      rows.push({
        file,
        line: lineNo,
        section: section?.title ?? null,
        feature,
        persona: personaIdx >= 0 ? cells[personaIdx] || null : null,
        status: cells[statusIdx],
        state: classifyStatus(cells[statusIdx]),
      });
    });

  return {
    file,
    sections: sections.map((s) => s.title),
    rows,
    planned: rows.filter((r) => r.state === 'planned').length,
    partial: rows.filter((r) => r.state === 'partial').length,
    implemented: rows.filter((r) => r.state === 'implemented').length,
  };
}

/** Read the first feature doc that exists in the repo. */
export async function scanProduct(repo) {
  for (const rel of FEATURE_DOC_CANDIDATES) {
    let body;
    try {
      body = await readFile(path.join(repo, rel), 'utf8');
    } catch {
      continue;
    }
    return parseFeatureDoc(body, { file: rel });
  }
  return null;
}

/**
 * One idea per unfinished feature row.
 *
 * `perSection` keeps one fat section (Integrations has a dozen rows) from
 * filling the whole deck, and the doc's own order is preserved because it is
 * written most-important-first. Planned rows come before partial ones: shipping
 * something the product promised is a different motion from picking up
 * half-finished work, and mixing them in the queue hides that difference.
 */
export function productIdeas(signals, { limit = 12, perSection = 2 } = {}) {
  const doc = signals?.product;
  if (!doc?.rows?.length) return [];

  const planned = doc.rows.filter((r) => r.state === 'planned');
  const partial = doc.rows.filter((r) => r.state === 'partial');
  const out = [];
  const seen = new Map(); // section -> count, shared by both passes

  const push = (row, source) => {
    const key = row.section ?? '(no section)';
    const used = seen.get(key) ?? 0;
    if (used >= perSection) return false;
    seen.set(key, used + 1);
    const verb = source === 'product-feature' ? 'Ship' : 'Finish';
    const title = `${verb}: ${row.feature}`;
    out.push({
      source,
      kind: 'feature',
      title,
      persona: row.persona,
      section: row.section,
      rationale:
        source === 'product-feature'
          ? `${doc.file} lists this under "${row.section}" as Planned — designed, not built. It is part of the product's own inventory, so shipping it moves a user-visible surface rather than the plumbing behind one.`
          : `${doc.file} lists this under "${row.section}" as In progress: partially landed. Finishing it is cheaper than starting something new, but the doc's claim is a claim — the specifier checks what actually exists before this reaches a swipe.`,
      evidence: [`${row.file}:${row.line} | ${row.feature} | ${row.persona ?? '?'} | ${row.status}`, `section: ${row.section}`],
      // Deliberately coarse: the specifier re-scores with the effort it can
      // actually see in the code, and a wrong guess here would only pre-sort a
      // deck that is sorted again after specification.
      effortHint: source === 'product-feature' ? 'medium' : 'small',
    });
    return true;
  };

  for (const row of planned) push(row, 'product-feature');
  for (const row of partial) push(row, 'product-in-progress');

  return out.slice(0, limit);
}
