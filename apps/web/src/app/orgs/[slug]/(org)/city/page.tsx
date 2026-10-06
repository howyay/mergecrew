import type { ReactNode } from 'react';
import { ApiError, api, type Session } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { requireSession } from '@/lib/session';
import {
  Card,
  CardBody,
  CardHead,
  Chip,
  DataTable,
  PageHead,
  StatBadge,
  StatusDot,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';

/**
 * Gas City state for one organization. Reads the admin city endpoints added in
 * ADR-0016 criterion 3.
 *
 * Every section owns its own read, so one failing read never blanks the page: an
 * unreachable supervisor still leaves the tenant mapping and the navigation usable,
 * and a missing admin role is reported in the card that needed it. The reads run
 * together, so the page costs one round trip instead of one per section.
 */

/** Live shapes of the supervisor read API — see ops/gc/city-client.mjs for the same door outside the API. */
interface CityStatus {
  name?: string;
  version?: string;
  path?: string;
  uptime_sec?: number;
  suspended?: boolean;
  agent_count?: number;
  rig_count?: number;
  beads_version?: string;
  agents?: { total?: number; running?: number; suspended?: number; quarantined?: number };
}

interface Counts {
  total?: number;
  running?: number;
}

interface Tenant {
  organization: string;
  city: string;
  rig: string;
  known?: boolean;
}

interface Agent {
  name?: string;
  display_name?: string;
  provider?: string;
  pool?: string;
  state?: string;
  running?: boolean;
  suspended?: boolean;
  available?: boolean;
}

interface CitySession {
  id?: string;
  alias?: string;
  title?: string;
  rig?: string;
  kind?: string;
  template?: string;
  provider?: string;
  display_name?: string;
  state?: string;
  last_active?: string | number;
  created_at?: string | number;
}

interface List<T> {
  items?: T[];
  total?: number;
}

/** One project bound (or not bound) to a rig — `/admin/city/projects`. */
interface ProjectRig {
  projectSlug: string;
  projectName: string;
  repoFullName: string | null;
  rig: string | null;
  rigPath: string | null;
  matched: boolean;
  reason: string;
  fix: string | null;
}

interface ProjectRigMap {
  city: string;
  rigs: { name: string; path?: string | null; suspended?: boolean | null }[];
  items: ProjectRig[];
  total: number;
  unmatched: number;
  complete: boolean;
}

type DotStatus = 'running' | 'paused' | 'idle' | 'failed' | 'done' | 'pending';
type Read<T> = { ok: true; data: T } | { ok: false; message: string };

/** One read per section. A failure is a value, not a thrown page. */
async function load<T>(path: string, session: Session): Promise<Read<T>> {
  try {
    return { ok: true, data: await api<T>(path, { session }) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, message: 'This view needs the admin role in this organization.' };
      }
      if (error.status === 404) {
        return {
          ok: false,
          message:
            'This organization maps to a rig the city does not hold. Add the rig, or set CITY_RIGS to the rig list the product should accept.',
        };
      }
      return { ok: false, message: error.message };
    }
    return { ok: false, message: 'The city read failed before Gas City answered.' };
  }
}

function agentStatus(agent: Agent): DotStatus {
  if (agent.running) return 'running';
  if (agent.suspended) return 'paused';
  if ((agent.state ?? '').toLowerCase() === 'failed') return 'failed';
  if (agent.available || (agent.state ?? '').toLowerCase() === 'stopped') return 'idle';
  return 'pending';
}

function sessionStatus(state?: string): DotStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'active':
    case 'running':
      return 'running';
    case 'start-pending':
    case 'pending':
      return 'pending';
    case 'suspended':
    case 'paused':
      return 'paused';
    case 'failed':
    case 'error':
      return 'failed';
    case 'stopped':
    case 'closed':
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

/** The supervisor reports uptime in seconds; the page shows the two units that matter. */
function formatUptime(seconds?: number): string {
  if (!Number.isFinite(seconds) || (seconds ?? 0) <= 0) return '—';
  const total = Math.round(seconds as number);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.round((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Session timestamps arrive as ISO strings or epoch seconds, and the shared
 * `relativeTime` helper owns the wording ("just now", "3m ago"), so this only
 * normalizes and falls back to the raw value.
 */
function ago(value?: string | number): string {
  if (value == null || value === '') return '—';
  const date =
    typeof value === 'number'
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : relativeTime(date);
}

function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hair-2 py-[7px] last:border-b-0">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">{k}</span>
      <span className={`text-right ${mono ? 'font-mono text-[12px] text-ink-2' : 'text-[13px]'}`}>
        {v}
      </span>
    </div>
  );
}

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <CardHead title={title} right={<Chip kind="high">unavailable</Chip>} />
      <CardBody>
        <p className="m-0 text-[13px] text-muted">{message}</p>
      </CardBody>
    </Card>
  );
}

