import { Module } from '@nestjs/common';

/**
 * AI: reads read-models and creates suggestions/derived artifacts only; never updates user
 * conclusions (PRD §26). Owned by Epic 6's tickets.
 */
@Module({})
export class AiModule {}
