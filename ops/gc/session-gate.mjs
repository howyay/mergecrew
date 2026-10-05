// Session contract gate. ADR-0016 step 4, second slice.
//
// For ten rounds the same failure repeated: a bead was routed to an agent, and no session ever
// claimed it. The work looked queued and was not. This gate checks the contract directly — every
// routed bead must have a live session that can claim it. Zero dependencies.
//
// Usage:
//   node ops/gc/session-gate.mjs [--city-dir=/home/haoye/gascity] [--max-waiting-minutes=15]
//
// Test: node --test ops/gc/test/session-gate.test.mjs

/** The states that mean "a session can still claim work". */
export const LIVE_STATES = ['active', 'start-pending'];

/** Open beads that carry a routing target. */
export function routedBeads(beads) {
  return (beads ?? []).filter((bead) => {
    if (bead.status && bead.status !== 'open' && bead.status !== 'in_progress') return false;
    return Boolean(bead.metadata?.['gc.routed_to']);
  });
}

export function liveSessions(sessions, target) {
  return (sessions ?? []).filter(
    (session) => session.template === target && LIVE_STATES.includes(session.state),
  );
}

function waitingMinutes(bead, now) {
  const stamp = bead.metadata?.['gc.routed_at'] ?? bead.updated_at ?? bead.created_at;
  const parsed = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

/**
 * Find routed work that no live session can claim.
 * Returns [{ bead, target, waitingMinutes, reason }].
 */
export function findStuckRouting({ beads, sessions, now = Date.now(), maxWaitingMinutes = 15 } = {}) {
  const stuck = [];
  for (const bead of routedBeads(beads)) {
    const target = bead.metadata['gc.routed_to'];
    const waiting = waitingMinutes(bead, now);
    const live = liveSessions(sessions, target);
    if (live.length === 0) {
      stuck.push({
        bead: bead.id,
        target,
        waitingMinutes: waiting,
        reason: waiting === null ? 'no live session for the target' : `no live session for the target after ${waiting} minute(s)`,
      });
      continue;
    }
    if (waiting !== null && waiting > maxWaitingMinutes) {
      stuck.push({
        bead: bead.id,
        target,
        waitingMinutes: waiting,
        reason: `waiting ${waiting} minute(s) while ${live.length} session(s) stay live`,
      });
    }
  }
  return stuck;
}

export function stateSummary(sessions) {
  const counts = {};
  for (const session of sessions ?? []) {
    const state = session.state ?? 'unknown';
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

export function renderGate({ routed, stuck, states, maxWaitingMinutes }) {
  const lines = ['# Session contract gate (ADR-0016 step 4)', ''];
  lines.push(`Routed work items: ${routed.length}`);
  lines.push(`Stuck: ${stuck.length} (limit ${maxWaitingMinutes} minute(s))`);
  lines.push(`Sessions by state: ${Object.entries(states).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Routed work');
  lines.push('');
  if (!routed.length) lines.push('None.');
  for (const item of routed) lines.push(`- \`${item.bead}\` → ${item.target}`);
  lines.push('');
  lines.push('## Stuck');
  lines.push('');
  if (!stuck.length) lines.push('None. Every routed work item has a live session.');
  for (const item of stuck) lines.push(`- \`${item.bead}\` → ${item.target}: ${item.reason}`);
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function runGate({ beads, sessions, now = Date.now(), maxWaitingMinutes = 15 } = {}) {
  const routed = routedBeads(beads).map((bead) => ({ bead: bead.id, target: bead.metadata['gc.routed_to'] }));
  const stuck = findStuckRouting({ beads, sessions, now, maxWaitingMinutes });
  const states = stateSummary(sessions);
  return { routed, stuck, states, report: renderGate({ routed, stuck, states, maxWaitingMinutes }) };
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const cityDir = arg('--city-dir') ?? process.env.GC_CITY_PATH ?? process.cwd();
  const maxWaitingMinutes = Number(arg('--max-waiting-minutes') ?? 15);
  const { execFileSync } = await import('node:child_process');
  const run = (callArgs) => execFileSync('gc', callArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: cityDir });
  const parse = (text) => {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : (data.issues ?? data.sessions ?? data.items ?? []);
  };

  const beads = parse(run(['bd', 'list', '--json']));
  const sessions = parse(run(['session', 'list', '--json']));
  const result = runGate({ beads, sessions, maxWaitingMinutes });
  console.log(result.report);
  return result.stuck.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
