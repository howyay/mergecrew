# Gas City integration contract

Status: active. Date: 2026-10-05. Related: ADR-0016, `ops/gc/*`.

## 1. Purpose

This page is the contract between MergeCrew and Gas City. It states the read calls, the action
calls, the tenant rule, and the failure behaviour. Every payload shape below comes from a live run,
not from a guess.

## 2. Topology

| Item | Value |
| - | - |
| City directory | `/home/haoye/gascity` |
| City name | `gascity` |
| Rig | `mergecrew`, from `/home/haoye/projects/mergecrew` |
| Supervisor API | `http://127.0.0.1:8372` |
| Dashboard | the same supervisor, path `/` |
| Store | beads on Dolt, prefix `me` for the rig, `ga` for the city |

## 3. Read calls (HTTP)

The supervisor serves a read-only JSON API. Use it for reads. Do not shell out for a read.

| Call | Meaning | Verified shape |
| - | - | - |
| `GET /v0/city/<city>/status` | city state | `{name, path, version, uptime_sec, suspended, agent_count, rig_count, running, agents, rigs, work, mail}` |
| `GET /v0/city/<city>/agents` | agent list | `{items, total}` |
| `GET /v0/city/<city>/sessions` | session list | `{items, total}` |
| `GET /v0/city/<city>/usage` | token and cost record | `{available, recording, source, today, recent, recent_window_secs, observed_from, updated_at}` |
| `GET /v0/city/<city>/mail` | the mailbox addressed to `human` | `{items, total}`; each item `{id, from, to, subject, body, created_at, read, thread_id, rig}` |

`today` holds `invocations`, `compute_facts`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `wall_seconds`, `cost_usd_estimate`, and `unpriced` — the number of
invocations with no price on file.

A list call returns an envelope. Always read `items`. Some CLI calls return a bare array, so the
shared helper `items()` in `ops/gc/city-client.mjs` accepts both.

## 4. Action calls (CLI)

Use the CLI for a change. Add `--json` to every call and parse the result.

| Call | Meaning |
| - | - |
| `gc bd create --title <t> --type <k> --priority <n> --json` | create a work item in the rig |
| `gc bd show <id> --json` | read one work item |
| `gc sling <rig>/gastown.polecat <bead>` | route a work item to an agent |
| `gc order list --json` | list the scheduled orders |
| `gc formula list --json` | list the available formulas |
| `gc formula cook <name>` | instantiate a formula as real beads |
| `gc rig list --json` | list the rigs |
| `gc beads city use-managed` | repair a rig endpoint mirror after a move |
| `gc agent list --json` | agent config as gc reads it |
| `gc mail send human "<body>" --subject <s>` | ask a person a question (see §7c) |
| `gc mail reply <id> "<body>"` | answer into the asking thread |

Verified agent keys: `name`, `qualified_name`, `scope`, `work_dir`, `suspended`, `pool`,
`work_query`, `sling_query`. Verified session keys: `id`, `name`, `template`, `provider`, `state`,
`title`, `rig`, `alias`, `agent_name`, `command`, `work_dir`, `session_name`.

## 5. Tenant rule

Gas City is single-operator. MergeCrew is multi-tenant. The map is the missing layer.

| Rule | Value |
| - | - |
| One organization | one rig |
| Reference organization | `mergecrew` keeps the rig `mergecrew` |
| Any other organization | rig `mc-<org-slug>` |
| One project | one work prefix inside the rig |
| Remote write | a signed grant that names the city. One grant per organization. Never reuse a grant |

`ops/gc/tenant-map.mjs` renders the map and reports a missing rig, a shared rig, and an unknown
organization. `CityService.tenant()` in the product exposes the same rule, and
`GET /v1/orgs/:slug/admin/city/tenant/:orgSlug` answers it as a report: `known` says whether the
city holds the derived rig, and `known: false` is a value, not a 404. That is the normal state of an
organization whose rig has not been created yet, and the Gas City page renders it as "unknown rig"
beside the fix (create the rig, or set `CITY_RIGS`) instead of an "unavailable" card. On a
single-rig city only the reference organization (`mergecrew`) is mapped; a `demo` organization
derives to `mc-demo`, which the city does not hold until someone creates it.

## 6. Product surface

The API module `apps/api/src/modules/city` exposes the reads. It reuses `RoleGuard` and
`RequireRole('admin')`, in the same way as the admin health endpoint; the mailbox writes and reads
need `operator` and above instead, because answering an agent is an operational call, not an
administrative one.

