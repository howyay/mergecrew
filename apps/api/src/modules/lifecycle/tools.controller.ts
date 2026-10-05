import { Controller, Get } from '@nestjs/common';
import { ToolsService } from './tools.service.js';

/**
 * Public tools view. Like `/v1/skills` it is global (not tenant-scoped): the
 * stock agents and their bindings are the same for every organization.
 */
@Controller('v1/tools')
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get()
  list() {
    return this.tools.list();
  }
}
