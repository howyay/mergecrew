# ops/ — primitive CI/CD, automatic ideation, the swipe gate, and the delivery chain

One loop, five stages, no dependencies:

```
   git commit ─▶ mergecrew-ci.service          ops/ci/ci-loop.mjs
                 polls HEAD → checks.conf → deploy.sh
                        │ ops/ci/state/last-run.json
                        ▼
   signals ─▶ generator ─▶ scorer ─▶ ideas.json     mergecrew-ideation.service
                        │
                        ▼
   swipe deck (in the product: /orgs/<slug>/ideas, plus the ops fallback on :7788)
                        │ accept
                        ▼
   mergecrew-pipeline.service                      ops/pipeline/run.mjs
     1 PRD      ops/pipeline/prd/<id>.md
     2 Issue    GitHub or Forgejo, or a local file when there is no token
     3 Worktree .worktrees/<id> on idea/<id>-<slug>
     4 Dev      one agent per feature, isolated in that worktree
     5 UAT      real chromium: strict checks + a screencast demo (APNG)
                        │
                        ▼
   human verdict on the card (Approve / Reject) — the pipeline never merges
```

Everything is plain Node (no dependencies, no build step) and every stage
writes its result to a file you can `cat`. Nothing in this directory claims a
success it did not observe: a stage with no record has not run, and a failure
keeps the provider's own words.

The mergecrew *application* stack that serves https://sd.yay.how is also owned
here (`ops/systemd/mergecrew-stack.service` + the health timer) — see section 7.

---

## 0. Is it running?

One command answers it — units, CI heartbeat, last pipeline result, and a live
HTTP probe of the swipe UI:

```bash
bash ops/systemd/install.sh status
```

A healthy system prints all four lines and exits 0. Anything that is not
`active`, a heartbeat older than four poll intervals, or an unreachable
`/healthz` makes it exit non-zero, so it also works from a cron/nagios-style
check. The loop is *supposed* to be quiet between commits: the journal only
speaks on a new SHA, a changed `checks.conf`, an `alive:` heartbeat line, or a
failure. Silence is not death — `heartbeat.json` tells them apart.

The swipe UI is loopback-only (`127.0.0.1:7788`). If you reach this machine
from elsewhere, forward the port (`ssh -L 7788:127.0.0.1:7788 ...`) rather than
binding the service to `0.0.0.0`: it has no authentication.

---

## 1. CI/CD — `ops/ci/`

`ci-loop.mjs` runs forever under systemd. Every `CI_POLL_SECONDS` (default 30)
it compares `git rev-parse HEAD` **and** a fingerprint of `checks.conf` with the
last recorded run. When either changed it:

1. runs each command in `checks.conf` in order, stopping at the first failure;
2. writes `ops/ci/state/last-run.json` (full result, per-check exit code,
   duration, last 4000 characters of output, the `checksHash` it ran under);
3. appends one line to `ops/ci/state/ci.log`;
4. if **all** checks passed **and** `ops/ci/deploy.sh` exists and is executable,
   runs it — that hook is the entire "CD" story.

Two behaviours exist because the alternative hides failures:

- **a restart runs the pipeline.** At startup the loop runs immediately unless
  the recorded result is for the current commit *and* the current check
  configuration. Otherwise a reboot (or a healthy `Restart=always`) would leave
  `last-run.json` frozen at a green result from an older tree, or missing
  entirely.
- **a changed `checks.conf` re-runs the pipeline.** A green run under the old
  check list says nothing about the new one; adding a check must produce a new
  verdict, not inherit the old one.
- **`SIGTERM` stops within a second.** The poll sleep is interruptible, so
  `systemctl restart` does not wait out the interval.
- **a running loop is visibly alive.** The poll loop rewrites
  `state/heartbeat.json` every 30s and logs an `alive: N polls ...` line every
  `CI_HEARTBEAT_EVERY` polls (default 20 = 10 min). Without it, a healthy loop
  between commits is indistinguishable from a dead one.

| File | Role |
| --- | --- |
| `checks.conf` | one shell command per line, run with cwd = repo root |
| `deploy.sh` | optional, gitignored, executable → run after a green pipeline |
| `deploy.sh.example` | the hook contract; copy to `deploy.sh` to enable CD |
| `state/last-run.json` | machine-readable result of the last run (also a signal for ideation) |
| `state/ci.log` | one line per run, for `tail` |
| `state/heartbeat.json` | refreshed every poll: pid, phase, polls, last result, next poll time |
| `test/ci-loop.test.mjs` | drives the real loop in throwaway git repos: fail-fast, deploy gating, fingerprint, watch mode |

