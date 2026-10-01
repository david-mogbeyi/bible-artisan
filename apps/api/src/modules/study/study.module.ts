import { Module } from '@nestjs/common';
import { StudyAccessService } from './study-access.service';
import { StudyRevisionService } from './study-revision.service';

/**
 * Study bounded context (PRD §26). Owns `study` and `study_node`. No `/v1/studies` route ships
 * yet (BIB-19+). It exports `StudyAccessService`, the owner-scoped lookup every private
 * study-scoped route must use (NFR-SEC-001), and `StudyRevisionService`, the study row's
 * transactional counters (event sequence, content revision).
 */
@Module({
  providers: [StudyAccessService, StudyRevisionService],
  exports: [StudyAccessService, StudyRevisionService],
})
export class StudyModule {}
