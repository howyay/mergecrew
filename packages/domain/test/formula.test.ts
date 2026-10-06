import { describe, expect, it } from 'vitest';
import {
  FORMULA_COMPILER_REQUIREMENT,
  FORMULA_LANDING_STEP_ID,
  FORMULA_NAME_PREFIX,
  STOCK_LIFECYCLE_TEMPLATES,
  formulaForTemplate,
  formulaNameForTemplate,
  formulaSlug,
  formulaStepsForTemplate,
  formulaWorkflowAgents,
} from '../src/index.js';
// The exporter is the other half of this contract. Importing it here is the
// point of the suite: the product and the CLI must name and order steps the
// same way, and this test fails when either side drifts.
import { formulaName, templateToFormula } from '../../../ops/gc/formula-export.mjs';

const CAREFUL = {
  id: 'generic-careful',
  parsed: {
    lifecycle: { workflows: [{ id: 'multi-agent', agents: ['planner', 'coder', 'reviewer'] }] },
    agents: {
      planner: { kind: 'Planner' },
      coder: { kind: 'Coder' },
      reviewer: { kind: 'Reviewer' },
    },
  },
};

describe('formulaSlug', () => {
  it('lower cases, collapses separators and trims dashes', () => {
    expect(formulaSlug('  Next.js Vercel ')).toBe('next-js-vercel');
    expect(formulaSlug('--a--b--')).toBe('a-b');
    expect(formulaSlug('!!!')).toBe('');
  });
});

describe('formulaNameForTemplate', () => {
  it('namespaces the slug', () => {
    expect(formulaNameForTemplate('generic-careful')).toBe('mol-mc-generic-careful');
    expect(formulaNameForTemplate('Next.js Vercel')).toBe('mol-mc-next-js-vercel');
    expect(FORMULA_NAME_PREFIX).toBe('mol-mc-');
  });

  it('refuses an empty id instead of emitting mol-mc-', () => {
    expect(() => formulaNameForTemplate('   ')).toThrow(/templateId is required/);
  });
});

describe('formulaWorkflowAgents', () => {
  it('reads the first workflow in order', () => {
    expect(formulaWorkflowAgents(CAREFUL.parsed)).toEqual(['planner', 'coder', 'reviewer']);
  });

  it('refuses a config with no workflow and a workflow with no agents', () => {
    expect(() => formulaWorkflowAgents({ lifecycle: { workflows: [] } })).toThrow(
      /workflows is empty/,
    );
    expect(() => formulaWorkflowAgents({ lifecycle: { workflows: [{ agents: [] }] } })).toThrow(
      /first workflow has no agents/,
    );
  });
});

describe('formulaStepsForTemplate', () => {
  it('chains the agents in order and ends with the landing step', () => {
    const steps = formulaStepsForTemplate(CAREFUL);
    expect(steps.map((s) => s.id)).toEqual(['planner', 'coder', 'reviewer', FORMULA_LANDING_STEP_ID]);
    expect(steps.map((s) => s.needs)).toEqual([[], ['planner'], ['coder'], ['reviewer']]);
    expect(steps.map((s) => s.kind)).toEqual(['Planner', 'Coder', 'Reviewer', null]);
    expect(steps[3]?.agent).toBeNull();
  });

  it('keeps an agent name that has no slug', () => {
    const steps = formulaStepsForTemplate({
      id: 'odd',
      parsed: { lifecycle: { workflows: [{ agents: ['???'] }] }, agents: {} },
    });
    expect(steps.map((s) => s.id)).toEqual(['???', FORMULA_LANDING_STEP_ID]);
    expect(steps[0]?.kind).toBeNull();
  });

  it('requires a template id', () => {
    expect(() => formulaStepsForTemplate({ id: '' })).toThrow(/template.id is required/);
  });
});

describe('formulaForTemplate', () => {
  it('answers with the name, the compiler requirement and the chain', () => {
    expect(formulaForTemplate(CAREFUL)).toEqual({
      formula: 'mol-mc-generic-careful',
      compiler: FORMULA_COMPILER_REQUIREMENT,
      steps: formulaStepsForTemplate(CAREFUL),
    });
  });
});

describe('parity with ops/gc/formula-export.mjs', () => {
  it('names every stock template the same way the exporter does', () => {
    for (const template of STOCK_LIFECYCLE_TEMPLATES) {
      expect(formulaNameForTemplate(template.id)).toBe(formulaName(template.id));
    }
  });

  it('produces the exporter step ids and needs for every stock template', () => {
    for (const template of STOCK_LIFECYCLE_TEMPLATES) {
      const exported = templateToFormula(template) as {
        steps: Array<{ id: string; needs: string[] }>;
      };
      expect(formulaStepsForTemplate(template).map((s) => s.id)).toEqual(
        exported.steps.map((s) => s.id),
      );
      expect(formulaStepsForTemplate(template).map((s) => s.needs)).toEqual(
        exported.steps.map((s) => s.needs),
      );
    }
  });

  it('covers the five stock templates the city has formulas for', () => {
    expect(STOCK_LIFECYCLE_TEMPLATES.map((t) => t.id).sort()).toEqual([
      'generic-careful',
      'go-fly',
      'nextjs-vercel',
      'python-render',
      'roster',
    ]);
  });
});
