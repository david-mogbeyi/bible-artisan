import { Module } from '@nestjs/common';
import { BibleController } from './bible.controller';
import { ReferenceService } from './reference/reference.service';
import { SearchService } from './search/search.service';

/**
 * Bible content bounded context (PRD §26). Owns `bible_edition`, `bible_book`, `bible_verse`,
 * `bible_superscription` (the immutable WEB corpus, imported by `pnpm corpus:import`, BIB-14) and
 * `scripture_reference` (canonical ranges, BIB-15). Keyword search (BIB-16) reads the generated
 * `bible_verse.search_vector`. The reader (BIB-17) adds its routes here.
 */
@Module({
  controllers: [BibleController],
  providers: [ReferenceService, SearchService],
  exports: [ReferenceService],
})
export class BibleContentModule {}
