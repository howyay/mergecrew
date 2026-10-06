import { ApiError, api, type Session } from '@/lib/api';
import { requireSession } from '@/lib/session';
import Link from 'next/link';
import { Card, CardBody, CardHead, Chip, PageHead, StatBadge, Tile } from '@/components/ui';
import { SideEffectBadge } from '@/components/side-effect-badge';
import {
  SKILL_CATALOG_ROUTE,
  type SideEffectClass,
  type SkillRow,
} from '@/lib/skill-catalog';

/**
 * Skills vs tools (#324) — and the catalog's only home.
 *
 * A skill is a capability in the catalog; a tool is what an agent kind actually
 * sees on the wire. The gap is a projection the runtime applies before every
 * model call — read-only kinds lose write skills, and dotted skill names are
 * sanitized for providers that reject them. `/v1/tools` reports that projection
 * from the same code the runtime uses, so this page never has to explain the
 * difference in prose alone: it shows both sides.
 *
 * The stock catalog is global and read-only, so it is listed here and nowhere
 * else: the lifecycle editor links here instead of re-rendering it. Custom
 * skills run the other way — they belong to one lifecycle scope, so they are
 * authored there and this page only says where.
 */

type ToolRow = {
  wireName: string;
  skillName: string;
  sideEffectClass: SideEffectClass;
  description: string;
};

type AgentSurface = {
  ref: string;
  kind: string;
  description: string | null;
  readOnly: boolean;
  tools: ToolRow[];
  hidden: { skillName: string; sideEffectClass: SideEffectClass; reason: string }[];
  missing: { skillName: string; reason: string }[];
};

type ToolsPayload = {
  items: AgentSurface[];
  readOnlyKinds: string[];
  skillCount: number;
  wireNaming: string;
};

type Read<T> = { ok: true; data: T } | { ok: false; message: string };

/** One read per section. A failure is a value, not a thrown page. */
async function load<T>(path: string, session: Session): Promise<Read<T>> {
  try {
    return { ok: true, data: await api<T>(path, { session }) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, message: 'This view needs an authenticated organization member.' };
      }
      return { ok: false, message: error.message };
    }
    return { ok: false, message: 'The catalog read failed before the API answered.' };
  }
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

