import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import {
  IDEA_STATUS_QUEUED,
  NotFoundError,
  PICKABLE_IDEA_STATUS,
  ValidationError,
} from '@mergecrew/domain';

@Controller('v1/orgs/:slug/projects/:projectSlug/intent-inbox')
@UseGuards(RoleGuard)
export class IntentInboxController {
  constructor(private prisma: PrismaService, private tenant: TenantContextService) {}

  @Get()
  async list(@Param('projectSlug') projectSlug: string) {
    const t = this.tenant.require();
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const items = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return { items };
  }

  /**
   * File an idea for a project.
   *
   * By default the idea lands `queued`: it waits in the organization's idea
   * queue until a person approves it, which is what keeps a machine-filed idea
   * (a Sentry issue, a triage finding) from starting a run on its own. A UI
   * flow where a person authors the idea and picks it in the same action —
   * onboarding's first task, a direction chosen off a discovery report — passes
   * `decision: 'approve'` instead, because the human decision already happened
   * there and asking for it twice would just be ceremony.
   */
  @Post()
  @RequireRole('operator')
  async create(
    @Param('projectSlug') projectSlug: string,
    @Body() body: { body: string; decision?: string },
  ) {
    const t = this.tenant.require();
    if (body.decision !== undefined && body.decision !== 'approve') {
      throw new ValidationError(`unknown decision "${body.decision}"; expected approve`);
    }
    const status = body.decision === 'approve' ? PICKABLE_IDEA_STATUS : IDEA_STATUS_QUEUED;
    const project = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.project.findFirst({ where: { slug: projectSlug, organizationId: t.organizationId } }),
    );
    if (!project) throw new NotFoundError();
    const created = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.intentInboxItem.create({
        data: {
          organizationId: t.organizationId,
          projectId: project.id,
          submittedByUserId: t.userId,
          body: body.body,
          status,
        },
      }),
    );
    return created;
  }
}
