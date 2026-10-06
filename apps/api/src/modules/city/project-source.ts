import type { ProjectRepoRef } from '@mergecrew/domain';

/**
 * The projects of one organization, as the rig binding needs them: the slug the
 * URL uses, the display name, and the repository that the city would carry.
 *
 * This is a port rather than a direct `PrismaService` dependency so the city
 * service tests can run without a database — the Prisma implementation lives in
 * `prisma-project-source.ts`.
 */
export const ORG_PROJECT_SOURCE = Symbol('ORG_PROJECT_SOURCE');

export type OrgProjectRow = ProjectRepoRef;

export interface OrgProjectSource {
  listByOrganizationId(organizationId: string): Promise<OrgProjectRow[]>;
}
