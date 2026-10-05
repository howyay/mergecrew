import { Module } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller.js';
import { LifecycleService } from './lifecycle.service.js';
import { LifecyclePrService } from './lifecycle-pr.service.js';
import { OrgTemplateController } from './org-template.controller.js';
import { OrgTemplateService } from './org-template.service.js';
import { SkillsController } from './skills.controller.js';
import { SKILL_CATALOG } from './skill-catalog.js';
import { StockTemplateController } from './stock-templates.controller.js';
import { buildStockSkillCatalog } from './stock-skill-catalog.js';
import { ToolsController } from './tools.controller.js';
import { ToolsService } from './tools.service.js';

@Module({
  controllers: [
    LifecycleController,
    SkillsController,
    ToolsController,
    OrgTemplateController,
    StockTemplateController,
  ],
  providers: [
    LifecycleService,
    LifecyclePrService,
    OrgTemplateService,
    ToolsService,
    { provide: SKILL_CATALOG, useFactory: buildStockSkillCatalog },
  ],
  exports: [LifecycleService, LifecyclePrService, OrgTemplateService],
})
export class LifecycleModule {}
