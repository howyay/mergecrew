import type { SideEffectClass } from './tools.js';

/**
 * The tool surface is what an agent's bound skills look like after the runtime
 * projects them for a model: read-only agent kinds lose every write capability,
 * and names are sanitized for providers that reject our dotted skill namespace.
 *
 * Two consumers share this module so the product's "Tools" view can never drift
 * from what the runtime actually binds:
 *   - `packages/agent-runtime/src/loop.ts` — binds tools for a model step.
 *   - `apps/api/src/modules/lifecycle/tools.service.ts` — reports the surface.
 *
 * It lives in `@mergecrew/domain` (not `@mergecrew/skills`) because `skills`
 * pulls in the runtime skill catalog — and with it the database — while these
 * rules are pure: no registry, no I/O, no provider knowledge.
 */

/**
 * Agent kinds that only ever see read-only skills. Even if a lifecycle YAML
 * binds a write capability to one of these kinds, the model never sees the tool
 * — the filter runs before the provider call.
 *
 * Includes Planner + Reviewer, plus the read-only kinds in the roster:
 * Discovery scans, PM drafts specs (no repo writes), QA runs test commands,
 * DesignReviewer reads the deployed UI, Observation hits the smoke endpoint,
 * BugTriage files tracker issues. Engineers / SRE / DocWriter are not here —
 * they write to the workspace.
 */
export const READ_ONLY_AGENT_KINDS: ReadonlySet<string> = new Set([
  'Planner',
  'Reviewer',
  'Discovery',
  'PM',
  'QA',
  'DesignReviewer',
  'Observation',
  'BugTriage',
]);

/** The shape the projection needs from a skill, whatever else it carries. */
export type SurfaceSkill = {
  name: string;
  description: string;
  sideEffectClass: SideEffectClass;
};

/** True when `kind` is allowed to see `skill` on the wire. */
export function skillVisibleForKind(
  kind: string,
  skill: Pick<SurfaceSkill, 'sideEffectClass'>,
): boolean {
  return !(READ_ONLY_AGENT_KINDS.has(kind) && skill.sideEffectClass !== 'read');
}

/**
 * OpenAI's tool-call API enforces `^[a-zA-Z0-9_-]+$` on `function.name`, which
 * rejects our dotted skill namespace (`repo.read_file`, `slack.post`, …).
 * Anthropic, Bedrock, and Ollama accept dots, but the sanitized form is valid
 * for all of them, so we use it on every wire rather than branch per provider.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** A skill binding as it appears in lifecycle YAML / stock agent definitions. */
export type SkillBindingRef = string | { name: string };

export type ToolSurfaceTool<TSkill extends SurfaceSkill = SurfaceSkill> = {
  /** The resolved skill, so a caller can keep using its input schema / execute. */
  skill: TSkill;
  /** Canonical dotted name — what policy checks and tool-call rows use. */
  skillName: string;
  /** Name the model sees (dots replaced). */
  wireName: string;
  description: string;
  sideEffectClass: SideEffectClass;
};

export type ToolSurfaceHidden = {
  skillName: string;
  sideEffectClass: SideEffectClass;
  reason: string;
};

export type ToolSurfaceMissing = {
  skillName: string;
  reason: string;
};

export type ToolSurface<TSkill extends SurfaceSkill = SurfaceSkill> = {
  kind: string;
  /** True when the kind is in {@link READ_ONLY_AGENT_KINDS}. */
  readOnly: boolean;
  /** Tools the model sees, in binding order. Names are unique. */
  tools: ToolSurfaceTool<TSkill>[];
  /** Bound skills the kind is not allowed to see. */
  hidden: ToolSurfaceHidden[];
  /** Bound skills that are not in the catalog — a lifecycle YAML typo. */
  missing: ToolSurfaceMissing[];
};

/**
 * Project an agent kind's skill bindings into the tool surface a model would
 * receive. Unresolved bindings are reported rather than dropped silently, and a
 * collision after sanitization throws with the same message the runtime uses —
 * two dotted skills must never map to one wire name.
 */
export function projectToolSurface<TSkill extends SurfaceSkill>(input: {
  kind: string;
  bindings: readonly SkillBindingRef[];
  lookup: (name: string) => TSkill | undefined;
}): ToolSurface<TSkill> {
  const tools: ToolSurfaceTool<TSkill>[] = [];
  const hidden: ToolSurfaceHidden[] = [];
  const missing: ToolSurfaceMissing[] = [];
  const wireToSkill = new Map<string, string>();

  for (const binding of input.bindings) {
    const name = typeof binding === 'string' ? binding : binding.name;
    const skill = input.lookup(name);
    if (!skill) {
      missing.push({ skillName: name, reason: 'not in the skill catalog' });
      continue;
    }
    if (!skillVisibleForKind(input.kind, skill)) {
      hidden.push({
        skillName: skill.name,
        sideEffectClass: skill.sideEffectClass,
        reason: `${input.kind} is a read-only agent kind`,
      });
      continue;
    }
    const wireName = sanitizeToolName(skill.name);
    const prior = wireToSkill.get(wireName);
    if (prior && prior !== skill.name) {
      throw new Error(
        `tool name collision after sanitization: '${prior}' and '${skill.name}' both map to '${wireName}'`,
      );
    }
    wireToSkill.set(wireName, skill.name);
    tools.push({
      skill,
      skillName: skill.name,
      wireName,
      description: skill.description,
      sideEffectClass: skill.sideEffectClass,
    });
  }

  return {
    kind: input.kind,
    readOnly: READ_ONLY_AGENT_KINDS.has(input.kind),
    tools,
    hidden,
    missing,
  };
}
