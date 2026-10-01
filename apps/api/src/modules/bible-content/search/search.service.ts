import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  type SearchBibleQuery,
  type SearchBibleResponse,
  type SearchResult,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import { SearchQueryIsReferenceError, ValidationError } from '../../../common/errors/domain-errors';
import { DATABASE } from '../../../database/database.module';
import type { Database } from '../../../database/database';
import { ReferenceService } from '../reference/reference.service';
import { type CursorPosition, decodeCursor, encodeCursor, queryFingerprint } from './search-cursor';
import { matchVerse, parseSearchQuery, toCodePointRanges } from './search-text';

/** Most candidate verses one request examines; a page may end early with a cursor to continue. */
export const MAX_SCANNED_CANDIDATES = 1000;

interface CandidateRow extends CursorPosition {
  bookCode: string;
  text: string;
}

/**
 * Candidates in result order: `ts_rank` descending, then canonical order (book sequence, chapter,
 * verse), strictly after the cursor position when one is given. The query string reaches SQL only
 * as already-normalized word tokens, as a bind parameter, through `plainto_tsquery`, which reads
 * plain text and never operator syntax. `search_vector` is the generated `simple` vector; its GIN
 * index serves `@@`. The rank (a float4) is computed once per row (inner query) and returned as
 * float8 text, which keeps 15 + `extra_float_digits` significant digits (17 at the default); a
 * float4 needs 9, so `$4::real` reads back the same float4 unless that setting is below -6, and
 * the keyset never skips or repeats a row. (Float4 text would round at `extra_float_digits` 0.)
 */
export const CANDIDATES_SQL = `
  SELECT c."bookCode", c.chapter, c.verse, c.text, c.sequence, c.rank::float8::text AS rank
    FROM (
      SELECT v.book_code AS "bookCode", v.chapter, v.verse, v.text, b.sequence,
             ts_rank(v.search_vector, q.query) AS rank
        FROM bible_verse v
        JOIN bible_book b ON b.edition_id = v.edition_id AND b.code = v.book_code
       CROSS JOIN plainto_tsquery('simple'::regconfig, $2) AS q(query)
       WHERE v.edition_id = $1
         AND v.search_vector @@ q.query
         AND ($3::text IS NULL OR v.book_code = $3::text)
    ) c
   WHERE $4::real IS NULL
      OR (c.rank, -c.sequence, -c.chapter, -c.verse) < ($4::real, -($5::int), -($6::int), -($7::int))
   ORDER BY c.rank DESC, c.sequence, c.chapter, c.verse
   LIMIT $8`;

/**
 * Keyword search over the active edition's verse text (BIB-16, FR-BIBLE-004/005). PostgreSQL
 * narrows the candidates; `matchVerse` decides every result against the stored text, so a
 * candidate the index admits but the text does not support is dropped, never shown. Read-only:
 * no transaction, no events, nothing persisted, nothing logged.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly references: ReferenceService,
  ) {}

  async search(params: SearchBibleQuery): Promise<SearchBibleResponse> {
    const { q, mode, editionId, book, cursor } = params;
    const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;

    const index = await this.references.bookIndex(editionId); // unknown or inactive: 404
    if (book !== undefined && !index.book(book)) {
      throw new ValidationError('Invalid request', {
        book: ['No book in this translation has that code'],
      });
    }
    if (mode === 'terms' && (await this.references.isReference(editionId, q))) {
      throw new SearchQueryIsReferenceError();
    }
    const query = parseSearchQuery(q, mode);
    if (query === 'no_words') {
      throw new ValidationError('Invalid request', { q: ['Enter at least one word'] });
    }
    if (query === 'too_many_words') {
      throw new ValidationError('Invalid request', {
        q: [`Enter at most ${MAX_SEARCH_TOKENS} words`],
      });
    }

    const fingerprint = queryFingerprint(query, editionId, book);
    let after: CursorPosition | null = null;
    if (cursor !== undefined) {
      after = decodeCursor(cursor, fingerprint);
      if (!after) throw new ValidationError('Invalid request', { cursor: ['Invalid cursor'] });
    }

    const results: SearchResult[] = [];
    let scanned = 0;
    let remaining = false;
    let last: CursorPosition | null = null;
    scan: for (;;) {
      // At most three round trips: `limit + 1` candidates (enough when most verify, as in terms
      // mode), then the rest of the bounded scan at once (phrases the index cannot narrow), then
      // one row to learn whether anything remains. Each fetch takes one row beyond what this
      // request may still use, so `remaining` is exact.
      const full = results.length === limit || scanned === MAX_SCANNED_CANDIDATES;
      const size = full ? 1 : scanned === 0 ? limit + 1 : MAX_SCANNED_CANDIDATES - scanned + 1;
      const rows = await this.candidates(editionId, query.tokens.join(' '), book, after, size);
      for (const row of rows) {
        if (results.length === limit || scanned === MAX_SCANNED_CANDIDATES) {
          remaining = true;
          break scan;
        }
        scanned += 1;
        last = { rank: row.rank, sequence: row.sequence, chapter: row.chapter, verse: row.verse };
        const ranges = matchVerse(query, row.text);
        if (!ranges) continue;
        const name = index.book(row.bookCode)?.name;
        if (!name) throw new Error('SearchService: candidate book missing from the book index');
        results.push({
          reference: {
            bookCode: row.bookCode,
            chapter: row.chapter,
            verse: row.verse,
            label: `${name} ${row.chapter}:${row.verse}`,
          },
          text: row.text,
          highlights: toCodePointRanges(row.text, ranges),
        });
      }
      if (rows.length < size) break;
      after = last;
    }

    return {
      results,
      nextCursor: remaining && last ? encodeCursor(fingerprint, last) : null,
    };
  }

  private candidates(
    editionId: string,
    tokens: string,
    book: string | undefined,
    after: CursorPosition | null,
    size: number,
  ): Promise<CandidateRow[]> {
    return this.db.query<CandidateRow>(CANDIDATES_SQL, {
      bind: [
        editionId,
        tokens,
        book ?? null,
        after?.rank ?? null,
        after?.sequence ?? null,
        after?.chapter ?? null,
        after?.verse ?? null,
        size,
      ],
      type: QueryTypes.SELECT,
    });
  }
}
