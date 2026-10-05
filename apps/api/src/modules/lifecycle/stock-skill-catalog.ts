import { stockSkills } from '@mergecrew/skills';
import type { SkillCatalog } from './skill-catalog.js';

/**
 * The stock skill catalog, narrowed to the fields the tool surface reports.
 * Everything that needs the runtime catalog goes through here, so the only
 * module in the lifecycle tree that depends on `@mergecrew/skills` is this one.
 */
export function buildStockSkillCatalog(): SkillCatalog {
  return new Map(
    stockSkills.map((s) => [
      s.name,
      { name: s.name, description: s.description, sideEffectClass: s.sideEffectClass },
    ]),
  );
}