export default async function CityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const base = `/v1/orgs/${slug}/admin/city`;

  const [status, tenant, projectRigs, agents, sessions] = await Promise.all([
    load<CityStatus>(`${base}/status?view=summary`, session),
    load<Tenant>(`${base}/tenant/${slug}`, session),
    load<ProjectRigMap>(`${base}/projects`, session),
    load<List<Agent>>(`${base}/agents`, session),
    load<List<CitySession>>(`${base}/sessions`, session),
  ]);

  const agentItems = agents.ok ? (agents.data.items ?? []) : [];
  const sessionItems = sessions.ok ? (sessions.data.items ?? []) : [];
  const projectRigItems = projectRigs.ok ? (projectRigs.data.items ?? []) : [];
  const unmatched = projectRigs.ok ? projectRigs.data.unmatched : 0;
  const runningAgents = agentItems.filter((a) => a.running).length;
  const counts: Counts = status.ok ? (status.data.agents ?? {}) : {};
  const liveSessions = sessionItems.filter((s) => sessionStatus(s.state) === 'running').length;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[{ label: slug, href: `/orgs/${slug}` }, { label: 'Gas City' }]}
        title="Gas City"
        meta={
          status.ok ? (
            <StatBadge kind={status.data.suspended ? 'warn' : 'healthy'}>
              {status.data.suspended ? 'suspended' : 'running'}
            </StatBadge>
          ) : (
            <StatBadge kind="disabled">unreachable</StatBadge>
          )
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        {status.ok ? (
          <Card>
            <CardHead
              title="City"
              meta={status.data.version ? `v${status.data.version}` : undefined}
              right={<StatusDot status={status.data.suspended ? 'paused' : 'running'} />}
            />
            <CardBody>
              <Row k="Name" v={status.data.name ?? 'unknown'} />
              <Row k="Uptime" v={formatUptime(status.data.uptime_sec)} />
              <Row
                k="Agents"
                v={`${counts.running ?? runningAgents} of ${counts.total ?? agentItems.length}`}
              />
              <Row k="Rigs" v={status.data.rig_count ?? '—'} />
              <Row k="Beads" v={status.data.beads_version ?? '—'} mono />
              <Row k="State dir" v={status.data.path ?? '—'} mono />
            </CardBody>
          </Card>
        ) : (
          <Unavailable title="City" message={status.message} />
        )}

        {tenant.ok ? (
          <Card>
            <CardHead
              title="Tenant mapping"
              meta="ADR-0016 · step 6"
              right={
                <StatBadge kind={tenant.data.known === false ? 'warn' : 'healthy'}>
                  {tenant.data.known === false ? 'unknown rig' : 'mapped'}
                </StatBadge>
              }
            />
            <CardBody>
              <Row k="Organization" v={tenant.data.organization} mono />
              <Row k="City" v={tenant.data.city} mono />
              <Row k="Rig" v={tenant.data.rig} mono />
              {tenant.data.known === false ? (
                <p className="mt-3 mb-0 text-[13px] text-muted">
                  The city holds no rig named <code className="font-mono">{tenant.data.rig}</code> for
                  this organization. Create the rig, or set{' '}
                  <code className="font-mono">CITY_RIGS</code> to the rig list the product should
                  accept.
                </p>
              ) : (
                <p className="mt-3 mb-0 text-[13px] text-muted">
                  Work for this organization routes to the rig above, inside city{' '}
                  <code className="font-mono">{tenant.data.city}</code>.
                </p>
              )}
            </CardBody>
          </Card>
        ) : (
          <Unavailable title="Tenant mapping" message={tenant.message} />
        )}
      </section>

      <section className="mb-6">
        {projectRigs.ok ? (
          <Card>
            <CardHead
              title="Projects"
              meta="each project, and the rig that carries it"
              right={
                <StatBadge kind={unmatched > 0 ? 'warn' : 'healthy'}>
                  {unmatched > 0
                    ? `${unmatched} without a rig`
                    : `${projectRigItems.length} mapped`}
                </StatBadge>
              }
            />
            {projectRigItems.length === 0 ? (
              <CardBody>
                <p className="m-0 text-[13px] text-muted">
                  This organization has no projects yet, so there is nothing to map to a rig.
                </p>
              </CardBody>
            ) : (
              <DataTable>
                <THead>
                  <TR>
                    <TH>Project</TH>
                    <TH>Repository</TH>
                    <TH>Rig</TH>
                    <TH>Match</TH>
                  </TR>
                </THead>
                <tbody>
                  {projectRigItems.map((item) => (
                    <TR key={item.projectSlug}>
                      <TD>
                        <div className="text-[13px] text-ink">{item.projectName}</div>
                        <div className="font-mono text-[11.5px] text-muted">{item.projectSlug}</div>
                      </TD>
                      <TD className="font-mono text-[11.5px] text-ink-2">
                        {item.repoFullName ?? '—'}
                      </TD>
                      <TD>
                        {item.matched ? (
                          <div className="font-mono text-[11.5px] text-ink-2">{item.rig}</div>
                        ) : (
                          <Chip kind="high">no rig</Chip>
                        )}
                        {item.matched && item.rigPath && (
                          <div className="font-mono text-[11px] text-muted">{item.rigPath}</div>
                        )}
                      </TD>
                      <TD className="text-[12px] text-muted">
                        <div>{item.reason}</div>
                        {!item.matched && item.fix && (
                          <div className="mt-1 text-[12px] text-ink-2">{item.fix}</div>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        ) : (
          <Unavailable title="Projects" message={projectRigs.message} />
        )}
      </section>

      <section className="mb-6">
        {agents.ok ? (
          <Card>
            <CardHead
              title="Agents"
              meta={`${agents.data.total ?? agentItems.length} in this city`}
              right={
                <StatBadge kind={runningAgents > 0 ? 'healthy' : 'disabled'}>
                  {runningAgents} running
                </StatBadge>
              }
            />
            {agentItems.length === 0 ? (
              <CardBody>
                <p className="m-0 text-[13px] text-muted">
                  No agents are registered in this city yet.
                </p>
              </CardBody>
            ) : (
              <DataTable>
                <THead>
                  <TR>
                    <TH>State</TH>
                    <TH>Agent</TH>
                    <TH>Provider</TH>
                    <TH>Pool</TH>
                    <TH>Reported</TH>
                  </TR>
                </THead>
                <tbody>
                  {agentItems.map((agent, i) => (
                    <TR key={agent.name ?? i}>
                      <TD>
                        <StatusDot status={agentStatus(agent)} />
                      </TD>
                      <TD className="font-mono text-[11.5px] text-ink-2">{agent.name ?? '—'}</TD>
                      <TD>{agent.provider ?? agent.display_name ?? '—'}</TD>
                      <TD className="font-mono text-[11.5px] text-ink-2">{agent.pool ?? '—'}</TD>
                      <TD className="text-muted">{agent.state ?? '—'}</TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        ) : (
          <Unavailable title="Agents" message={agents.message} />
        )}
      </section>

      <section>
        {sessions.ok ? (
          <Card>
            <CardHead
              title="Sessions"
              meta={`${sessions.data.total ?? sessionItems.length} known`}
              right={
                <StatBadge kind={liveSessions > 0 ? 'accent' : 'disabled'}>
                  {liveSessions} live
                </StatBadge>
              }
            />
            {sessionItems.length === 0 ? (
              <CardBody>
                <p className="m-0 text-[13px] text-muted">No sessions are running right now.</p>
              </CardBody>
            ) : (
              <DataTable>
                <THead>
                  <TR>
                    <TH>State</TH>
                    <TH>Session</TH>
                    <TH>Template</TH>
                    <TH>Provider</TH>
                    <TH>Last active</TH>
                  </TR>
                </THead>
                <tbody>
                  {sessionItems.map((session_, i) => (
                    <TR key={session_.id ?? i}>
                      <TD>
                        <StatusDot status={sessionStatus(session_.state)} />
                      </TD>
                      <TD>
                        <div className="font-mono text-[11.5px] text-ink-2">
                          {session_.alias ?? session_.title ?? session_.id ?? '—'}
                        </div>
                        <div className="text-[12px] text-muted">{session_.state ?? '—'}</div>
                      </TD>
                      <TD className="font-mono text-[11.5px] text-ink-2">
                        {session_.template ?? session_.kind ?? '—'}
                      </TD>
                      <TD>{session_.provider ?? session_.display_name ?? '—'}</TD>
                      <TD className="text-muted">{ago(session_.last_active)}</TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        ) : (
          <Unavailable title="Sessions" message={sessions.message} />
        )}
      </section>
    </main>
  );
}
