import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { Card, Chip, PageHead } from '@/components/ui';
import { DiffView, type DiffFile, type CommentRecord } from './diff-view';

interface DiffPayload {
  prNumber: number;
  files: DiffFile[];
}

interface CommentList {
  items: CommentRecord[];
}

interface Changeset {
  id: string;
  title: string;
  status: string;
  prNumber: number | null;
  prUrl: string | null;
}

export default async function ChangesetDiffPage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string; csId: string }>;
}) {
  const { slug, projectSlug, csId } = await params;
  const session = await requireSession();

  const [cs, diff, comments] = await Promise.all([
    apiOr404<Changeset>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`, { session }),
    api<DiffPayload>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/diff`, {
      session,
    }).catch((e: any) => ({ error: String(e?.message ?? e) }) as { error: string }),
    api<CommentList>(`/v1/orgs/${slug}/projects/${projectSlug}/changesets/${csId}/comments`, {
      session,
    }),
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          {
            label: 'Changesets',
            href: `/orgs/${slug}/projects/${projectSlug}/changesets`,
          },
          {
            label: cs.prNumber ? `#${cs.prNumber}` : cs.id.slice(0, 8),
            href: `/orgs/${slug}/projects/${projectSlug}/changesets/${csId}`,
          },
          { label: 'Diff' },
        ]}
        title={cs.title}
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            {cs.id} · <Chip>{cs.status}</Chip>
            {cs.prNumber && cs.prUrl && (
              <>
                {' '}·{' '}
                <a className="text-accent" href={cs.prUrl}>
                  PR #{cs.prNumber}
                </a>
              </>
            )}
          </span>
        }
      />

      {'error' in diff ? (
        <Card>
          <p className="text-sm text-rose-700 dark:text-rose-300">
            Could not load diff: {diff.error}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            The diff requires an open PR and a configured GitHub App on the server.
          </p>
        </Card>
      ) : (
        <DiffView
          slug={slug}
          projectSlug={projectSlug}
          csId={csId}
          files={diff.files}
          comments={comments.items}
          currentUserId={session.userId}
        />
      )}
    </main>
  );
}
