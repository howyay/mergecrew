'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { FileText, Loader2, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui';
import { utcStamp } from '@/lib/time';
import type { Idea, IdeaBand, IdeaFeatures, IdeaPriority } from '@/lib/ideation';
import { normalizeKind } from '@/lib/ideation-kinds';

/**
 * The card's specification, and the machine's verdict on it.
 *
 * A card reaches this panel only after the host specifier has verified the
 * claim against the code (`stage === 'specified'`), so this is where the
 * operator reads what the idea would actually mean — acceptance criteria,
 * what is explicitly out of scope, and what the specifier found — before
 * spending a swipe on it. Everything here is the host's words, not the app's:
 * where a field is missing the panel says so rather than filling the gap.
 */

/** Rubric ceilings, mirroring `ops/ideation/lib/scorer.mjs`. */
export const RUBRIC: Record<keyof IdeaFeatures, { max: number; label: string }> = {
  impact: { max: 40, label: 'Impact' },
  confidence: { max: 20, label: 'Confidence' },
  effort: { max: 20, label: 'Effort' },
  risk: { max: 20, label: 'Risk' },
};

const AXES = Object.keys(RUBRIC) as (keyof IdeaFeatures)[];

/** Older records predate the rubric; a missing axis is zero, never NaN. */
export const ZERO_FEATURES: IdeaFeatures = { impact: 0, confidence: 0, effort: 0, risk: 0 };

export function featuresOf(idea: Idea): IdeaFeatures {
  return { ...ZERO_FEATURES, ...(idea.features ?? {}) };
}

export const BAND_TONE: Record<IdeaBand, string> = {
  must: 'text-energy-deep',
  should: 'text-accent-deep',
  could: 'text-warn',
  wont: 'text-muted',
};

const BAND_LABEL: Record<IdeaBand, string> = {
  must: 'must do',
  should: 'should do',
  could: 'could do',
  wont: "won't do",
};

const KIND_TONE: Record<string, string> = {
  feature: 'border-accent text-accent-deep',
  chore: 'border-ink text-ink',
  refactor: 'border-warn text-warn',
};

const KIND_TITLE: Record<string, string> = {
  feature: 'a product change — specified and verified against the code before a human decides',
  chore: 'maintenance work — never specified; QA is repo checks and the deliverable is a changelog',
  refactor: 'a restructure with no user-visible change',
};

/**
 * The card's kind. The badge normalises before it renders, so a record written
 * before the chore rename can never print `technical` on a card — the legacy
 * spelling resolves to the same badge a chore gets today.
 */
export function KindBadge({ kind }: { kind: string }) {
  const canonical = normalizeKind(kind);
  return (
    <span
      className={clsx('border px-1.5 py-0.5 font-mono text-[10.5px]', KIND_TONE[canonical] ?? 'border-hair text-muted')}
      title={KIND_TITLE[canonical]}
    >
      {canonical}
    </span>
  );
}

export const PRIORITY_TONE: Record<IdeaPriority, string> = {
  P0: 'border-energy bg-energy text-paper',
  P1: 'border-energy text-energy-deep',
  P2: 'border-accent text-accent-deep',
  P3: 'border-hair text-muted',
};

export function PriorityChip({ priority, overridden }: { priority: IdeaPriority | null; overridden?: boolean }) {
  if (!priority) {
    return (
      <span className="border border-hair px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
        no priority yet
      </span>
    );
  }
  return (
    <span
      className={clsx('border px-1.5 py-0.5 font-mono text-[10.5px]', PRIORITY_TONE[priority] ?? 'border-hair text-muted')}
      title={overridden ? 'set by an operator, overriding the machine' : 'set by the machine'}
    >
      {priority}
      {overridden ? ' · set by hand' : ''}
    </span>
  );
}

