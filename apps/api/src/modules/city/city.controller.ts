import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
  tenant(@Param('orgSlug') orgSlug: string) {
    return this.city.tenant(orgSlug);
  }
}
