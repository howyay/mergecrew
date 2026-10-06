import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Button, Chip, PageHead, Label } from '@/components/ui';
import { relativeTime } from '@/lib/format';

interface InboxItem {
  id: string;
  reason: string;
  details: Record<string, any>;
  changesetId: string | null;
  projectId: string;
  projectSlug: string | null;
  createdAt: string;
}

/**
 * An idea is a proposal — a sentence, a Sentry issue, a triage finding. It
 * waits here until a person approves it, and only an approved idea can seed a
 * run, so this list is the gate between "someone suggested it" and "the city
 * worked on it".
 */
interface IdeaItem {
  id: string;
  body: string;
  status: string;
  sourceKey: string | null;
  projectSlug: string | null;
  projectName: string | null;
  createdAt: string;
}

function severityFromReason(reason: string): 'high' | 'med' | 'low' {
  if (reason === 'risk_score_high' || reason === 'blast_radius') return 'high';
  if (reason === 'review_required') return 'med';
  return 'low';
}

function severityGlyph(reason: string) {
  if (reason === 'risk_score_high') return 'R';
  if (reason === 'blast_radius') return 'B';
  if (reason === 'review_required') return 'V';
  return reason.slice(0, 1).toUpperCase();
}

const SEVERITY_TONES: Record<'high' | 'med' | 'low', string> = {
  high: 'bg-energy border-energy text-paper',
  med: 'bg-warn border-warn text-ink',
  low: 'bg-accent-soft border-accent text-accent-deep',
};

