import { Module } from '@nestjs/common';

/**
 * Thread: StudyEvent recording. Graph and Notes call this module's service inside their own
 * mutation transaction (AGENTS.md). Owned by Epic 4's tickets.
 */
@Module({})
export class ThreadModule {}
