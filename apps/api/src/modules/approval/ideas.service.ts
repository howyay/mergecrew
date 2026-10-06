import { Injectable } from '@nestjs/common';
import {
  IDEA_STATUS_QUEUED,
  NotFoundError,
  ValidationError,
  decideIdea,
  ideaDecisionAction,
  isIdeaDecision,
} from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * The human gate for ideas.
 *
 * An idea is a proposal — a sentence someone typed, a Sentry issue, a
 * bug-triage finding. It sits `queued` until a person approves or rejects it,
 * and the runner seeds work from `approved` ideas alone. This service is
 * therefore what stands between a machine-filed idea and a run: nothing else
 * moves an idea across the gate.
 */
@Injectable()
export class IdeasService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  /** Every idea still waiting for a decision, oldest first. */
  async listQueue() {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.findMany({
        where: { organizationId: t.organizationId, status: IDEA_STATUS_QUEUED },
        orderBy: { createdAt: 'asc' },
        include: { project: { select: { slug: true, name: true } } },
      }),
    );
    // Flatten the project name and slug into the response so the inbox can
    // label each idea without a round-trip per row.
    return rows.map(({ project, ...row }) => ({
      ...row,
      projectSlug: project?.slug ?? null,
      projectName: project?.name ?? null,
    }));
  }

  /**
   * Approve or reject one idea. A decision is legal only while the idea waits
   * for one: a second decision is refused rather than overwriting the first,
   * and the decision is recorded in the organization's audit log because the
   * `intent_inbox_items` table has no "decided by" column.
   */
  async decide(ideaId: string, decision: string) {
    const t = this.tenant.require();
    if (!isIdeaDecision(decision)) {
      throw new ValidationError(`unknown decision "${decision}"; expected approve or reject`);
    }

    const idea = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.findFirst({ where: { id: ideaId, organizationId: t.organizationId } }),
    );
    if (!idea) throw new NotFoundError();

    // Throws when the idea is past the gate (approved, rejected or picked_up).
    const from = idea.status;
    const status = decideIdea(from, decision);

    const updated = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.update({ where: { id: idea.id }, data: { status } }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: ideaDecisionAction(decision),
          target: { ideaId: idea.id },
          metadata: { projectId: idea.projectId, from, to: status },
        },
      }),
    );

    return { ok: true, id: updated.id, status: updated.status };
  }
}
