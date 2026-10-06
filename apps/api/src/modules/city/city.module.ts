import { Module } from '@nestjs/common';
import { CityController } from './city.controller.js';
import { CityService } from './city.service.js';
import { ORG_PROJECT_SOURCE } from './project-source.js';
import { PrismaOrgProjectSource } from './prisma-project-source.js';

/** Gas City read surface for the product (ADR-0016 criterion 3). */
@Module({
  controllers: [CityController],
  providers: [
    CityService,
    PrismaOrgProjectSource,
    { provide: ORG_PROJECT_SOURCE, useExisting: PrismaOrgProjectSource },
  ],
  exports: [CityService],
})
export class CityModule {}