| Route | Result |
| - | - |
| `GET /v1/orgs/:slug/admin/city/status` | city state; `?view=summary` keeps the nine fields the pages read and drops `agent_details` |
| `GET /v1/orgs/:slug/admin/city/agents` | agent list |
| `GET /v1/orgs/:slug/admin/city/sessions` | session list |
| `GET /v1/orgs/:slug/admin/city/tenant/:orgSlug` | the rig for an organization |
| `GET /v1/orgs/:slug/admin/city/projects` | every project of the organization bound to a rig, with a reason and a fix for the unmapped ones |
| `GET /v1/orgs/:slug/admin/city/usage` | today's invocations, tokens and wall time, with the city's own cost estimate |
| `GET /v1/orgs/:slug/admin/city/mail` | the mailbox addressed to `human`, normalized to `{items, total, unread}` |
| `POST /v1/orgs/:slug/admin/city/mail/:messageId/{reply,read,mark-unread,archive}` | answer a message, or move it between read, unread and archived (§7c) |

### Cost and usage

The city counts tokens, wall time and invocations on the host it runs on. That makes its numbers a
**local estimate, not a provider bill**, and the product says so instead of presenting them as spend.
`CityService.usage()` reads `GET /v0/city/<city>/usage` and normalizes it through `projectUsage()`:

| Field | Rule |
| - | - |
| `source` | the city's own label, `local_estimate` on the reference city; anything non-string becomes `unknown` |
| `unpriced` | invocations the city could not price |
| `partial` | derived here as `unpriced > 0`: the estimate is a floor, not a total |
| counters | coerced through a finite-number guard, so a missing or malformed counter reads as `0` rather than `NaN` |
| `available` / `recording` | strict `=== true`, so an absent flag is never read as healthy |
| missing payload | `EMPTY_CITY_USAGE` — zeros, `source: unknown`, no timestamp |

The costs page shows two sources side by side and keeps them apart: the per-day ledger from the
application database (`/v1/orgs/:slug/costs`, written by the runner) and the city panel. A failed city
read never blanks the ledger: `403` reads as "needs the admin role", any other failure renders a note
and leaves the ledger rows in place. A zero estimate with `partial` set is reported as "none of the N
invocations has a price on file, not because nothing was spent".

### Project to rig binding

A project reaches the city through a rig, so the product has to answer which rig carries which
project. The rule lives in one place — `packages/domain/src/rigs.ts` — so the API, the pages, and the
`ops/gc` tools cannot drift apart. `CityService.projectRigs()` reads `GET /v0/city/<city>/rigs` once
and binds each project (organization-scoped, `deletedAt: null`, ordered by slug) in this order:

1. `CITY_PROJECT_RIGS`, an explicit override. JSON (`{"mergecrew":"mc-mergecrew"}`) or a
   `slug=rig,slug2=rig2` list. A key may be the project slug, the full repository name, or the bare
   repository name, all lowercased.
2. The rig `name` equal to the repository name (`howyay/mergecrew` → `mergecrew`).
3. The rig directory basename equal to the repository name.

A project with no match is reported, never dropped: `reason` says what was tried, and `fix` names the
action (`gc rig add <path>`) so the page can show it. An override that names a rig the city does not
hold is reported the same way instead of silently falling back to a weaker match.

The override is read from the environment, so it needs no migration. Persisting it per project is the
next cut, and it is recorded as a finding before this landed.

| Environment variable | Default | Meaning |
| - | - | - |
| `CITY_API_URL` | `http://127.0.0.1:8372` (compose: `http://host.containers.internal:8373`) | supervisor address, or the city bridge when the API runs in a container (§7b) |
| `GC_CITY` | `gascity` | city name in the path |
| `CITY_API_TIMEOUT_MS` | `1500` | read timeout |
| `CITY_PROJECT_RIGS` | unset | explicit project → rig overrides, when the naming rule cannot find the rig |

The supervisor always answers with the whole status, `agent_details` included, and ignores query
parameters, so the `view=summary` projection happens in `CityService`: a keep-list of the nine fields
the pages read, which took the payload from 5,234 to 220 bytes on the reference city. The dropped block
is the agent list, so the saving grows with the agent count. A caller that omits `view` still gets the
full status.

### Lifecycle templates and formulas

A stock lifecycle template is the authoring surface; a formula is the execution graph. They are not the
same object and the mapping runs one way: **templates compile to formulas, templates do not become
formulas.**

| | Lifecycle template | Gas City formula |
| - | - | - |
| Holds | the whole `MergecrewConfig`: agent kinds, budgets, skill bindings, stack hints, the YAML an operator edits | the step graph the city compiles into beads |
| Edited by | the operator, per project, through the Lifecycle editor | nobody — it is generated, and the file says so |
| Consumed by | the product's runner, the Lifecycle picker, the onboarding wizard | `gc formula cook`, then sessions and beads |

