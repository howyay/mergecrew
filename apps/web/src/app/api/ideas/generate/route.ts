import { NextResponse } from 'next/server';
import { requestGeneration } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * Ask for one ideation cycle.
 *
 * The web app has no repo checkout, so it cannot collect signals itself: it
 * drops a request file that the host-side `ops/ideation` service polls. This is
 * the same one-way file contract the swipe decisions use.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const result = await requestGeneration(session.email ?? 'session');
  if (!result.ok) {
    return NextResponse.json({ error: `could not write the request file: ${result.reason}` }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    note: 'the host ideation service runs a cycle within seconds and updates the deck',
  });
}
