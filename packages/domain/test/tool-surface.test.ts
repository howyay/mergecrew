import { describe, expect, it } from 'vitest';
import type { SideEffectClass } from '../src/tools.js';
import {
  READ_ONLY_AGENT_KINDS,
  projectToolSurface,
  sanitizeToolName,
  skillVisibleForKind,
  type SurfaceSkill,
} from '../src/tool-surface.js';

type FakeSkill = SurfaceSkill & { inputSchema: Record<string, unknown> };

function skill(name: string, sideEffectClass: SideEffectClass): FakeSkill {
  return {
    name,
    description: `${name} description`,
    sideEffectClass,
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
}

const CATALOG = new Map<string, FakeSkill>(
  [
    skill('repo.read_file', 'read'),
    skill('repo.list_paths', 'read'),
    skill('repo.search', 'read'),
    skill('repo.commit', 'write_workspace'),
    skill('deploy.trigger', 'irreversible'),
    skill('git.commit', 'write_workspace'),
  ].map((s) => [s.name, s] as const),
);

const lookup = (name: string) => CATALOG.get(name);

describe('READ_ONLY_AGENT_KINDS', () => {
  it('covers the read-only roster and excludes the writing kinds', () => {
    for (const kind of [
      'Planner',
      'Reviewer',
      'Discovery',
      'PM',
      'QA',
      'DesignReviewer',
      'Observation',
      'BugTriage',
    ]) {
      expect(READ_ONLY_AGENT_KINDS.has(kind)).toBe(true);
    }
    for (const kind of ['Coder', 'BackendEngineer', 'FrontendEngineer', 'SRE', 'DocWriter']) {
      expect(READ_ONLY_AGENT_KINDS.has(kind)).toBe(false);
    }
  });
});

describe('skillVisibleForKind', () => {
  it('hides write skills from read-only kinds and shows them to everyone else', () => {
    const write = skill('repo.commit', 'write_workspace');
    expect(skillVisibleForKind('Planner', write)).toBe(false);
    expect(skillVisibleForKind('Coder', write)).toBe(true);
    expect(skillVisibleForKind('Planner', skill('repo.read_file', 'read'))).toBe(true);
  });
});

describe('sanitizeToolName', () => {
  it('replaces everything outside the OpenAI function-name charset', () => {
    expect(sanitizeToolName('repo.read_file')).toBe('repo_read_file');
    expect(sanitizeToolName('git.commit')).toBe('git_commit');
    expect(sanitizeToolName('deploy.trigger')).toBe('deploy_trigger');
  });
});

describe('projectToolSurface', () => {
  it('resolves bindings in order and reports the wire name for each', () => {
    const surface = projectToolSurface({
      kind: 'Coder',
      bindings: ['repo.read_file', { name: 'repo.commit' }],
      lookup,
    });

    expect(surface.kind).toBe('Coder');
    expect(surface.readOnly).toBe(false);
    expect(surface.tools.map((t) => t.wireName)).toEqual(['repo_read_file', 'repo_commit']);
    expect(surface.tools.map((t) => t.sideEffectClass)).toEqual(['read', 'write_workspace']);
    expect(surface.tools[1]?.skill.name).toBe('repo.commit');
    expect(surface.hidden).toEqual([]);
    expect(surface.missing).toEqual([]);
  });

  it('hides write capabilities from a read-only kind and says why', () => {
    const surface = projectToolSurface({
      kind: 'Reviewer',
      bindings: ['repo.read_file', 'repo.commit', 'deploy.trigger'],
      lookup,
    });

    expect(surface.readOnly).toBe(true);
    expect(surface.tools.map((t) => t.skillName)).toEqual(['repo.read_file']);
    expect(surface.hidden).toEqual([
      { skillName: 'repo.commit', sideEffectClass: 'write_workspace', reason: 'Reviewer is a read-only agent kind' },
      { skillName: 'deploy.trigger', sideEffectClass: 'irreversible', reason: 'Reviewer is a read-only agent kind' },
    ]);
  });

  it('reports a binding that is not in the catalog instead of dropping it', () => {
    const surface = projectToolSurface({
      kind: 'Coder',
      bindings: ['repo.read_file', 'repo.read_fil'],
      lookup,
    });

    expect(surface.tools.map((t) => t.skillName)).toEqual(['repo.read_file']);
    expect(surface.missing).toEqual([
      { skillName: 'repo.read_fil', reason: 'not in the skill catalog' },
    ]);
  });

  it('accepts a kind that is not in the roster as a writing kind', () => {
    const surface = projectToolSurface({
      kind: 'CustomBuilder',
      bindings: ['repo.commit'],
      lookup,
    });

    expect(surface.readOnly).toBe(false);
    expect(surface.tools.map((t) => t.skillName)).toEqual(['repo.commit']);
  });

  it('throws when two skills collide on one wire name', () => {
    const collision = new Map<string, FakeSkill>([
      ['repo.read_file', skill('repo.read_file', 'read')],
      ['repo/read_file', skill('repo/read_file', 'read')],
    ]);

    expect(() =>
      projectToolSurface({
        kind: 'Coder',
        bindings: ['repo.read_file', 'repo/read_file'],
        lookup: (name) => collision.get(name),
      }),
    ).toThrow(
      "tool name collision after sanitization: 'repo.read_file' and 'repo/read_file' both map to 'repo_read_file'",
    );
  });
});
