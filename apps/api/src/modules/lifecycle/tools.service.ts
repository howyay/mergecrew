import { Inject, Injectable } from '@nestjs/common';
import { READ_ONLY_AGENT_KINDS, STOCK_AGENTS, projectToolSurface } from '@mergecrew/domain';
import { SKILL_CATALOG, type SkillCatalog } from './skill-catalog.js';

/**
 * Skills are the catalog; tools are what an agent kind actually sees. The
 * difference is a projection the runtime applies before every model call —
 * read-only kinds lose write skills, and dotted skill names are sanitized to the
 * provider-safe charset. This service runs that same projection (it lives in
 * `@mergecrew/domain` so both sides share one implementation) so the product can
 * show the real tool names instead of making operators guess.
 */
@Injectable()
export class ToolsService {
  constructor(@Inject(SKILL_CATALOG) private readonly catalog: SkillCatalog) {}

  list() {
    const items = Object.entries(STOCK_AGENTS).map(([ref, agent]) => {
      const surface = projectToolSurface({
        kind: agent.kind,
        bindings: agent.skills,
        lookup: (name) => this.catalog.get(name),
      });

      return {
        ref,
        kind: surface.kind,
        description: agent.description ?? null,
        readOnly: surface.readOnly,
        /** Bound and visible, in the order the runtime binds them. */
        tools: surface.tools.map((t) => ({
          wireName: t.wireName,
          skillName: t.skillName,
          sideEffectClass: t.sideEffectClass,
          description: t.description,
        })),
        /** Bound but filtered out — the binding is legal, the kind can't use it. */
        hidden: surface.hidden,
        /** Bound to a name no skill defines — a lifecycle typo worth surfacing. */
        missing: surface.missing,
      };
    });

    return {
      items,
      readOnlyKinds: [...READ_ONLY_AGENT_KINDS].sort(),
      /** Size of the catalog the bindings were resolved against. */
      skillCount: this.catalog.size,
      /** What changed between the skill name and the tool name. */
      wireNaming: 'skill names are dots; tool names replace every character outside [a-zA-Z0-9_-] with "_"',
    };
  }
}
