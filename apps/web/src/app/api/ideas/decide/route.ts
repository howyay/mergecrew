import { NextResponse } from 'next/server';
import { decideIdea, swipeGate, type IdeaStatus } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * Record one swipe decision from the Ideas page.
 *
 * Session-gated: the deck is a decision surface, and an unauthenticated writer
 * could accept work on the operator's behalf. The host-side service picks the
 * decision up from the shared file within seconds — this route never claims an
 * execution happened.
 *
 * The swipe gate is enforced here as well as in the deck. The deck only offers
 * cards the host has finished specifying; this is what stops a hand-made POST
 * from accepting a draft that no one has verified against the code.
 */
export const dynamic = 'force-dynamic';

const DECISIONS: IdeaStatus[] = ['accepted', 'rejected', 'pending'];

export async function POST(req: Request): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    decision?: unknown;
    comment?: unknown;
  } | null;
  const id = body?.id;
  const decision = body?.decision;
  if (typeof id !== 'string' || !DECISIONS.includes(decision as IdeaStatus)) {
    return NextResponse.json(
      { error: 'expected {id: string, decision: accepted|rejected|pending, comment?: string}' },
      { status: 400 },
    );
  }

  if (decision === 'accepted') {
    const gate = await swipeGate(id);
    if (!gate) return NextResponse.json({ error: `unknown idea ${id}` }, { status: 404 });
    if (!gate.ok) {
      return NextResponse.json({ error: `not ready to decide: ${gate.reason}` }, { status: 409 });
    }
  }

  const comment = typeof body?.comment === 'string' ? body.comment : null;
  const idea = await decideIdea(id, decision as IdeaStatus, {
    comment,
    by: session.name || session.email || 'human',
  });
  if (!idea) return NextResponse.json({ error: `unknown idea ${id}` }, { status: 404 });

  return NextResponse.json({ idea });
}
