import { Inject, Injectable } from '@nestjs/common';
import {
  type BibleEditionAttribution,
  httpUrlSchema,
  type ResolveReferenceResponse,
  type ScriptureReference as ScriptureReferenceDto,
  type SearchReferenceSuggestion,
} from '@bible-artisan/contracts';
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
  type Resolution,
  resolveParsedReference,
} from './book-index';
import { parseReference } from './parse-reference';

/** A book-only input's resolution: the book's first chapter, or the books it could mean. */
export type BookOnlyResolution = Extract<Resolution, { outcome: 'resolved' | 'ambiguous' }>;

/**
 * How a terms search treats its input (PRD section 14, BIB-16):
 * - `keywords`: not a reference; search it.
 * - `book`: only a book name, abbreviation or code; search it, and suggest the book.
 * - `reference`: a reference with a chapter or verse, or an invalid reference; refuse (422).
 */
export type SearchPrecedence =
  { kind: 'keywords' } | { kind: 'book'; resolution: BookOnlyResolution } | { kind: 'reference' };

/**
 * An active edition as the reader needs it: its attribution and its book index. Cached for the
 * process lifetime: the database refuses every change to an activated edition row, its books and
 * its verses (BIB-14).
 */
export interface ActiveEdition {
  attribution: BibleEditionAttribution;
  code: string;
  language: string;
  index: BookIndex;
}

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
   * One entry per ACTIVE edition. Safe to keep for the process lifetime: the database refuses
   * every change to an activated edition row, its books and its verses (BIB-14).
   */
  private readonly editions = new Map<string, Promise<ActiveEdition>>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Unknown or not-yet-active edition: 404. Invalid reference: `ReferenceInvalidError` (422). */
  async resolve(editionId: string, input: string): Promise<ResolveReferenceResponse> {
    const { index } = await this.activeEdition(editionId);
    const resolution = resolveParsedReference(index, parseReference(input));
    switch (resolution.outcome) {
      case 'invalid':
        throw new ReferenceInvalidError(resolution.code);
      case 'not_reference':
        return { outcome: 'not_reference' };
      case 'ambiguous':
      case 'resolved':
        return this.outcome(editionId, resolution);
    }
  }

  /**
   * A stored reference with its active edition (whose attribution and index come from the cache,
   * so the caller needs no second edition lookup). The reference fixes the edition; a given
   * `editionId` must be that edition. Unknown id, another edition, or an inactive edition: the
   * same 404.
   */
  async storedReference(
    referenceId: string,
    editionId?: string,
  ): Promise<{ reference: ScriptureReferenceDto; edition: ActiveEdition }> {
    const row = await ScriptureReference.findByPk(referenceId);
    if (!row || (editionId !== undefined && row.editionId !== editionId)) throw new NotFoundError();
    const edition = await this.activeEdition(row.editionId);
    const range: ReferenceRange = {
      bookCode: row.bookCode,
      startChapter: row.startChapter,
      startVerse: row.startVerse,
      endChapter: row.endChapter,
      endVerse: row.endVerse,
    };
    return {
      reference: {
        id: row.id,
        editionId: row.editionId,
        ...range,
        label: edition.index.label(range),
      },
      edition,
    };
  }

  /**
   * The shared reference for a whole chapter, or one verse of it, chosen by structure (no text
   * parsing): validated against the corpus and persisted exactly as `resolve` persists the same
   * range, so both give the same id. Unknown or inactive edition: 404. A book, chapter or verse
   * the edition lacks: `ReferenceInvalidError` (422), never the nearest one that exists.
   */
  async chapterReference(
    editionId: string,
    bookCode: string,
    chapter: number,
    verse?: number,
  ): Promise<ScriptureReferenceDto> {
    const { index } = await this.activeEdition(editionId);
    const result = index.chapterRange(bookCode, chapter, verse);
    if (result.outcome === 'invalid') throw new ReferenceInvalidError(result.code);
    const id = await this.persist(editionId, result.range);
    return { id, editionId, ...result.range, label: result.label };
  }

  /** The active edition's book index (cached). Unknown or not-yet-active edition: 404. */
  async bookIndex(editionId: string): Promise<BookIndex> {
    return (await this.activeEdition(editionId)).index;
  }

  /**
   * How a terms search treats the input (PRD §14: reference lookup takes precedence over
   * keywords; product decision for BIB-16: book-only input is searched and suggested, not
   * refused). Uses the same parse and resolution as `resolve`. Read-only: nothing is persisted.
   * Unknown or not-yet-active edition: 404.
   */
  async searchPrecedence(editionId: string, input: string): Promise<SearchPrecedence> {
    const { index } = await this.activeEdition(editionId);
    const parsed = parseReference(input);
    const resolution = resolveParsedReference(index, parsed);
    if (resolution.outcome === 'not_reference') return { kind: 'keywords' };
    const bookOnly = parsed.kind === 'reference' && parsed.spec.form === 'book';
    // A book-only reference always names a valid range (the first chapter); `invalid` here would
    // be a resolver change, and is refused rather than searched.
    if (bookOnly && resolution.outcome !== 'invalid') return { kind: 'book', resolution };
    return { kind: 'reference' };
  }

  /**
   * The suggestion for a book-only search input: exactly what `resolve` answers for it. Only a
   * resolved book persists its shared `scripture_reference` row (an idempotent upsert, as in
   * `resolve`); an ambiguous one writes nothing.
   */
  suggestion(
    editionId: string,
    resolution: BookOnlyResolution,
  ): Promise<SearchReferenceSuggestion> {
    return this.outcome(editionId, resolution);
  }

  private async outcome(
    editionId: string,
    resolution: BookOnlyResolution,
  ): Promise<SearchReferenceSuggestion> {
    if (resolution.outcome === 'ambiguous') {
      return { outcome: 'ambiguous', candidates: resolution.candidates };
    }
    const id = await this.persist(editionId, resolution.range);
    return {
      outcome: 'resolved',
      reference: { id, editionId, ...resolution.range, label: resolution.label },
    };
  }

  /**
   * The active edition (cached). Unknown or not-yet-active edition: 404.
   *
   * Single flight: the first caller stores one promise covering the active-edition read and the
   * corpus load, and every concurrent caller awaits that same promise, so the full-corpus
   * aggregation runs once. A rejection (unknown or inactive edition, a database blip) is evicted,
   * so a later call retries.
   */
  activeEdition(editionId: string): Promise<ActiveEdition> {
    const cached = this.editions.get(editionId);
    if (cached) return cached;
    const loading = this.loadActiveEdition(editionId);
    this.editions.set(editionId, loading);
    loading.catch(() => {
      if (this.editions.get(editionId) === loading) this.editions.delete(editionId);
    });
    return loading;
  }

  private async loadActiveEdition(editionId: string): Promise<ActiveEdition> {
    const edition = await BibleEdition.findOne({
      where: { id: editionId, activatedAt: { [Op.ne]: null } },
    });
    if (!edition) throw new NotFoundError();
    const notice = httpUrlSchema.safeParse(edition.rightsRecord.publisherNoticeUrl);
    return {
      attribution: {
        id: edition.id,
        name: edition.name,
        abbreviation: edition.abbreviation,
        attribution: edition.attribution,
        noticeUrl: notice.success ? notice.data : null,
      },
      code: edition.code,
      language: edition.language,
      index: await this.loadIndex(editionId),
    };
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
