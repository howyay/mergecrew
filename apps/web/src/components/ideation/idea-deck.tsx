'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Clock,
  FileText,
  GitBranch,
  Loader2,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { utcStamp } from '@/lib/time';
import { BAND_TONE, KindBadge, PriorityChip, SpecPanel } from '@/components/ideation/spec-panel';
import type { Idea, IdeaPipeline } from '@/lib/ideation';

const THRESHOLD = 110;

/**
 * Where a dev agent's harness session can be looked at. The harness runs on the
 * same host as this UI and has no per-session URL, so this is the session list;
 * the card shows the recorded session id to search for. The host writes
 * `dev.watchUrl` on the pipeline record, and this is only the fallback for
 * records written before that field existed.
 */
const DSH_WEB_URL = 'http://127.0.0.1:53087/';

/** A pending card the host has not finished specifying, with the reason why. */
export type PreparingCard = { idea: Idea; reason: string };

async function post(path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, text: await res.text() };
}

/** Ask the host ideation service for one fresh cycle. */
export function GenerateButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const { ok, text } = await post('/api/ideas/generate', {});
          setBusy(false);
          setNote(
            ok
              ? 'requested — the host service runs a cycle within seconds, then refresh'
              : `could not request a cycle: ${text.slice(0, 160)}`,
          );
          router.refresh();
        }}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        Generate
      </Button>
      {note && <span className="text-[12px] text-muted">{note}</span>}
    </span>
  );
}

/**
 * The swipe gate (the first of the two human gates).
 *
 * Only cards the host has finished specifying are offered for a decision, and
 * the page is explicit about the ones that are not: a draft is a claim nobody
 * has verified, and deciding on it would push work into the pipeline that no
 * one has checked against the code. Nothing is hidden — an undecidable card
 * appears in "Being prepared" with the stage it is stuck at, because a card
 * that silently disappears is indistinguishable from a card that was never
 * proposed.
 */
