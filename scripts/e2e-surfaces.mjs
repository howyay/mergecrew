#!/usr/bin/env node
/**
 * End-to-end check of the org surfaces a person actually uses.
 *
 * It walks the same path a browser does — web page → API route → database or
 * Gas City — and asserts on what comes back, so a green run means "the
 * surface renders the data the API has", not "the unit tests pass".
 *
 * Usage (against a running stack):
 *   node scripts/e2e-surfaces.mjs
 *
 * Env:
 *   MERGECREW_E2E_API      API base            (default http://127.0.0.1:4000)
 *   MERGECREW_E2E_WEB      web base            (default http://127.0.0.1:3100)
 *   MERGECREW_E2E_ORG      org slug to check   (default demo)
 *   MERGECREW_E2E_API_KEY  mc_* API key        (default the local-stack e2e key)
 *   MERGECREW_E2E_CITY_URL supervisor, on the host (default http://127.0.0.1:8372)
 *   MERGECREW_E2E_CITY     city name           (default gascity)
 *
 * Exit code is 1 when any check fails. Role-gated routes (403) and pages that
 * need a session (sign-in redirect) are reported as `info`, not as failures:
 * they say what this credential can see, and the run stays honest about it.
 */
const API = (process.env.MERGECREW_E2E_API ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const WEB = (process.env.MERGECREW_E2E_WEB ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const ORG = process.env.MERGECREW_E2E_ORG ?? 'demo';
const KEY =
  process.env.MERGECREW_E2E_API_KEY ??
  process.env.MERGECREW_E2E_LOCAL_API_KEY ??
  'mc_live_local_verify_token';

const results = [];

function record(surface, name, status, detail) {
  results.push({ surface, name, status, detail });
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'info';
  console.log(`  [${mark}] ${name} — ${detail}`);
}

function check(surface, name, ok, detail) {
  record(surface, name, ok ? 'pass' : 'fail', detail);
}

function info(surface, name, detail) {
  record(surface, name, 'info', detail);
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function webGet(path) {
  const res = await fetch(`${WEB}${path}`, { redirect: 'follow' });
  return { status: res.status, url: res.url, body: await res.text() };
}

/** Most list routes answer `{ items: [...] }`; a couple answer a bare array. */
function asList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  return undefined;
}

function apiMessage(body) {
  return body?.error?.message ?? body?.message ?? '';
}

/**
 * Where the Gas City supervisor listens when this script runs on the host. The
 * API container cannot reach it (it binds loopback), so asking from here is how
 * a run tells "the supervisor is down" apart from "the container cannot see it".
 */
const HOST_CITY = (
  process.env.MERGREW_E2E_CITY_URL ?? 'http://127.0.0.1:8372'
).replace(/\/+$/, '');
const CITY = process.env.MERGREW_E2E_CITY ?? 'gascity';

async function supervisorAnswersOnHost() {
  try {
    const res = await fetch(`${HOST_CITY}/v0/city/${CITY}/usage`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 403 means "this credential is not allowed"; that is a fact, not a bug. */
function gateOrFail(surface, name, res, allowed) {
  if (res.status === 403 || res.status === 401) {
    info(surface, name, `HTTP ${res.status} for this credential — ${apiMessage(res.json)}`);
    return false;
  }
  if (res.status !== 200) {
    record(surface, name, 'fail', `HTTP ${res.status} ${apiMessage(res.json)}`.trim());
    return false;
  }
  if (!allowed(res.json)) {
    record(surface, name, 'fail', `HTTP 200 but unexpected body: ${JSON.stringify(res.json).slice(0, 160)}`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`e2e surfaces · api=${API} web=${WEB} org=${ORG}`);

  // ── health ────────────────────────────────────────────────────────────────
  console.log('\nstack');
  const ready = await fetch(`${API}/readyz`).catch((err) => ({ status: 0, err }));
  check('stack', 'api /readyz', ready.status === 200, `HTTP ${ready.status}`);
  const home = await webGet('/').catch((err) => ({ status: 0, body: '', url: '', err }));
  check('stack', 'web / responds', home.status === 200, `HTTP ${home.status} → ${home.url}`);
  check(
    'stack',
    'nav has no Activity entry',
    !/>(Activity|Activities)</.test(home.body),
    />(Activity|Activities)</.test(home.body) ? 'found an Activity nav item' : 'no Activity nav item',
  );
  check(
    'stack',
    'no link to the removed activity page',
    !home.body.includes(`/orgs/${ORG}/activity`),
    home.body.includes(`/orgs/${ORG}/activity`) ? 'found /activity link' : 'no /activity link',
  );

  // The sidebar draws one lucide glyph per item. Those icons lived as an
  // uncommitted edit for a while, so an image built from git shipped without
  // them and the nav fell back to bare squares. Checking the rendered class
  // names is what makes that regression loud instead of cosmetic.
  // ("Building2" kebab-cases to `building2`, so it is matched by prefix.)
  const EXPECTED_ICONS = [
    'layout-dashboard',
    'folder-kanban',
    'lightbulb',
    'inbox',
    'chart-line',
    'wallet',
    'flask-conical',
    'workflow',
    'sparkles',
    'settings',
  ];
  const missingIcons = EXPECTED_ICONS.filter((name) => !home.body.includes(`lucide-${name}`));
  const iconCount = new Set(home.body.match(/lucide-[a-z0-9-]+/g) ?? []).size;
  check(
    'stack',
    'nav renders an icon per item',
    missingIcons.length === 0 && home.body.includes('lucide-building'),
    missingIcons.length > 0
      ? `missing lucide-${missingIcons.join(', lucide-')}`
      : `${iconCount} distinct lucide icons in the shell`,
  );
  check(
    'stack',
    'nav has no Activity icon',
    !home.body.includes('lucide-activity'),
    home.body.includes('lucide-activity') ? 'found lucide-activity in the shell' : 'no Activity icon',
  );

  // ── projects ─────────────────────────────────────────────────────────────
  console.log('\nprojects');
  const projects = await apiGet(`/v1/orgs/${ORG}/projects`);
  let slugs = [];
  if (gateOrFail('projects', 'GET projects', projects, (b) => (asList(b)?.length ?? 0) > 0)) {
    slugs = asList(projects.json).map((p) => p.slug ?? p.projectSlug ?? p.name);
    check('projects', 'project list is non-empty', slugs.length > 0, `${slugs.length}: ${slugs.slice(0, 4).join(', ')}`);
  }
  const projectsPage = await webGet(`/orgs/${ORG}/projects`);
  check('projects', 'projects page renders', projectsPage.status === 200, `HTTP ${projectsPage.status}`);
  if (slugs.length > 0) {
    check(
      'projects',
      'projects page shows a real project',
      projectsPage.body.includes(slugs[0]),
      `looked for "${slugs[0]}"`,
    );
    const detail = await apiGet(`/v1/orgs/${ORG}/projects/${slugs[0]}`);
    gateOrFail('projects', `GET project ${slugs[0]}`, detail, (b) => b && typeof b === 'object');
  }

  // ── lifecycle templates and their city formulas ──────────────────────────
  console.log('\ntemplates/formulas');
  const stock = await apiGet('/v1/lifecycle-templates/stock');
  if (gateOrFail('templates', 'GET stock catalog', stock, (b) => (asList(b)?.length ?? 0) > 0)) {
    const list = asList(stock.json);
    check('templates', 'stock catalog has templates', list.length >= 5, `${list.length} templates`);
    const labelled = list.filter((t) => typeof t.formula === 'string' && t.formula.startsWith('mol-mc-'));
    check(
      'templates',
      'every stock template names its city formula',
      labelled.length === list.length,
      `${labelled.length}/${list.length} carry mol-mc-* (e.g. ${list[0]?.formula ?? 'none'})`,
    );
    const first = list[0];
    if (first?.id) {
      const detail = await apiGet(`/v1/lifecycle-templates/stock/${first.id}`);
      if (gateOrFail('templates', `GET stock ${first.id}`, detail, (b) => b && typeof b === 'object')) {
        const steps = detail.json.steps ?? [];
        check('templates', 'detail carries compiler + steps', typeof detail.json.compiler === 'string' && steps.length > 0, `compiler=${detail.json.compiler} steps=${steps.length}`);
        check('templates', 'workflow ends in the landing step', steps.some((s) => s.id === 'land'), steps.map((s) => s.id).join(' → '));
      }
    }
  }
  const templatesPage = await webGet(`/orgs/${ORG}/lifecycle-templates`);
  check(
    'templates',
    'org template page renders',
    templatesPage.status === 200,
    `HTTP ${templatesPage.status} → ${templatesPage.url}`,
  );
  // The stock catalog — and the city formula each template becomes — is rendered
  // where a template is actually chosen: a project's lifecycle page. The org page
  // above is the YAML editor for the org-level default template.
  if (slugs.length > 0) {
    const pickerPage = await webGet(`/orgs/${ORG}/projects/${slugs[0]}/lifecycle`);
    const rendered = pickerPage.body.includes('mol-mc-');
    check(
      'templates',
      'project lifecycle page renders the stock picker with its formulas',
      pickerPage.status === 200 && rendered,
      `HTTP ${pickerPage.status}${rendered ? ' — mol-mc-* rendered' : ' — no formula text in HTML'}`,
    );
  }

  // ── costs (database ledger + Gas City usage) ─────────────────────────────
  console.log('\ncosts');
  const costs = await apiGet(`/v1/orgs/${ORG}/costs`);
  gateOrFail('costs', 'GET org costs', costs, (b) => b && typeof b === 'object');
  const usage = await apiGet(`/v1/orgs/${ORG}/admin/city/usage`);
  if (usage.status === 200) {
    const u = usage.json;
    check('costs', 'city usage answers', u && typeof u.available === 'boolean', `available=${u?.available} source=${u?.source}`);
    if (u?.available) {
      const today = u.today ?? {};
      check(
        'costs',
        'city usage carries today counters',
        ['invocations', 'wall_seconds', 'input_tokens', 'output_tokens', 'unpriced'].every((k) => typeof today[k] === 'number'),
        `invocations=${today.invocations} wall=${today.wall_seconds}s tokens=${today.input_tokens}/${today.output_tokens} unpriced=${today.unpriced} partial=${u.partial}`,
      );
      check(
        'costs',
        'estimate is labelled as local',
        u.source === 'local_estimate',
        `source=${u.source}`,
      );
    } else {
      info('costs', 'city usage available', `available=false — ${u?.error ?? 'no detail'}`);
    }
  } else if (usage.status === 403) {
    info('costs', 'GET city usage', `HTTP 403 for this credential — ${apiMessage(usage.json)}`);
  } else {
    // A 500 with a live supervisor means the stack cannot reach the city: the
    // supervisor binds 127.0.0.1, and the repo ships `ops/gc/city-bridge.mjs`
    // plus a compose default that points CITY_API_URL at it, so this is a
    // deployment missing a piece — not a defect in the route.
    const hostAnswers = await supervisorAnswersOnHost();
    check(
      'costs',
      'GET city usage',
      !hostAnswers,
      hostAnswers
        ? `HTTP ${usage.status} while the supervisor answers on the host (${HOST_CITY}) — the stack cannot reach it: install mergecrew-city-bridge.service and point CITY_API_URL at it (see docs/03-infrastructure/08-gas-city-integration.md §7b)`
        : `HTTP ${usage.status} — ${apiMessage(usage.json)} (the supervisor is not answering on the host either)`,
    );
  }
  const costsPage = await webGet(`/orgs/${ORG}/costs`);
  if (costsPage.status === 200) {
    check('costs', 'costs page renders', true, 'HTTP 200');
    check(
      'costs',
      'costs page shows the Gas City usage section',
      costsPage.body.includes('Gas City usage'),
      costsPage.body.includes('Gas City usage') ? 'section present' : 'section missing',
    );
  } else {
    info('costs', 'costs page renders', `HTTP ${costsPage.status} → ${costsPage.url}`);
  }

  // ── the Gas City tab ─────────────────────────────────────────────────────
  // Every route here reads the supervisor through `ops/gc/city-bridge.mjs`,
  // because the supervisor itself only listens on the host's loopback.
  console.log('\ncity');
  const cityStatus = await apiGet(`/v1/orgs/${ORG}/admin/city/status`);
  let anAgentName;
  if (cityStatus.status === 200) {
    const status = cityStatus.json ?? {};
    const details = Array.isArray(status.agent_details) ? status.agent_details : [];
    anAgentName = details[0]?.name;
    check('city', 'GET city status', typeof status.name === 'string', `name=${status.name} version=${status.version}`);
    check('city', 'status is the configured city', status.name === CITY, `expected ${CITY}, got ${status.name}`);
    check(
      'city',
      'status carries agents and work',
      typeof status.agent_count === 'number' && status.agent_count > 0 && status.work !== undefined,
      `agents=${status.agent_count} running=${status.running} work=${JSON.stringify(status.work ?? {})}`,
    );
  } else if (cityStatus.status === 403) {
    info('city', 'GET city status', `HTTP 403 for this credential — ${apiMessage(cityStatus.json)}`);
  } else {
    const hostAnswers = await supervisorAnswersOnHost();
    check(
      'city',
      'GET city status',
      false,
      hostAnswers
        ? `HTTP ${cityStatus.status} while the supervisor answers on the host (${HOST_CITY}) — the stack cannot reach the city bridge (§7b)`
        : `HTTP ${cityStatus.status} — ${apiMessage(cityStatus.json)}`,
    );
  }
  for (const resource of ['agents', 'sessions', 'projects']) {
    const read = await apiGet(`/v1/orgs/${ORG}/admin/city/${resource}`);
    if (read.status === 200) {
      const items = asList(read.json);
      check('city', `GET city ${resource}`, Array.isArray(items), `${items?.length ?? 0} item(s)`);
    } else if (read.status === 403) {
      info('city', `GET city ${resource}`, 'HTTP 403 for this credential');
    } else {
      check('city', `GET city ${resource}`, false, `HTTP ${read.status} — ${apiMessage(read.json)}`);
    }
  }
  const tenant = await apiGet(`/v1/orgs/${ORG}/admin/city/tenant/${ORG}`);
  if (tenant.status === 200) {
    // The mapping is the answer: a city that does not hold the derived rig is
    // reported with known=false, not answered with 404.
    const t = tenant.json ?? {};
    check(
      'city',
      'GET city tenant mapping',
      typeof t.rig === 'string' && t.rig.length > 0 && typeof t.known === 'boolean',
      `organization=${t.organization} rig=${t.rig} known=${t.known}`,
    );
  } else if (tenant.status === 403) {
    info('city', 'GET city tenant mapping', 'HTTP 403 for this credential');
  } else {
    check('city', 'GET city tenant mapping', false, `HTTP ${tenant.status} — ${apiMessage(tenant.json)}`);
  }
  const cityPage = await webGet(`/orgs/${ORG}/city`);
  if (cityPage.status === 200) {
    const unavailable = (cityPage.body.match(/unavailable/gi) ?? []).length;
    check(
      'city',
      'city page renders live data',
      unavailable === 0,
      unavailable === 0 ? 'no "unavailable" card' : `${unavailable} "unavailable" card(s) — the page kept a failed read`,
    );
    const stated = /unknown rig/.test(cityPage.body) || />mapped</.test(cityPage.body);
    check(
      'city',
      'city page states the tenant mapping',
      stated,
      stated ? 'the mapping card says mapped or unknown rig' : 'the mapping card said neither',
    );
    const names = [CITY, anAgentName].filter(Boolean);
    const missing = names.filter((name) => !cityPage.body.includes(name));
    check(
      'city',
      'city page shows the read payload',
      names.length > 0 && missing.length === 0,
      missing.length === 0 ? `found ${names.join(' and ')}` : `missing ${missing.join(', ')}`,
    );
    check(
      'city',
      'city page keeps its sections',
      ['Tenant mapping', 'Agents', 'Sessions'].every((title) => cityPage.body.includes(title)),
      'Tenant mapping · Agents · Sessions',
    );
  } else {
    info('city', 'city page renders', `HTTP ${cityPage.status} → ${cityPage.url}`);
  }

  // ── removed surfaces stay removed ────────────────────────────────────────
  console.log('\nremoved surfaces');
  const oldActivity = await apiGet(`/v1/orgs/${ORG}/activity`);
  check('removed', 'GET /v1/orgs/:slug/activity is gone', oldActivity.status === 404, `HTTP ${oldActivity.status}`);
  const activityPage = await webGet(`/orgs/${ORG}/activity`);
  check('removed', 'activity route is gone from the app', activityPage.status === 404, `HTTP ${activityPage.status} → ${activityPage.url}`);

  // ── tools + skills + ideas (the other two surfaces people click) ─────────
  console.log('\ntools, skills, ideas');
  const tools = await apiGet('/v1/tools');
  gateOrFail('tools', 'GET /v1/tools', tools, (b) => Boolean(b) && typeof b === 'object');
  const skillsPage = await webGet(`/orgs/${ORG}/skills`);
  if (skillsPage.status === 200) {
    check('tools', 'skills page renders as tools + skills', /Tools/i.test(skillsPage.body), 'HTTP 200');
  } else {
    info('tools', 'skills page renders', `HTTP ${skillsPage.status} → ${skillsPage.url}`);
  }
  const ideas = await apiGet(`/v1/orgs/${ORG}/ideas`);
  gateOrFail('ideas', 'GET ideas', ideas, (b) => Boolean(b) && typeof b === 'object');
  for (const route of ['ideas', 'inbox']) {
    const page = await webGet(`/orgs/${ORG}/${route}`);
    if (page.status === 200) check('ideas', `${route} page renders`, true, 'HTTP 200');
    else info('ideas', `${route} page renders`, `HTTP ${page.status} → ${page.url}`);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'fail');
  const passed = results.filter((r) => r.status === 'pass');
  const infos = results.filter((r) => r.status === 'info');
  console.log(`\n${passed.length} passed · ${failed.length} failed · ${infos.length} informational`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.surface}: ${f.name} — ${f.detail}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`e2e surfaces crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
