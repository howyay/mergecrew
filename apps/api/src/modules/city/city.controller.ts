import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CityService } from './city.service.js';
import { RequireRole, RoleGuard } from '../../common/role.guard.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/** A message id travels into a URL path, so it is held to the ids the city issues. */
const MESSAGE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A reply is a sentence to an agent, not a document. */
const REPLY_MAX = 4_000;

function messageIdOf(raw: string): string {
  const id = String(raw ?? '').trim();
  if (!MESSAGE_ID.test(id)) throw new BadRequestException('that is not a city message id');
  return id;
}

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

  /**
   * What the city's agents asked a human — the messages an agent left behind when
   * it stopped for a decision, each with the thread a reply has to join.
   *
   * `operator` rather than `admin`, because answering one is the same act as
   * resolving an approval, and the Inbox is where a person does both.
   */
  @Get('mail')
  @RequireRole('operator')
  async mail() {
    return this.city.mail();
  }

  /**
   * Answer one message. The reply joins the message's thread, so the agent that
   * stopped to ask receives it in the same conversation.
   */
  @Post('mail/:messageId/reply')
  @RequireRole('operator')
  async reply(@Param('messageId') messageId: string, @Body() body: { body?: unknown }) {
    const answer = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!answer) throw new BadRequestException('a reply needs a body');
    if (answer.length > REPLY_MAX) throw new BadRequestException(`a reply is limited to ${REPLY_MAX} characters`);
    return this.city.replyToMail(messageIdOf(messageId), answer);
  }

  @Post('mail/:messageId/read')
  @RequireRole('operator')
  @HttpCode(HttpStatus.OK)
  async markRead(@Param('messageId') messageId: string) {
    return this.city.markMailRead(messageIdOf(messageId));
  }

  @Post('mail/:messageId/mark-unread')
  @RequireRole('operator')
  @HttpCode(HttpStatus.OK)
  async markUnread(@Param('messageId') messageId: string) {
    return this.city.markMailUnread(messageIdOf(messageId));
  }

  /**
   * Put a message away. The supervisor has no unarchive route, so this is the one
   * action here that a person should mean: the page asks before it writes.
   */
  @Post('mail/:messageId/archive')
  @RequireRole('operator')
  @HttpCode(HttpStatus.OK)
  async archive(@Param('messageId') messageId: string) {
    return this.city.archiveMail(messageIdOf(messageId));
  }
}
