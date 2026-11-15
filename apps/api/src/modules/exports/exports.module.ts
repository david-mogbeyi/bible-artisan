import { Module } from '@nestjs/common';
import { BibleContentModule } from '../bible-content/bible-content.module';
import { StudyModule } from '../study/study.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Exports bounded context (PRD §26; BIB-47, BIB-48). Owns `export_file`: study and account
 * exports (JSON and Markdown), their signed 15-minute download links and their 24-hour expiry.
 * The worker purges expired files through `ExportPurgeModule`.
 */
@Module({
  imports: [StudyModule, BibleContentModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
