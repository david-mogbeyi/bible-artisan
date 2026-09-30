import { Module } from '@nestjs/common';

/**
 * Thread bounded context (PRD §26). Owns `study_event` and the transactional per-study sequence
 * allocator that Graph/Notes call inside their own mutation transactions. Placeholder module — the
 * allocator and idempotency utilities ship with BIB-12.
 */
@Module({})
export class ThreadModule {}
