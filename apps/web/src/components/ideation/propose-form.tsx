'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Loader2, PenLine } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * Propose work by hand.
 *
 * Some work nobody can infer from the repo — a refactor the team has been
 * putting off, a piece of plumbing with no issue behind it. This form puts it
 * into the same pipeline as a generated idea rather than into a side channel:
 * it lands as a `draft`, the host specifier verifies it against the code and
 * scores it, and only then does it become a card someone can swipe. The form
 * says so, because "I proposed it" is not the same claim as "it is worth doing".
 */

const KINDS = ['feature', 'technical', 'refactor'] as const;
type Kind = (typeof KINDS)[number];

const KIND_HINT: Record<Kind, string> = {
  feature: 'noticed a product idea',
  technical: 'engineering work with no user-visible change',
  refactor: 'restructure code without changing behaviour',
};

export function ProposeForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Kind>('refactor');
  const [rationale, setRationale] = useState('');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    const res = await fetch('/api/ideas/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, kind, rationale, persona }),
    });
    const text = await res.text();
    setBusy(false);
    if (!res.ok) {
      let message = text.slice(0, 240);
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        /* keep the raw body */
      }
      setNote({ text: `could not propose that: ${message}`, bad: true });
      return;
    }
    setTitle('');
    setRationale('');
    setPersona('');
    setNote({
      text: 'proposed — it is a draft until the host specifier verifies it against the code and scores it, then it appears under "Being prepared" and moves up on its own',
    });
    router.refresh();
  };

  return (
    <section className="mb-6 border border-hair bg-paper">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] font-medium"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <PenLine className="h-[14px] w-[14px]" />
        Propose work by hand
        <span className="ml-auto font-mono text-[11px] text-muted">{open ? 'close' : 'open'}</span>
      </button>

      {open && (
        <div className="border-t border-hair px-4 py-3">
          <p className="mb-3 max-w-[90ch] text-[12.5px] text-muted">
            For work the generator cannot infer from repo signals (a refactor, plumbing with no issue
            behind it). It enters the same pipeline as everything else: the host specifier checks the
            claim against the code and scores it before it reaches the deck, so a hand-proposed idea
            that is already implemented dies at the same gate.
          </p>

          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <label className="block">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
                Title
              </span>
              <input
                className="w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13px] outline-none focus:border-accent"
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Extract the retry policy out of the worker loop"
                value={title}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
                Kind
              </span>
              <select
                className="w-full border border-hair bg-paper-2 px-2 py-[7px] text-[13px] outline-none focus:border-accent"
                onChange={(e) => setKind(e.target.value as Kind)}
                value={kind}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k} — {KIND_HINT[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
                Persona (optional)
              </span>
              <input
                className="w-full border border-hair bg-paper-2 px-3 py-[7px] text-[13px] outline-none focus:border-accent"
                maxLength={120}
                onChange={(e) => setPersona(e.target.value)}
                placeholder="the on-call engineer"
                value={persona}
              />
            </label>
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
              Rationale
            </span>
            <textarea
              className="w-full border border-hair bg-paper-2 px-3 py-2 text-[13px] outline-none focus:border-accent"
              maxLength={1200}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why now, and what it unblocks. The specifier reads this, and so does the next person who wonders why it is in the deck."
              rows={3}
              value={rationale}
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={busy || title.trim().length === 0} onClick={() => void submit()} type="button">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
              Add to the pipeline
            </Button>
            <span className="text-[11.5px] text-muted">
              lands as <span className="font-mono">stage=draft</span>,{' '}
              <span className="font-mono">source=human</span> · provisional score 67 (should)
            </span>
          </div>

          {note && (
            <div
              className={clsx(
                'mt-3 border px-3 py-2 text-[12.5px]',
                note.bad ? 'border-energy bg-energy-wash text-energy-deep' : 'border-hair bg-paper-2 text-ink-2',
              )}
            >
              {note.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
