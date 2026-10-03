import { utcStamp } from '@/lib/time';
import { LinkButton, PageHead, Tile } from '@/components/ui';
import { GenerateButton, IdeaDeck } from '@/components/ideation/idea-deck';
import { ProposeForm } from '@/components/ideation/propose-form';
import type { PreparingCard } from '@/components/ideation/idea-deck';
import { counts, deckOrder, isSwipeable, preparingReason, readIdeaState } from '@/lib/ideation';
import { requireSession } from '@/lib/session';

/**
 * Idea triage inside the product (#UX) — the first of two human gates.
 *
 * The deck is produced by the host-side `ops/ideation` service from repo
 * signals; this page renders it, records the swipe, and then shows the delivery
 * chain the host-side `ops/pipeline` service runs for each accepted idea (PRD →
 * issue → worktree → dev agent → UAT → demo). The second gate is the review
 * verdict on an accepted idea, below.
 *
 * Only cards the host has finished specifying are swipable, and that filter is
 * applied here rather than in the deck so the same predicate (`isSwipeable`)
 * also guards the API: a draft is a claim nobody has verified against the code,
 * and accepting one would push unverified work into the pipeline. The cards
 * that are not ready are passed through as "being prepared" with the reason
 * they are not ready, so nothing is silently dropped from the page.
 *
 * The state file is mounted from the host, so it must be read on every request —
 * a cached render would show a deck that no longer exists.
 */
export const dynamic = 'force-dynamic';

export default async function IdeasPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireSession();

  const state = await readIdeaState();
  const ideas = state.ideas ?? [];
  const tally = counts(ideas);
  const pending = deckOrder(ideas.filter((i) => i.status === 'pending'));
  const ready = pending.filter(isSwipeable);
  const preparing: PreparingCard[] = pending
    .filter((i) => !isSwipeable(i))
    .map((idea) => ({ idea, reason: preparingReason(idea) }));
  const accepted = deckOrder(ideas.filter((i) => i.status === 'accepted'));
  const rejected = [...ideas.filter((i) => i.status === 'rejected')].sort((a, b) =>
    String(b.decidedAt ?? '').localeCompare(String(a.decidedAt ?? '')),
  );
  const generated = state.lastGeneration;

  const inFlight = accepted.filter(
    (i) => i.pipeline && !['done', 'blocked', 'awaiting-review'].includes(i.pipeline.status ?? ''),
  ).length;
  const awaitingReview = accepted.filter((i) => i.pipeline?.status === 'awaiting-review').length;

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[{ label: slug, href: `/orgs/${slug}` }, { label: 'Ideas' }]}
        title="Ideas"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {generated
              ? `generator ${generated.generator} · last cycle proposed ${generated.proposed} (added ${generated.added}) · ${utcStamp(generated.at)}`
              : 'no generation recorded yet — the host ops/ideation service has not completed a cycle'}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/orgs/${slug}/ideas/timeline`} size="sm" variant="secondary">
              Timeline
            </LinkButton>
            <GenerateButton />
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Tile k="Awaiting decision" v={String(tally.ready)} n="swipe each one" accent />
        <Tile
          k="Being prepared"
          v={String(tally.preparing)}
          n="specified before you decide"
          energy={tally.preparing > 0}
        />
        <Tile k="Accepted" v={String(tally.accepted)} n="the pipeline runs these" />
        <Tile k="In the pipeline" v={String(inFlight)} n="PRD → issue → agent → UAT" />
        <Tile
          k="Awaiting review"
          v={String(awaitingReview)}
          n="your call, below"
          energy={awaitingReview > 0}
        />
        <Tile
          k="Stale signals"
          v={String(tally.stale)}
          n="evidence no longer holds"
          energy={tally.stale > 0}
        />
      </div>

      <ProposeForm />

      {rejected.length > 0 && (
        <p className="mb-4 text-[12.5px] text-muted">
          {rejected.length} rejected — a rejected fingerprint never comes back, and the reasons are
          listed at the bottom of this page and in the{' '}
          <a className="underline" href={`/orgs/${slug}/ideas/timeline?event=rejected`}>
            timeline
          </a>
          .
        </p>
      )}

      <IdeaDeck ready={ready} preparing={preparing} accepted={accepted} rejected={rejected} />
    </main>
  );
}
