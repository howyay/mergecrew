#!/usr/bin/env bash
# Install / uninstall the two user services from the templates in this dir.
#
#   ops/systemd/install.sh              # install + enable --now + verify
#   ops/systemd/install.sh uninstall    # stop, disable, remove unit files
#   ops/systemd/install.sh status       # units + CI heartbeat + last run + HTTP probe
#
# Templates use __REPO__ / __NODE__ / __LOCAL_BIN__ / __PROFILE_BIN__ / __USER__
# placeholders resolved here, so the units never carry a hardcoded path that
# drifts from the checkout they were installed from.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(mergecrew-ci.service mergecrew-ideation.service mergecrew-pipeline.service mergecrew-city-bridge.service mergecrew-stack.service mergecrew-stack-health.service mergecrew-stack-health.timer mergecrew-uiscan.service mergecrew-uiscan.timer)

NODE="$(command -v node)"
LOCAL_BIN="$(dirname "$(command -v pnpm || command -v node)")"
PROFILE_BIN="$(dirname "$(command -v git)")"
UID_NUM="$(id -u)"
DOCKER_BIN="$(command -v docker || true)"
DSH_BIN="$(command -v dsh || true)"
[[ "$LOCAL_BIN" == "$PROFILE_BIN" ]] && PROFILE_BIN="/etc/profiles/per-user/$USER/bin"

render() {
  sed -e "s|__REPO__|$REPO|g" \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__LOCAL_BIN__|$LOCAL_BIN|g" \
      -e "s|__PROFILE_BIN__|$PROFILE_BIN|g" \
      -e "s|__USER__|$USER|g" \
      -e "s|__UID__|$UID_NUM|g" \
      -e "s|__DOCKER__|$DOCKER_BIN|g" \
      -e "s|__DSH__|$DSH_BIN|g" \
      "$1"
}

install_units() {
  mkdir -p "$UNIT_DIR"
  for u in "${UNITS[@]}"; do
    render "$HERE/$u.in" > "$UNIT_DIR/$u"
    echo "rendered $UNIT_DIR/$u"
  done
  systemctl --user daemon-reload
  # enable --now is not enough: it leaves an *already active* unit running the
  # old definition, so a unit file change would silently do nothing until the
  # next reboot. Restart services explicitly; timers and timer-driven oneshots
  # only need to be started (installing must not wait on a browser scan).
  systemctl --user enable "${UNITS[@]}"
  for u in "${UNITS[@]}"; do
    case "$u" in
      *.timer|*health.service|*uiscan.service) systemctl --user start "$u" || true ;;
      *) systemctl --user restart "$u" ;;
    esac
  done
  sleep 3
  for u in "${UNITS[@]}"; do
    printf '%-28s %s\n' "$u" "$(systemctl --user is-active "$u")"
  done
  echo
  echo "CI status file:   $REPO/ops/ci/state/last-run.json"
  echo "Stack origin:     $REPO/ops/systemd/mergecrew-stack.service"
  echo "City bridge:      journalctl --user -u mergecrew-city-bridge -f  (the stack reads the city through :8373)"
  echo "Swipe UI:         http://127.0.0.1:7788/"
  echo "Ideas deck:       https://sd.yay.how/orgs/demo/ideas"
  echo "Logs:             journalctl --user -u mergecrew-ci -f"
}

uninstall_units() {
  systemctl --user disable --now "${UNITS[@]}" 2>/dev/null || true
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  systemctl --user daemon-reload
  echo "removed ${UNITS[*]}"
}

