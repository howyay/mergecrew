import { NextResponse } from 'next/server';
import { readIdeaState, readArtifact } from '@/lib/ideation';
import { getSession } from '@/lib/session';

/**
 * Serve one artefact the host pipeline produced for an idea: its spec, its PRD,
 * its UAT report, its demo recording, or its local issue file.
 *
 * The paths come from the idea record (written by the host), never from the
 * query string, so a caller cannot walk the mount: it can only ask for an
 * artefact that the pipeline itself recorded for that idea. Anything the host
 * has not written yet is a 404 — the page must show "not yet", not a blank
 * document that looks like an empty PRD.
 */
export const dynamic = 'force-dynamic';

const TEXT_KINDS = new Set(['spec', 'prd', 'uat', 'issue', 'deliver', 'demo-html']);

export async function GET(req: Request): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const kind = url.searchParams.get('kind') ?? '';
  const state = await readIdeaState();
  const idea = state.ideas.find((i) => i.id === id);
  if (!idea) return NextResponse.json({ error: `unknown idea ${id}` }, { status: 404 });

  const pipeline = idea.pipeline ?? {};
  const relPath =
    kind === 'spec'
      ? idea.spec?.file
      : kind === 'prd'
        ? pipeline.prd?.file
        : kind === 'issue'
          ? pipeline.issue?.file
          : kind === 'uat'
            ? pipeline.qa?.report
            : kind === 'deliver'
              ? pipeline.deliver?.file
              : kind === 'demo'
                ? pipeline.qa?.demo
                : null;
  if (!relPath) {
    return NextResponse.json({ error: `no ${kind} recorded for ${id}` }, { status: 404 });
  }

  if (kind === 'demo') {
    const { readFile } = await import('node:fs/promises');
    const { artifactPath } = await import('@/lib/ideation');
    const full = artifactPath(relPath);
    if (!full) return NextResponse.json({ error: 'bad artefact path' }, { status: 400 });
    try {
      const bytes = await readFile(full);
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': relPath.endsWith('.apng') ? 'image/apng' : 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return NextResponse.json({ error: `demo not readable: ${relPath}` }, { status: 404 });
    }
  }

  if (!TEXT_KINDS.has(kind)) {
    return NextResponse.json({ error: 'expected kind=spec|prd|issue|uat|deliver|demo' }, { status: 400 });
  }

  const body = await readArtifact(relPath);
  if (body === null) {
    return NextResponse.json({ error: `artefact missing on disk: ${relPath}` }, { status: 404 });
  }
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
