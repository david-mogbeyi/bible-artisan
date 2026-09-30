import { Module } from '@nestjs/common';

/**
 * Bible content bounded context (PRD §26). Owns BibleTranslation/BibleBook/BibleVerse. Placeholder
 * module — corpus import and the reader routes are BIB-14+'s scope, not this ticket's.
 */
@Module({})
export class BibleContentModule {}
