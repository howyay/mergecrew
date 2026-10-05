import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
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

  @Get('status')
  @RequireRole('admin')
  async status() {
    return this.city.status();
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
