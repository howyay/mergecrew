import { NextResponse } from 'next/server';
import { isPriority, setPriority } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * Override an idea's priority (gate 2b).
 *
 * The machine ranks every idea on four axes; an operator sometimes knows better
 * (a card blocks a release, or is cheap enough to do first). The override is
 * recorded *beside* the machine's verdict rather than instead of it, and it
 * recomputes `triage.rank` — the value the deck and the host's execution queue
 * both sort on, which is what makes the override actually change the order.
 *
 * Session-gated for the same reason the decide route is: this reorders what the
 * pipeline runs.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    priority?: unknown;
    reason?: unknown;
  } | null;
  const id = body?.id;
  const priority = body?.priority;
  if (typeof id !== 'string' || !isPriority(priority)) {
    return NextResponse.json(
      { error: 'expected {id: string, priority: P0|P1|P2|P3, reason?: string}' },
      { status: 400 },
    );
  }

  const idea = await setPriority(id, priority, {
    reason: typeof body?.reason === 'string' ? body.reason : null,
    by: session.name || session.email || 'human',
  });
  if (!idea) return NextResponse.json({ error: `unknown idea ${id}` }, { status: 404 });

  return NextResponse.json({ idea });
}
