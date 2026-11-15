import { Module } from '@nestjs/common';
import { ExportPurgeService } from './export-purge.service';

/** The expired-export purge (BIB-47) alone, for the worker: no controllers or HTTP services. */
@Module({
  providers: [ExportPurgeService],
  exports: [ExportPurgeService],
})
export class ExportPurgeModule {}
