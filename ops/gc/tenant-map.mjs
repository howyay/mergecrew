// MergeCrew tenant map: organization and project -> Gas City city and rig. ADR-0016 step 6, first slice.
//
// Gas City is a single-operator model. MergeCrew is multi-tenant. The map is the missing layer: it
// states which city and which rig serve an organization, and which project owns which work prefix.
// A remote write needs a signed grant that names the city. The map says which grant belongs to
// which tenant. Zero dependencies.
//
// Usage:
//   node ops/gc/tenant-map.mjs --orgs=orgs.json --projects=projects.json --rigs=rigs.json [--city=gascity]
//
// Test: node --test ops/gc/test/tenant-map.test.mjs

import { readFileSync } from 'node:fs';

/** The tenant that owns the deployment itself. It keeps the existing rig. */
export const REFERENCE_ORG_SLUG = 'mergecrew';

export function rigNameForOrg(slug, { prefix = 'mc-', referenceRig = 'mergecrew' } = {}) {
  const clean = String(slug ?? '').trim();
  if (!clean) throw new Error('rigNameForOrg: slug is required');
  if (clean === REFERENCE_ORG_SLUG) return referenceRig;
  return `${prefix}${clean}`;
}

/**
 * Build the tenant map.
 * Returns { city, tenants: [{ org, rig, projects: [{ project, prefix }] }], problems: [] }.
 */
export function buildTenantMap({ orgs = [], projects = [], rigs = [], city = 'gascity', referenceRig = 'mergecrew' } = {}) {
  const problems = [];
  const knownRigs = new Set(rigs.map((r) => (typeof r === 'string' ? r : r.name)));
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  const tenants = orgs.map((org) => {
    const rig = rigNameForOrg(org.slug, { referenceRig });
    if (!knownRigs.has(rig)) {
      problems.push(`organization "${org.slug}" maps to rig "${rig}", and the city has no such rig`);
    }
    return { org: org.slug, orgId: org.id, rig, projects: [] };
  });

  const byRig = new Map();
  for (const tenant of tenants) {
    if (byRig.has(tenant.rig)) {
      problems.push(`organizations "${byRig.get(tenant.rig)}" and "${tenant.org}" share the rig "${tenant.rig}"`);
    }
    byRig.set(tenant.rig, tenant.org);
  }

  for (const project of projects) {
    const org = orgById.get(project.organizationId);
    if (!org) {
      problems.push(`project "${project.slug}" names an unknown organization "${project.organizationId}"`);
      continue;
    }
    const tenant = tenants.find((t) => t.orgId === org.id);
    const prefix = `p-${project.slug}`;
    if (tenant.projects.some((p) => p.prefix === prefix)) {
      problems.push(`project prefix "${prefix}" repeats inside organization "${org.slug}"`);
    }
    tenant.projects.push({ project: project.slug, projectId: project.id, prefix });
  }

  return { city, tenants, problems };
}

export function renderTenantMap(map) {
  const lines = [`# Tenant map for city \`${map.city}\``, ''];
  lines.push('| Organization | Rig | Projects |');
  lines.push('| - | - | - |');
  for (const t of map.tenants) {
    const projects = t.projects.map((p) => `\`${p.project}\` (${p.prefix})`).join(', ') || '—';
    lines.push(`| ${t.org} | \`${t.rig}\` | ${projects} |`);
  }
  lines.push('');
  lines.push('## Authorization');
  lines.push('');
  lines.push('A remote write needs a signed grant that names the city.');
  lines.push('The row above says which grant belongs to which tenant.');
  lines.push('Do not reuse one grant for two organizations.');
  lines.push('');
  if (map.problems.length) {
    lines.push('## Problems');
    lines.push('');
    for (const p of map.problems) lines.push(`- ${p}`);
    lines.push('');
  } else {
    lines.push('## Problems');
    lines.push('');
    lines.push('None.');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const orgs = arg('--orgs');
  const projects = arg('--projects');
  const rigs = arg('--rigs');
  if (!orgs || !rigs) {
    console.error('usage: node ops/gc/tenant-map.mjs --orgs=orgs.json --projects=projects.json --rigs=rigs.json [--city=gascity]');
    return 2;
  }
  const map = buildTenantMap({
    orgs: readJson(orgs),
    projects: projects ? readJson(projects) : [],
    rigs: readJson(rigs),
    city: arg('--city') ?? 'gascity',
  });
  console.log(renderTenantMap(map));
  return map.problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
