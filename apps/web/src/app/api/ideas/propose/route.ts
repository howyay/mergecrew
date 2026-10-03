import { NextResponse } from 'next/server';
import { proposeIdea, type IdeaKind } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * Propose work by hand — the human door into the same gate.
 *
 * A person can see work the generator cannot (a refactor they have been putting
 * off, plumbing nobody filed an issue for). What they cannot do is skip the
 * machine: the record is created as a `draft` with a provisional score, and the
 * host specifier still verifies it against the code, writes acceptance criteria
 * and re-scores it before it becomes swipable. A hand-proposed idea that turned
 * out to be already implemented dies at the same gate as any other.
 */
export const dynamic = 'force-dynamic';

const KINDS: IdeaKind[] = ['feature', 'technical', 'refactor'];

export async function POST(req: Request): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    kind?: unknown;
    rationale?: unknown;
    persona?: unknown;
  } | null;

  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const rawKind = typeof body?.kind === 'string' ? body.kind : '';
  const kind: IdeaKind = (KINDS as string[]).includes(rawKind) ? (rawKind as IdeaKind) : 'feature';
  if (!title) {
    return NextResponse.json(
      { error: 'expected {title: string, kind?: feature|technical|refactor, rationale?: string, persona?: string}' },
      { status: 400 },
    );
  }

  const result = await proposeIdea({
    title,
    kind,
    rationale: typeof body?.rationale === 'string' ? body.rationale : null,
    persona: typeof body?.persona === 'string' ? body.persona : null,
    by: session.name || session.email || 'human',
  });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });

  return NextResponse.json({ idea: result.idea });
}
