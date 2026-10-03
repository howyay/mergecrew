import Link from 'next/link';
import { clsx } from 'clsx';
import { PageHead } from '@/components/ui';
import { utcStamp } from '@/lib/time';
import { readIdeaState, timeline } from '@/lib/ideation';
import { requireSession } from '@/lib/session';

/**
 * The decision log (2a): every event on every idea, newest first.
 *
 * The deck answers "what should I decide now?"; this answers "what did we
 * decide, and why?" — the question that actually comes up weeks later, when
 * someone asks why a piece of work was rejected or what happened to the idea
 * that was accepted. Rejection comments are shown on the row, because a
 * rejection without its reason is indistinguishable from an accident.
 *
 * The rows are derived from each idea's own `events` list rather than from a
 * second log: one source of truth means the timeline cannot disagree with the
 * cards it describes.
 */
export const dynamic = 'force-dynamic';

const EVENT_TONE: Record<string, string> = {
  proposed: 'border-hair text-muted',
  specified: 'border-accent text-accent-deep',
  'spec-failed': 'border-energy text-energy-deep',
  accepted: 'border-positive text-positive-deep',
  rejected: 'border-energy text-energy-deep',
  'decision-undone': 'border-hair text-muted',
  priority: 'border-warn text-warn',
  stale: 'border-warn text-warn',
  queued: 'border-accent text-accent-deep',
  'dispatch-failed': 'border-energy text-energy-deep',
};

const EVENT_FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: 'Everything' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'priority', label: 'Priority' },
  { key: 'stale', label: 'Stale' },
];

const KIND_FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: 'all kinds' },
  { key: 'feature', label: 'feature' },
  { key: 'technical', label: 'technical' },
  { key: 'refactor', label: 'refactor' },
];

function href(
  slug: string,
  { event, kind, pending }: { event: string | null; kind: string | null; pending: boolean },
): string {
  const params = new URLSearchParams();
  if (event) params.set('event', event);
  if (kind) params.set('kind', kind);
  if (pending) params.set('status', 'pending');
  const query = params.toString();
  return `/orgs/${slug}/ideas/timeline${query ? `?${query}` : ''}`;
}

export default async function IdeasTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ event?: string; kind?: string; status?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  await requireSession();

  const event = EVENT_FILTERS.some((f) => f.key === query.event) ? (query.event ?? null) : null;
  const kind = KIND_FILTERS.some((f) => f.key === query.kind) ? (query.kind ?? null) : null;
  // Not a chip of its own: it narrows the rows to ideas still awaiting a
  // decision, which is the one idea-level question worth asking here.
  const pending = query.status === 'pending';

  const state = await readIdeaState();
  const ideas = state.ideas ?? [];
  const rows = timeline(ideas, { limit: 400, event, kind, status: pending ? 'pending' : null });
  const withEvents = ideas.filter((i) => (i.events ?? []).length > 0).length;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: 'Ideas', href: `/orgs/${slug}/ideas` },
          { label: 'Timeline' },
        ]}
        title="Decision timeline"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {rows.length} event{rows.length === 1 ? '' : 's'} from {withEvents} of {ideas.length} ideas · newest
            first
          </span>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {EVENT_FILTERS.map((filter) => (
          <Link
            key={filter.label}
            className={clsx(
              'border px-2.5 py-[5px] font-mono text-[11.5px] no-underline',
              filter.key === event
                ? 'border-accent bg-accent-soft text-accent-deep'
                : 'border-hair text-ink-2 hover:border-ink',
            )}
            href={href(slug, { event: filter.key, kind, pending })}
          >
            {filter.label}
          </Link>
        ))}
        <span className="mx-1 h-[18px] w-px bg-hair" />
        {KIND_FILTERS.map((filter) => (
          <Link
            key={filter.label}
            className={clsx(
              'border px-2.5 py-[5px] font-mono text-[11.5px] no-underline',
              filter.key === kind
                ? 'border-ink bg-bg text-ink'
                : 'border-hair text-muted hover:border-ink',
            )}
            href={href(slug, { event, kind: filter.key, pending })}
          >
            {filter.label}
          </Link>
        ))}
        <span className="mx-1 h-[18px] w-px bg-hair" />
        <Link
          className={clsx(
            'border px-2.5 py-[5px] font-mono text-[11.5px] no-underline',
            pending ? 'border-ink bg-bg text-ink' : 'border-hair text-muted hover:border-ink',
          )}
          href={href(slug, { event, kind, pending: !pending })}
        >
          no decision yet
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="border border-hair bg-paper px-4 py-6 text-[13px] text-ink-2">
          No events recorded{event || kind || pending ? ' for this filter' : ''}. The host service appends one
          row every time it proposes, specifies, or acts on an idea — and the deck appends the ones you
          decide. Older records written before the event log existed have none.
        </div>
      ) : (
        <div className="border border-hair bg-paper">
          {rows.map((row, i) => (
            <div
              key={`${row.id}-${row.at}-${i}`}
              className={clsx('px-4 py-3', i > 0 && 'border-t border-hair')}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[11px] text-muted">{utcStamp(row.at)}</span>
                <span
                  className={clsx(
                    'border px-1.5 py-0.5 font-mono text-[10.5px] uppercase',
                    EVENT_TONE[row.kind] ?? 'border-hair text-muted',
                  )}
                >
                  {row.kind}
                </span>
                <span className="min-w-0 text-[13px] font-medium">{row.title}</span>
                <span className="font-mono text-[10.5px] text-muted">{row.id}</span>
                <span className="ml-auto flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted">
                  <span className="border border-hair px-1.5 py-0.5">{row.source}</span>
                  <span className="border border-hair px-1.5 py-0.5">{row.ideaKind}</span>
                  <span className="border border-hair px-1.5 py-0.5">{row.ideaStatus}</span>
                  {row.priority && <span className="border border-hair px-1.5 py-0.5">{row.priority}</span>}
                  <span>by {row.by}</span>
                </span>
              </div>

              {row.detail && <p className="mt-1 text-[12.5px] text-ink-2">{row.detail}</p>}

              {row.comment && (
                <blockquote className="mt-2 border-l-2 border-energy pl-3 text-[12.5px] text-energy-deep">
                  {row.comment}
                </blockquote>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
