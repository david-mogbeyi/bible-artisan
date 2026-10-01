import { Module } from '@nestjs/common';

/**
 * Bible content bounded context (PRD §26). Owns `bible_edition`, `bible_book`, `bible_verse`: the
 * immutable WEB corpus, imported by `pnpm corpus:import` (`corpus/`, BIB-14). No routes yet:
 * reference resolution (BIB-15), search (BIB-16), and the reader (BIB-17) add them.
 */
@Module({})
export class BibleContentModule {}
