/**
 * beads-reconcile CLI: diff tracker issues vs bd beads, print the report.
 *
 * Dry-run by default. `--write` additionally creates beads for missing
 * issues (still never updates/closes/deletes anything).
 *
 * Usage:
 *   beads-reconcile [--write] [--tracker <github-issues|linear>] [--config <json>]
 *
 * `--config` is a JSON blob passed to the tracker adapter constructor,
 * e.g. {"installationToken":"...","repoFullName":"owner/repo"} for
 * github-issues. Without a tracker the CLI runs in beads-only mode and
 * reports against an empty issue set (useful to list orphaned imports).
 */
import { GitHubIssuesProvider, LinearProvider } from '@mergecrew/adapters-tracker';

import { BeadsClient } from './beads-client.js';
import { reconcile, renderReport } from './reconcile.js';

interface CliFlags {
  write: boolean;
  tracker: string;
  config: string;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { write: false, tracker: 'github-issues', config: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--write') flags.write = true;
    else if (a === '--tracker') flags.tracker = argv[++i] ?? '';
    else if (a === '--config') flags.config = argv[++i] ?? '';
  }
  return flags;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  let cfg: unknown = {};
  if (flags.config) cfg = JSON.parse(flags.config);

  let tracker;
  if (flags.tracker === 'github-issues') tracker = new GitHubIssuesProvider(cfg as never);
  else if (flags.tracker === 'linear') tracker = new LinearProvider(cfg as never);
  else throw new Error(`unknown tracker ${flags.tracker}`);

  const report = await reconcile(tracker, new BeadsClient(), { write: flags.write });
  console.log(renderReport(report));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('beads-reconcile:', err instanceof Error ? err.message : err);
    process.exit(1);
  });