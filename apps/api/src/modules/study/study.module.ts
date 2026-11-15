import { Module } from '@nestjs/common';
import { AccountStorageService } from './account-storage.service';
import { DEFAULT_SAFETY_LIMITS, SAFETY_LIMITS } from './safety-limits';
import { StudyAccessService } from './study-access.service';
import { StudyGraphService } from './study-graph.service';
import { StudyRevisionService } from './study-revision.service';

/**
 * Study bounded context (PRD §26). Owns `study`, `study_node` and `study_branch`. Since BIB-25 the
 * Graph context creates, edits and lists nodes (`/studies/:id/nodes`); Study still inserts the
 * roots at study creation and BIB-20's new main question. It exports
 * `StudyAccessService`, the owner-scoped lookup every private study-scoped route must use
 * (NFR-SEC-001), and `StudyRevisionService`, the study row lock and transactional counters (event
 * sequence, content revision) used by `MutationService`, and `StudyGraphService`, the node cap
 * and initial-branch rule every node-creating path shares. `AccountStorageService` and
 * `SAFETY_LIMITS` (BIB-52) give the pipeline and the limits route the event and storage caps.
 *
 * Services only: MutationModule imports this module, so study routes that run mutations live in
 * `StudyHttpModule` (`http/`, `/v1/studies`, BIB-19), which imports MutationModule, not here, or
 * Nest would see a circular import.
 */
@Module({
  providers: [
    StudyAccessService,
    StudyRevisionService,
    StudyGraphService,
    AccountStorageService,
    { provide: SAFETY_LIMITS, useValue: DEFAULT_SAFETY_LIMITS },
  ],
  exports: [
    StudyAccessService,
    StudyRevisionService,
    StudyGraphService,
    AccountStorageService,
    SAFETY_LIMITS,
  ],
})
export class StudyModule {}
