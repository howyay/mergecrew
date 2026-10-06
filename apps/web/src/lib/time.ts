/**
 * Timestamps for server-rendered pages.
 *
 * The web container runs in UTC and the browser does not, so
 * `new Date(x).toLocaleString()` renders one string on the server and a
 * different one in the browser. React then throws away the server HTML and
 * reports "Minified React error #418" — the page still works, which is exactly
 * why nobody notices until they look at the console.
 *
 * These helpers render the same string on both sides. They are deliberately
 * explicit about being UTC: an unambiguous stamp beats a pretty one that
 * disagrees with itself.
 */

/** `2026-10-03 05:31:57 UTC` — identical on the server and in the browser. */
export function utcStamp(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `2026-10-03` — for charts and tables that only need the day. */
export function utcDay(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}