The evidence that the mapping is mechanical: all five stock templates export without a special case,
and the exporter's output was cooked for real — `gc formula cook mol-mc-generic-careful` produced a
root bead plus five step beads. The evidence that the two should not be merged: a template carries
fields the city has no place for (stack tags; MergeCrew skill names, where the city deprecated its
`skills` key in v0.15.1 and hard-errors in v0.16), and a formula carries the landing step the
product's runner treats as its own job. Merging them would force one side to grow a vocabulary it does
not need.

What is wired today: `packages/domain/src/formula.ts` answers `formulaNameForTemplate()` and
`formulaStepsForTemplate()`; `GET /v1/lifecycle-templates/stock` reports the formula for each template
and the detail route adds `compiler` and the step chain; the Lifecycle picker prints the formula on
each card. `packages/domain/test/formula.test.ts` imports `ops/gc/formula-export.mjs` and fails when
the name or the step chain drifts, so the product and the CLI cannot disagree without CI going red.

What is not wired: the runner still executes its own step loop; it does not cook the project's
lifecycle formula and let the city run the steps. That is the next cut, recorded as a finding.

## 7. Failure behaviour

A read fails with one message that names the address and the fix: "Gas City is not reachable at
`<url>`. Start the supervisor, or set CITY_API_URL." The failure is logged at warn level. A read
never blocks the product request path for more than `CITY_API_TIMEOUT_MS`.

## 7b. When the API runs in a container: the city bridge

The supervisor binds `127.0.0.1:8372`, which is a loopback address on the *host*. A container that is
told to read it reaches its own loopback, so every `/v1/orgs/:slug/admin/city/*` route answers
`500 Gas City is not reachable at http://127.0.0.1:8372`, the Gas City tab renders "unavailable"
cards beside a healthy database, and the costs page keeps its ledger while saying the usage panel
could not be read.

`docker-compose.full.yml` therefore points the API at `ops/gc/city-bridge.mjs` (unit
`mergecrew-city-bridge.service`), which is the one way across:

* it binds the host's **default-route address** plus loopback, because that is the address
  `host.containers.internal` resolves to under podman/pasta. Measured on the reference host: a
  listener on the LAN address is reachable from a container at `169.254.1.2`, one bound to
  `172.17.0.1` is not reachable at all, and `10.89.0.1` is the container-side gateway, not the host;
* it forwards **reads** — `GET/HEAD /v0/city/<city>/{status,agents,sessions,usage,rigs}` — and the
  **human mailbox**: `GET .../mail` plus `POST .../mail/{id}/{reply,read,mark-unread,archive}`. Mail
  is private even on a LAN, so both halves of it need `X-City-Bridge-Token` to match
  `CITY_BRIDGE_TOKEN`; with no token configured the bridge answers `403` and names the missing
  variable, which is the state it starts in. Every other write (`bead/{id}/close`,
  `session/{id}/respond`, …) and every other path is refused with `403`, a write to a read path is
  `405`, so a container network still cannot drive the city;
* it is stateless, so it needs no restart of the supervisor. Rebinding the supervisor was rejected:
  it has no bind flag, it would mean restarting the unit the agents live in, and the same port would
  then serve its write routes to the LAN.

```bash
systemctl --user status mergecrew-city-bridge                  # is it running?
node ops/gc/city-bridge.mjs --check                            # supervisor reachable from the host?
node ops/gc/city-bridge.mjs --check --target http://host.containers.internal:8373
curl -s http://127.0.0.1:8373/v0/city/gascity/usage            # what the API sees
curl -s -H "x-city-bridge-token: $CITY_BRIDGE_TOKEN" \
  http://127.0.0.1:8373/v0/city/gascity/mail                   # the mailbox, token-gated
```

The token is set on the unit, not in the repo: `/home/haoye/.config/mergecrew/city-bridge-env.yml`
is the third compose file `mergecrew-stack.service` loads, and it supplies `CITY_BRIDGE_TOKEN` to
**both** the bridge and the API — the API reads mail through the bridge, so the two must agree. A
secret belongs in the operator's config tree, not in `docker-compose.full.yml`.

Host-side tooling (`ops/gc/city-client.mjs`, the gates) keeps reading `127.0.0.1:8372` directly: it
runs on the host, where the supervisor is already reachable. After the host changes networks the
default-route address changes with it — `systemctl --user restart mergecrew-city-bridge` re-resolves
it.

`scripts/e2e-surfaces.mjs` proves both directions: with the bridge missing it fails the city reads
(`HTTP 500 while the supervisor answers on the host`), and with it in place the same run reads
status, agents, sessions, projects and the tenant mapping, asserts the Gas City page renders the
payload with no "unavailable" card, and checks that the mailbox answers `403` without the token and
`200` with it.

## 7c. Asking a human: the mailbox the inbox is wired to

An agent that will not guess stops and asks. The city has two primitives for that:

