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

/**
 * A message an agent sent to a person over the city mailbox. The city keeps a
 * message until somebody answers it, so this queue is where every run that
 * stopped to ask a question shows up. Replying rejoins the thread the agent is
 * waiting on, which is what lets it carry on.
 */
interface CityMailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string | null;
  read: boolean;
  threadId: string | null;
  rig: string | null;
}

interface CityMailbox {
  items: CityMailMessage[];
  total: number;
  unread: number;
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
  // Three queues are read in parallel. The idea queue and the city mailbox are
  // each allowed to fail on their own: a mailbox the city cannot answer for must
  // not take the approval inbox down with it, because the approvals are what
  // stop a run from shipping.
  const [inbox, ideasRes, mailRes] = await Promise.all([
    api<{ items: InboxItem[] }>(`/v1/orgs/${slug}/inbox`, { session }),
    api<{ items: IdeaItem[] }>(`/v1/orgs/${slug}/ideas`, { session }).catch(() => null),
    api<CityMailbox>(`/v1/orgs/${slug}/admin/city/mail`, { session }).catch(() => null),
  ]);
  const items = inbox.items ?? [];
  const ideas = ideasRes?.items ?? [];
  const ideasFailed = ideasRes === null;
  const mail = mailRes?.items ?? [];
  const mailFailed = mailRes === null;
  const mailUnread = mail.filter((message) => !message.read).length;

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
            {items.length} pending · {ideas.length} {ideas.length === 1 ? 'idea' : 'ideas'} ·{' '}
            {mail.length} from the city awaiting a decision
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

      <section className="mb-8">
        <div className="mb-3 flex items-baseline gap-3">
          <Label energy>Gas City</Label>
          <h2 className="m-0 text-[14px] font-medium tracking-[-0.005em]">
            Agents waiting on a person
          </h2>
          {!mailFailed && mailUnread > 0 && <Chip kind="high">{mailUnread} unread</Chip>}
        </div>
        {mailFailed ? (
          <Card className="p-5">
            <p className="m-0 text-[13.5px] text-muted">
              The city mailbox could not be read, so nothing is shown here. The queues below are
              unaffected. Reload to try again.
            </p>
          </Card>
        ) : mail.length === 0 ? (
          <Card className="p-5">
            <p className="m-0 text-[13.5px] text-muted">
              Nothing from the city. When an agent stops instead of guessing — a backup that would
              not sync, a cleanup it refuses to force, a call it will not make alone — the question
              lands here, and the run waits for your answer.
            </p>
          </Card>
        ) : (
          <ul className="m-0 space-y-3 list-none p-0">
            {mail.map((message) => (
              <li key={message.id}>
                <Card>
                  <div className="px-5 py-5">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[14px] font-medium tracking-[-0.005em]">
                        {message.subject}
                      </span>
                      {!message.read && <Chip kind="medium">unread</Chip>}
                    </div>
                    <p className="mt-2 m-0 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-ink">
                      {message.body}
                    </p>
                    <div className="mt-3 font-mono text-[11.5px] text-muted">
                      {message.from ? `from ${message.from} · ` : ''}
                      {message.rig ? `${message.rig} · ` : ''}
                      {message.id}
                      {message.createdAt ? ` · sent ${relativeTime(message.createdAt)}` : ''}
                    </div>
                    <div className="mt-4 grid grid-cols-[1fr_auto] items-start gap-4">
                      <ReplyToAgentForm slug={slug} messageId={message.id} />
                      <MailFlagForms slug={slug} messageId={message.id} read={message.read} />
                    </div>
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

/**
 * An answer goes back into the thread the message came from, so the agent that
 * asked picks it up on its next turn. An empty box is refused before it leaves
 * the page: a blank reply is not an answer.
 */
async function replyToAgentAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const messageId = String(formData.get('messageId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/admin/city/mail/${messageId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ body }),
    session,
  });
}

function ReplyToAgentForm({ slug, messageId }: { slug: string; messageId: string }) {
  return (
    <form action={replyToAgentAction} className="min-w-0">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="messageId" value={messageId} />
      <textarea
        name="body"
        rows={3}
        maxLength={4000}
        required
        placeholder="Answer the agent. It lands in the thread it is waiting on."
        className="w-full border border-hair bg-paper-2 px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="energy" size="sm" type="submit">
          Send reply
        </Button>
        <span className="font-mono text-[10.5px] text-muted">
          answering a message also marks it read
        </span>
      </div>
    </form>
  );
}

async function mailFlagAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const messageId = String(formData.get('messageId') ?? '');
  const action = String(formData.get('action') ?? 'archive');
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/admin/city/mail/${messageId}/${action}`, {
    method: 'POST',
    session,
  });
}

function MailFlagForms({
  slug,
  messageId,
  read,
}: {
  slug: string;
  messageId: string;
  read: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <form action={mailFlagAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="messageId" value={messageId} />
        <input type="hidden" name="action" value={read ? 'mark-unread' : 'read'} />
        <Button variant="ghost" size="sm" className="w-full">
          {read ? 'Mark unread' : 'Mark read'}
        </Button>
      </form>
      <form action={mailFlagAction}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="messageId" value={messageId} />
        <input type="hidden" name="action" value="archive" />
        <Button variant="danger" size="sm" className="w-full">
          Archive
        </Button>
      </form>
      <span className="text-center font-mono text-[10.5px] leading-[1.4] text-muted">
        archiving clears it from the city mailbox for good
      </span>
    </div>
  );
}
