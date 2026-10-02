import { Module } from '@nestjs/common';
import { AnchorService } from './anchor/anchor.service';
import { BibleController } from './bible.controller';
import { PassageService } from './passage/passage.service';
import { ReferenceService } from './reference/reference.service';
import { SearchService } from './search/search.service';

/**
 * Bible content bounded context (PRD §26). Owns `bible_edition`, `bible_book`, `bible_verse`,
 * `bible_superscription` (the immutable WEB corpus, imported by `pnpm corpus:import`, BIB-14) and
 * `scripture_reference` (canonical ranges, BIB-15). Keyword search (BIB-16) reads the generated
 * `bible_verse.search_vector`. The reader (BIB-17) reads chapters and editions through `PassageService`.
 * Durable verse/phrase anchors (BIB-18) are checked against the stored text by `AnchorService`.
 */
@Module({
  controllers: [BibleController],
  providers: [ReferenceService, SearchService, PassageService, AnchorService],
  // AnchorService: Notes (BIB-24) re-checks the anchors it stores through it, never `bible_verse`.
  exports: [ReferenceService, AnchorService],
})
export class BibleContentModule {}
