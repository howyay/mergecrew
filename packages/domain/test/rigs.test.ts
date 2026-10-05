import { describe, expect, it } from 'vitest';
import {
  bindProject,
  bindProjects,
  parseRigOverrides,
  pathBaseName,
  repoNameFrom,
  type CityRig,
} from '../src/rigs.js';

const RIGS: CityRig[] = [
  {
    name: 'mergecrew',
    path: '/home/me/projects/mergecrew',
    suspended: false,
    default_branch: 'main',
    agent_count: 8,
    running_count: 1,
  },
  { name: 'docs', path: '/srv/checkouts/mergecrew-site', suspended: true },
];

describe('repoNameFrom', () => {
  it('takes the last path segment, lowercased, and drops a .git suffix', () => {
    expect(repoNameFrom('howyay/mergecrew')).toBe('mergecrew');
    expect(repoNameFrom('howyay/MergeCrew.git')).toBe('mergecrew');
    expect(repoNameFrom('mergecrew')).toBe('mergecrew');
  });

  it('returns null when there is nothing to read', () => {
    expect(repoNameFrom('')).toBeNull();
    expect(repoNameFrom('   ')).toBeNull();
    expect(repoNameFrom(null)).toBeNull();
    expect(repoNameFrom(undefined)).toBeNull();
  });
});

describe('pathBaseName', () => {
  it('reads the directory name and tolerates a trailing slash', () => {
    expect(pathBaseName('/home/me/projects/mergecrew')).toBe('mergecrew');
    expect(pathBaseName('/home/me/projects/mergecrew/')).toBe('mergecrew');
    expect(pathBaseName('mergecrew')).toBe('mergecrew');
  });

  it('returns null for an empty path', () => {
    expect(pathBaseName('')).toBeNull();
    expect(pathBaseName(null)).toBeNull();
  });
});

describe('parseRigOverrides', () => {
  it('reads a JSON object and lowercases the keys', () => {
    const map = parseRigOverrides('{"Mergecrew":"docs","howyay/other":"rig-2"}');
    expect(map.get('mergecrew')).toBe('docs');
    expect(map.get('howyay/other')).toBe('rig-2');
  });

  it('reads the key=rig list form', () => {
    const map = parseRigOverrides('mergecrew=docs, other=rig-2');
    expect(map.get('mergecrew')).toBe('docs');
    expect(map.get('other')).toBe('rig-2');
  });

  it('keeps the list form usable when the JSON body is malformed', () => {
    expect(parseRigOverrides('{"a":').size).toBe(0);
    expect(parseRigOverrides('a=rig-1').get('a')).toBe('rig-1');
  });

  it('returns an empty map for empty input', () => {
    expect(parseRigOverrides('').size).toBe(0);
    expect(parseRigOverrides(null).size).toBe(0);
  });
});

