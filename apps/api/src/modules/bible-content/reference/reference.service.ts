import { Inject, Injectable } from '@nestjs/common';
import type { ResolveReferenceResponse } from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import { NotFoundError, ReferenceInvalidError } from '../../../common/errors/domain-errors';
import { DATABASE } from '../../../database/database.module';
import type { Database } from '../../../database/database';
import { BibleBook } from '../../../database/models/bible-book.model';
import { BibleEdition } from '../../../database/models/bible-edition.model';
import { ScriptureReference } from '../../../database/models/scripture-reference.model';
import {
  BookIndex,
  type IndexBook,
  type ReferenceRange,
  resolveParsedReference,
} from './book-index';
import { parseReference } from './parse-reference';

interface ChapterRow {
  bookCode: string;
  chapter: number;
  verseCount: number;
  lastVerse: number;
}

/**
 * Resolves typed Bible references against an active edition's imported corpus (BIB-15) and
 * persists the canonical range as a shared `scripture_reference` row. Exported for later
 * callers (study creation, AI citation checks); it never returns or reads verse text.
 */
@Injectable()
export class ReferenceService {
  /**
   * One book index per ACTIVE edition. Safe to keep for the process lifetime: the database
   * refuses every change to an activated edition's books and verses (BIB-14).
   */
  private readonly indexes = new Map<string, Promise<BookIndex>>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Unknown or not-yet-active edition: 404. Invalid reference: `ReferenceInvalidError` (422). */
  async resolve(editionId: string, input: string): Promise<ResolveReferenceResponse> {
    const index = await this.indexFor(editionId);
    const resolution = resolveParsedReference(index, parseReference(input));
    switch (resolution.outcome) {
      case 'invalid':
        throw new ReferenceInvalidError(resolution.code);
      case 'not_reference':
        return { outcome: 'not_reference' };
      case 'ambiguous':
        return { outcome: 'ambiguous', candidates: resolution.candidates };
      case 'resolved': {
        const id = await this.persist(editionId, resolution.range);
        return {
          outcome: 'resolved',
          reference: { id, editionId, ...resolution.range, label: resolution.label },
        };
      }
    }
  }

  private async indexFor(editionId: string): Promise<BookIndex> {
    const cached = this.indexes.get(editionId);
    if (cached) return cached;
    const active = await BibleEdition.count({
      where: { id: editionId, activatedAt: { [Op.ne]: null } },
    });
    if (active === 0) throw new NotFoundError();
    const loading = this.loadIndex(editionId);
    this.indexes.set(editionId, loading);
    // A failed load (e.g. the database blipped) is not cached; the next request retries.
    loading.catch(() => this.indexes.delete(editionId));
    return loading;
  }

  private async loadIndex(editionId: string): Promise<BookIndex> {
    const books = await BibleBook.findAll({ where: { editionId }, order: [['sequence', 'ASC']] });
    const chapters = await this.db.query<ChapterRow>(
      `SELECT book_code AS "bookCode", chapter, count(*)::int AS "verseCount",
              max(verse)::int AS "lastVerse"
         FROM bible_verse
        WHERE edition_id = $1
        GROUP BY book_code, chapter
        ORDER BY book_code, chapter`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    const verses = new Map<string, number[]>();
    for (const row of chapters) {
      // BIB-14 imports verses contiguous from 1; anything else must not be silently accepted.
      if (row.verseCount !== row.lastVerse) {
        throw new Error('ReferenceService: corpus verses are not contiguous');
      }
      const list = verses.get(row.bookCode) ?? [];
      if (row.chapter !== list.length + 1) {
        throw new Error('ReferenceService: corpus chapters are not contiguous');
      }
      list.push(row.verseCount);
      verses.set(row.bookCode, list);
    }
    const indexBooks: IndexBook[] = books.map((book) => ({
      code: book.code,
      sequence: book.sequence,
      name: book.name,
      abbreviation: book.abbreviation,
      chapterCount: book.chapterCount,
      versesPerChapter: verses.get(book.code) ?? [],
    }));
    return new BookIndex(indexBooks);
  }

  /**
   * Insert-if-absent, then read back: concurrent resolves of the same range converge on the one
   * row the unique constraint allows. The composite FKs re-check both endpoints in the database.
   */
  private async persist(editionId: string, range: ReferenceRange): Promise<string> {
    const where = { editionId, ...range };
    await ScriptureReference.bulkCreate([where], { ignoreDuplicates: true });
    const row = await ScriptureReference.findOne({ where, attributes: ['id'] });
    if (!row) throw new Error('ReferenceService: reference row missing after insert');
    return row.id;
  }
}
