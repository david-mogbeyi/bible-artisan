import { Inject, Injectable } from '@nestjs/common';
import type { ResolveReferenceResponse } from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import { NotFoundError, ReferenceInvalidError } from '../../../common/errors/domain-errors';
import { DATABASE } from '../../../database/database.module';
import type { Database } from '../../../database/database';
import { BibleBook } from '../../../database/models/bible-book.model';
import { BibleEdition } from '../../../database/models/bible-edition.model';
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

  /**
   * Single flight: the first caller stores one promise covering the active-edition check and the
   * corpus load, and every concurrent caller awaits that same promise, so the full-corpus
   * aggregation runs once. A rejection (unknown or inactive edition, a database blip) is evicted,
   * so a later call retries.
   */
  private indexFor(editionId: string): Promise<BookIndex> {
    const cached = this.indexes.get(editionId);
    if (cached) return cached;
    const loading = this.loadActiveIndex(editionId);
    this.indexes.set(editionId, loading);
    loading.catch(() => {
      if (this.indexes.get(editionId) === loading) this.indexes.delete(editionId);
    });
    return loading;
  }

  private async loadActiveIndex(editionId: string): Promise<BookIndex> {
    const active = await BibleEdition.count({
      where: { id: editionId, activatedAt: { [Op.ne]: null } },
    });
    if (active === 0) throw new NotFoundError();
    return this.loadIndex(editionId);
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
   * Insert-or-select in one statement: the CTE inserts the range if absent and returns the new id;
   * otherwise the UNION reads the existing row. Under a race, ON CONFLICT waits for the other
   * transaction, but this statement's snapshot predates that row, so it can return nothing; only
   * then does a second, fresh-snapshot SELECT read the winner's id. The composite FKs re-check both
   * endpoints in the database.
   */
  private async persist(editionId: string, range: ReferenceRange): Promise<string> {
    const bind = [
      editionId,
      range.bookCode,
      range.startChapter,
      range.startVerse,
      range.endChapter,
      range.endVerse,
    ];
    const match = `edition_id = $1 AND book_code = $2 AND start_chapter = $3 AND start_verse = $4
       AND end_chapter = $5 AND end_verse = $6`;
    const [row] = await this.db.query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO scripture_reference
           (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT scripture_reference_range_key DO NOTHING
         RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM scripture_reference WHERE ${match}
       LIMIT 1`,
      { bind, type: QueryTypes.SELECT },
    );
    if (row) return row.id;
    const [winner] = await this.db.query<{ id: string }>(
      `SELECT id FROM scripture_reference WHERE ${match}`,
      { bind, type: QueryTypes.SELECT },
    );
    if (!winner) throw new Error('ReferenceService: reference row missing after insert');
    return winner.id;
  }
}
