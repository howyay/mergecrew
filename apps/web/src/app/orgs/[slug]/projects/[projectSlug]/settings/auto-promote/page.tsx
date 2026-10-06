import { revalidatePath } from 'next/cache';
import { api, apiOr404 } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, PageHead } from '@/components/ui';
import { AutoPromoteEditor } from '@/components/auto-promote-editor';

interface AutoPromoteRule {
  name: string;
  pathPatterns: string[];
  maxFilesChanged?: number;
  maxLinesChanged?: number;
  requireDocsOnly?: boolean;
  requirePackageJsonPatchOnly?: boolean;
}

export default async function AutoPromotePage({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const session = await requireSession();
  const [{ rules }, canEdit, project] = await Promise.all([
    apiOr404<{ rules: AutoPromoteRule[] }>(
      `/v1/orgs/${slug}/projects/${projectSlug}/auto-promote`,
      { session },
    ),
    hasRole(slug, session, 'operator'),
    apiOr404<{ demo?: boolean }>(`/v1/orgs/${slug}/projects/${projectSlug}`, { session }),
  ]);
  const isDemo = Boolean(project.demo);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <PageHead
        crumb={[
          { label: slug, href: `/orgs/${slug}` },
          { label: projectSlug, href: `/orgs/${slug}/projects/${projectSlug}` },
          {
            label: 'Settings',
            href: `/orgs/${slug}/projects/${projectSlug}/settings`,
          },
          { label: 'Auto-promote rules' },
        ]}
        title="Auto-promote rules"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Changesets that match any rule below will skip human review and auto-promote.
            Empty list = every changeset goes through the manual approval gate.
          </span>
        }
      />

      <Card>
        <AutoPromoteEditor
          initialRules={rules}
          canEdit={canEdit && !isDemo}
          onSave={async (next) => {
            'use server';
            try {
              const session = await requireSession();
              await api(`/v1/orgs/${slug}/projects/${projectSlug}/auto-promote`, {
                method: 'PUT',
                body: JSON.stringify({ rules: next }),
                session,
              });
              revalidatePath(
                `/orgs/${slug}/projects/${projectSlug}/settings/auto-promote`,
              );
              return { ok: true } as const;
            } catch (e: any) {
              return { ok: false, error: String(e?.message ?? e) } as const;
            }
          }}
        />
      </Card>
    </main>
  );
}