* **Mail** — `gc mail send <to> <body>`, where `<to>` is a session alias or `human`. A message is a
  bead of type `message`, so it is durable and threaded: `gc mail reply <id>` answers into the same
  `thread_id`, which is how the answer reaches the asking agent instead of landing in a void.
  `gc mail` also has `archive`, `count`, `inbox`, `mark-read`, `mark-unread`, `peek`, `read`,
  `thread`.
* **Session prompts** — `GET /v0/city/<city>/session/{id}/pending` and `POST …/respond` for a live
  session blocked on a prompt. That is the dashboard's path and it only covers an agent that is
  still running; mail survives a session that ended, so the product reads mail.

The Inbox page (`apps/web/src/app/orgs/[slug]/(org)/inbox/page.tsx`) renders three queues now:
ideas, the city mailbox, and gate approvals. Mail is read from
`/v1/orgs/:slug/admin/city/mail` and answered through the four write routes in §10-api-surface;
answering rejoins the thread and marks the message read, and archiving is one-way because the city
exposes no unarchive route.

Two traps found by probing the live supervisor (2026-10-06):

* **Write routes need `X-GC-Request`.** Without a non-empty `X-GC-Request` header every mutation
  answers `403 {"title":"Forbidden","detail":"csrf: X-GC-Request header required on mutation
  endpoints"}`, including `POST …/mail/{id}/reply`. `CityService.write()` sends
  `x-gc-request: mergecrew-inbox`; a body is required on create (`{to, subject, body}`) but optional
  on reply.
* **`gc mail` and `GET /mail` are different views.** On the reference host `gc mail count --json`
  reported `{"recipient":"human","total":9,"unread":9}` with ids like `ga-wisp-oo9y`, and those ids
  are not in the bead store (`bd show` answers "not found") — while `GET /v0/city/gascity/mail`
  answered 23 items with `gc-` ids. The CLI also refuses remote operation (`gc mail inbox: this
  command does not support a remote city … yet`), so anything in a container must read the API. When
  the two disagree, the API is what the product shows.

Also: a write that times out is reported as *"did not complete at …; it did not answer within
<timeout>ms, so the write may or may not have landed"* and is never retried, because retrying a
reply would answer an agent twice.

## 7a. The rig endpoint mirror

A rig reads and writes through the city's store, which it finds in `<rig>/.beads/dolt-server.port`.
With `dolt.auto-start: false` that file is the only thing that names the endpoint, so when it goes
missing the rig resolves port 0 and every command in the rig directory fails:

```
$ cd ~/projects/mergecrew && bd list
Error: failed to open database: Dolt server unreachable at 127.0.0.1:0
```

The file went missing twice on 2026-10-05 (once before the write-failure incident, once after the
file-backed migration). The fix is one line, and it is the same line both times:

```bash
printf '%s\n' "$(cat ~/gascity/.beads/dolt-server.port)" > ~/projects/mergecrew/.beads/dolt-server.port
```

`ops/gc/city-health.mjs` checks the mirror for every rig and prints that fix with the file path, so a
missing or mismatched port file is caught by a gate instead of by a failed write:

```bash
node ops/gc/city-health.mjs --city-dir="$HOME/gascity"
# Endpoint mirror problems: 0
```

Do not answer this with `bd dolt start`: it starts a second server and points the rig at it, which is
the state the mirror rule exists to prevent.

## 7b. How the contract is enforced

`ops/gc/live-city-check.mjs` reads `status`, `agents`, `sessions`, and `usage`, then reports a
missing key, a bad list envelope, or an unreachable supervisor. `ops/gc/test/live-city.test.mjs`
runs it. The live test skips when the supervisor is down, so the suite still runs on a machine
without Gas City.

Run it before a release, and after a Gas City upgrade:

```bash
node ops/gc/live-city-check.mjs
# status: HTTP 200 · ok
# agents: HTTP 200 · ok
# sessions: HTTP 200 · ok
# usage: HTTP 200 · ok
# contract holds
```

## 8. Operating rules (learned on 2026-10-05)

1. An order that writes once per minute destroys the store. Fourteen such orders dropped the Dolt
   connection, and session metadata writes failed with them. Keep event-driven orders on. Keep
   timer orders off, or slow.
2. `min_active_sessions = 0` sends a pool worker to sleep. Set `1` for a worker that must stay warm.
3. Never run two Dolt servers on one data directory. Never `SIGKILL` the server.
4. `skills` in an agent config is deprecated. Record the skill intent as a comment.

## 9. What this page does not cover

1. No pull request exists yet for the ADR-0016 work. The keyring token is unreadable in a
   non-interactive shell.
2. The web app does not call the new endpoints yet. The API module is ready for it.
3. `pnpm --filter @mergecrew/api typecheck` is red for pre-existing reasons. See `me-kgy`.
