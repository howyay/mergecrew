import { Module } from '@nestjs/common';
import { CityController } from './city.controller.js';
import { CityService } from './city.service.js';

/** Gas City read surface for the product (ADR-0016 criterion 3). */
@Module({
  controllers: [CityController],
  providers: [CityService],
  exports: [CityService],
})
export class CityModule {}
