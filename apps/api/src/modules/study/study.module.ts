import { Module } from '@nestjs/common';

/**
 * Study bounded context (PRD §26). Owns `study` and `study_node`. Placeholder module — no
 * `/v1/studies` route or service ships in this ticket (see AC/out-of-scope); this ticket only
 * makes the underlying tables and composite-FK invariant exist.
 */
@Module({})
export class StudyModule {}
