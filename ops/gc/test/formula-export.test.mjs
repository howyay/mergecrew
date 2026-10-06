// Tests for the MergeCrew lifecycle -> Gas City formula exporter.
//
//   node --test ops/gc/test/formula-export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPILER_REQUIREMENT,
  exportFormula,
  formulaName,
  renderFormulaToml,
  templateToFormula,
  tomlString,
  workflowAgents,
} from '../formula-export.mjs';

const genericCareful = {
  id: 'generic-careful',
  name: 'Generic (careful flow)',
  description: 'Planner, coder, reviewer.',
  stack: ['Generic'],
  parsed: {
    version: 1,
    lifecycle: { workflows: [{ id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] }] },
    agents: {
      planner: {
        kind: 'Planner',
        description: 'Reads the repo + intent and emits a structured markdown plan.',
        skills: ['repo.read_file', 'repo.search'],
        maxStepsPerRun: 8,
        maxToolCallsPerStep: 12,
      },
      coder: {
        kind: 'Coder',
        description: 'Implements the plan as a diff.',
        skills: ['repo.write_file', 'repo.git.commit', 'build.run_unit_tests'],
        maxStepsPerRun: 16,
        maxToolCallsPerStep: 20,
      },
      reviewer: {
        kind: 'Reviewer',
        description: 'Reviews the diff against the plan.',
        skills: ['repo.read_file'],
        maxStepsPerRun: 6,
        maxToolCallsPerStep: 8,
      },
    },
  },
};

test('formulaName slugs the template id', () => {
  assert.equal(formulaName('generic-careful'), 'mol-mc-generic-careful');
  assert.equal(formulaName('Next.js on Vercel'), 'mol-mc-next-js-on-vercel');
  assert.throws(() => formulaName(''), /templateId is required/);
});

test('workflowAgents reads the first workflow', () => {
  assert.deepEqual(workflowAgents(genericCareful.parsed), ['planner', 'coder', 'reviewer']);
  assert.throws(() => workflowAgents({ lifecycle: { workflows: [] } }), /workflows is empty/);
  assert.throws(() => workflowAgents({ lifecycle: { workflows: [{ agents: [] }] } }), /no agents/);
});

test('templateToFormula chains the steps with needs and adds the landing step', () => {
  const formula = templateToFormula(genericCareful);
  assert.equal(formula.formula, 'mol-mc-generic-careful');
  assert.equal(formula.compiler, COMPILER_REQUIREMENT);
  assert.deepEqual(
    formula.steps.map((s) => s.id),
    ['planner', 'coder', 'reviewer', 'land'],
  );
  assert.deepEqual(formula.steps[0].needs, []);
  assert.deepEqual(formula.steps[1].needs, ['planner']);
  assert.deepEqual(formula.steps[2].needs, ['coder']);
  assert.deepEqual(formula.steps[3].needs, ['reviewer']);
});

test('step text carries the tools and the budget', () => {
  const formula = templateToFormula(genericCareful);
  const coder = formula.steps.find((s) => s.id === 'coder');
  assert.match(coder.title, /^Coder:/);
  assert.match(coder.description, /repo\.write_file/);
  assert.match(coder.description, /16 steps, 20 tool calls per step/);
  assert.match(coder.description, /generic-careful/);
});

test('the landing step forbids a push to the default branch', () => {
  const formula = templateToFormula(genericCareful);
  const land = formula.steps.at(-1);
  assert.equal(land.id, 'land');
  assert.match(land.description, /pull request/i);
  assert.match(land.description, /Do not push to the default branch/);
});

test('the exporter is deterministic', () => {
  const a = exportFormula(genericCareful).toml;
  const b = exportFormula(genericCareful).toml;
  assert.equal(a, b);
});

test('the rendered TOML keeps the required sections', () => {
  const toml = exportFormula(genericCareful).toml;
  assert.match(toml, /^formula = "mol-mc-generic-careful"$/m);
  assert.match(toml, /^\[requires\]$/m);
  assert.match(toml, /^\[vars\.work_bead\]$/m);
  assert.match(toml, /^\[\[steps\]\]$/m);
  assert.match(toml, /^needs = \["planner"\]$/m);
});

test('a description with quotes and backslashes stays valid TOML', () => {
  const rendered = tomlString('say """hi""" on C:\\tmp');
  assert.match(rendered, /\\"\\"\\"/);
  assert.match(rendered, /C:\\\\tmp/);
  assert.ok(rendered.startsWith('"""\n'));
  assert.ok(rendered.trimEnd().endsWith('"""'));
});

test('renderFormulaToml escapes hostile text in a step title', () => {
  const formula = templateToFormula(genericCareful);
  formula.steps[0].title = 'weird "title" with \\ backslash';
  const toml = renderFormulaToml(formula);
  assert.match(toml, /title = "weird \\"title\\" with \\\\ backslash"/);
});

test('templateToFormula rejects an incomplete template', () => {
  assert.throws(() => templateToFormula({}), /template.id is required/);
  assert.throws(() => templateToFormula({ id: 'x' }), /template.parsed is required/);
});