export function RubricBars({ features }: { features: IdeaFeatures }) {
  return (
    <div className="space-y-1">
      {AXES.map((axis) => (
        <div key={axis} className="flex items-center gap-2 text-[11.5px]">
          <span className="w-[84px] shrink-0 text-muted">{RUBRIC[axis].label}</span>
          <span className="h-[3px] flex-1 bg-hair">
            <span
              className="block h-full bg-accent"
              style={{ width: `${Math.min(100, (features[axis] / RUBRIC[axis].max) * 100)}%` }}
            />
          </span>
          <span className="w-[46px] shrink-0 text-right font-mono text-muted">
            {features[axis]}/{RUBRIC[axis].max}
          </span>
        </div>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-[3px] text-[12.5px]">
      <span className="w-[104px] shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function List({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <Row label={label}>
      {items.length === 0 ? (
        <span className="text-muted">{empty}</span>
      ) : (
        <ul className="m-0 list-disc space-y-[2px] pl-4">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </Row>
  );
}

const asList = (value: string[] | undefined): string[] => (Array.isArray(value) ? value.filter(Boolean) : []);

/**
 * The priority control (gate 2b).
 *
 * The machine ranks every idea on the same four axes; a person sometimes knows
 * better, and this is where they say so. The override never erases the machine's
 * verdict — it is recorded beside it (`triage.override.automatic`) and an event
 * is appended, so "who moved this and why" survives the next regeneration. The
 * rank is recomputed on the host's formula, which is what actually reorders the
 * deck and the execution queue.
 */
export function PriorityControl({
  idea,
  onChanged,
  onNote,
}: {
  idea: Idea;
  onChanged: () => void;
  onNote: (text: string, bad?: boolean) => void;
}) {
  const current = idea.triage?.priority ?? null;
  const [target, setTarget] = useState<IdeaPriority | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    const res = await fetch('/api/ideas/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: idea.id, priority: target, reason }),
    });
    const text = await res.text();
    setBusy(false);
    if (!res.ok) {
      onNote(`could not set ${target}: ${text.slice(0, 200)}`, true);
      return;
    }
    onNote(`${idea.id} priority ${current ?? 'unset'} → ${target}${reason.trim() ? ' (reason recorded)' : ''}`);
    setTarget(null);
    setReason('');
    onChanged();
  };

  return (
    <div className="mt-3 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">Priority</span>
        <PriorityChip priority={current} overridden={Boolean(idea.triage?.override)} />
        {(idea.triage?.rank ?? null) !== null && (
          <span className="font-mono text-[10.5px] text-muted">rank {idea.triage?.rank}</span>
        )}
        <span className="text-[12px] text-muted">
          {idea.triage?.reason ? `machine: ${idea.triage.reason}` : 'the machine has not ranked this card'}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">override</span>
        {(['P0', 'P1', 'P2', 'P3'] as IdeaPriority[]).map((priority) => (
          <button
            key={priority}
            className={clsx(
              'border px-2 py-[3px] font-mono text-[11px]',
              priority === target
                ? 'border-accent bg-accent-soft text-accent-deep'
                : 'border-hair text-ink-2 hover:border-ink',
              priority === current && 'opacity-50',
            )}
            disabled={busy || priority === current}
            onClick={() => {
              setTarget(priority);
              setReason('');
            }}
            title={priority === current ? 'already the priority of record' : `set ${priority}`}
            type="button"
          >
            {priority}
          </button>
        ))}
      </div>

      {target && (
        <div className="mt-2 border border-hair bg-paper-2 px-3 py-2">
          <label className="block text-[12px] text-muted" htmlFor={`reason-${idea.id}`}>
            Why {target}? Optional — it is recorded with your name and shown beside the machine&apos;s verdict.
          </label>
          <input
            className="mt-1 w-full border border-hair bg-paper px-2 py-[5px] text-[12.5px] outline-none focus:border-accent"
            id={`reason-${idea.id}`}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. it blocks the release; do it before the rest"
            value={reason}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void apply()} type="button">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Set {target}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setTarget(null);
                setReason('');
              }}
              type="button"
            >
              Cancel
            </Button>
            <span className="text-[11.5px] text-muted">
              was {current ?? 'unset'} · the machine&apos;s verdict is kept as{' '}
              {idea.triage?.priority ? `automatic ${idea.triage.priority}` : 'automatic: none'}
            </span>
          </div>
        </div>
      )}

      {idea.triage?.override && (
        <p className="mt-2 text-[11.5px] text-muted">
          Overridden to {idea.triage.override.priority} by {idea.triage.override.by} ·{' '}
          {utcStamp(idea.triage.override.at)}
          {idea.triage.override.automatic.priority
            ? ` · replaced the machine's ${idea.triage.override.automatic.priority}`
            : ''}
          {idea.triage.override.reason ? ` — ${idea.triage.override.reason}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * The full spec panel: the claim, what done means, what the specifier found in
 * the code, and the artefact it wrote. It ends with the priority control, since
 * ranking is the one thing an operator can change without spending the swipe.
 */
export function SpecPanel({
  idea,
  onChanged,
  onNote,
  defaultOpen = true,
}: {
  idea: Idea;
  onChanged: () => void;
  onNote: (text: string, bad?: boolean) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const spec = idea.spec ?? null;
  const verification = idea.verification ?? null;
  const band = idea.band ?? 'could';
  const features = featuresOf(idea);

  return (
    <section className="mt-3 border border-hair bg-paper">
      <div className="flex flex-wrap items-center gap-2 border-b border-hair px-4 py-2">
        <button className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted underline" onClick={() => setOpen(!open)} type="button">
          {open ? 'hide' : 'show'} specification
        </button>
        <KindBadge kind={idea.kind ?? 'feature'} />
        <PriorityChip priority={idea.triage?.priority ?? null} overridden={Boolean(idea.triage?.override)} />
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[14px]">{idea.score ?? '—'}</span>
          <span className={clsx('font-mono text-[10.5px] uppercase', BAND_TONE[band])}>{BAND_LABEL[band]}</span>
        </span>
      </div>

      {open && (
        <div className="px-4 py-3">
          <RubricBars features={features} />

          {idea.scoreReasons && idea.scoreReasons.length > 0 && (
            <div className="mt-1.5 font-mono text-[10.5px] text-muted">{idea.scoreReasons.join(' · ')}</div>
          )}

          <div className="mt-3 border-t border-hair pt-2">
            <Row label="Stage">
              <span className="font-mono text-[11.5px]">{idea.stage ?? 'draft'}</span>
              {spec?.specifiedBy ? ` · specified by ${spec.specifiedBy}` : ''}
              {spec?.specifiedAt ? ` · ${utcStamp(spec.specifiedAt)}` : ''}
            </Row>
            <Row label="Summary">
              {spec?.summary ? spec.summary : <span className="text-muted">the specifier wrote no summary</span>}
            </Row>
            <Row label="Generalization">
              {spec?.generalization ? (
                spec.generalization
              ) : (
                <span className="text-muted">none recorded — treat the claim literally</span>
              )}
            </Row>
            <Row label="Persona">
              {spec?.persona ?? idea.persona ?? <span className="text-muted">no persona named</span>}
            </Row>
            <List label="Acceptance" items={asList(spec?.acceptance)} empty="no acceptance criteria recorded" />
            <List label="Out of scope" items={asList(spec?.outOfScope)} empty="nothing declared out of scope" />
            <List label="Open questions" items={asList(spec?.openQuestions)} empty="none" />
          </div>

          <div className="mt-3 border-t border-hair pt-2">
            <Row label="Verification">
              {verification ? (
                <span>
                  {verification.alreadyImplemented === 'possible' ? (
                    <span className="text-energy-deep">
                      possibly already implemented — check the evidence before accepting
                    </span>
                  ) : (
                    <span>not already implemented, as far as the specifier can tell</span>
                  )}
                  {verification.basis ? ` · basis: ${verification.basis}` : ''}
                  {verification.checkedAt ? ` · ${utcStamp(verification.checkedAt)}` : ''}
                  {verification.by ? ` · by ${verification.by}` : ''}
                </span>
              ) : (
                <span className="text-muted">the host has not recorded a verification pass</span>
              )}
            </Row>

            {verification?.evidence && verification.evidence.length > 0 && (
              <Row label="Evidence">
                <ul className="m-0 list-none space-y-[2px] p-0 font-mono text-[11.5px]">
                  {verification.evidence.map((item, i) => (
                    <li key={i} className="break-words">
                      {item.path ?? 'unknown path'}
                      {item.line ? `:${item.line}` : ''}
                      {item.token ? ` · ${item.token}` : ''}
                      {item.note ? ` — ${item.note}` : ''}
                    </li>
                  ))}
                </ul>
              </Row>
            )}

            {verification?.notes && <Row label="Notes">{verification.notes}</Row>}
            {Array.isArray(idea.evidence) && idea.evidence.length > 0 && (
              <Row label="Signals">
                <span className="font-mono text-[11.5px]">{idea.evidence.join(' · ')}</span>
              </Row>
            )}
          </div>

          {spec?.markdown && (
            <details className="mt-3 border-t border-hair pt-2">
              <summary className="cursor-pointer font-mono text-[11.5px] text-muted">
                spec document · {spec.markdown.length} chars
              </summary>
              <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap border border-hair bg-bg p-3 font-mono text-[11.5px] leading-[1.5]">
                {spec.markdown}
              </pre>
            </details>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-hair pt-2">
            {spec?.file ? (
              <a
                className="inline-flex items-center gap-[6px] text-[12.5px] underline"
                href={`/api/ideas/artifact?id=${encodeURIComponent(idea.id)}&kind=spec`}
                rel="noreferrer"
                target="_blank"
                title="read from the mounted artefacts directory; a 404 means the host has not written that file where the container can see it"
              >
                <FileText className="h-[13px] w-[13px]" /> {spec.file}
              </a>
            ) : (
              <span className="inline-flex items-center gap-[6px] text-[12.5px] text-muted">
                <ShieldQuestion className="h-[13px] w-[13px]" /> the specifier recorded no spec document
              </span>
            )}
            {idea.rationale && <span className="min-w-0 flex-1 text-[12px] text-muted">{idea.rationale}</span>}
          </div>

          <PriorityControl idea={idea} onChanged={onChanged} onNote={onNote} />
        </div>
      )}
    </section>
  );
}
