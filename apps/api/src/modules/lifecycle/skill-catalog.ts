import type { SurfaceSkill } from '@mergecrew/domain';

/**
 * The catalog the tools view resolves an agent's skill bindings against.
 *
 * The token lives in this dependency-free module on purpose: `ToolsService`
 * imports it at runtime, while the stock catalog itself (which reaches the
 * database through `@mergecrew/skills`) is wired in `stock-skill-catalog.ts`.
 * That split keeps the service's unit tests free of a Prisma client.
 */
export const SKILL_CATALOG = Symbol('SKILL_CATALOG');

/** A skill as the projection needs it: name, description, and effect class. */
export type SkillCatalog = ReadonlyMap<string, SurfaceSkill>;
