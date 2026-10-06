import { IdeasService } from './ideas.service.js';
import type { PrismaService } from '../../common/prisma.service.js';
import type { TenantContextService } from '../../common/tenant-context.service.js';

// The real PrismaService loads the generated Prisma client, which a box without
// `prisma generate` cannot resolve (finding me-kgy). The gate logic under test
// never touches Prisma — the fake below stands in for it — so the module is
// stubbed to keep this spec runnable wherever the API's other specs run.
jest.mock('../../common/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));

/**
 * The idea gate is the only thing that turns a proposal into work, so these
 * tests pin the two properties that matter: a decision flips exactly one idea
 * from `queued` and is recorded, and nothing else can move an idea across the
 * gate (a second decision is refused, an unknown idea is not found, an
 * unknown decision never reaches the database).
 */

interface IdeaRow {
  id: string;
  organizationId: string;
  projectId: string;
  status: string;
  body: string;
}

function makeService(rows: IdeaRow[]) {
  const audits: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const queries: Record<string, unknown>[] = [];

  const tx = {
    intentInboxItem: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        queries.push(args);
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        return rows.filter(
          (row) =>
            row.organizationId === where.organizationId && row.status === where.status,
        );
      }),
      findFirst: jest.fn(async (args: Record<string, unknown>) => {
        const where = (args as { where?: Record<string, unknown> }).where ?? {};
        return (
          rows.find(
            (row) => row.id === where.id && row.organizationId === where.organizationId,
          ) ?? null
        );
      }),
      update: jest.fn(async (args: Record<string, unknown>) => {
        const { where, data } = args as {
          where: { id: string };
          data: { status: string };
        };
        updates.push(args);
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('update called for an unknown row');
        row.status = data.status;
        return row;
      }),
    },
    auditLogEntry: {
      create: jest.fn(async (args: Record<string, unknown>) => {
        audits.push((args as { data: Record<string, unknown> }).data);
        return args;
      }),
    },
  };

  const prisma = {
    withTenant: (_organizationId: string, fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as PrismaService;

  const tenant = {
    require: () => ({
      organizationId: 'org-1',
      organizationSlug: 'acme',
      userId: 'user-1',
      role: 'owner',
    }),
  } as unknown as TenantContextService;

  return { service: new IdeasService(prisma, tenant), tx, audits, updates, queries, rows };
}

const queued = (over: Partial<IdeaRow> = {}): IdeaRow => ({
  id: 'idea-1',
  organizationId: 'org-1',
  projectId: 'proj-1',
  status: 'queued',
  body: 'Sentry says checkout 500s on retry',
  ...over,
});

describe('IdeasService.listQueue', () => {
  it('returns the ideas of this organization that wait for a decision', async () => {
    const { service, queries } = makeService([
      queued(),
      queued({ id: 'idea-2', status: 'approved', body: 'already decided' }),
      queued({ id: 'idea-3', organizationId: 'org-2', body: 'another tenant' }),
    ]);

    const items = await service.listQueue();

    expect(items.map((i: { id: string }) => i.id)).toEqual(['idea-1']);
    expect(queries[0]).toMatchObject({
      where: { organizationId: 'org-1', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('flattens the project name and slug so the inbox can label each row', async () => {
    const { service } = makeService([queued()]);

    const items = await service.listQueue();

    expect(items[0]).toMatchObject({ id: 'idea-1', projectSlug: null, projectName: null });
  });
});

describe('IdeasService.decide', () => {
  it('approves a queued idea into the pickable status and records who decided', async () => {
    const { service, audits, updates } = makeService([queued()]);

    await expect(service.decide('idea-1', 'approve')).resolves.toEqual({
      ok: true,
      id: 'idea-1',
      status: 'approved',
    });

    expect(updates[0]).toMatchObject({ where: { id: 'idea-1' }, data: { status: 'approved' } });
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        action: 'idea.approved',
        target: { ideaId: 'idea-1' },
        metadata: { projectId: 'proj-1', from: 'queued', to: 'approved' },
      }),
    ]);
  });

  it('rejects a queued idea into a status no run can pick up', async () => {
    const { service, audits, rows } = makeService([queued()]);

    await expect(service.decide('idea-1', 'reject')).resolves.toMatchObject({
      status: 'rejected',
    });

    expect(rows[0]?.status).toBe('rejected');
    expect(audits[0]).toMatchObject({ action: 'idea.rejected' });
  });

  it('refuses a second decision instead of overwriting the first', async () => {
    const { service, audits, updates, tx } = makeService([queued({ status: 'approved' })]);

    await expect(service.decide('idea-1', 'reject')).rejects.toThrow(/past the human gate/);
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
    expect(tx.intentInboxItem.update).not.toHaveBeenCalled();
  });

  it('does not find an idea that belongs to another organization', async () => {
    const { service, audits } = makeService([queued({ organizationId: 'org-2' })]);

    await expect(service.decide('idea-1', 'approve')).rejects.toThrow(/not found/i);
    expect(audits).toEqual([]);
  });

  it('rejects an unknown decision before it touches the database', async () => {
    const { service, tx, updates } = makeService([queued()]);

    await expect(service.decide('idea-1', 'maybe')).rejects.toThrow(/unknown decision/);
    expect(tx.intentInboxItem.findFirst).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
