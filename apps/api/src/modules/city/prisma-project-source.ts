import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import type { OrgProjectRow, OrgProjectSource } from './project-source.js';

/** Reads the organization's projects through the tenant-scoped client. */
@Injectable()
export class PrismaOrgProjectSource implements OrgProjectSource {
  constructor(private readonly prisma: PrismaService) {}

  async listByOrganizationId(organizationId: string): Promise<OrgProjectRow[]> {
    const rows = await this.prisma.withTenant(organizationId, (tx) =>
      tx.project.findMany({
        where: { organizationId, deletedAt: null },
        select: {
          slug: true,
          name: true,
          connectedRepo: { select: { repoFullName: true } },
        },
        orderBy: { slug: 'asc' },
      }),
    );
    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      repoFullName: row.connectedRepo?.repoFullName ?? null,
    }));
  }
}
