import { Module } from '@nestjs/common';
import { MutationModule } from '../../common/mutation/mutation.module';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { StudyModule } from '../study/study.module';
import { DEFAULT_EXPORT_LIMITS, EXPORT_LIMITS } from './export-limits';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Exports bounded context (PRD §26; BIB-47, BIB-48). Owns `export_file`: study and account
 * exports (JSON and Markdown), their signed 15-minute download links and their 24-hour expiry.
 * Creating an export takes an Idempotency-Key (MutationService receipts), is capped in size
 * (413) and rate limited per owner (429). The worker purges expired files through
 * `ExportPurgeModule`.
 */
@Module({
  imports: [StudyModule, BibleContentModule, MutationModule],
  controllers: [ExportsController],
  providers: [ExportsService, { provide: EXPORT_LIMITS, useValue: DEFAULT_EXPORT_LIMITS }],
})
export class ExportsModule {}
