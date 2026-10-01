import { Module } from '@nestjs/common';
import { StudyAccessService } from './study-access.service';
import { StudyRevisionService } from './study-revision.service';

/**
 * Study bounded context (PRD §26). Owns `study` and `study_node`. No `/v1/studies` route ships
 * yet (BIB-19+). It exports `StudyAccessService`, the owner-scoped lookup every private
 * study-scoped route must use (NFR-SEC-001), and `StudyRevisionService`, the study row lock and
 * transactional counters (event sequence, content revision) used by `MutationService`.
 *
 * Services only: MutationModule imports this module, so study routes that run mutations go in a
 * module that imports MutationModule (e.g. a `StudyHttpModule`), not here, or Nest would see a
 * circular import.
 */
@Module({
  providers: [StudyAccessService, StudyRevisionService],
  exports: [StudyAccessService, StudyRevisionService],
})
export class StudyModule {}