# One command that answers "is it running?" without reading any source.
status_units() {
  local ok=0
  for u in "${UNITS[@]}"; do
    local active result state
    active="$(systemctl --user is-active "$u" 2>/dev/null || true)"
    result="$(systemctl --user show -p Result --value "$u" 2>/dev/null || true)"
    # Oneshot units (the health check) are "inactive" once they succeed; only a
    # failed Result means they are unhealthy.
    if [[ "$active" == "active" ]]; then
      state="$active"
    elif [[ "$result" == "success" && "$u" == *.service ]]; then
      # A oneshot service that already succeeded sits at inactive/success.
      # A dead *timer* is never healthy — it means nothing is checking anymore.
      state="done"
    else
      state="${active:-unknown}"
      ok=1
    fi
    printf '%-28s %-8s %s\n' "$u" "$state" "$(systemctl --user is-enabled "$u" 2>/dev/null || true)"
  done

  if [[ -f "$REPO/ops/ci/state/heartbeat.json" ]]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const h = JSON.parse(fs.readFileSync(p, "utf8"));
      const age = Math.round((Date.now() - Date.parse(h.at)) / 1000);
      const due = Math.round((Date.parse(h.nextPollAt) - Date.now()) / 1000);
      console.log(`ci heartbeat:     pid ${h.pid} ${age}s ago, phase ${h.phase}` +
        (h.head ? `, head ${String(h.head).slice(0, 8)}` : "") +
        `, last result ${h.lastStatus ?? "none"}, polls ${h.polls}` +
        (due >= 0 ? `, next poll in ${due}s` : `, poll overdue by ${-due}s`));
      process.exit(age > Math.max(120, (h.pollMs || 30000) / 1000 * 4) ? 2 : 0);
    ' "$REPO/ops/ci/state/heartbeat.json" || ok=1
  else
    echo "ci heartbeat:     none — the CI loop has not polled since this state dir was cleared"
  fi

  if [[ -f "$REPO/ops/ci/state/last-run.json" ]]; then
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(`ci last run:      ${r.status} head ${String(r.head).slice(0, 8)} ` +
        `(${r.checks?.length ?? 0} checks, ${r.finishedAt})`);
    ' "$REPO/ops/ci/state/last-run.json"
  fi

  # The pipeline spawns agents on its own; without a heartbeat a stuck sweep and
  # a quiet one look identical.
  if [[ -f "$REPO/ops/pipeline/state/heartbeat.json" ]]; then
    node -e '
      const fs = require("fs");
      const h = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const age = Math.round((Date.now() - Date.parse(h.at)) / 1000);
      const ideas = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).ideas ?? [];
      const pipeline = ideas.filter((i) => i.pipeline);
      const awaiting = pipeline.filter((i) => i.pipeline.status === "awaiting-review").length;
      const running = pipeline.filter((i) => i.pipeline.status === "running").length;
      console.log(`pipeline:         pid ${h.pid} ${age}s ago, ${h.advanced ?? 0} advanced of ${h.queue ?? 0} queued, ` +
        `dev agent ${h.devAgent ? "ON" : "off"}, ${running} running / ${awaiting} awaiting review`);
      process.exit(age > 180 ? 2 : 0);
    ' "$REPO/ops/pipeline/state/heartbeat.json" "$REPO/ops/ideation/state/ideas.json" || ok=1
  else
    echo "pipeline:         no heartbeat — nothing has swept since this state dir was cleared"
  fi

  local port="${IDEATION_PORT:-7788}"
  node -e '
    const port = process.argv[1];
    fetch(`http://127.0.0.1:${port}/healthz`)
      .then((r) => r.json())
      .then((h) => {
        console.log(`ideation http:    ok, pid ${h.pid}, up ${h.uptimeSeconds}s, ` +
          `${h.ideas} ideas, executor ${h.executorEnabled ? "ON" : "off"}`);
      })
      .catch((e) => {
        console.log(`ideation http:    NOT REACHABLE on 127.0.0.1:${port} (${e.message})`);
        process.exit(1);
      });
  ' "$port" || ok=1

  # The origin behind https://sd.yay.how. The tunnel stays "active" while this
  # is dead, so checking the unit alone would report a healthy site that 502s.
  node -e '
    const url = "http://127.0.0.1:3100/orgs/demo";
    const t0 = Date.now();
    fetch(url, { redirect: "manual" })
      .then((r) => {
        const ms = Date.now() - t0;
        if (r.status >= 400) {
          console.log(`sd.yay.how origin: HTTP ${r.status} on ${url} (${ms}ms) — the site will 502`);
          process.exit(1);
        }
        console.log(`sd.yay.how origin: ok, HTTP ${r.status} in ${ms}ms (127.0.0.1:3100)`);
      })
      .catch((e) => {
        console.log(`sd.yay.how origin: NOT REACHABLE on 127.0.0.1:3100 (${e.cause?.code ?? e.message}) — the site is down`);
        process.exit(1);
      });
  ' || ok=1

  # Last browser scan of the operator pages. From the outside a clean page and a
  # page whose console is full of React hydration errors look identical — the
  # page renders either way — so this report is where that difference lives.
  if [[ -f "$REPO/ops/ci/state/hydration-report.json" ]]; then
    node -e '
      const fs = require("fs");
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const results = r.results ?? [];
      const bad = results.filter((x) => (x.errors ?? []).length > 0 || (x.textChars ?? 0) < 200);
      const age = r.scannedAt ? Math.round((Date.now() - Date.parse(r.scannedAt)) / 60000) : null;
      console.log(`ui scan:          ${results.length - bad.length}/${results.length} page(s) clean` +
        (age === null ? "" : `, ${age}min ago`));
      for (const x of bad) {
        console.log(`                  FAIL ${x.url}`);
        for (const e of (x.errors ?? []).slice(0, 2)) console.log(`                       ${String(e).slice(0, 140)}`);
      }
      process.exit(bad.length ? 2 : 0);
    ' "$REPO/ops/ci/state/hydration-report.json" || ok=1
  else
    echo "ui scan:          never run — systemctl --user start mergecrew-uiscan.service"
  fi

  echo
  echo "UI:    http://127.0.0.1:${port}/   (loopback only)"
  echo "Site:  https://sd.yay.how/          (Cloudflare Access SSO -> 127.0.0.1:3100)"
  echo "Logs:  journalctl --user -u mergecrew-ci -u mergecrew-ideation -u mergecrew-stack -n 20"
  return "$ok"
}

case "${1:-install}" in
  install) install_units ;;
  uninstall) uninstall_units ;;
  status) status_units ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac
