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
 * a value the caller keeps (BIB-24 stores it as `Annotation.anchor_json`). Both operations check
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
