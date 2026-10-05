// Local readiness check for the heavy repository gates. ADR-0016 support.
//
// On 2026-10-05 the API typecheck reported 576 errors on this workstation. They were not code
// defects: the Prisma client was never generated (this host has no Prisma engine) and several
// workspace packages had no dist. This check answers the question in one command, so nobody spends a
// day on phantom errors. Zero dependencies.
//
// Usage:
//   node ops/gc/local-readiness.mjs [--root=.]
//
// Test: node --test ops/gc/test/local-readiness.test.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A workspace package that publishes from dist. */
export function shippedFromDist(pkg) {
  const text = JSON.stringify(pkg?.main ?? '') + JSON.stringify(pkg?.exports ?? '') + JSON.stringify(pkg?.types ?? '');
  return text.includes('dist');
}

/** Packages that declare a dist entry point and do not have one. */
export function missingDist(root, entries) {
  const missing = [];
  for (const entry of entries ?? []) {
    const dir = join(root, entry);
    if (!existsSync(join(dir, 'package.json'))) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      missing.push(entry);
      continue;
    }
    if (!shippedFromDist(pkg)) continue;
    if (!existsSync(join(dir, 'dist'))) missing.push(pkg.name ?? entry);
  }
  return missing;
}

/** The workspace entries to inspect. */
export function workspaceEntries(root) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    try {
      for (const name of readdirSync(join(root, group), { withFileTypes: true })) {
        if (name.isDirectory()) out.push(`${group}/${name.name}`);
      }
    } catch {
      // A workspace without the group is not an error.
    }
  }
  return out.sort();
}

/** The verdict, as pure data, so the rules are testable. */
export function evaluateReadiness({ prismaClient = false, distMissing = [], gcInstalled = false, store = null } = {}) {
  const blockers = [];
  if (!gcInstalled) blockers.push('gc is not on PATH');
  if (!prismaClient) {
    blockers.push('the Prisma client is not generated, so `pnpm --filter @mergecrew/api typecheck` cannot pass here');
  }
  if (distMissing.length) {
    blockers.push(`${distMissing.length} workspace package(s) have no dist: ${distMissing.join(', ')}`);
  }
  if (store && store.ok === false) {
    blockers.push(`the store is not ready: ${store.reason}`);
  }
  return { ok: blockers.length === 0, blockers };
}

export function renderReadiness({ prismaClient, distMissing, gcInstalled, store, verdict }) {
  const lines = ['# Local readiness for the heavy gates', ''];
  lines.push(`Prisma client generated: ${prismaClient ? 'yes' : 'no'}`);
  lines.push(`gc on PATH: ${gcInstalled ? 'yes' : 'no'}`);
  lines.push(`Workspace packages without dist: ${distMissing.length}${distMissing.length ? ` (${distMissing.join(', ')})` : ''}`);
  lines.push(`Store: ${store ? `${store.ok ? 'ready' : 'not ready'} (${store.reason})` : 'not checked'}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  if (verdict.ok) {
    lines.push('The heavy gates can run on this machine.');
  } else {
    lines.push('Run the heavy gates in CI. The blockers:');
    for (const blocker of verdict.blockers) lines.push(`- ${blocker}`);
    lines.push('');
    lines.push('The same code passes in CI, so these are provisioning gaps, not code defects. See `me-kgy`.');
  }
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const root = arg('--root') ?? process.cwd();

  const prismaClient =
    existsSync(join(root, 'node_modules', '.prisma', 'client')) ||
    existsSync(join(root, 'packages', 'db', 'node_modules', '.prisma', 'client'));

  const distMissing = missingDist(root, workspaceEntries(root));
  const gcInstalled = existsSync(join('/home/haoye/.local/bin/gc')) || Boolean(process.env.PATH?.includes('gc'));

  let store = null;
  const cityDir = arg('--city-dir') ?? process.env.GC_CITY_PATH;
  if (cityDir) {
    try {
      const cityPort = readFileSync(join(cityDir, '.beads', 'dolt-server.port'), 'utf8').trim();
      store = cityPort ? { ok: true, reason: `city port ${cityPort}` } : { ok: false, reason: 'no city port file' };
    } catch {
      store = { ok: false, reason: 'no city port file' };
    }
  }

  const verdict = evaluateReadiness({ prismaClient, distMissing, gcInstalled, store });
  console.log(renderReadiness({ prismaClient, distMissing, gcInstalled, store, verdict }));
  return verdict.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
