/**
 * The product feature inventory is the pipeline's default source of ideas, so
 * its parser is load-bearing: if it silently stops finding rows, the deck goes
 * quiet and everything looks healthy. These tests pin the parsing rules and the
 * honesty rules (a half-implemented feature is not "implemented").
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStatus, parseFeatureDoc, productIdeas } from '../lib/product.mjs';

const DOC = `# Features

Some prose that mentions Planned work but is not a table.

## Identity & tenancy

| Feature | Persona | Status |
| --- | --- | --- |
| Email + Google + GitHub OAuth | All | Implemented (GitHub OAuth); email + Google Planned |
| SAML/SCIM SSO | Enterprise | Planned |

## Projects

| Feature | Persona | Status |
| --- | --- | --- |
| Per-project policy | Mira | In progress |
| Multi-repo project | Mira | Planned |
| Project templates | Theo | Implemented |
`;

test('classifyStatus reads a mixed cell as partially landed, not done', () => {
  assert.equal(classifyStatus('Implemented (GitHub OAuth); email + Google Planned'), 'partial');
  assert.equal(classifyStatus('In progress (API endpoint exists; UI Planned)'), 'partial');
  assert.equal(classifyStatus('In progress (cost tracking Implemented; budgets Planned)'), 'partial');
  assert.equal(classifyStatus('Planned'), 'planned');
  assert.equal(classifyStatus('In progress'), 'partial');
  assert.equal(classifyStatus('Implemented'), 'implemented');
  assert.equal(classifyStatus(''), 'unknown');
});

test('parseFeatureDoc keeps line numbers, sections and personas for every row', () => {
  const doc = parseFeatureDoc(DOC, { file: 'docs/00-product/05-features.md' });
  assert.deepEqual(doc.sections, ['Identity & tenancy', 'Projects']);
  assert.equal(doc.rows.length, 5);
  const saml = doc.rows.find((r) => r.feature === 'SAML/SCIM SSO');
  assert.equal(saml.line, 10, 'line numbers are the evidence a human checks');
  assert.equal(saml.section, 'Identity & tenancy');
  assert.equal(saml.persona, 'Enterprise');
  assert.equal(saml.state, 'planned');
  assert.equal(doc.planned, 2);
  assert.equal(doc.partial, 2);
  assert.equal(doc.implemented, 1);
});


test('parseFeatureDoc ignores prose that looks like a status', () => {
  const doc = parseFeatureDoc(DOC);
  // Line 3 mentions "Planned" in prose; it must not become a row.
  assert.ok(!doc.rows.some((r) => r.line === 3));
});

test('productIdeas proposes unfinished work only, citing the doc line', () => {
  const doc = parseFeatureDoc(DOC, { file: 'docs/00-product/05-features.md' });
  const ideas = productIdeas({ product: doc }, { limit: 12, perSection: 2 });

  const titles = ideas.map((i) => i.title);
  assert.ok(titles.includes('Ship: SAML/SCIM SSO'));
  assert.ok(titles.includes('Finish: Per-project policy'));
  assert.ok(!titles.some((t) => /Project templates/.test(t)), 'Implemented rows are not proposed');
  // A mixed cell is proposed once, as unfinished work — never as "Ship".
  assert.ok(titles.includes('Finish: Email + Google + GitHub OAuth'));
  assert.ok(!titles.some((t) => /^Ship: Email/.test(t)));

  for (const idea of ideas) {
    assert.equal(idea.kind, 'feature');
    assert.ok(idea.evidence.some((e) => /docs\/00-product\/05-features\.md:\d+ \| /.test(e)));
  }
});

test('perSection keeps one fat section from filling the deck', () => {
  const doc = parseFeatureDoc(DOC);
  const ideas = productIdeas({ product: doc }, { limit: 12, perSection: 1 });
  const perSection = ideas.filter((i) => i.section === 'Projects');
  assert.equal(perSection.length, 1, 'one row per section when perSection is 1');
  // ...and the row that wins the slot is the planned one: shipping something the
  // product promised outranks picking up half-finished work.
  assert.equal(perSection[0].title, 'Ship: Multi-repo project');
});

test('planned features are proposed before half-finished ones', () => {
  const doc = parseFeatureDoc(DOC);
  const ideas = productIdeas({ product: doc }, { limit: 12, perSection: 2 });
  const sources = ideas.map((i) => i.source);
  assert.equal(sources[0], 'product-feature');
  assert.ok(sources.lastIndexOf('product-feature') < sources.indexOf('product-in-progress'));
});

test('a repo without a product doc proposes nothing rather than inventing features', () => {
  assert.deepEqual(productIdeas({ product: null }, {}), []);
  assert.deepEqual(productIdeas({}, {}), []);
  assert.deepEqual(productIdeas({ product: { rows: [] } }, {}), []);
});