Environment overrides (defaults are what systemd uses):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERGECREW_REPO` | cwd | repository to watch |
| `CI_CHECKS_FILE` | `ops/ci/checks.conf` | check list |
| `CI_STATE_DIR` | `ops/ci/state` | where the result and log are written |
| `CI_DEPLOY_HOOK` | `ops/ci/deploy.sh` | script to run after a green pipeline |
| `CI_POLL_SECONDS` | `30` | how often to look at `HEAD` |
| `CI_CHECK_TIMEOUT_SECONDS` | `1800` | per-check timeout (`SIGKILL`) |

Run it by hand:

```bash
node ops/ci/ci-loop.mjs --once     # run the pipeline once and exit (verification)
node ops/ci/ci-loop.mjs            # watch mode, same as systemd runs it
```

Add a check by editing `checks.conf`. Keep the cheap checks first: the pipeline
fails fast, so a broken commit is reported in seconds instead of minutes.

## 2. Ideation + scoring — `ops/ideation/`

One cycle = collect signals → generate ideas → score them → persist. The timer
runs a cycle every `IDEATION_INTERVAL_MINUTES` (default 360), plus one cycle at
cold start so the deck is never empty in a misleading way.

**Signals** (`lib/signals.mjs`, local and read-only): current HEAD/branch,
the last 60 commit subjects, TODO/FIXME/HACK clusters grouped by directory,
open `- [ ]` backlog items, and the last CI result from `ops/ci/state/last-run.json`.

Marker detection is deliberately strict, because a false cluster becomes a work
item a human then has to swipe away. A marker counts only when it is a real
comment that opens with the canonical colon form:

```ts
// TODO: validate input        ✅ counted
# FIXME(bob): no retry         ✅ counted (hash-comment languages only)
/* HACK: retried once */       ✅ counted
const x = "TODO: later";       ❌ inside a string literal
// TODO fix this               ❌ no colon form
 * TODO/FIXME density,         ❌ prose about markers
