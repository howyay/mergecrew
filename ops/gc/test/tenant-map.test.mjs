// Tests for the MergeCrew tenant map.
//
//   node --test ops/gc/test/tenant-map.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFERENCE_ORG_SLUG,
  buildTenantMap,
  renderTenantMap,
  rigNameForOrg,
} from '../tenant-map.mjs';

const orgs = [
  { id: 'o1', slug: 'mergecrew', name: 'MergeCrew' },
  { id: 'o2', slug: 'acme', name: 'Acme' },
];
const projects = [
  { id: 'p1', organizationId: 'o1', slug: 'core' },
  { id: 'p2', organizationId: 'o2', slug: 'widget' },
];
const rigs = ['mergecrew', 'mc-acme'];

test('rigNameForOrg keeps the reference rig and prefixes the others', () => {
  assert.equal(rigNameForOrg('mergecrew'), 'mergecrew');
  assert.equal(rigNameForOrg('acme'), 'mc-acme');
  assert.equal(rigNameForOrg('acme', { prefix: 'org-' }), 'org-acme');
  assert.throws(() => rigNameForOrg(''), /slug is required/);
  assert.equal(REFERENCE_ORG_SLUG, 'mergecrew');
});

test('the map links each organization to one rig and each project to a prefix', () => {
  const map = buildTenantMap({ orgs, projects, rigs });
  assert.equal(map.city, 'gascity');
  assert.deepEqual(map.problems, []);
  assert.deepEqual(map.tenants.map((t) => [t.org, t.rig]), [
    ['mergecrew', 'mergecrew'],
    ['acme', 'mc-acme'],
  ]);
  assert.deepEqual(map.tenants[1].projects, [{ project: 'widget', projectId: 'p2', prefix: 'p-widget' }]);
});

test('a missing rig is reported, not invented', () => {
  const map = buildTenantMap({ orgs, projects, rigs: ['mergecrew'] });
  assert.match(map.problems.join(' '), /"acme" maps to rig "mc-acme", and the city has no such rig/);
});

test('two organizations may not share a rig', () => {
  const map = buildTenantMap({
    orgs: [{ id: 'o1', slug: 'mergecrew' }, { id: 'o2', slug: 'mergecrew' }],
    projects: [],
    rigs: ['mergecrew'],
  });
  assert.match(map.problems.join(' '), /share the rig "mergecrew"/);
});

test('a project with an unknown organization is reported', () => {
  const map = buildTenantMap({ orgs, projects: [{ id: 'p9', organizationId: 'nope', slug: 'x' }], rigs });
  assert.match(map.problems.join(' '), /unknown organization "nope"/);
});

test('the rendered map states the authorization rule', () => {
  const text = renderTenantMap(buildTenantMap({ orgs, projects, rigs }));
  assert.match(text, /^\| Organization \| Rig \| Projects \|$/m);
  assert.match(text, /\| acme \| `mc-acme` \| `widget` \(p-widget\) \|/);
  assert.match(text, /signed grant that names the city/);
  assert.match(text, /Do not reuse one grant for two organizations\./);
  assert.match(text, /^None\.$/m);
});

test('the rendered map lists the problems when they exist', () => {
  const text = renderTenantMap(buildTenantMap({ orgs, projects, rigs: [] }));
  assert.match(text, /## Problems/);
  assert.doesNotMatch(text, /^None\.$/m);
});

test('an organization without projects shows a dash', () => {
  const text = renderTenantMap(buildTenantMap({ orgs, projects: [], rigs }));
  assert.match(text, /\| acme \| `mc-acme` \| — \|/);
});
