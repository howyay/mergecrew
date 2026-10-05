import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller.js';
import { ApprovalService } from './approval.service.js';
import { IdeasController } from './ideas.controller.js';
import { IdeasService } from './ideas.service.js';
import { IntentInboxController } from './intent-inbox.controller.js';

@Module({
  controllers: [ApprovalController, IntentInboxController, IdeasController],
  providers: [ApprovalService, IdeasService],
  exports: [ApprovalService, IdeasService],
})
export class ApprovalModule {}
