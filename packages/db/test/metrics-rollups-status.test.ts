import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyRunStatus, StepStatus } from '@mergecrew/domain';

/**
 * The rollup SQL compares two status columns to string literals, and the two
 * vocabularies in this repo do not agree: `StepOutcome.kind` says `completed`,
 * while the persisted `DailyRunStatus` and `StepStatus` say `done`.
 *
 * `daily_runs.status` is an enum, so `dr.status = 'completed'` is not a wrong
 * answer — it is a failed statement (`22P02 invalid input value for enum
 * daily_run_status`), and the whole rollup UPSERT rolls back with it. On the
 * reference host that is exactly what happened: worker-cron logged
 * `metrics.rollup_hourly_failed` every tick, `metrics_rollups` stayed empty, and
 * the metrics pages and the SLO evaluator read zeros while 340 runs sat in the
 * database.
 *
 * These tests hold every literal in that file to the vocabulary the columns
 * actually hold, so the next edit cannot quietly reintroduce it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(HERE, '..', 'src', 'metrics-rollups.ts'), 'utf8');

/** Every `alias.status = 'literal'` comparison in the file, in source order. */
function literalsFor(alias: string): string[] {
  const pattern = new RegExp(`\\b${alias}\\.status\\s*=\\s*'([^']*)'`, 'g');
  return [...sql.matchAll(pattern)].map((m) => m[1]);
}

describe('metrics rollup status literals', () => {
  it('finds the comparisons it is guarding', () => {
    // If the SQL is renamed or reshaped, this fails loudly instead of
    // passing vacuously over an empty list.
    expect(literalsFor('dr')).toHaveLength(4);
    expect(literalsFor('s')).toHaveLength(2);
  });

  it('compares daily_runs.status only to DailyRunStatus labels', () => {
    const labels = DailyRunStatus.options as readonly string[];
    for (const literal of literalsFor('dr')) {
      expect(labels, `${literal} is not a DailyRunStatus label`).toContain(literal);
    }
  });

  it('compares agent_steps.status only to StepStatus values', () => {
    const values = StepStatus.options as readonly string[];
    for (const literal of literalsFor('s')) {
      expect(values, `${literal} is not a StepStatus value`).toContain(literal);
    }
  });

  it('counts a finished run and a passed step as done', () => {
    expect(literalsFor('dr')).toEqual(['done', 'failed', 'done', 'failed']);
    expect(literalsFor('s')).toEqual(['done', 'done']);
  });

  it('does not use the StepOutcome spelling for a persisted status', () => {
    expect(sql).not.toMatch(/\.status\s*=\s*'completed'/);
  });
});