describe('bindProject', () => {
  it('matches a rig whose name is the repository name, whatever the case', () => {
    const binding = bindProject({ slug: 'mergecrew', repoFullName: 'howyay/MergeCrew' }, RIGS);
    expect(binding).toMatchObject({
      projectSlug: 'mergecrew',
      rig: 'mergecrew',
      rigPath: '/home/me/projects/mergecrew',
      rigSuspended: false,
      matched: true,
      reason: 'matched by rig name',
      fix: null,
    });
  });

  it('falls back to the rig directory name when the rig name differs', () => {
    const binding = bindProject({ slug: 'site', repoFullName: 'howyay/mergecrew-site' }, RIGS);
    expect(binding.rig).toBe('docs');
    expect(binding.reason).toBe('matched by rig directory');
    expect(binding.rigSuspended).toBe(true);
  });

  it('prefers the rig name over the rig directory', () => {
    const rigs: CityRig[] = [
      { name: 'other', path: '/srv/mergecrew' },
      { name: 'mergecrew', path: '/srv/elsewhere' },
    ];
    const binding = bindProject({ slug: 'mergecrew', repoFullName: 'howyay/mergecrew' }, rigs);
    expect(binding.rig).toBe('mergecrew');
    expect(binding.reason).toBe('matched by rig name');
  });

  it('is deterministic and says so when several rigs match', () => {
    const rigs: CityRig[] = [
      { name: 'b-mergecrew', path: '/x' },
      { name: 'a-mergecrew', path: '/y' },
      { name: 'mergecrew', path: '/z' },
    ];
    const binding = bindProject({ slug: 'mergecrew', repoFullName: 'howyay/mergecrew' }, rigs);
    expect(binding.rig).toBe('mergecrew');
    expect(binding.reason).toBe('matched by rig name');
    const tied = bindProject({ slug: 'mergecrew', repoFullName: 'howyay/mergecrew' }, [
      { name: 'app', path: '/x/mergecrew' },
      { name: 'b-app', path: '/y/mergecrew' },
    ]);
    expect(tied.rig).toBe('app');
    expect(tied.reason).toBe('matched by rig directory (first of 2 matches)');
  });

  it('an explicit override wins over the derivation', () => {
    const binding = bindProject(
      { slug: 'mergecrew', repoFullName: 'howyay/mergecrew' },
      RIGS,
      parseRigOverrides('{"mergecrew":"docs"}'),
    );
    expect(binding.rig).toBe('docs');
    expect(binding.reason).toBe('mapped explicitly to rig "docs"');
  });

  it('reports an override that names a rig the city does not hold', () => {
    const binding = bindProject(
      { slug: 'mergecrew', repoFullName: 'howyay/mergecrew' },
      RIGS,
      parseRigOverrides('mergecrew=ghost'),
    );
    expect(binding.matched).toBe(false);
    expect(binding.reason).toBe(
      'CITY_PROJECT_RIGS maps this project to rig "ghost", which the city does not hold',
    );
    expect(binding.fix).toContain('gc rig add');
  });

  it('asks for a repository when the project has none', () => {
    const binding = bindProject({ slug: 'blank', name: 'Blank' }, RIGS);
    expect(binding).toMatchObject({
      projectName: 'Blank',
      repoFullName: null,
      matched: false,
      reason: 'no repository is connected to this project',
    });
    expect(binding.fix).toContain('project settings');
  });

  it('names the repository and the two fixes when no rig matches', () => {
    const binding = bindProject({ slug: 'other', repoFullName: 'howyay/other' }, RIGS);
    expect(binding.matched).toBe(false);
    expect(binding.reason).toBe('no rig in the city matches repository "howyay/other"');
    expect(binding.fix).toContain('gc rig add');
    expect(binding.fix).toContain('CITY_PROJECT_RIGS=other=<rig>');
  });

  it('treats an empty rig list as unmapped rather than throwing', () => {
    const binding = bindProject({ slug: 'mergecrew', repoFullName: 'howyay/mergecrew' }, []);
    expect(binding.matched).toBe(false);
    expect(binding.fix).toContain('gc rig add');
  });
});

describe('bindProjects', () => {
  it('sorts by project slug and counts what is unmapped', () => {
    const map = bindProjects(
      [
        { slug: 'zeta', repoFullName: 'howyay/other' },
        { slug: 'mergecrew', name: 'Mergecrew', repoFullName: 'howyay/mergecrew' },
        { slug: 'blank' },
      ],
      RIGS,
    );
    expect(map.items.map((item) => item.projectSlug)).toEqual(['blank', 'mergecrew', 'zeta']);
    expect(map.total).toBe(3);
    expect(map.unmatched).toBe(2);
    expect(map.complete).toBe(false);
  });

  it('is complete when every project has a rig', () => {
    const map = bindProjects([{ slug: 'mergecrew', repoFullName: 'howyay/mergecrew' }], RIGS);
    expect(map).toMatchObject({ total: 1, unmatched: 0, complete: true });
  });

  it('is not complete when there is nothing to bind', () => {
    expect(bindProjects([], RIGS)).toMatchObject({ total: 0, unmatched: 0, complete: false });
  });
});
