import { Inject, Injectable } from '@nestjs/common';
import type {
  AnchorProblemCode,
  AnchorSelection,
  CaptureAnchorResponse,
  ResolveAnchorResponse,
  ScriptureAnchor,
  ScriptureReference,
} from '@bible-artisan/contracts';
import { QueryTypes } from 'sequelize';
import { AnchorInvalidError, NotFoundError } from '../../../common/errors/domain-errors';
import { DATABASE } from '../../../database/database.module';
import type { Database } from '../../../database/database';
import type { BookIndex, ReferenceRange } from '../reference/book-index';
import { ReferenceService } from '../reference/reference.service';
import {
  type AnchorInput,
  type AnchorSegmentInput,
  checkCoordinates,
  checkText,
  type StoredVerse,
} from './anchor-check';

/**
 * Durable Scripture anchors (BIB-18, PRD sections 14, 23; FR-BIBLE-006). Stateless: an anchor is
 * a value the caller keeps (BIB-24 stores it as `Annotation.anchor_json` and on notes, and calls
 * `resolve` before writing one and `checkStored` when reading them back). Both operations check
 * the anchor against the immutable corpus and never adjust it. The only write is the idempotent
 * upsert of the shared `scripture_reference` row for the anchor's verses, exactly as
 * `POST /bible/resolve` writes one. Nothing is logged; no transaction is needed.
 */
