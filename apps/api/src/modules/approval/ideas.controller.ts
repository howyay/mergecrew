import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { IdeasService } from './ideas.service.js';

/**
 * The organization's idea queue and the gate that moves an idea out of it.
 *
 * Reading the queue is open to any member of the organization, the same way
 * the approval inbox is; deciding is an operator action, because approving an
 * idea is what lets a run start from it.
 */
@Controller('v1/orgs/:slug/ideas')
@UseGuards(RoleGuard)
export class IdeasController {
  constructor(private ideas: IdeasService) {}

  @Get()
  async list() {
    return { items: await this.ideas.listQueue() };
  }

  @Post(':ideaId/decision')
  @RequireRole('operator')
  async decide(@Param('ideaId') ideaId: string, @Body() body: { decision?: string }) {
    return this.ideas.decide(ideaId, String(body?.decision ?? ''));
  }
}
