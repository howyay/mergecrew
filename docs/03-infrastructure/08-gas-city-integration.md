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

`today` holds `invocations`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `wall_seconds`, and `cost_usd_estimate`.

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
organization. `CityService.tenant()` in the product exposes the same rule.

## 6. Product surface

The API module `apps/api/src/modules/city` exposes the reads. It reuses `RoleGuard` and
`RequireRole('admin')`, in the same way as the admin health endpoint.

| Route | Result |
| - | - |
| `GET /v1/orgs/:slug/admin/city/status` | city state; `?view=summary` keeps the nine fields the pages read and drops `agent_details` |
| `GET /v1/orgs/:slug/admin/city/agents` | agent list |
| `GET /v1/orgs/:slug/admin/city/sessions` | session list |
| `GET /v1/orgs/:slug/admin/city/tenant/:orgSlug` | the rig for an organization |

The supervisor always answers with the whole status, `agent_details` included, and ignores query
parameters, so the `view=summary` projection happens in `CityService`: a keep-list of the nine fields
the pages read, which took the payload from 5,234 to 220 bytes on the reference city. The dropped block
is the agent list, so the saving grows with the agent count. A caller that omits `view` still gets the
full status.

| Environment variable | Default | Meaning |
| - | - | - |
| `CITY_API_URL` | `http://127.0.0.1:8372` | supervisor address |
| `GC_CITY` | `gascity` | city name in the path |
| `CITY_API_TIMEOUT_MS` | `1500` | read timeout |

## 7. Failure behaviour

A read fails with one message that names the address and the fix: "Gas City is not reachable at
`<url>`. Start the supervisor, or set CITY_API_URL." The failure is logged at warn level. A read
never blocks the product request path for more than `CITY_API_TIMEOUT_MS`.

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
