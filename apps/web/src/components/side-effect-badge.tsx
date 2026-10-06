import type { SideEffectClass } from '@/lib/skill-catalog';

/**
 * The side-effect badge, in one place.
 *
 * A skill's side-effect class is the runtime's own vocabulary for what it may
 * touch, so every surface that names a skill shows it the same way instead of
 * keeping its own tone table (#324 in reverse: one badge, not two).
 */

const SIDE_EFFECT_TONES: Record<SideEffectClass, string> = {
  read: 'bg-bg text-ink-2 border border-hair',
  write_workspace: 'bg-accent-soft text-accent-deep border border-accent',
  write_external: 'bg-warn/30 text-ink border border-warn',
  irreversible: 'bg-energy-soft text-energy-deep border border-energy',
};

export function SideEffectBadge({ cls }: { cls: SideEffectClass }) {
  return (
    <span
      className={`shrink-0 px-[8px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.06em] ${SIDE_EFFECT_TONES[cls]}`}
    >
      {cls.replace(/_/g, ' ')}
    </span>
  );
}
