import { Module } from '@nestjs/common';

/**
 * AI bounded context (PRD §26). Owns StudySummary, AISuggestion, AIJob/AIResult, ContextManifest.
 * AI reads read-models and creates suggestions/derived artifacts only; it never updates user
 * conclusions or node statuses. Placeholder module — job infrastructure ships with BIB-39+.
 */
@Module({})
export class AiModule {}