export function IdeaDeck({
  ready,
  preparing,
  accepted,
  rejected,
}: {
  ready: Idea[];
  preparing: PreparingCard[];
  accepted: Idea[];
  rejected: Idea[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const drag = useRef<{ x: number; active: boolean }>({ x: 0, active: false });

  const top = ready[0];
  const behind = ready[1];
  const queued = ready.slice(1);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const note = useCallback((text: string, bad?: boolean) => setToast({ text, bad }), []);

  const decide = useCallback(
    async (id: string, decision: 'accepted' | 'rejected' | 'pending', why?: string) => {
      setBusy(true);
      const body: Record<string, unknown> = { id, decision };
      if (typeof why === 'string' && why.trim()) body.comment = why.trim();
      const { ok, text } = await post('/api/ideas/decide', body);
      setBusy(false);
      setDx(0);
      setRejecting(false);
      setComment('');
      if (!ok) {
        setToast({ text: `could not record that: ${text.slice(0, 200)}`, bad: true });
        return;
      }
      setToast({
        text:
          decision === 'accepted'
            ? `${id} accepted — the host pipeline picks it up within seconds`
            : decision === 'rejected'
              ? `${id} rejected${typeof why === 'string' && why.trim() ? ' with your comment' : ''} — this fingerprint will not come back`
              : `${id} is back to awaiting a decision`,
      });
      refresh();
    },
    [refresh],
  );

  /**
   * The keyboard the card advertises. Ignored while the operator is typing in
   * the comment box — otherwise the reason they are halfway through writing
   * becomes the reason the card is rejected.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (event.key === 'Escape') {
        setRejecting(false);
        return;
      }
      if (!top || busy) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void decide(top.id, 'accepted');
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void decide(top.id, 'rejected');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [top, busy, decide]);

  return (
    <div>
      {top ? (
        <>
          <div
            className="relative select-none"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, active: true };
            }}
            onPointerMove={(e) => {
              if (drag.current.active) setDx(e.clientX - drag.current.x);
            }}
            onPointerUp={() => {
              drag.current.active = false;
              if (dx > THRESHOLD) void decide(top.id, 'accepted');
              else if (dx < -THRESHOLD) void decide(top.id, 'rejected');
              else setDx(0);
            }}
            onPointerLeave={() => {
              drag.current.active = false;
              setDx(0);
            }}
          >
            {behind && (
              <div className="pointer-events-none absolute inset-x-3 top-3 h-full border border-hair bg-paper" />
            )}
            <div
              className="relative border border-hair bg-paper px-5 py-4"
              style={{ transform: `translateX(${dx}px) rotate(${dx / 40}deg)` }}
            >
              <div className="flex items-start justify-between gap-4">
                <h3 className="max-w-[70ch] text-[15px] font-medium leading-[1.35]">{top.title}</h3>
                <div className="text-right">
                  <div className="font-mono text-[22px] leading-none">{top.score ?? '—'}</div>
                  <div className={clsx('font-mono text-[10.5px] uppercase', BAND_TONE[top.band ?? 'could'])}>
                    {top.band ?? 'unscored'}
                  </div>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted">
                <KindBadge kind={top.kind ?? 'feature'} />
                <PriorityChip
                  priority={top.triage?.priority ?? null}
                  overridden={Boolean(top.triage?.override)}
                />
                <span className="border border-hair px-1.5 py-0.5">{top.source ?? 'unknown source'}</span>
                <span className="border border-hair px-1.5 py-0.5">effort {top.effortHint ?? 'unknown'}</span>
                <span className="border border-hair px-1.5 py-0.5">{top.id}</span>
              </div>

              <p className="mt-3 text-[13px] leading-[1.5] text-ink-2">{top.rationale}</p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void decide(top.id, 'rejected')}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Reject
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRejecting(!rejecting)}
              title="reject and say why — the comment is recorded with the event"
              type="button"
            >
              <XCircle className="h-3.5 w-3.5" /> Reject with comment
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              title="restore the last decision"
              onClick={() => void decide(top.id, 'pending')}
              type="button"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Undo
            </Button>
            <Button disabled={busy} onClick={() => void decide(top.id, 'accepted')} type="button">
              Accept <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <span className="ml-2 text-[12px] text-muted">drag, or ← → to decide</span>
          </div>

          {rejecting && (
            <div className="mt-3 border border-hair bg-paper px-4 py-3">
              <label className="block text-[12.5px] text-muted" htmlFor="reject-comment">
                Why not? The comment is stored on the decision and read back in the timeline — and the
                generator sees recent rejections, so a specific objection is what makes the next round
                better.
              </label>
              <textarea
                autoFocus
                className="mt-2 w-full border border-hair bg-paper-2 px-3 py-2 text-[13px] outline-none focus:border-accent"
                id="reject-comment"
                maxLength={2000}
                onChange={(e) => setComment(e.target.value)}
                placeholder="e.g. the claim is already true — the flag is only read in the old path"
                rows={3}
                value={comment}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  disabled={busy}
                  onClick={() => void decide(top.id, 'rejected', comment)}
                  type="button"
                  variant="danger"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                  Reject {top.id}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setRejecting(false);
                    setComment('');
                  }}
                  type="button"
                  variant="secondary"
                >
                  Cancel
                </Button>
                <span className="text-[11.5px] text-muted">
                  {comment.trim().length}/2000 · Esc closes this box
                </span>
              </div>
            </div>
          )}

          <SpecPanel idea={top} onChanged={refresh} onNote={note} />
        </>
      ) : (
        <div className="border border-hair bg-paper px-4 py-6 text-[13px] text-ink-2">
          Nothing is ready for a decision. The host service adds cards as it finds repo signals and
          specifies them one at a time — press Generate to ask for a cycle now.
          {preparing.length > 0 &&
            ` ${preparing.length} card${preparing.length === 1 ? ' is' : 's are'} still being prepared below.`}
        </div>
      )}

      {toast && (
        <div
          className={clsx(
            'mt-3 border px-3 py-2 text-[12.5px]',
            toast.bad
              ? 'border-energy bg-energy-wash text-energy-deep'
              : 'border-hair bg-paper text-ink-2',
          )}
        >
          {toast.text}
        </div>
      )}

      {preparing.length > 0 && <PreparingSection items={preparing} />}

      {queued.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-[13px] font-medium">
            Next in the deck ({queued.length}) — also ready, decided in rank order
          </h2>
          <p className="mb-3 max-w-[90ch] text-[12.5px] text-muted">
            The host ranks every idea on the same four axes; the deck decides them in that order, so
            you can read ahead here. A priority override reorders this list immediately and is what
            the execution queue follows too.
          </p>
          <div className="space-y-3">
            {queued.map((idea) => (
              <QueuedCard key={idea.id} idea={idea} onChanged={refresh} onNote={note} />
            ))}
          </div>
        </section>
      )}

      {accepted.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-[13px] font-medium">
            Accepted ({accepted.length}) — the pipeline runs each one end to end
          </h2>
          <p className="mb-3 max-w-[90ch] text-[12.5px] text-muted">
            Every stage below is written by the host service. A stage with no record has not run;
            nothing here is inferred from the stage before it.
          </p>
          <div className="space-y-4">
            {accepted.map((idea) => (
              <DeliveryCard key={idea.id} idea={idea} onChanged={refresh} />
            ))}
          </div>
        </section>
      )}

      {rejected.length > 0 && <RejectedSection items={rejected} onDecide={decide} busy={busy} />}
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  draft: 'draft',
  specifying: 'being specified',
  specified: 'specified',
  'spec-failed': 'specification failed',
};

/**
 * Cards the host has not finished with. They are shown rather than hidden, and
 * each one says which stage it is at and why it cannot be decided — "the host is
 * verifying this against the code right now" is a different problem from "the
 * evidence behind it no longer holds".
 */
function PreparingSection({ items }: { items: PreparingCard[] }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <Clock className="h-[14px] w-[14px]" /> Being prepared ({items.length})
      </h2>
      <p className="mb-3 max-w-[90ch] text-[12.5px] text-muted">
        These are proposed but not yet decidable: the host writes a spec, checks the claim against the
        code and re-scores it before a human is asked to swipe. They are not lost — they move up here
        on their own once the specifier is done.
      </p>
      <div className="space-y-2">
        {items.map(({ idea, reason }) => {
          const stage = idea.stage ?? 'draft';
          return (
            <div key={idea.id} className="border border-hair bg-paper px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium">{idea.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted">
                    <KindBadge kind={idea.kind ?? 'feature'} />
                    <span className="border border-hair px-1.5 py-0.5">{idea.source ?? 'unknown source'}</span>
                    <span className="border border-hair px-1.5 py-0.5">{idea.id}</span>
                    {idea.score !== undefined && (
                      <span className="border border-hair px-1.5 py-0.5">
                        provisional {idea.score} {idea.band ?? ''}
                      </span>
                    )}
                    {idea.createdAt && (
                      <span className="border border-hair px-1.5 py-0.5">proposed {utcStamp(idea.createdAt)}</span>
                    )}
                  </div>
                </div>
                <span
                  className={clsx(
                    'shrink-0 border px-1.5 py-0.5 font-mono text-[10.5px] uppercase',
                    stage === 'spec-failed' ? 'border-energy text-energy-deep' : 'border-hair text-muted',
                  )}
                >
                  {STAGE_LABEL[stage] ?? stage}
                </span>
              </div>
              <p className="mt-2 text-[12.5px] text-ink-2">{reason}</p>
              {idea.specFailedReason && stage === 'spec-failed' && (
                <p className="mt-1 font-mono text-[11.5px] text-energy-deep">{idea.specFailedReason}</p>
              )}
              {idea.rationale && <p className="mt-1 text-[12px] text-muted">{idea.rationale}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A ready card further down the deck: readable (and re-rankable) ahead of its turn. */
function QueuedCard({
  idea,
  onChanged,
  onNote,
}: {
  idea: Idea;
  onChanged: () => void;
  onNote: (text: string, bad?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-hair bg-paper px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{idea.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted">
            <KindBadge kind={idea.kind ?? 'feature'} />
            <PriorityChip priority={idea.triage?.priority ?? null} overridden={Boolean(idea.triage?.override)} />
            <span className="border border-hair px-1.5 py-0.5">{idea.source ?? 'unknown source'}</span>
            <span className="border border-hair px-1.5 py-0.5">{idea.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[14px]">{idea.score ?? '—'}</span>
          <span className={clsx('font-mono text-[10.5px] uppercase', BAND_TONE[idea.band ?? 'could'])}>
            {idea.band ?? 'unscored'}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(!open)} type="button">
            {open ? 'hide spec' : 'read spec'}
          </Button>
        </div>
      </div>
      {open && <SpecPanel idea={idea} onChanged={onChanged} onNote={onNote} defaultOpen />}
    </div>
  );
}

/**
 * The rejected list: what was turned down, why, and a way back.
 *
 * A rejection is a decision, not a deletion — the fingerprint is remembered so
 * the generator does not re-propose it, which means the reason has to stay
 * readable or the same ground gets re-argued by hand.
 */
function RejectedSection({
  items,
  onDecide,
  busy,
}: {
  items: Idea[];
  onDecide: (id: string, decision: 'accepted' | 'rejected' | 'pending', why?: string) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <XCircle className="h-[14px] w-[14px]" /> Rejected ({items.length})
      </h2>
      <p className="mb-3 max-w-[90ch] text-[12.5px] text-muted">
        A rejected fingerprint never comes back on its own, so the reason is kept here. Restoring one
        puts it back in the deck without re-running the specifier.
      </p>
      <div className="space-y-2">
        {items.map((idea) => (
          <div key={idea.id} className="border border-hair bg-paper px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium">{idea.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-muted">
                  <KindBadge kind={idea.kind ?? 'feature'} />
                  <span className="border border-hair px-1.5 py-0.5">{idea.source ?? 'unknown source'}</span>
                  <span className="border border-hair px-1.5 py-0.5">{idea.id}</span>
                  {idea.decidedAt && (
                    <span className="border border-hair px-1.5 py-0.5">
                      rejected {utcStamp(idea.decidedAt)}
                      {idea.decision?.by ? ` by ${idea.decision.by}` : ''}
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void onDecide(idea.id, 'pending')}
                type="button"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restore
              </Button>
            </div>
            {idea.decision?.comment && (
              <blockquote className="mt-2 border-l-2 border-hair pl-3 text-[12.5px] text-ink-2">
                {idea.decision.comment}
              </blockquote>
            )}
            {!idea.decision?.comment && (
              <p className="mt-2 text-[12px] text-muted">rejected without a comment</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

type StageState = 'done' | 'blocked' | 'waiting' | 'pending';

const STAGE_TONE: Record<StageState, string> = {
  done: 'text-positive-deep',
  blocked: 'text-energy-deep',
  waiting: 'text-accent-deep',
  pending: 'text-muted',
};

function StageIcon({ state }: { state: StageState }) {
  if (state === 'done') return <CheckCircle2 className="h-[14px] w-[14px]" />;
  if (state === 'blocked') return <XCircle className="h-[14px] w-[14px]" />;
  if (state === 'waiting') return <Loader2 className="h-[14px] w-[14px]" />;
  return <CircleDashed className="h-[14px] w-[14px]" />;
}

function Stage({
  label,
  state,
  detail,
  children,
}: {
  label: string;
  state: StageState;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={clsx('flex items-baseline gap-2 py-[3px] text-[12.5px]', STAGE_TONE[state])}>
      <StageIcon state={state} />
      <span className="w-[86px] shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words">
        {detail}
        {children}
      </span>
    </div>
  );
}

function artifactUrl(id: string, kind: string): string {
  return `/api/ideas/artifact?id=${encodeURIComponent(id)}&kind=${kind}`;
}

function DeliveryCard({ idea, onChanged }: { idea: Idea; onChanged: () => void }) {
  const pipeline: IdeaPipeline = idea.pipeline ?? {};
  const [open, setOpen] = useState<{ kind: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dev = pipeline.dev;
  const qa = pipeline.qa;

  const prdState: StageState = pipeline.prd ? 'done' : 'pending';
  const issueState: StageState =
    pipeline.issue?.status === 'created' ? 'done' : pipeline.issue ? 'blocked' : 'pending';
  const worktreeState: StageState =
    pipeline.worktree?.status === 'created' || pipeline.worktree?.status === 'reused'
      ? 'done'
      : pipeline.worktree
        ? 'blocked'
        : 'pending';
  const devState: StageState =
    dev?.status === 'done'
      ? 'done'
      : dev?.status === 'running'
        ? 'waiting'
        : dev
          ? 'blocked'
          : 'pending';
  const qaState: StageState =
    qa?.verdict === 'pass' ? 'done' : qa ? (qa.verdict === 'blocked' ? 'waiting' : 'blocked') : 'pending';
  const reviewState: StageState =
    pipeline.review?.status === 'approved'
      ? 'done'
      : pipeline.review?.status === 'rejected'
        ? 'blocked'
        : pipeline.status === 'awaiting-review'
          ? 'waiting'
          : 'pending';

  const statusPill = useMemo(() => {
    const s = pipeline.status ?? 'accepted';
    const tone =
      s === 'done'
        ? 'border-positive text-positive-deep'
        : s === 'blocked'
          ? 'border-energy text-energy-deep'
          : s === 'awaiting-review'
            ? 'border-accent text-accent-deep'
            : 'border-hair text-muted';
    return (
      <span className={clsx('border px-1.5 py-0.5 font-mono text-[10.5px] uppercase', tone)}>{s}</span>
    );
  }, [pipeline.status]);

  const view = async (kind: string) => {
    setError(null);
    const res = await fetch(artifactUrl(idea.id, kind));
    if (!res.ok) {
      setError(`${kind}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    setOpen({ kind, body: await res.text() });
  };

  const review = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    const { ok, text } = await post('/api/ideas/review', { id: idea.id, decision });
    setBusy(false);
    if (!ok) setError(text.slice(0, 200));
    onChanged();
  };

  return (
    <div className="border border-hair bg-paper px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{idea.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted">
            <KindBadge kind={idea.kind ?? 'feature'} />
            <span>
              {idea.id} · score {idea.score ?? '—'} {idea.band ?? ''} · {idea.source ?? 'unknown source'}
            </span>
            {idea.decidedAt && <span>· accepted {utcStamp(idea.decidedAt)}</span>}
          </div>
        </div>
        {statusPill}
      </div>

      {!pipeline.status && idea.execution && (
        <div className="mt-1 text-[12px] text-muted">
          host dispatch: {idea.execution.status}
          {idea.execution.reason ? ` — ${idea.execution.reason}` : ''}
        </div>
      )}

      <div className="mt-2 border-t border-hair pt-2">
        <Stage
          label="PRD"
          state={prdState}
          detail={pipeline.prd ? `${pipeline.prd.file} (${pipeline.prd.bytes} bytes)` : 'not written yet'}
        >
          {pipeline.prd && (
            <button className="ml-2 underline" onClick={() => void view('prd')}>
              view
            </button>
          )}
        </Stage>
        <Stage
          label="Issue"
          state={issueState}
          detail={
            pipeline.issue
              ? pipeline.issue.url
                ? pipeline.issue.url
                : `local file — ${pipeline.issue.reason ?? pipeline.issue.status}`
              : 'not created yet'
          }
        >
          {pipeline.issue?.url && (
            <a className="ml-2 underline" href={pipeline.issue.url} rel="noreferrer" target="_blank">
              open
            </a>
          )}
          {pipeline.issue?.file && (
            <button className="ml-2 underline" onClick={() => void view('issue')}>
              view
            </button>
          )}
        </Stage>
        <Stage
          label="Worktree"
          state={worktreeState}
          detail={
            pipeline.worktree
              ? `${pipeline.worktree.dir} · branch ${pipeline.worktree.branch}`
              : 'not created yet'
          }
        />
        <Stage
          label="Dev agent"
          state={devState}
          detail={
            dev
              ? `${dev.provider ?? 'agent'} · ${dev.status}${
                  dev.reason ? ` — ${String(dev.reason).slice(0, 160)}` : ''
                }`
              : 'not spawned yet'
          }
        >
          {dev?.sessionId && (
            // The harness exposes no per-session deep link: the id is the handle
            // you search for in the session list, which is why it is shown.
            <a
              className="ml-2 underline"
              href={dev.watchUrl ?? DSH_WEB_URL}
              rel="noreferrer"
              target="_blank"
              title={`harness session ${dev.sessionId} — open the session list and search for it`}
            >
              watch ({dev.sessionId})
            </a>
          )}
        </Stage>
        <Stage
          label="UAT"
          state={qaState}
          detail={qa ? `${qa.verdict}${qa.report ? ` · ${qa.report}` : ''}` : 'not run yet'}
        >
          {qa?.report && (
            <button className="ml-2 underline" onClick={() => void view('uat')}>
              report
            </button>
          )}
        </Stage>
        {qa?.demo && (
          <Stage label="Demo" state="done" detail={qa.demo}>
            <a
              className="ml-2 underline"
              href={artifactUrl(idea.id, 'demo')}
              rel="noreferrer"
              target="_blank"
            >
              open recording
            </a>
          </Stage>
        )}
        <Stage
          label={pipeline.deliver?.kind === 'technical' ? 'Changelog' : 'Deliverable'}
          state={pipeline.deliver ? 'done' : qaState === 'done' ? 'waiting' : 'pending'}
          detail={
            pipeline.deliver
              ? `${pipeline.deliver.kind ?? 'deliverable'} · ${pipeline.deliver.file ?? ''}${
                  pipeline.deliver.title ? ` · ${pipeline.deliver.title}` : ''
                }`
              : qaState === 'done'
                ? 'being written from the QA verdict and the agent report'
                : 'not written yet'
          }
        >
          {pipeline.deliver?.file && (
            <button className="ml-2 underline" onClick={() => void view('deliver')}>
              read
            </button>
          )}
        </Stage>
        <Stage
          label="Review"
          state={reviewState}
          detail={
            pipeline.review?.status === 'approved'
              ? `approved${pipeline.review.by ? ` by ${String(pipeline.review.by)}` : ''}`
              : pipeline.review?.status === 'rejected'
                ? `rejected${pipeline.review.note ? `: ${String(pipeline.review.note)}` : ''}`
                : pipeline.status === 'awaiting-review'
                  ? 'waiting for a human — approve or reject below'
                  : 'not ready yet'
          }
        />
      </div>

      {qa?.demo && (
        <div className="mt-3 border-t border-hair pt-3">
          {/* APNG plays inline; no encoder, no codec, no external player. */}
          <img
            alt={`Demo recording for ${idea.id}`}
            className="max-h-[320px] w-auto border border-hair"
            src={artifactUrl(idea.id, 'demo')}
          />
        </div>
      )}

      {pipeline.status === 'awaiting-review' && (
        <div className="mt-3 flex items-center gap-2 border-t border-hair pt-3">
          <Button size="sm" disabled={busy} onClick={() => void review('approved')}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void review('rejected')}
          >
            <XCircle className="h-3.5 w-3.5" /> Reject
          </Button>
          <span className="text-[12px] text-muted">
            Approval keeps the branch for you; the pipeline never merges or deploys by itself.
          </span>
        </div>
      )}

      {pipeline.status === 'blocked' && pipeline.reason && (
        <div className="mt-3 flex items-start gap-2 border border-energy bg-energy-wash px-3 py-2 text-[12.5px] text-energy-deep">
          <TriangleAlert className="mt-0.5 h-[14px] w-[14px] shrink-0" />
          <span>
            {pipeline.reason}
            {pipeline.error ? ` (${pipeline.error})` : ''}
          </span>
        </div>
      )}

      {error && <div className="mt-2 text-[12.5px] text-energy-deep">{error}</div>}

      {open && (
        <div className="mt-3 border-t border-hair pt-3">
          <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
            <FileText className="h-[13px] w-[13px]" /> {open.kind}
            <button className="underline" onClick={() => setOpen(null)}>
              close
            </button>
          </div>
          <pre className="max-h-[360px] overflow-auto border border-hair bg-wash p-3 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap">
            {open.body}
          </pre>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 font-mono text-[10.5px] text-muted">
        <span className="flex items-center gap-1">
          <GitBranch className="h-[12px] w-[12px]" />
          {pipeline.worktree?.branch ?? 'no branch yet'}
        </span>
      </div>
    </div>
  );
}
