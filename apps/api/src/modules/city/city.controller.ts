import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { CityService } from './city.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';

/**
 * Gas City read endpoints. Mounted under the admin tree so the existing
 * tenant middleware and RoleGuard authorize the caller, in the same way as
 * the admin health endpoint.
 */
@Controller('v1/orgs/:slug/admin/city')
@UseGuards(RoleGuard)
export class CityController {
  constructor(private city: CityService) {}

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

  @Get('tenant/:orgSlug')
  @RequireRole('admin')
  async tenant(@Param('orgSlug') orgSlug: string) {
    const tenant = await this.city.tenant(orgSlug);
    if (!tenant.known) {
      throw new NotFoundException(
        `The city "${tenant.city}" has no rig "${tenant.rig}" for organization "${tenant.organization}". ` +
          'Add the rig to the city, or set CITY_RIGS to the rig list the product should accept.',
      );
    }
    return tenant;
  }
}
