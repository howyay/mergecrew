import { NextResponse } from 'next/server';
import { reviewIdea, type ReviewDecision } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * The second human gate: approve or reject the work the automation delivered.
 *
 * The demo recording on the Ideas page exists so this is a ten-second decision
 * made from evidence rather than a status string. The route records the verdict
 * only; the host pipeline owns every consequence (keeping or tearing down the
 * worktree, marking the idea done).
 */
export const dynamic = 'force-dynamic';

const DECISIONS: ReviewDecision[] = ['approved', 'rejected'];

export async function POST(req: Request): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { id?: unknown; decision?: unknown; note?: unknown }
    | null;
  const id = body?.id;
  const decision = body?.decision;
  if (typeof id !== 'string' || !DECISIONS.includes(decision as ReviewDecision)) {
    return NextResponse.json(
      { error: 'expected {id: string, decision: approved|rejected, note?: string}' },
      { status: 400 },
    );
  }

  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;
  const idea = await reviewIdea(id, decision as ReviewDecision, session.email ?? 'session', note);
  if (!idea) return NextResponse.json({ error: `unknown idea ${id}` }, { status: 404 });

  return NextResponse.json({ idea });
}