```

String literals are skipped entirely, so fixture data cannot masquerade as work.
This matters in practice: before the fix this repository reported 12 "TODO"
markers of which 10 were this file's own prose and test fixtures. The fix-churn
rule also requires `commitCount >= 10` subjects; a shallow clone reports one
commit, and one fix commit would otherwise read as 100% churn.

**Generation** (`lib/generator.mjs`) has two modes and always reports which one
actually ran:

| Mode | When | Behaviour |
| --- | --- | --- |
| `heuristic` (default) | no LLM credentials configured | deterministic rules over the signals |
| `llm` | `IDEA_LLM_BASE_URL` + `IDEA_LLM_API_KEY` (+ `IDEA_LLM_MODEL`) | OpenAI-compatible chat completion, JSON-only prompt, same signal bundle |

Set `IDEA_GENERATOR=llm` to force LLM mode. Any LLM failure falls back to
heuristic and records the reason in `lastGeneration.fallbackReason` — the UI
shows "生成器 heuristic", never "LLM" for a call that did not happen.

The heuristic rules, in the order they are evaluated (only the first 12 survive
the cap, so the urgent ones are generated first):

| Source | Fires when | Evidence it cites |
| --- | --- | --- |
| `ci-failure` | the last pipeline run failed | `ops/ci/state/last-run.json` status + the failing commands |
| `ci-missing` | no pipeline run has ever been recorded | the missing state file and `checks.conf` |
| `disabled-check` | a check is commented out in `ops/ci/checks.conf` | the exact line number and command |
| `deploy-hook` | `ops/ci/deploy.sh.example` exists but `deploy.sh` does not | both paths |
| `todo-cluster` | ≥3 actionable markers share a directory | the marker lines with `file:line` |
| `untested-area` | an `ops/*` area has source files and no test of its own | the source file paths |
| `backlog` | a backlog doc has open `- [ ]` items | the doc name and the item text |
| `fix-churn` | ≥25% of the last 60 subjects are fixes, sample ≥10 | the matching commit subjects |

The `untested-area` rule only looks at `ops/*`. The application packages have
their own conventions, and a wrong guess about where their tests live is worse
than no idea at all.

**Scoring** (`lib/scorer.mjs`) is one fixed rubric so ideas from different days
stay comparable:

| Axis | Max | Meaning |
| --- | --- | --- |
| impact | 40 | how much it moves the product |
| confidence | 20 | evidence-backed certainty it is real |
| effort | 20 | inverse of cost (small change scores high) |
| risk | 20 | inverse of blast radius (safe scores high) |

Bands: `≥75 must · ≥55 should · ≥35 could · else wont`. Only `ci-failure` (36
impact) reaches `must`; housekeeping work such as a TODO cluster (14) or an
untested area (18) is real but must not outrank a red trunk.

**Store** (`lib/store.mjs`) is one JSON file with atomic writes and serialized
mutations. A fingerprint a human already decided (accepted *or* rejected) is
never re-proposed, so a swipe is permanent until someone edits the file.

**Staleness.** Because a swipe is permanent, a card can outlive its own
evidence — "add tests to `ops/ci`" is false the moment `ops/ci` gains a test
suite. Each cycle re-derives the fingerprints the signals currently support and
sets `stale: true` on pending cards that fell out of that set (`markStaleness`,
counts reported as `staleMarked` / `staleCleared`). The UI shows a
"当前信号已不再支持" tag; the card stays swipeable, it just stops claiming to be
current. Cards that were already decided keep whatever flag they had.

A rendered-page check exists for the case where HTTP is fine but the UI is not:

```bash
node ops/ideation/tools/ui-render-check.mjs            # needs chromium + a running service
```

It drives headless chromium over CDP, waits for `.card` to appear, and fails on a
blank deck, a missing top card, or any console error — then writes a screenshot
you can look at. It is not in `checks.conf` on purpose: it needs a browser and a
live server, so it is a pre-release gate, not a per-commit one.

## 3. Swipe triage — two surfaces, one deck

**In the product (primary):** `https://sd.yay.how/orgs/<slug>/ideas` — the deck is
a page in the mergecrew web app, next to Inbox, with the same card, the same
rubric bars and the same evidence lines. Decisions go through
`POST /api/ideas/decide` (session-gated) into the shared state file.

**Standalone (operator surface):** `http://127.0.0.1:7788/` — the same deck from
the host service, for when the app is down or you are already in a terminal.

| Key | Action |
| --- | --- |
| `→` or drag right | accept |
| `←` or drag left | reject |
| `U` | undo the last decision |
| `G` / `R` | generate now / reload (standalone only) |

Each card shows the four rubric numbers, the source rule, the effort hint and
the raw evidence lines — a decision is made against evidence, not a headline.

### How the two surfaces stay consistent

The web app runs in a container with no repo access, so it cannot write task
files or spawn agents. The **file is the interface**:

1. the app writes only `status` / `decidedAt` (and clears `execution`);
2. the host service sweeps the file every `IDEATION_DISPATCH_SWEEP_SECONDS`
   (default 15s) and is the only writer of `execution` — it turns an accepted
   idea into `ops/execution/queue/<id>.md` and spawns the runner;
3. `docker-compose.override.yml` mounts `./ops/ideation/state` at `/data` with
   `userns_mode: keep-id`, so the container's uid 1000 is the host user and can
   actually write the decision back.

A decision therefore becomes work within seconds, with no network path between
the container and the host, and a decision made in either surface is honoured by
the same sweep.

HTTP API of the standalone service (all JSON):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | liveness: pid, uptime, repo, idea count, executor flag |
| GET | `/api/state` | stats, last generation (incl. `fallbackReason`), CI snapshot |
| GET | `/api/ideas?status=pending` | ideas, sorted by score |
| POST | `/api/decide` | `{id, decision: accepted\|rejected\|pending}` |
| POST | `/api/generate` | run a cycle now, returns real proposed/added/skipped |

App-side routes (`apps/web`): `GET /orgs/<slug>/ideas` renders the deck,
`POST /api/ideas/decide` records one decision, `POST /api/ideas/review` records
the Approve/Reject verdict for a finished chain, `POST /api/ideas/generate` asks
the host for a cycle, and `GET /api/ideas/artifact?id=&kind=` serves prd / issue
/ uat / demo. The container has no repo and cannot spawn anything, so every one
of those routes is a file handoff — see section 8.

## 4. The delivery chain — `ops/pipeline/` (the swipe is the gate)

`mergecrew-pipeline.service` watches accepted ideas and advances each one as far
as it honestly can. Stages, in order:

| # | Stage | Writes | Stops when |
|---|-------|--------|-----------|
| 1 | `prd` | `ops/pipeline/prd/<id>.md` | — (deterministic, from the idea + evidence) |
| 2 | `issue` | Forgejo/GitHub issue, else `ops/pipeline/issues/<id>.md` | no token → local file, the card says so |
| 3 | `worktree` | `.worktrees/<id>` on `idea/<id>-<slug>` | git refuses |
| 4 | `dev` | `TASK.md` + `PRD.md` in the worktree, one agent per feature; then the pipeline commits the tree on the idea branch | agent exits without `AGENT_REPORT.md` |
| 5 | `qa` | `ops/pipeline/uat/<id>/{uat.md,index.html,demo.png}` | a strict check fails |
| 6 | `review` | the human verdict, consumed from the deck | always waits for a person |

The gate itself is the swipe: `accept` puts a card in the queue, and the dev
stage only starts for accepted cards. The pipeline **never merges and never
deploys** — a passing chain ends at `awaiting-review` until a human presses
Approve.

Run one stage by hand, or one idea:

```bash
node ops/pipeline/run.mjs --idea idea-740f1748 --stage qa --force-qa   # UAT now, even after a failed dev
node ops/pipeline/run.mjs --idea idea-740f1748 --retry dev             # after a provider outage: re-run dev
node ops/pipeline/run.mjs --sweep                                      # one pass over the queue
node ops/pipeline/run.mjs --watch                                      # what the service runs
```

`--retry <stage>` exists because a recorded failure is deliberately *not*
retried automatically (see "Why a stage says blocked" below) — so without it, one
provider outage parks every accepted idea forever, and the only way out would be
hand-editing state. It clears the named stage **and every stage after it**: the
UAT verdict and the review record describe an artefact the retry is about to
replace. Stages before it stay, because the PRD and the filed issue are the
evidence of work already done and redoing them would file a second issue.

Environment (all optional, all in `ops/systemd/mergecrew-pipeline.service.in`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PIPELINE_DEV_AGENT` | `off` | `on` lets the dev stage spawn an agent (costs tokens) |
| `DEV_AGENT` | `auto` | `claude`, `pi` or `dsh`; `auto` takes the first one on PATH. The unit names `dsh` explicitly — see below |
| `PIPELINE_STAGE_ATTEMPTS` | `2` | failures before a stage is parked for a human |
| `PIPELINE_UAT_URL` | `http://127.0.0.1:3100/orgs/demo/ideas` | what the UAT drives |
| `ISSUE_TRACKER` | `auto` | `github`, `forgejo`, `none` — see below |
| `FORGEJO_URL` / `FORGEJO_REPO` / `FORGEJO_TOKEN` | — | read from `ops/pipeline/forgejo.env` (0600, gitignored) |

### Which agent actually runs

`claude` and `pi` are both installed on this host and both route to the
ai.yay.how gateway, which on 2026-10-03 answered every request with
`[claude-code:unrecognized_model]` (and `ALL_TARGETS_SKIPPED` for pi) — an
outage, not a task failure. `dsh headless` reaches a model here, so the unit
sets `DEV_AGENT=dsh` and `DSH_BIN=<path>` rather than leaving it to `auto`
(which would pick `claude` first and park every idea). The probe that justified
it: `dsh headless "Read TASK.md and do the task it describes."` in a scratch dir
read the file, wrote what it asked for, verified it with `wc -c`, and exited 0.
Switch that one line back the day the gateway serves `claude` again.

The agent does not get the pipeline's own environment: `childEnv` strips every
`PIPELINE_*` variable before spawning. A dev agent that inherits
`PIPELINE_DEV_AGENT=on` runs this repository's own test suite under a different
contract than the suite documents (`run.test.mjs` assumes the variable is off),
so the pipeline would fail the agent's verification for a reason that has nothing
to do with its change. The agent reported exactly that on 2026-10-03.

### What the worktree gets, and who commits

`git worktree add` checks out `HEAD`, and an idea can name a file that is not in
it — the first real dev agent spent its run hunting for `ops/ci/checks.conf`,
which existed only as an untracked directory in the operator's checkout (it is
tracked now, as of `a0d18d9`). `seedOps` therefore copies the `ops/` tooling in,
reported as `opsFiles` on the worktree stage. It copies the tooling and nothing
else — no `state/`, no `queue/`, no `node_modules/`, no `*.env`, not
`deploy.sh` — and it never overwrites a file that is already there, so a re-seed
cannot quietly revert the very edit under review.

The agent cannot commit. It runs inside a file sandbox rooted at its worktree,
while git's per-worktree index lives in `<repo>/.git/worktrees/<id>/`:

```console
$ git add ops/ci/checks.conf
fatal: Unable to create '.../.git/worktrees/idea-740f1748/index.lock': Permission denied
```

The pipeline runs outside that sandbox, so **the pipeline commits** the agent's
tree on the idea branch when `AGENT_REPORT.md` appears, with an identity passed
per command (`user.name=mergecrew agent`, and `commit.gpgsign=false` — this host
has signing configured with a key it cannot read). The dev record then carries
`commit`, `commitFiles` and `durationMs`, and keeps `provider`/`command`/`pid`
so the deck can say *which* agent did the work instead of "agent".

### Where issues are filed

`auto` uses the git remote. That is right until it is not: this repository's
upstream is a public GitHub repo with issues disabled, so a GitHub remote is not
automatically a place an idea can be filed. Set `ISSUE_TRACKER` explicitly to
override:

```bash
# ops/pipeline/forgejo.env — installed as EnvironmentFile by the pipeline unit
ISSUE_TRACKER=forgejo
FORGEJO_URL=http://127.0.0.1:3000
FORGEJO_REPO=haoye/mergecrew
FORGEJO_TOKEN=...            # needs write:issue
```

Forgejo also takes label **ids**, not names, so the module resolves (and if
necessary creates) `mergecrew`/`idea` before filing. A misspelled
`ISSUE_TRACKER` disables filing rather than silently falling back to GitHub.

### Why a stage says "blocked"

`blocked` means a human has to act; `failed` means the stage itself threw and
will be retried. An agent that never reached its model — a gateway 524, an
`ALL_TARGETS_SKIPPED` 503 — is recorded as
`dev agent could not reach its model provider: <the provider's own line>` with
`failureKind: provider-outage`, because retrying an outage just spends tokens.

## 5. Execution — `ops/execution/`

Accepting an idea **always** writes `ops/execution/queue/<idea-id>.md`: title,
score, evidence, and a definition of done that demands a verify command.

Spawning an agent is a separate, explicit switch: `EXECUTOR=on`. Then the
service starts `sandcastle-runner.mjs`, which hands the task file to
`sandcastle` (`@ai-hero/sandcastle`) and writes an outcome file the service
reconciles onto the idea.

The runner refuses to fake a run. It exits `3` (blocked) with a recorded reason
when sandcastle is not installed, when the installed package does not expose the
expected API, or when the requested container runtime is unavailable. It writes
`done` only when the agent process exits `0`.

An outcome belongs to one attempt, so reconciliation has two rules that keep the
card honest:

- **only accepted cards receive outcomes.** Undo a decision and any verdict the
  runner left behind is dropped (`execution.status: "none"`, reason
  `decision is pending/rejected`), rather than re-stamped on the next read;
- **re-publishing an outcome is not re-applying it.** A result is applied when
  status *and* `finishedAt` differ, so re-accepting an idea with the same
  outcome file still advances it, and a cleared card stays cleared.

```bash
# install the sandcastle dependency (kept OUT of the pnpm workspace on purpose)
pnpm --dir ops/execution install

# execution status of accepted ideas
cat ops/ideation/state/ideas.json | node -e "..."   # or just read the JSON
# set EXECUTOR=on in ops/systemd/mergecrew-ideation.service, then:
systemctl --user restart mergecrew-ideation
```

Container mode: `docker` and `podman` binary are present on this host but both
daemons are **down**, so the runner defaults to `SANDCASTLE_SANDBOX=none`
(host execution). Set `SANDCASTLE_SANDBOX=docker` only once the daemon runs;
the runner probes it and reports `blocked` instead of guessing.

## 6. Install / operate

```bash
ops/systemd/install.sh              # render units, enable --now, print status
ops/systemd/install.sh uninstall    # stop, disable, remove unit files
```

The units are rendered from `ops/systemd/*.service.in`, so the paths always
match the checkout they were installed from.

```bash
systemctl --user status mergecrew-ci mergecrew-ideation
journalctl --user -u mergecrew-ci -f
curl -s http://127.0.0.1:7788/healthz
```

Environment knobs (systemd `Environment=` lines, or the shell for manual runs):

| Variable | Default | Effect |
| --- | --- | --- |
| `MERGECREW_REPO` | repo root above `ops/` | which checkout to watch |
| `CI_POLL_SECONDS` | `30` | HEAD poll interval |
| `CI_CHECK_TIMEOUT_SECONDS` | `1800` | per-check kill timeout |
| `CI_CHECKS_FILE` | `ops/ci/checks.conf` | pipeline definition |
| `IDEATION_HOST` / `IDEATION_PORT` | `127.0.0.1` / `7788` | bind address |
| `IDEATION_INTERVAL_MINUTES` | `360` | generation cadence |
| `IDEATION_STATE_FILE` | `ops/ideation/state/ideas.json` | idea log (tests override it) |
| `IDEATION_EXECUTION_DIR` | `ops/execution` | queue/state location |
| `IDEA_GENERATOR` | `auto` | `auto` \| `heuristic` \| `llm` |
| `IDEA_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | unset | enables LLM generation |
| `EXECUTOR` | `off` | `on` spawns sandcastle per accepted idea |
| `SANDCASTLE_SANDBOX` | `none` | `none` \| `docker` \| `podman` |

## 7. Verify it actually works

```bash
bash ops/systemd/install.sh status            # units + heartbeats + every service + the sd.yay.how origin
node --test "ops/**/test/*.test.mjs"          # the whole chain: CI loop, ideation, pipeline, UAT recorder
node ops/ci/ci-loop.mjs --once                # the real pipeline: 6 checks, ~70s
node ops/ideation/tools/ui-render-check.mjs   # swipe UI renders in a real browser, screenshot attached
node ops/ci/tools/hydration-scan.mjs          # every operator page in a real browser, console must be clean
node ops/systemd/stack-health.mjs             # is the sd.yay.how origin answering?
```

`checks.conf` runs six things, cheapest first: the CI-loop tests, the ideation
tests, **the whole pipeline test suite** (PRD → issue → worktree → dev → UAT),
the no-raw-SQL lint, `tsc --noEmit` for the web app (the UI users see — without
it a sidebar change would ship unchecked), and the Forgejo tracker adapter.

`hydration-scan.mjs` is the one gate that needs the stack up, so it stays out of
`checks.conf`. It opens each page in headless Chromium and fails on a console
error, an uncaught exception or a React hydration mismatch (#418). That class is
invisible to every other check: the page renders, React silently throws the
server markup away and rebuilds it in the browser, and the only symptom is a red
console line. jsdom cannot see it either — it renders in one timezone and never
hydrates. Run it after any change that formats a date, and read
`apps/web/src/lib/time.ts` first.


To watch a card move without touching the UI:

```bash
node ops/pipeline/run.mjs --sweep                                  # one pass
cat ops/pipeline/state/idea-<id>.json                              # per-stage truth
node ops/pipeline/run.mjs --idea idea-<id> --stage qa --force-qa    # record a demo now
ls ops/pipeline/uat/idea-<id>/                                     # uat.md + index.html player
```

## 8. The stack behind https://sd.yay.how

The site is Cloudflare tunnel → `127.0.0.1:3100` → mergecrew web (rootless
podman compose). The units below are all installed by
`bash ops/systemd/install.sh`:

| Unit | What it does |
| --- | --- |
| `mergecrew-stack.service` | oneshot + `RemainAfterExit`: runs `docker compose -f docker-compose.full.yml -f docker-compose.override.yml up -d --no-build` at boot; `ExecStop` runs `compose stop` |
| `mergecrew-stack-health.timer` | every 5 min, plus 3 min after boot |
| `mergecrew-stack-health.service` | probes `http://127.0.0.1:3100/orgs/demo`; when it does not answer, restarts `mergecrew-stack.service` and re-probes (`ops/systemd/stack-health.mjs --repair`) |
| `mergecrew-uiscan.timer` / `.service` | daily, 04:30 + up to 10 min jitter: opens the four operator pages in headless Chromium and writes `ops/ci/state/hydration-report.json`. Exits 1 on a console error or a React hydration mismatch, so the day such a bug lands it shows up as a failed unit — `install.sh status` prints `ui scan: N/M page(s) clean` and names the failing URLs instead of nothing at all |

`mergecrew-tunnel.service` (the cloudflared connector, installed outside this
repo because its unit carries the tunnel token) declares
`Wants=mergecrew-stack.service` and `After=mergecrew-stack.service`.

Why this exists — on 2026-10-02 the site had been returning 502 for **7 days**:

1. The stack's containers had exited and **nothing was scheduled to start
   them**. cloudflared was enabled and healthy, so every health signal that only
   looked at *units* said "running" while the origin logged
   `dial tcp 127.0.0.1:3100: connect: connection refused` forever.
2. Even once the origin was up, `/api/auth/*` answered 500 `UntrustedHost`:
   Auth.js v5 only trusts the `Host` header automatically when `AUTH_URL` (not
   the legacy `NEXTAUTH_URL`) is set, and behind the tunnel the container never
   sees `sd.yay.how` on its own interface. `docker-compose.override.yml` now
   sets `AUTH_TRUST_HOST: 'true'`; safe because the app is reachable only over
   loopback and the CF Access–gated tunnel.

```bash
bash ops/systemd/install.sh status                 # all units + heartbeat + both services + origin probe
node ops/systemd/stack-health.mjs                  # check the origin only, exit 1 when down
node ops/systemd/stack-health.mjs --repair         # what the timer runs
systemctl --user stop mergecrew-stack              # simulate the outage; the timer brings it back within 5 min
journalctl --user -u mergecrew-stack -u mergecrew-stack-health -f
```

The repair path is tested by hand, not by the timer alone: stopping
`mergecrew-stack.service` and running the health service brought the origin back
in ~16s.

### The bridge network on this host has no way out

Rootless podman on this machine builds container networks that can neither
resolve nor route: the same image resolves DNS under `--network=host` and times
out on the bridge — even when the resolver is set explicitly to `1.1.1.1`, so
`dns:` in compose does not help. Containers here can talk to each other and to
nothing else. Other stacks on this host never noticed because they only talk to
each other.

It became our problem through `migrate`, which needs the network: the prisma CLI
fetches `schema-engine` from `binaries.prisma.sh` on first run, so on the bridge
it died with `getaddrinfo EAI_AGAIN`, and compose treats a failed dependency as
a reason to abort the whole `up`. `web` and `api` were left in `Created` — i.e.
`docker compose up -d` took the site down instead of bringing it up, including
the boot path and the health-timer repair path.

`docker-compose.override.yml` therefore runs `migrate` with
`network_mode: host` and reaches postgres over a loopback publish
(`127.0.0.1:55432`; 5432 is taken by a *host* postgres). Two details worth
remembering:

- `network_mode` and `networks` are mutually exclusive, so the base file's
  `networks: [internal]` has to be cleared with `networks: !override []` —
  otherwise compose refuses the project with `declares mutually exclusive
  network_mode and networks`.
- the same failure mode applies to anything else that fetches at runtime. If a
  future service needs the internet, it needs `network_mode: host` too.

## Known limits (not bugs to discover later)

- **No LLM credentials exist on this host**, so generation runs the heuristic
  path. The service reports `generator: "heuristic"` and says why if LLM mode
  was requested.
- **sandcastle is not installed** and **no container daemon is running**, so
  `EXECUTOR=on` currently produces `blocked: @ai-hero/sandcastle not installed`.
  Accepted ideas are queued as task files and nothing pretends to have executed.
- **The dev agents depend on an upstream gateway that is currently failing.**
  Both CLI agents on this machine go through remote model routers, and at the
  time of writing `claude` gets `API Error: 524 ... origin_response_timeout`
  from `ai.yay.how` while `pi` gets
  `503 ... ALL_TARGETS_SKIPPED`. The worktree, the task file, the spawn and the
  log capture all work; the agent reaches its model and dies. The pipeline
  records exactly that (with the provider's own line in `logTail`) and parks the
  card. Point `ANTHROPIC_BASE_URL` (or `DEV_AGENT`) at a working route to
  exercise stage 4 for real.
- Until a real dev agent runs, **the Approve path of the review gate has only
  been exercised by tests**: there has been no agent-authored change to approve.
  Reject, retry, the demo recording and the status derivation are all verified
  against real runs.
- The pipeline is single-repo, single-SHA, no artifacts, no parallelism, no
  per-branch history. That is the design, not an unfinished part of it.
- `deploy.sh` ships only as `.example`; CD is a no-op until you write a real one.
