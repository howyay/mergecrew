import type { SideEffectClass, SurfaceSkill } from '@mergecrew/domain';
import { ToolsController } from './tools.controller.js';
import { ToolsService } from './tools.service.js';
import type { SkillCatalog } from './skill-catalog.js';

/**
 * The tools view is the product's window onto the same projection the runtime
 * applies before a model call. These tests drive it with a fixture catalog so
 * they need no database, and they assert the two rules that matter: read-only
 * kinds never see a write tool, and every wire name is provider-safe.
 *
 * They run in the repository CI (apps/api `test`).
 */
function catalog(entries: Array<[string, SideEffectClass]>): SkillCatalog {
  return new Map<string, SurfaceSkill>(
    entries.map(([name, sideEffectClass]) => [
      name,
      { name, description: `${name} description`, sideEffectClass },
    ]),
  );
}

/** The stock bindings, all resolvable, with the effect classes they really have. */
const STOCK = catalog([
  ['repo.read_file', 'read'],
  ['repo.list_paths', 'read'],
  ['repo.search', 'read'],
  ['repo.write_file', 'write_workspace'],
  ['repo.git.commit', 'write_workspace'],
  ['build.run_unit_tests', 'read'],
  ['build.run_typecheck', 'read'],
]);

function serviceWith(skills: SkillCatalog): ToolsService {
  return new ToolsService(skills);
}

describe('ToolsService.list', () => {
  it('lists every stock agent with the tools the runtime binds', () => {
    const payload = serviceWith(STOCK).list();

    expect(payload.items.map((a) => a.ref)).toEqual(['Planner', 'Coder', 'Reviewer']);
    expect(payload.items.map((a) => a.kind)).toEqual(['Planner', 'Coder', 'Reviewer']);

    const coder = payload.items.find((a) => a.ref === 'Coder');
    expect(coder?.readOnly).toBe(false);
    expect(coder?.tools.map((t) => t.wireName)).toEqual([
      'repo_read_file',
      'repo_write_file',
      'repo_list_paths',
      'repo_search',
      'repo_git_commit',
      'build_run_unit_tests',
      'build_run_typecheck',
    ]);
    expect(coder?.tools.map((t) => t.skillName)).toEqual([
      'repo.read_file',
      'repo.write_file',
      'repo.list_paths',
      'repo.search',
      'repo.git.commit',
      'build.run_unit_tests',
      'build.run_typecheck',
    ]);
    expect(coder?.hidden).toEqual([]);
    expect(coder?.missing).toEqual([]);

    const planner = payload.items.find((a) => a.ref === 'Planner');
    expect(planner?.tools.map((t) => t.skillName)).toEqual([
      'repo.read_file',
      'repo.list_paths',
      'repo.search',
    ]);
  });

  it('can never emit a tool name a provider would reject', () => {
    const payload = serviceWith(STOCK).list();
    const wireNames = payload.items.flatMap((a) => a.tools.map((t) => t.wireName));

    expect(wireNames.length).toBeGreaterThan(0);
    for (const name of wireNames) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(wireNames).toContain('repo_read_file');
  });

  it('hides a write skill bound to a read-only kind and says why', () => {
    // A catalog where a Planner binding resolves to a write skill: legal config,
    // illegal binding — the runtime drops the tool, so the view must too.
    const corrupted = catalog([
      ['repo.read_file', 'read'],
      ['repo.list_paths', 'read'],
      ['repo.search', 'write_workspace'],
    ]);

    const planner = serviceWith(corrupted)
      .list()
      .items.find((a) => a.ref === 'Planner');

    expect(planner?.tools.map((t) => t.skillName)).toEqual(['repo.read_file', 'repo.list_paths']);
    expect(planner?.hidden).toEqual([
      {
        skillName: 'repo.search',
        sideEffectClass: 'write_workspace',
        reason: 'Planner is a read-only agent kind',
      },
    ]);
  });

  it('reports a binding with no catalog entry instead of dropping it', () => {
    const missingOne = catalog([
      ['repo.read_file', 'read'],
      ['repo.write_file', 'write_workspace'],
      ['repo.list_paths', 'read'],
      ['repo.search', 'read'],
      ['repo.git.commit', 'write_workspace'],
      ['build.run_unit_tests', 'read'],
    ]);

    const payload = serviceWith(missingOne).list();
    const coder = payload.items.find((a) => a.ref === 'Coder');

    expect(coder?.missing).toEqual([
      { skillName: 'build.run_typecheck', reason: 'not in the skill catalog' },
    ]);
    expect(coder?.tools.map((t) => t.skillName)).not.toContain('build.run_typecheck');

    const planner = payload.items.find((a) => a.ref === 'Planner');
    expect(planner?.missing).toEqual([]);
  });

  it('reports the catalog size, the read-only kinds, and the naming rule', () => {
    const payload = serviceWith(STOCK).list();

    expect(payload.skillCount).toBe(STOCK.size);
    expect(payload.readOnlyKinds).toEqual([
      'BugTriage',
      'DesignReviewer',
      'Discovery',
      'Observation',
      'PM',
      'Planner',
      'QA',
      'Reviewer',
    ]);
    expect(payload.wireNaming).toContain('[a-zA-Z0-9_-]');
  });
});

describe('ToolsController', () => {
  it('serves the service payload unchanged', () => {
    const service = serviceWith(STOCK);
    const controller = new ToolsController(service);

    expect(controller.list()).toEqual(service.list());
    expect(controller.list().items).toHaveLength(3);
  });
});