export default async function InboxPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  // Both queues are read in parallel. The idea queue is allowed to fail on its
  // own: an idea read that breaks must not take the approval inbox down with it,
  // because the approvals are what stop a run from shipping.
  const [inbox, ideasRes] = await Promise.all([
    api<{ items: InboxItem[] }>(`/v1/orgs/${slug}/inbox`, { session }),
    api<{ items: IdeaItem[] }>(`/v1/orgs/${slug}/ideas`, { session }).catch(() => null),
  ]);
  const items = inbox.items ?? [];
  const ideas = ideasRes?.items ?? [];
  const ideasFailed = ideasRes === null;

  const counts = items.reduce(
    (acc, a) => {
      const s = severityFromReason(a.reason);
      acc[s] += 1;
      return acc;
    },
    { high: 0, med: 0, low: 0 },
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Inbox' },
        ]}
        title="Inbox"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {items.length} pending · {ideas.length} {ideas.length === 1 ? 'idea' : 'ideas'} awaiting a
            decision
          </span>
        }
      />

      <section className="mb-8">
        <div className="mb-3 flex items-baseline gap-3">
          <Label energy>Ideas</Label>
          <h2 className="m-0 text-[14px] font-medium tracking-[-0.005em]">
            Waiting for a decision
          </h2>
          {!ideasFailed && ideas.length > 0 && <Chip kind="high">{ideas.length}</Chip>}
        </div>
        {ideasFailed ? (
          <Card className="p-5">
            <p className="m-0 text-[13.5px] text-muted">
              The idea queue could not be read, so nothing is shown here. The approvals below are
              unaffected. Reload to try again.
            </p>
          </Card>
        ) : ideas.length === 0 ? (
          <Card className="p-5">
            <p className="m-0 text-[13.5px] text-muted">
              No idea is waiting. A Sentry issue, a bug-triage finding or a suspicion someone typed
              lands here and stays put until a person approves it — nothing runs from an idea on its
              own.
            </p>
          </Card>
        ) : (
          <ul className="m-0 space-y-3 list-none p-0">
            {ideas.map((idea) => (
              <li key={idea.id}>
                <Card>
                  <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-5">
                    <div className="min-w-0">
                      <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-ink">
                        {idea.body}
                      </p>
                      <div className="mt-3 font-mono text-[11.5px] text-muted">
                        {idea.projectSlug ? `${idea.projectSlug} · ` : ''}
                        {idea.sourceKey ? `${idea.sourceKey} · ` : ''}filed{' '}
                        {relativeTime(idea.createdAt)}
                      </div>
                    </div>
                    <IdeaDecisionForm slug={slug} ideaId={idea.id} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-3 flex items-baseline gap-3">
        <Label>Changesets</Label>
        <h2 className="m-0 text-[14px] font-medium tracking-[-0.005em]">Waiting for a decision</h2>
      </section>

      <section className="mb-6 grid grid-cols-3 gap-3">
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label energy>High</Label>
          <div className="mt-1 text-[26px] font-medium text-energy-deep leading-none">
            {counts.high}
          </div>
        </div>
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label>Medium</Label>
          <div className="mt-1 text-[26px] font-medium leading-none">{counts.med}</div>
        </div>
        <div className="border border-hair bg-paper px-[18px] py-[14px]">
          <Label accent>Low</Label>
          <div className="mt-1 text-[26px] font-medium text-accent-deep leading-none">
            {counts.low}
          </div>
        </div>
      </section>

      {items.length === 0 ? (
        <Card className="p-5">
          <p className="m-0 text-[13.5px] text-muted">
            Nothing pending — quiet day. Anything that trips a guardrail (risk score · blast
            radius · denied path · budget · missing reviewer) lands here.
          </p>
        </Card>
      ) : (
        <ul className="m-0 space-y-3 list-none p-0">
          {items.map((a) => {
            const sev = severityFromReason(a.reason);
            return (
              <li key={a.id}>
                <Card>
                  <div className="grid grid-cols-[56px_1fr_auto] gap-4 px-5 py-5">
                    <div
                      className={`flex h-[44px] w-[44px] items-center justify-center border-[1.5px] font-mono text-[20px] font-semibold ${SEVERITY_TONES[sev]}`}
                    >
                      {severityGlyph(a.reason)}
                    </div>
                    <div className="min-w-0">
                      {a.reason === 'risk_score_high' ? (
                        <RiskScoreItem item={a} slug={slug} />
                      ) : (
                        <GenericItem item={a} />
                      )}
                      <div className="mt-3 font-mono text-[11.5px] text-muted">
                        {a.projectSlug ? `${a.projectSlug} · ` : ''}filed{' '}
                        {relativeTime(a.createdAt)}
                      </div>
                    </div>
                    <ResolveForm
                      slug={slug}
                      projectSlug={a.projectSlug ?? '-'}
                      approvalId={a.id}
                      changesetHref={
                        a.changesetId && a.projectSlug
                          ? `/orgs/${slug}/projects/${a.projectSlug}/changesets/${a.changesetId}`
                          : null
                      }
                    />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function GenericItem({ item }: { item: InboxItem }) {
  return (
    <div>
      <div className="text-[14px] font-medium tracking-[-0.005em]">{item.reason}</div>
      <pre className="mt-2 m-0 max-h-[140px] overflow-auto border-l-[3px] border-hair bg-bg-2 p-2 font-mono text-[11.5px] leading-[1.5] text-ink-2 whitespace-pre-wrap">
        {JSON.stringify(item.details, null, 2)}
      </pre>
    </div>
  );
}

function RiskScoreItem({ item, slug }: { item: InboxItem; slug: string }) {
  const { score, threshold, filesChanged, linesChanged, sensitiveHits, prNumber, prUrl } =
    item.details ?? {};
  const hits = Array.isArray(sensitiveHits) ? sensitiveHits : [];
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[14px] font-medium tracking-[-0.005em]">
          Changeset needs review · risk score
        </span>
        <span className="bg-energy-soft px-[8px] py-[2px] font-mono text-[10.5px] text-energy-deep">
          {Number(score ?? 0).toFixed(1)} &gt; {Number(threshold ?? 0).toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-2">
        Score breakdown:{' '}
        <span className="font-mono">
          {Number(filesChanged ?? 0)} files × 1 + {Number(linesChanged ?? 0)} lines × 0.1 +{' '}
          {hits.length} sensitive × 10
        </span>
      </p>
      {hits.length > 0 && (
        <ul className="mt-2 m-0 space-y-1 list-none p-0">
          {hits.map((h: any, i: number) => (
            <li key={i} className="font-mono text-[11.5px] text-energy-deep">
              ⊘ <code>{h.path}</code> ← <code>{h.glob}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
        {item.changesetId && item.projectSlug && (
          <Link
            href={`/orgs/${slug}/projects/${item.projectSlug}/changesets/${item.changesetId}`}
            className="text-accent underline-offset-[3px] hover:underline"
          >
            View changeset →
          </Link>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-[3px] hover:underline"
          >
            PR #{prNumber} →
          </a>
        )}
      </div>
    </div>
  );
}

async function decideIdeaAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const ideaId = String(formData.get('ideaId') ?? '');
  const decision = String(formData.get('decision') ?? 'approve');
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/ideas/${ideaId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
    session,
  });
}

function IdeaDecisionForm({ slug, ideaId }: { slug: string; ideaId: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <form action={decideIdeaAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="ideaId" value={ideaId} />
        <input type="hidden" name="decision" value="approve" />
        <Button variant="energy" size="sm" className="w-full">
          Approve
        </Button>
      </form>
      <form action={decideIdeaAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="ideaId" value={ideaId} />
        <input type="hidden" name="decision" value="reject" />
        <Button variant="danger" size="sm" className="w-full">
          Reject
        </Button>
      </form>
      <span className="text-center font-mono text-[10.5px] leading-[1.4] text-muted">
        approving lets the next run pick it up
      </span>
    </div>
  );
}

async function resolveAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const projectSlug = String(formData.get('projectSlug') ?? '');
  const approvalId = String(formData.get('approvalId') ?? '');
  const resolution = String(formData.get('resolution') ?? 'approve');
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/projects/${projectSlug}/approvals/${approvalId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolution }),
    session,
  });
}

function ResolveForm({
  slug,
  projectSlug,
  approvalId,
  changesetHref,
}: {
  slug: string;
  projectSlug: string;
  approvalId: string;
  changesetHref: string | null;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <form action={resolveAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="approvalId" value={approvalId} />
        <input type="hidden" name="resolution" value="approve" />
        <Button variant="energy" size="sm" className="w-full">
          Approve
        </Button>
      </form>
      <form action={resolveAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="approvalId" value={approvalId} />
        <input type="hidden" name="resolution" value="reject" />
        <Button variant="danger" size="sm" className="w-full">
          Reject
        </Button>
      </form>
      {changesetHref && (
        <Link
          href={changesetHref}
          className="border border-hair bg-paper px-[10px] py-[6px] text-center font-mono text-[11px] text-ink-2 no-underline hover:bg-paper-2"
        >
          Open changeset
        </Link>
      )}
    </div>
  );
}
