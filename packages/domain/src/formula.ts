/**
 * Lifecycle template -> Gas City formula (ADR-0016 step 2).
 *
 * A stock lifecycle template is the authoring surface: a whole
 * `MergecrewConfig` with agent budgets, skill bindings and stack hints, editable
 * per project. A Gas City formula is the execution graph the city compiles into
 * beads. `ops/gc/formula-export.mjs` writes the formula file; this module answers
 * the question the product has to answer without shelling out — *which formula
 * does this lifecycle become, and what steps does it hold?*
 *
 * Both sides must agree, so `packages/domain/test/formula.test.ts` imports the
 * exporter and fails when the name or the step chain drifts.
 */

/** Every MergeCrew-owned formula is namespaced so a city listing stays readable. */
export const FORMULA_NAME_PREFIX = 'mol-mc-';

/** The exporter emits formula v2 graphs; an older city cannot compile them. */
export const FORMULA_COMPILER_REQUIREMENT = '>=2.0.0';

/** The exporter appends this step after the last agent to land the change. */
export const FORMULA_LANDING_STEP_ID = 'land';

/** One step of the exported formula, in execution order. */
export interface FormulaStep {
  /** Step id inside the formula (`slug(agent)` or `land`). */
  id: string;
  /** Agent name from the template's first workflow; null for the landing step. */
  agent: string | null;
  /** Agent kind (`Planner`, `Coder`, …); null for the landing step. */
  kind: string | null;
  /** Step ids this step waits for. The chain is linear. */
  needs: string[];
}

/** The formula a lifecycle template becomes. */
export interface TemplateFormula {
  formula: string;
  compiler: string;
  steps: FormulaStep[];
}

interface WorkflowShape {
  agents?: unknown;
}

interface AgentShape {
  kind?: unknown;
}

interface ConfigShape {
  lifecycle?: { workflows?: unknown };
  agents?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Slug rule, kept identical to `slug()` in `ops/gc/formula-export.mjs`: lower
 * case, runs of anything else collapse to a single dash, no leading or trailing
 * dash.
 */
export function formulaSlug(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `generic-careful` -> `mol-mc-generic-careful`. Throws on an empty id. */
export function formulaNameForTemplate(templateId: string): string {
  const slug = formulaSlug(templateId);
  if (!slug) throw new Error('formulaNameForTemplate: templateId is required');
  return `${FORMULA_NAME_PREFIX}${slug}`;
}

/**
 * Agent order of the first workflow. The exporter reads the same field, and it
 * throws rather than exporting a formula with no work in it.
 */
export function formulaWorkflowAgents(parsed: unknown): string[] {
  const config = (parsed ?? {}) as ConfigShape;
  const workflows = asArray(config.lifecycle?.workflows) as WorkflowShape[];
  if (workflows.length === 0) {
    throw new Error('formulaWorkflowAgents: lifecycle.workflows is empty');
  }
  const agents = asArray(workflows[0]?.agents);
  if (agents.length === 0) {
    throw new Error('formulaWorkflowAgents: the first workflow has no agents');
  }
  return agents.map(String);
}

function agentKind(parsed: unknown, agentName: string): string | null {
  const config = (parsed ?? {}) as ConfigShape;
  const agents = config.agents;
  if (!agents || typeof agents !== 'object') return null;
  const agent = (agents as Record<string, AgentShape | undefined>)[agentName];
  const kind = agent?.kind;
  return typeof kind === 'string' && kind ? kind : null;
}

/**
 * Steps the city runs: one per agent in the template's first workflow, in order,
 * then the landing step. The chain is linear — step N needs step N-1.
 */
export function formulaStepsForTemplate(template: {
  id: string;
  parsed?: unknown;
}): FormulaStep[] {
  if (!template?.id) throw new Error('formulaStepsForTemplate: template.id is required');
  const agents = formulaWorkflowAgents(template.parsed);
  const steps: FormulaStep[] = [];
  let previous: string | null = null;
  for (const agentName of agents) {
    const id = formulaSlug(agentName) || agentName;
    steps.push({
      id,
      agent: agentName,
      kind: agentKind(template.parsed, agentName),
      needs: previous ? [previous] : [],
    });
    previous = id;
  }
  steps.push({
    id: FORMULA_LANDING_STEP_ID,
    agent: null,
    kind: null,
    needs: previous ? [previous] : [],
  });
  return steps;
}

/** The whole answer the product needs about a template's formula. */
export function formulaForTemplate(template: {
  id: string;
  parsed?: unknown;
}): TemplateFormula {
  return {
    formula: formulaNameForTemplate(template.id),
    compiler: FORMULA_COMPILER_REQUIREMENT,
    steps: formulaStepsForTemplate(template),
  };
}
