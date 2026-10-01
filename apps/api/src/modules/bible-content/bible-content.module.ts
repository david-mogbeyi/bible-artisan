import { Module } from '@nestjs/common';
import { BibleController } from './bible.controller';
import { ReferenceService } from './reference/reference.service';

/**
 * Bible content bounded context (PRD §26). Owns `bible_edition`, `bible_book`, `bible_verse`,
 * `bible_superscription` (the immutable WEB corpus, imported by `pnpm corpus:import`, BIB-14) and
 * `scripture_reference` (canonical ranges, BIB-15). Search (BIB-16) and the reader (BIB-17) add
 * their routes here.
 */
@Module({
  controllers: [BibleController],
  providers: [ReferenceService],
  exports: [ReferenceService],
})
export class BibleContentModule {}