function ToolSurfaceCard({ agent }: { agent: AgentSurface }) {
  return (
    <Card>
      <CardHead
        title={agent.ref}
        meta={agent.kind === agent.ref ? undefined : `kind ${agent.kind}`}
        right={
          agent.readOnly ? (
            <Chip kind="low">read-only kind</Chip>
          ) : (
            <StatBadge kind="accent">writes</StatBadge>
          )
        }
      />
      <CardBody>
        {agent.description && (
          <p className="m-0 mb-4 text-[12.5px] leading-[1.55] text-ink-2">{agent.description}</p>
        )}

        {agent.tools.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">
            No tool is bound for this kind, so a model step from it has nothing to call.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {agent.tools.map((t, i) => (
              <li
                key={t.wireName}
                className={i < agent.tools.length - 1 ? 'border-b border-hair-2' : ''}
              >
                <div className="grid grid-cols-[1fr_auto] items-start gap-4 py-[10px]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono text-[13px] font-medium text-ink">
                        {t.wireName}
                      </span>
                      {t.skillName !== t.wireName && (
                        <span className="font-mono text-[10.5px] text-muted">
                          from {t.skillName}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[12.5px] leading-[1.55] text-ink-2">
                      {t.description}
                    </div>
                  </div>
                  <SideEffectBadge cls={t.sideEffectClass} />
                </div>
              </li>
            ))}
          </ul>
        )}

        {agent.hidden.length > 0 && (
          <div className="mt-4 border-t border-hair-2 pt-3">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
              Filtered out for this kind
            </div>
            <ul className="m-0 mt-2 list-none p-0">
              {agent.hidden.map((h) => (
                <li key={h.skillName} className="flex flex-wrap items-baseline gap-x-3 py-[3px]">
                  <span className="font-mono text-[12px] text-ink-2">{h.skillName}</span>
                  <span className="text-[12px] text-muted">{h.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {agent.missing.length > 0 && (
          <div className="mt-4 border-t border-hair-2 pt-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                Bound but not in the catalog
              </span>
              <Chip kind="high">{agent.missing.length}</Chip>
            </div>
            <ul className="m-0 mt-2 list-none p-0">
              {agent.missing.map((m) => (
                <li key={m.skillName} className="flex flex-wrap items-baseline gap-x-3 py-[3px]">
                  <span className="font-mono text-[12px] text-ink-2">{m.skillName}</span>
                  <span className="text-[12px] text-muted">{m.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default async function SkillsCatalogPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();

  const [catalog, tools] = await Promise.all([
    load<{ items: SkillRow[] }>(SKILL_CATALOG_ROUTE, session),
    load<ToolsPayload>('/v1/tools', session),
  ]);

  const items = catalog.ok ? (catalog.data.items ?? []) : [];
  const counts = items.reduce(
    (acc, s) => {
      acc.total += 1;
      acc[s.sideEffectClass] = (acc[s.sideEffectClass] ?? 0) + 1;
      return acc;
    },
    { total: 0 } as Record<string, number>,
  );

  const surfaces = tools.ok ? (tools.data.items ?? []) : [];

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[{ label: slug, href: `/orgs/${slug}` }, { label: 'Skills and tools' }]}
        title="Skills and tools"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Skills are the catalog you bind in an agent. Tools are the function surface that agent
            kind actually gets — read-only kinds never see a write skill, and names are sanitized
            for the provider.
          </span>
        }
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Total" v={String(counts.total)} />
        <Tile k="Read-only" v={String(counts.read ?? 0)} />
        <Tile k="Write workspace" v={String(counts.write_workspace ?? 0)} accent />
        <Tile
          k="Irreversible"
          v={String(counts.irreversible ?? 0)}
          energy={(counts.irreversible ?? 0) > 0}
        />
      </section>

      <section className="mb-6 flex flex-col gap-4">
        <h2 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          Tools — what each agent kind can call
        </h2>

        {!tools.ok ? (
          <Unavailable title="Tool surfaces" message={tools.message} />
        ) : surfaces.length === 0 ? (
          <Card>
            <CardHead title="Tool surfaces" />
            <CardBody>
              <p className="m-0 text-[13px] text-muted">
                No agent kind is defined for this deployment, so there is no tool surface to show.
                Stock agents come from{' '}
                <code className="font-mono text-[12px] text-ink">packages/domain</code> at boot.
              </p>
            </CardBody>
          </Card>
        ) : (
          <>
            {surfaces.map((agent) => (
              <ToolSurfaceCard key={agent.ref} agent={agent} />
            ))}
            <p className="m-0 text-[12px] leading-[1.55] text-muted">
              {surfaces.length} agent kinds resolved against {tools.data.skillCount} skills.
              Read-only kinds: {tools.data.readOnlyKinds.join(', ') || 'none'}.{' '}
              {tools.data.wireNaming}.
            </p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          Skills — the catalog
        </h2>

        <p className="m-0 max-w-[900px] text-[12.5px] leading-[1.55] text-muted">
          This page is the catalog&rsquo;s only home. A lifecycle scope that adds its own skills —
          an org template or a project — writes them in{' '}
          <Link
            href={`/orgs/${slug}/lifecycle-templates`}
            className="text-ink underline underline-offset-2"
          >
            Lifecycle templates
          </Link>
          , whose editor keeps a Custom skills tab and links back here for the stock list.
        </p>

        {!catalog.ok ? (
          <Unavailable title="Skill catalog" message={catalog.message} />
        ) : (
          <Card className="p-0">
            <CardHead
              title="Skill catalog"
              meta="Stock skills available to bind in any agent on any project"
              right={<Chip kind="neutral">{items.length} skills</Chip>}
            />
            {items.length === 0 ? (
              <CardBody>
                <p className="m-0 text-[13px] text-muted">
                  Skill catalog is empty for this deployment. Skills are loaded from{' '}
                  <code className="font-mono text-[12px] text-ink">packages/skills</code> at boot.
                </p>
              </CardBody>
            ) : (
              <ul className="m-0 list-none p-0">
                {items.map((s, i) => (
                  <li
                    key={s.name}
                    className={i < items.length - 1 ? 'border-b border-hair-2' : ''}
                  >
                    <div className="grid grid-cols-[1fr_auto] items-start gap-4 px-5 py-4">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-[14px] font-medium text-ink">
                            {s.name}
                          </span>
                          {s.capabilities && s.capabilities.length > 0 && (
                            <span className="font-mono text-[10.5px] text-muted">
                              {s.capabilities.join(' · ')}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-[12.5px] leading-[1.55] text-ink-2">
                          {s.description}
                        </div>
                      </div>
                      <SideEffectBadge cls={s.sideEffectClass} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </section>
    </main>
  );
}
