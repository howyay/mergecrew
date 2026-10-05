import { ApiError, api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, PageHead } from '@/components/ui';

/**
 * Gas City state for one organization. Reads the admin city endpoints added in
 * ADR-0016 criterion 3. The page degrades to a notice when the caller is not an
 * admin, or when the supervisor is not reachable.
 */
interface CityStatus {
  name?: string;
  version?: string;
  suspended?: boolean;
  agent_count?: number;
  rig_count?: number;
}

interface Tenant {
  organization: string;
  city: string;
  rig: string;
}

interface AgentRow {
  name?: string;
  qualified_name?: string;
  suspended?: boolean;
  scope?: string;
}

interface SessionRow {
  id?: string;
  name?: string;
  template?: string;
  provider?: string;
  state?: string;
  title?: string;
}

interface CityList<T> {
  items?: T[];
  total?: number;
}

interface Outcome {
  status: CityStatus | null;
  tenant: Tenant | null;
  agents: AgentRow[];
  sessions: SessionRow[];
  notice: string | null;
}

async function read(slug: string, session: Awaited<ReturnType<typeof requireSession>>): Promise<Outcome> {
  const empty = { status: null, tenant: null, agents: [], sessions: [], notice: null };
  try {
    const status = await api<CityStatus>(`/v1/orgs/${slug}/admin/city/status`, { session });
    const tenant = await api<Tenant>(`/v1/orgs/${slug}/admin/city/tenant/${slug}`, { session });
    // The lists are a second read, so a list failure still shows the city state.
    const agents = await api<CityList<AgentRow>>(`/v1/orgs/${slug}/admin/city/agents`, { session });
    const sessions = await api<CityList<SessionRow>>(`/v1/orgs/${slug}/admin/city/sessions`, { session });
    return {
      status,
      tenant,
      agents: agents.items ?? [],
      sessions: sessions.items ?? [],
      notice: null,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 403 || error.status === 401) {
        return { ...empty, notice: 'This view needs the admin role in this organization.' };
      }
      return { ...empty, notice: error.message };
    }
    return { ...empty, notice: 'Gas City state is not available right now.' };
  }
}

export default async function CityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const { status, tenant, agents, sessions, notice } = await read(slug, session);

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[{ label: slug, href: `/orgs/${slug}` }, { label: 'Gas City' }]}
        title="Gas City"
        meta={<span className="font-mono text-[12.5px] text-muted">the orchestrator for this organization</span>}
      />
      {notice ? (
        <Card>
          <p className="text-sm text-neutral-600">{notice}</p>
        </Card>
      ) : null}
      {status ? (
        <Card>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-neutral-500">City</dt>
            <dd>{status.name ?? 'unknown'}</dd>
            <dt className="text-neutral-500">Version</dt>
            <dd>{status.version ?? 'unknown'}</dd>
            <dt className="text-neutral-500">Agents</dt>
            <dd>{status.agent_count ?? 0}</dd>
            <dt className="text-neutral-500">Rigs</dt>
            <dd>{status.rig_count ?? 0}</dd>
            <dt className="text-neutral-500">State</dt>
            <dd>{status.suspended ? 'suspended' : 'running'}</dd>
          </dl>
        </Card>
      ) : null}
      {tenant ? (
        <Card>
          <p className="text-sm text-neutral-600">
            This organization runs on city <code>{tenant.city}</code> and rig <code>{tenant.rig}</code>.
          </p>
        </Card>
      ) : null}
      {agents.length ? (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Agents</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 font-normal">Agent</th>
                <th className="py-1 font-normal">Scope</th>
                <th className="py-1 font-normal">State</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.qualified_name ?? agent.name} className="border-t border-hair">
                  <td className="py-1 font-mono text-[12.5px]">{agent.qualified_name ?? agent.name ?? 'unknown'}</td>
                  <td className="py-1">{agent.scope ?? '—'}</td>
                  <td className="py-1">{agent.suspended ? 'suspended' : 'active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {sessions.length ? (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Sessions</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 font-normal">Session</th>
                <th className="py-1 font-normal">Agent</th>
                <th className="py-1 font-normal">State</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((row) => (
                <tr key={row.id ?? row.name} className="border-t border-hair">
                  <td className="py-1 font-mono text-[12.5px]">{row.name ?? row.id ?? 'unknown'}</td>
                  <td className="py-1 font-mono text-[12.5px]">{row.template ?? '—'}</td>
                  <td className="py-1">{row.state ?? 'unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </main>
  );
}
