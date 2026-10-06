/**
 * Project ↔ Gas City rig binding.
 *
 * A rig is a directory the city orchestrates (`gc rig list`); a project is a
 * repository the product orchestrates. They are the same thing seen from two
 * sides, so the product has to say which rig carries which project — and when
 * nothing does, because an unmapped project is a configuration error rather
 * than an empty state (ADR-0016, step 6).
 *
 * The rule lives here so the API, the web pages and the `ops/gc` tools read one
 * implementation. The domain-level half (`rigNameForOrg`, `rigsFromAgents`)
 * stays in the API: that one answers for an organization, this one for a project.
 */

export interface CityRig {
  name: string;
  path?: string | null;
  suspended?: boolean | null;
  default_branch?: string | null;
  agent_count?: number | null;
  running_count?: number | null;
  last_activity?: string | null;
}

/** The part of a project this binding needs. */
export interface ProjectRepoRef {
  slug: string;
  name?: string | null;
  repoFullName?: string | null;
}

export interface ProjectRigBinding {
  projectSlug: string;
  projectName: string | null;
  repoFullName: string | null;
  /** The rig that carries this project, or null when nothing matches. */
  rig: string | null;
  rigPath: string | null;
  rigSuspended: boolean | null;
  matched: boolean;
  /** Why this binding exists, or why it does not — shown to the operator. */
  reason: string;
  /** The command or setting that fixes an unmapped project; null when matched. */
  fix: string | null;
}

export interface ProjectRigMap {
  items: ProjectRigBinding[];
  total: number;
  unmatched: number;
  /** True only when there is at least one project and every one has a rig. */
  complete: boolean;
}

/** `howyay/mergecrew.git` → `mergecrew`. */
export function repoNameFrom(repoFullName?: string | null): string | null {
  const clean = String(repoFullName ?? '')
    .trim()
    .replace(/\.git$/i, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1]!.toLowerCase();
}

/** `/home/me/projects/mergecrew/` → `mergecrew`. */
export function pathBaseName(input?: string | null): string | null {
  const clean = String(input ?? '')
    .trim()
    .replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1]!.toLowerCase();
}

/**
 * `CITY_PROJECT_RIGS` names the rig for a project the derivation cannot guess.
 *
 * Accepts a JSON object (`{"mergecrew":"mergecrew"}`) or `key=rig,key=rig`. Keys
 * are matched against the project slug, then the repository full name, then the
 * repository name, all case-insensitively. A malformed JSON body falls through to
 * the `key=rig` form so one typo cannot silently drop the whole map.
 */
export function parseRigOverrides(raw?: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const text = String(raw ?? '').trim();
  if (!text) return out;
  const put = (key: unknown, value: unknown) => {
    const k = String(key ?? '').trim().toLowerCase();
    const v = String(value ?? '').trim();
    if (k && v) out.set(k, v);
  };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed ?? {})) put(key, value);
      return out;
    } catch {
      // fall through to the `key=rig` form below
    }
  }
  for (const pair of text.split(',')) {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length) put(key, rest.join('='));
  }
  return out;
}

function bound(
  rig: CityRig,
  base: Omit<ProjectRigBinding, 'rig' | 'rigPath' | 'rigSuspended' | 'matched' | 'reason' | 'fix'>,
  reason: string,
): ProjectRigBinding {
  return {
    ...base,
    rig: rig.name,
    rigPath: rig.path ?? null,
    rigSuspended: rig.suspended ?? null,
    matched: true,
    reason,
    fix: null,
  };
}

function unbound(
  base: Omit<ProjectRigBinding, 'rig' | 'rigPath' | 'rigSuspended' | 'matched' | 'reason' | 'fix'>,
  reason: string,
  fix: string,
): ProjectRigBinding {
  return { ...base, rig: null, rigPath: null, rigSuspended: null, matched: false, reason, fix };
}

/**
 * Bind one project to the rig that carries it.
 *
 * Order: an explicit `CITY_PROJECT_RIGS` entry, then a rig whose name is the
 * repository name, then a rig whose directory is named after the repository.
 * Names are compared case-insensitively and the rig list is sorted first, so the
 * answer cannot depend on the order the supervisor happened to return.
 */
export function bindProject(
  project: ProjectRepoRef,
  rigs: readonly CityRig[],
  overrides: ReadonlyMap<string, string> = new Map(),
): ProjectRigBinding {
  const projectSlug = String(project.slug ?? '').trim();
  const repoFullName = String(project.repoFullName ?? '').trim() || null;
  const repoName = repoNameFrom(repoFullName);
  const base = { projectSlug, projectName: project.name ?? null, repoFullName };
  const sorted = [...(rigs ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const override =
    overrides.get(projectSlug.toLowerCase()) ??
    (repoFullName ? overrides.get(repoFullName.toLowerCase()) : undefined) ??
    (repoName ? overrides.get(repoName) : undefined);
  if (override) {
    const rig = sorted.find((r) => r.name === override);
    if (rig) return bound(rig, base, `mapped explicitly to rig "${override}"`);
    return unbound(
      base,
      `CITY_PROJECT_RIGS maps this project to rig "${override}", which the city does not hold`,
      `Add rig "${override}" to the city (\`gc rig add <path>\`), or point CITY_PROJECT_RIGS at a rig the city holds.`,
    );
  }

  if (!repoName) {
    return unbound(
      base,
      'no repository is connected to this project',
      'Connect a repository in the project settings, then register it as a rig with `gc rig add <path>`.',
    );
  }

  const byName = sorted.filter((r) => String(r.name).toLowerCase() === repoName);
  const byPath = byName.length ? [] : sorted.filter((r) => pathBaseName(r.path) === repoName);
  const match = byName[0] ?? byPath[0];
  if (!match) {
    return unbound(
      base,
      `no rig in the city matches repository "${repoFullName}"`,
      `Register the repository as a rig (\`gc rig add <path to ${repoName}>\`), or map it explicitly with CITY_PROJECT_RIGS=${projectSlug || repoName}=<rig>.`,
    );
  }
  const candidates = byName.length || byPath.length;
  const how = byName.length ? 'rig name' : 'rig directory';
  const suffix = candidates > 1 ? ` (first of ${candidates} matches)` : '';
  return bound(match, base, `matched by ${how}${suffix}`);}

export function bindProjects(
  projects: readonly ProjectRepoRef[],
  rigs: readonly CityRig[],
  overrides: ReadonlyMap<string, string> = new Map(),
): ProjectRigMap {
  const items = [...(projects ?? [])]
    .map((project) => bindProject(project, rigs, overrides))
    .sort((a, b) => a.projectSlug.localeCompare(b.projectSlug));
  const unmatched = items.filter((item) => !item.matched).length;
  return { items, total: items.length, unmatched, complete: items.length > 0 && unmatched === 0 };
}
