/**
 * Is the mergecrew application stack (the origin behind https://sd.yay.how)
 * actually answering? Run by mergecrew-stack-health.timer every few minutes.
 *
 *   node ops/systemd/stack-health.mjs            # check only, exit 1 when down
 *   node ops/systemd/stack-health.mjs --repair   # restart mergecrew-stack.service, then re-check
 *
 * Why this exists: cloudflared is enabled at boot and happily keeps running
 * while its origin is dead, so the tunnel logs "connection refused" forever and
 * the site is simply down until someone notices. On 2026-10-02 the stack had
 * been stopped for 7 days with nothing scheduled to bring it back.
 *
 * Exit codes: 0 healthy (or repaired), 1 down, 3 down and repair did not help.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const args = process.argv.slice(2);
const repair = args.includes('--repair');
const url = valueOf('--url') ?? process.env.STACK_HEALTH_URL ?? 'http://127.0.0.1:3100/orgs/demo';
const timeoutMs = Number(valueOf('--timeout-ms') ?? process.env.STACK_HEALTH_TIMEOUT_MS ?? 10_000);
const unit = valueOf('--unit') ?? 'mergecrew-stack.service';

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const stamp = () => new Date().toISOString();

async function probe() {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.status < 400, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err?.name ?? String(err), ms: Date.now() - started };
  }
}

const describe = (r) => (r.ok ? `HTTP ${r.status} in ${r.ms}ms` : r.error ? `${r.error} after ${r.ms}ms` : `HTTP ${r.status} after ${r.ms}ms`);

const first = await probe();
if (first.ok) {
  console.log(`${stamp()} ok: ${url} -> ${describe(first)}`);
  process.exit(0);
}

console.log(`${stamp()} DOWN: ${url} -> ${describe(first)}`);

if (!repair) {
  console.log(`${stamp()} not repairing (pass --repair to restart ${unit})`);
  process.exit(1);
}

console.log(`${stamp()} restarting ${unit}`);
try {
  const { stdout, stderr } = await run('systemctl', ['--user', 'restart', unit], { timeout: 15 * 60_000 });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.log(stderr.trim());
} catch (err) {
  console.log(`${stamp()} restart failed: ${err?.message ?? err}`);
  console.log(`${stamp()} inspect: systemctl --user status ${unit} ; podman logs mergecrew-web`);
  process.exit(3);
}

// `docker compose up -d` returns once the containers are started, not once the
// app answers — give the origin a moment, then judge it on a real request.
let last = { ok: false, error: 'not probed yet' };
for (let attempt = 1; attempt <= 12; attempt++) {
  await new Promise((r) => setTimeout(r, 5_000));
  last = await probe();
  if (last.ok) {
    console.log(`${stamp()} recovered after restart: ${url} -> ${describe(last)} (attempt ${attempt})`);
    process.exit(0);
  }
}

console.log(`${stamp()} still down after restart: ${describe(last)}`);
console.log(`${stamp()} inspect: systemctl --user status ${unit} ; podman ps -a | grep mergecrew ; podman logs --tail 50 mergecrew-web`);
process.exit(3);
