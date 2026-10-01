import { Injectable } from '@nestjs/common';
import {
  type BibleChapterLink,
  type BiblePassageQuery,
  type BiblePassageResponse,
  type BibleTranslationsResponse,
} from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import { BibleEdition } from '../../../database/models/bible-edition.model';
import { BibleSuperscription } from '../../../database/models/bible-superscription.model';
import { BibleVerse } from '../../../database/models/bible-verse.model';
import type { BookIndex, IndexBook } from '../reference/book-index';
import { ReferenceService } from '../reference/reference.service';

/**
 * The reader's reads (BIB-17, PRD sections 11, 14, 20, 24). Text comes only from the stored
 * corpus rows and is returned byte for byte: never trimmed, merged, filled, or reconstructed.
 * A chapter that does not exist is refused, never replaced by a nearby one. No transaction, no
 * events, nothing logged. Only opaque IDs arrive in the URL. The only write: the neighboring
 * chapters' shared `scripture_reference` rows are upserted, exactly as `POST /bible/resolve`
 * would, so Previous/Next is one request.
 */
@Injectable()
export class PassageService {
  constructor(private readonly references: ReferenceService) {}

  async translations(): Promise<BibleTranslationsResponse> {
    const editions = await BibleEdition.findAll({
      attributes: ['id'],
      where: { activatedAt: { [Op.ne]: null } },
      order: [
        ['name', 'ASC'],
        ['activatedAt', 'ASC'],
      ],
    });
    const translations = await Promise.all(
      editions.map(async ({ id }) => {
        const { attribution, code, language, index } = await this.references.activeEdition(id);
        return {
          ...attribution,
          code,
          language,
          books: index
            .all()
            .map((b) => ({ code: b.code, name: b.name, chapterCount: b.chapterCount })),
        };
      }),
    );
    return { translations };
  }

  /**
   * The chapter holding the reference's start, with the reference. The reference fixes the
   * edition; a given `editionId` must match it (else 404).
   */
  async passage({ referenceId, editionId }: BiblePassageQuery): Promise<BiblePassageResponse> {
    const { reference, edition } = await this.references.storedReference(referenceId, editionId);
    const { bookCode, startChapter: chapter } = reference;
    const { index, attribution } = edition;
    // A stored reference always names a book and chapter of its edition (composite FKs).
    const book = index.book(bookCode);
    if (!book) throw new Error('PassageService: reference book missing from the book index');

    const where = { editionId: attribution.id, bookCode, chapter };
    const around = neighbors(index, book, chapter);
    const [verses, superscriptions, previous, next] = await Promise.all([
      BibleVerse.findAll({
        where,
        attributes: ['verse', 'text'],
        order: [['verse', 'ASC']],
      }),
      BibleSuperscription.findAll({
        where,
        attributes: ['beforeVerse', 'text'],
        order: [['beforeVerse', 'ASC']],
      }),
      this.link(attribution.id, around.previous),
      this.link(attribution.id, around.next),
    ]);
    // The index's verse counts come from the same immutable rows; a mismatch is corruption.
    if (verses.length !== book.versesPerChapter[chapter - 1]) {
      throw new Error('PassageService: chapter verses disagree with the book index');
    }

    return {
      edition: attribution,
      book: { code: book.code, name: book.name, chapterCount: book.chapterCount },
      chapter,
      verses: verses.map((v) => ({ verse: v.verse, text: v.text })),
      superscriptions: superscriptions.map((s) => ({ beforeVerse: s.beforeVerse, text: s.text })),
      reference,
      previous,
      next,
    };
  }

  /** A neighboring chapter with its whole-chapter reference id, or null at either canon end. */
  private async link(editionId: string, at: ChapterAt | null): Promise<BibleChapterLink | null> {
    if (!at) return null;
    const { id } = await this.references.chapterReference(editionId, at.book.code, at.chapter);
    return { bookCode: at.book.code, bookName: at.book.name, chapter: at.chapter, referenceId: id };
  }
}

interface ChapterAt {
  book: IndexBook;
  chapter: number;
}

/** The chapters before and after this one in canon order, crossing book boundaries. */
function neighbors(
  index: BookIndex,
  book: IndexBook,
  chapter: number,
): { previous: ChapterAt | null; next: ChapterAt | null } {
  const books = index.all();
  const at = books.indexOf(book);
  if (at < 0) throw new Error('PassageService: book missing from the book index');
  const before = books[at - 1];
  const after = books[at + 1];
  const previous =
    chapter > 1
      ? { book, chapter: chapter - 1 }
      : before
        ? { book: before, chapter: before.chapterCount }
        : null;
  const next =
    chapter < book.chapterCount
      ? { book, chapter: chapter + 1 }
      : after
        ? { book: after, chapter: 1 }
        : null;
  return { previous, next };
}
