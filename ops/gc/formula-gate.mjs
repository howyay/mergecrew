// Gas City formula gate. ADR-0016 step 2, second slice.
//
// A formula is the only workflow definition. A broken one fails at dispatch, in front of an agent, at
// the worst moment. This gate compiles every exported formula and checks the graph first: one root,
// unique ids, known dependencies, no cycle, and every step reachable. Zero dependencies.
//
// Usage:
//   node ops/gc/formula-gate.mjs [--city-dir=/home/haoye/gascity] [--expect=mol-mc-generic-careful]
//
// Test: node --test ops/gc/test/formula-gate.test.mjs

/** Find a cycle in the graph. Returns the offending ids, or an empty list. */
export function findCycle(steps, deps) {
  const edges = new Map(steps.map((s) => [s.id, []]));
  for (const dep of deps) {
    if (edges.has(dep.step_id) && edges.has(dep.depends_on_id)) {
      edges.get(dep.step_id).push(dep.depends_on_id);
    }
  }
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'open');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return [];
}

/** Check one compiled formula as `gc formula show <name> --json` returns it. */
export function checkFormula(compiled) {
  const problems = [];
  if (!compiled || compiled.ok !== true) return ['the formula did not compile'];
  const name = compiled.name ?? '(unnamed)';
  const steps = Array.isArray(compiled.steps) ? compiled.steps : [];
  const deps = Array.isArray(compiled.deps) ? compiled.deps : [];

  if (steps.length === 0) problems.push('the formula has no steps');

  const ids = steps.map((s) => s.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) problems.push('a step id repeats');

  const roots = steps.filter((s) => s.is_root === true);
  if (roots.length !== 1) {
    problems.push(`the formula needs exactly one root, and it has ${roots.length}`);
  } else if (roots[0].id !== name) {
    problems.push(`the root id "${roots[0].id}" does not match the formula name "${name}"`);
  }

  for (const step of steps) {
    if (!String(step.title ?? '').trim()) problems.push(`step "${step.id}" has no title`);
    // The compiler appends a finalize step. It carries no description of its own.
    const isCompilerStep = /[.]workflow-finalize$/.test(step.id);
    if (!isCompilerStep && !String(step.description ?? '').trim()) {
      problems.push(`step "${step.id}" has no description`);
    }
  }

  for (const dep of deps) {
    if (!unique.has(dep.step_id)) problems.push(`a dependency names an unknown step "${dep.step_id}"`);
    if (!unique.has(dep.depends_on_id)) problems.push(`a dependency names an unknown target "${dep.depends_on_id}"`);
    if (dep.step_id === dep.depends_on_id) problems.push(`step "${dep.step_id}" depends on itself`);
  }

  const cycle = findCycle(steps, deps);
  if (cycle.length) problems.push(`the graph has a cycle: ${cycle.join(' -> ')}`);

  if (roots.length === 1 && cycle.length === 0) {
    // The root's children carry no dependency on the root, so they are entry points too.
    const hasIncoming = new Set(deps.map((d) => d.step_id));
    const reachable = new Set([roots[0].id, ...ids.filter((id) => !hasIncoming.has(id))]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const dep of deps) {
        if (reachable.has(dep.depends_on_id) && !reachable.has(dep.step_id)) {
          reachable.add(dep.step_id);
          grew = true;
        }
      }
    }
    const orphan = ids.filter((id) => !reachable.has(id));
    if (orphan.length) problems.push(`steps are unreachable from the root: ${orphan.join(', ')}`);
  }

  return problems.map((problem) => `${name}: ${problem}`);
}

/** Check the city against the formulas it must hold. */
export function checkCity(expected, available) {
  const problems = [];
  const names = new Set((available ?? []).map((f) => f.name ?? f));
  for (const name of expected ?? []) {
    if (!names.has(name)) problems.push(`${name}: the formula is absent from the city`);
  }
  return problems;
}

export function renderGate({ expected, reports }) {
  const lines = ['# Formula gate (ADR-0016 step 2)', ''];
  let problems = 0;
  for (const report of reports) {
    problems += report.problems.length;
    lines.push(`## ${report.name}`);
    lines.push('');
    if (!report.problems.length) {
      lines.push(`- ok · ${report.steps} steps · ${report.deps} dependencies`);
    }
    for (const problem of report.problems) lines.push(`- ${problem}`);
    lines.push('');
  }
  lines.push(`Formulas checked: ${reports.length} of ${expected.length} expected. Problems: ${problems}.`);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function defaultExpectation(available) {
  return (available ?? []).map((f) => f.name ?? f).filter((name) => String(name).startsWith('mol-mc-'));
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const cityDir = arg('--city-dir') ?? process.env.GC_CITY_PATH ?? process.cwd();
  const { execFileSync } = await import('node:child_process');
  const run = (callArgs) => execFileSync('gc', callArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: cityDir });

  const listed = JSON.parse(run(['formula', 'list', '--json']));
  const available = listed.formulas ?? [];
  const expected = arg('--expect') ? arg('--expect').split(',') : defaultExpectation(available);

  const reports = [];
  const problems = checkCity(expected, available);
  for (const name of expected) {
    if (!available.some((f) => (f.name ?? f) === name)) continue;
    try {
      const compiled = JSON.parse(run(['formula', 'show', name, '--json']));
      reports.push({
        name,
        steps: (compiled.steps ?? []).length,
        deps: (compiled.deps ?? []).length,
        problems: checkFormula(compiled),
      });
    } catch (error) {
      reports.push({ name, steps: 0, deps: 0, problems: [`${name}: the compile failed (${String(error.message).slice(0, 80)})`] });
    }
  }

  const report = renderGate({ expected, reports });
  const absent = problems.length;
  console.log(report);
  if (absent) console.log(problems.map((p) => `- ${p}`).join('\n'));
  const failed = absent + reports.reduce((sum, r) => sum + r.problems.length, 0);
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
