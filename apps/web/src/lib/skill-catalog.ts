import { api, type Session } from '@/lib/api';

/**
 * One catalog, one shape, one place to read it.
 *
 * The stock catalog is global and read-only, so the web app has exactly one
 * home for it: the Skills and tools page. Everything else that needs to name a
 * skill — the lifecycle editor's agent picker, the project's agent roster —
 * imports the shape and the loader from here instead of declaring its own copy
 * or fetching the route again. Custom skills are a different thing entirely:
 * they belong to a lifecycle scope (an org template or a project) and are
 * authored in that scope's editor.
 */

export type SideEffectClass = 'read' | 'write_workspace' | 'write_external' | 'irreversible';

export interface SkillRow {
  name: string;
  description: string;
  sideEffectClass: SideEffectClass;
  capabilities?: string[];
}

/** The one route that serves the catalog. */
export const SKILL_CATALOG_ROUTE = '/v1/skills';

/** The one page that shows it. Editors link here rather than re-listing it. */
export function skillCatalogPath(orgSlug: string): string {
  return `/orgs/${orgSlug}/skills`;
}

export async function loadSkillCatalog(session: Session): Promise<SkillRow[]> {
  const { items } = await api<{ items: SkillRow[] }>(SKILL_CATALOG_ROUTE, { session });
  return items ?? [];
}
