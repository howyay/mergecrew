import { execa } from 'execa';

import type { Bead, BeadsClientOpts } from './types.js';

/**
 * Thin wrapper over the `bd` (beads) CLI's JSON interface.
 *
 * Scope is deliberately read-only plus minimal writes (create/update/close):
 * this is the non-destructive first slice of ADR-0016 / DEDUP-1. No
 * delete, no dep mutation, no status surgery beyond close.
 */
export class BeadsClient {
  private readonly bdPath: string;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: BeadsClientOpts = {}) {
    this.bdPath = opts.bdPath ?? 'bd';
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * List beads. Pass an external_ref to scope to beads already exported
   * from a tracker (the reconcile matching key).
   */
  async list(opts: { status?: string; externalRef?: string; limit?: number } = {}): Promise<Bead[]> {
    const args = ['list', '--json', '--limit', String(opts.limit ?? 0)];
    if (opts.status) args.push('--status', opts.status);
    if (opts.externalRef) args.push('--external-ref', opts.externalRef);
    return this.run<Bead[]>(args);
  }

  async show(id: string): Promise<Bead | null> {
    const rows = await this.run<Bead[]>(['show', id, '--json']);
    return rows[0] ?? null;
  }

  /** Create a bead; returns the created record including its new id. */
  async create(input: {
    title: string;
    description?: string;
    labels?: string[];
    priority?: number;
    externalRef?: string;
  }): Promise<Bead> {
    const args = ['create', input.title, '--json'];
    if (input.description) args.push('-d', input.description);
    if (input.labels?.length) args.push('--labels', input.labels.join(','));
    if (input.priority !== undefined) args.push('--priority', String(input.priority));
    if (input.externalRef) args.push('--external-ref', input.externalRef);
    return this.run<Bead>(args);
  }

  async update(
    id: string,
    input: {
      title?: string;
      description?: string;
      addLabels?: string[];
      removeLabels?: string[];
      priority?: number;
      status?: string;
      externalRef?: string;
    },
  ): Promise<Bead[]> {
    const args = ['update', id, '--json'];
    if (input.title) args.push('--title', input.title);
    if (input.description) args.push('-d', input.description);
    for (const l of input.addLabels ?? []) args.push('--add-label', l);
    for (const l of input.removeLabels ?? []) args.push('--remove-label', l);
    if (input.priority !== undefined) args.push('--priority', String(input.priority));
    if (input.status) args.push('--status', input.status);
    if (input.externalRef) args.push('--external-ref', input.externalRef);
    return this.run<Bead[]>(args);
  }

  async close(id: string, reason: string): Promise<Bead[]> {
    return this.run<Bead[]>(['close', id, '--reason', reason, '--json']);
  }

  private async run<T>(args: string[]): Promise<T> {
    const { stdout } = await execa(this.bdPath, args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : undefined,
      timeout: this.timeoutMs,
    });
    return JSON.parse(stdout) as T;
  }
}