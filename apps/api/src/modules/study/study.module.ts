import { Module } from '@nestjs/common';
import { StudyAccessService } from './study-access.service';

/**
 * Study bounded context (PRD §26). Owns `study` and `study_node`. No `/v1/studies` route ships
 * yet (BIB-19+). It exports `StudyAccessService`, the owner-scoped lookup every private
 * study-scoped route must use (NFR-SEC-001).
 */
@Module({
  providers: [StudyAccessService],
  exports: [StudyAccessService],
})
export class StudyModule {}
