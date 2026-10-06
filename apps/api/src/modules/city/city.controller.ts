import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CityService } from './city.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * Gas City read endpoints. Mounted under the admin tree so the existing
 * tenant middleware and RoleGuard authorize the caller, in the same way as
 * the admin health endpoint.
 */
@Controller('v1/orgs/:slug/admin/city')
@UseGuards(RoleGuard)
export class CityController {
  constructor(
    private city: CityService,
    private tenantContext: TenantContextService,
  ) {}

  /**
   * `?view=summary` keeps the nine fields the product pages read and drops
   * `agent_details` and friends — 83% of the payload on a twenty-agent city.
   * Anything else answers with the full status, so existing callers are unaffected.
   */
  @Get('status')
  @RequireRole('admin')
  async status(@Query('view') view?: string) {
    return this.city.status(view === 'summary' ? 'summary' : 'full');
  }

  @Get('agents')
  @RequireRole('admin')
  async agents() {
    return this.city.agents();
  }

  @Get('sessions')
  @RequireRole('admin')
  async sessions() {
    return this.city.sessions();
  }

  /**
   * Every project of this organization, bound to the rig that carries it. An
   * unmapped project answers with the reason and the fix instead of being
   * dropped, because the city cannot run a project it has no rig for.
   */
  @Get('projects')
  @RequireRole('admin')
  async projects() {
    const tenant = this.tenantContext.require();
    return this.city.projectRigs(tenant.organizationId);
  }

  /**
   * What the city recorded today. The supervisor's numbers are a local
   * estimate, so the payload carries `source`, `unpriced` and `partial` for the
   * cost page to label honestly rather than present as a bill.
   */
  @Get('usage')
  @RequireRole('admin')
  async usage() {
    return this.city.usage();
  }

  /**
   * The mapping rule's answer for one organization: the rig it derives to, and
   * whether the city holds that rig. A city that does not hold the rig is a
   * value here, not a failure — `known: false` is the normal state of an
   * organization whose rig has not been created yet, the page renders it as
   * "unknown rig" beside the fix, and the committed OpenAPI documents a 200.
   * Answering 404 hid exactly the answer this field exists to give.
   */
  @Get('tenant/:orgSlug')
  @RequireRole('admin')
  async tenant(@Param('orgSlug') orgSlug: string) {
    return this.city.tenant(orgSlug);
  }
}