@Injectable()
export class AnchorService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly references: ReferenceService,
  ) {}

  /**
   * Builds an anchor from a reader selection: the stored checksums are added, nothing else
   * changes. Unknown or inactive edition: 404. Any rule broken: `AnchorInvalidError` (422).
   */
  async capture(selection: AnchorSelection): Promise<CaptureAnchorResponse> {
    const { index } = await this.references.activeEdition(selection.editionId);
    const result = await this.check(index, selection.editionId, selection.bookCode, selection);
    if (result.problem) throw new AnchorInvalidError(result.problem);
    const anchor: ScriptureAnchor = {
      version: 1,
      editionId: selection.editionId,
      bookCode: selection.bookCode,
      kind: selection.kind,
      segments: selection.segments.map((s, i) => {
        const stored = result.verses[i];
        if (!stored) throw new Error('AnchorService: a checked segment has no stored verse');
        return { ...s, textSha256: stored.textSha256 };
      }),
      quote: selection.quote,
    };
    const reference = await this.references.rangeReference(
      selection.editionId,
      rangeOf(anchor.bookCode, anchor.segments),
    );
    return { anchor, reference };
  }

  /**
   * Re-checks a stored anchor, checksums included. Resolved: the anchor unchanged. Otherwise
   * unresolved with the first failing rule and the anchor exactly as sent, plus the reference for
   * its verses when they still exist in an active edition (so the reader can reopen them).
   */
  async resolve(anchor: ScriptureAnchor): Promise<ResolveAnchorResponse> {
    let index: BookIndex;
    try {
      ({ index } = await this.references.activeEdition(anchor.editionId));
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return unresolved('ANCHOR_EDITION_UNAVAILABLE', anchor, null);
    }
    const { problem, verses } = await this.check(index, anchor.editionId, anchor.bookCode, anchor);
    // The verses exist and are consecutive whenever the text was read (coordinates held).
    const reference =
      verses.length > 0
        ? await this.references.rangeReference(
            anchor.editionId,
            rangeOf(anchor.bookCode, anchor.segments),
          )
        : null;
    if (problem) return unresolved(problem, anchor, reference);
    if (!reference) throw new Error('AnchorService: a resolved anchor has a reference');
    return { outcome: 'resolved', anchor, reference };
  }

  /**
   * Re-checks many stored anchors at once (BIB-24: a chapter's highlights, a note list's Scripture
   * targets), with exactly the rules of `resolve` but without minting references (the caller
   * stored each anchor's reference id when it was saved). Returns each anchor's first failing rule,
   * or null while it still matches, in input order. Editions come from the cached index; the
   * verses of every anchor whose coordinates hold are read in ONE query (a primary-key range join
   * per anchor), so a list costs one statement, not one per item.
   */
  async checkStored(anchors: readonly ScriptureAnchor[]): Promise<(AnchorProblemCode | null)[]> {
    const problems: (AnchorProblemCode | null)[] = anchors.map(() => null);
    const pending: { index: number; anchor: ScriptureAnchor; range: ReferenceRange }[] = [];
    const indexes = new Map<string, BookIndex | null>();
    for (const [index, anchor] of anchors.entries()) {
      if (!indexes.has(anchor.editionId)) {
        try {
          indexes.set(
            anchor.editionId,
            (await this.references.activeEdition(anchor.editionId)).index,
          );
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          indexes.set(anchor.editionId, null);
        }
      }
      const bookIndex = indexes.get(anchor.editionId);
      if (!bookIndex) {
        problems[index] = 'ANCHOR_EDITION_UNAVAILABLE';
        continue;
      }
      const coordinates = checkCoordinates(bookIndex.book(anchor.bookCode), anchor.segments);
      if (coordinates) {
        problems[index] = coordinates;
        continue;
      }
      pending.push({ index, anchor, range: rangeOf(anchor.bookCode, anchor.segments) });
    }
    if (pending.length === 0) return problems;

    const rows = await this.db.query<StoredVerse & { item: string }>(
      `SELECT r.item, v.chapter, v.verse, v.text, v.text_sha256 AS "textSha256"
         FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[], $5::int[], $6::int[])
              WITH ORDINALITY AS r(edition_id, book_code, sc, sv, ec, ev, item)
         JOIN bible_verse v
           ON v.edition_id = r.edition_id AND v.book_code = r.book_code
          AND (v.chapter, v.verse) >= (r.sc, r.sv) AND (v.chapter, v.verse) <= (r.ec, r.ev)
        ORDER BY r.item, v.chapter, v.verse`,
      {
        bind: [
          pending.map((p) => p.anchor.editionId),
          pending.map((p) => p.range.bookCode),
          pending.map((p) => p.range.startChapter),
          pending.map((p) => p.range.startVerse),
          pending.map((p) => p.range.endChapter),
          pending.map((p) => p.range.endVerse),
        ],
        type: QueryTypes.SELECT,
      },
    );
    const versesOf = new Map<number, StoredVerse[]>();
    for (const { item, ...verse } of rows) {
      // ORDINALITY is 1-based and comes back from pg as a bigint string.
      const position = Number(item) - 1;
      const list = versesOf.get(position) ?? [];
      list.push(verse);
      versesOf.set(position, list);
    }
    for (const [position, { index, anchor }] of pending.entries()) {
      problems[index] = checkText(anchor, versesOf.get(position) ?? []);
    }
    return problems;
  }

  /**
   * Coordinates first (from the cached book index, no query), then the text: the anchor's verses
   * are read in one indexed range scan over the primary key.
   */
  private async check(
    index: BookIndex,
    editionId: string,
    bookCode: string,
    anchor: AnchorInput,
  ): Promise<{ problem: AnchorProblemCode | null; verses: StoredVerse[] }> {
    const coordinates = checkCoordinates(index.book(bookCode), anchor.segments);
    if (coordinates) return { problem: coordinates, verses: [] };
    const { startChapter, startVerse, endChapter, endVerse } = rangeOf(bookCode, anchor.segments);
    const verses = await this.db.query<StoredVerse>(
      `SELECT chapter, verse, text, text_sha256 AS "textSha256"
         FROM bible_verse
        WHERE edition_id = $1 AND book_code = $2
          AND (chapter, verse) >= ($3, $4) AND (chapter, verse) <= ($5, $6)
        ORDER BY chapter, verse`,
      {
        bind: [editionId, bookCode, startChapter, startVerse, endChapter, endVerse],
        type: QueryTypes.SELECT,
      },
    );
    return { problem: checkText(anchor, verses), verses };
  }
}

function unresolved(
  reason: AnchorProblemCode,
  anchor: ScriptureAnchor,
  reference: ScriptureReference | null,
): ResolveAnchorResponse {
  return { outcome: 'unresolved', reason, anchor, reference };
}

/** The verse range from the first segment to the last (segments are already in canon order). */
function rangeOf(bookCode: string, segments: readonly AnchorSegmentInput[]): ReferenceRange {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) throw new Error('AnchorService: an anchor has at least one segment');
  return {
    bookCode,
    startChapter: first.chapter,
    startVerse: first.verse,
    endChapter: last.chapter,
    endVerse: last.verse,
  };
}
