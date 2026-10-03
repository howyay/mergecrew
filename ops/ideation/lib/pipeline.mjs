/**
 * One ideation cycle: collect signals -> generate -> score -> persist.
 *
 * Scoring happens inside the generator (each idea is born with its rubric
 * numbers), so this module only orchestrates and reports. The report is what
 * the UI and the tests assert on: which generator actually ran, and how many
 * ideas were new versus already-decided.
 */
import { generateIdeas } from './generator.mjs';
import { collectSignals } from './signals.mjs';

export async function runIdeationCycle({ repo, store, mode, limit = 12, fetchImpl, log = () => {} }) {
  const startedAt = Date.now();
  const signals = await collectSignals(repo);
  const { generator, fallbackReason, ideas } = await generateIdeas(signals, { mode, limit, fetchImpl });
  const { added, skipped } = await store.addMany(ideas);

  // A card whose evidence stopped holding must be labelled, not silently kept.
  // Fingerprints are the generator's identity for "the signals still support
  // this", so anything absent from this cycle's set is no longer backed.
  const { marked, cleared } = await store.markStaleness(ideas.map((i) => i.fingerprint));

  const meta = {
    generator,
    fallbackReason,
    head: signals.head,
    signalsAt: signals.collectedAt,
    proposed: ideas.length,
    added: added.length,
    skipped: skipped.length,
    staleMarked: marked,
    staleCleared: cleared,
    durationMs: Date.now() - startedAt,
  };
  await store.recordGeneration(meta);
  log(
    `ideation cycle generator=${generator} proposed=${ideas.length} added=${added.length} skipped=${skipped.length} stale=+${marked}/-${cleared}`,
  );
  return { ...meta, addedIdeas: added, signals };
}
