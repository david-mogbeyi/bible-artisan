import { Module } from '@nestjs/common';

/**
 * Study: the `study`, `study_node`, and `study_event` tables (PRD §23). No service exists
 * yet — BIB-10/BIB-11/BIB-12 add the session, owner-scoping, and revision/idempotency
 * utilities this module's future services depend on before any route is exposed.
 */
@Module({})
export class StudyModule {}
