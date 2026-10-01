import { Injectable } from '@nestjs/common';
import {
  type BibleChapterLink,
  type BibleEditionAttribution,
  type BiblePassageQuery,
  type BiblePassageResponse,
  type BibleTranslationsResponse,
  httpUrlSchema,
} from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import { BibleEdition } from '../../../database/models/bible-edition.model';
import { BibleSuperscription } from '../../../database/models/bible-superscription.model';
import { BibleVerse } from '../../../database/models/bible-verse.model';
import type { BookIndex } from '../reference/book-index';
import { ReferenceService } from '../reference/reference.service';

/**
 * The reader's reads (BIB-17, PRD sections 11, 14, 20, 24). Text comes only from the stored
 * corpus rows and is returned byte for byte: never trimmed, merged, filled, or reconstructed.
 * A chapter that does not exist is refused, never replaced by a nearby one. Read-only: no
 * transaction, no events, nothing logged. Only opaque IDs arrive in the URL.
 */
@Injectable()
export class PassageService {
  constructor(private readonly references: ReferenceService) {}

  async translations(): Promise<BibleTranslationsResponse> {
    const editions = await BibleEdition.findAll({
      where: { activatedAt: { [Op.ne]: null } },
      order: [
        ['name', 'ASC'],
        ['activatedAt', 'ASC'],
      ],
    });
    const translations = await Promise.all(
      editions.map(async (edition) => {
        const index = await this.references.bookIndex(edition.id);
        return {
          ...attribution(edition),
          code: edition.code,
          language: edition.language,
          books: index
            .all()
            .map((b) => ({ code: b.code, name: b.name, chapterCount: b.chapterCount })),
        };
      }),
    );
    return { translations };
  }

  /** The chapter holding the reference's start, with the reference. */
  async passage({ editionId, referenceId }: BiblePassageQuery): Promise<BiblePassageResponse> {
    const index = await this.references.bookIndex(editionId); // unknown or inactive: 404
    const reference = await this.references.findReference(editionId, referenceId); // else 404
    const { bookCode, startChapter: chapter } = reference;
    // A stored reference always names a book and chapter of its edition (composite FKs).
    const book = index.book(bookCode);
    if (!book) throw new Error('PassageService: reference book missing from the book index');

    const where = { editionId, bookCode, chapter };
    const [edition, verses, superscriptions] = await Promise.all([
      BibleEdition.findByPk(editionId, { rejectOnEmpty: true }),
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
    ]);
    // The index's verse counts come from the same immutable rows; a mismatch is corruption.
    if (verses.length !== book.versesPerChapter[chapter - 1]) {
      throw new Error('PassageService: chapter verses disagree with the book index');
    }

    return {
      edition: attribution(edition),
      book: { code: book.code, name: book.name, chapterCount: book.chapterCount },
      chapter,
      verses: verses.map((v) => ({ verse: v.verse, text: v.text })),
      superscriptions: superscriptions.map((s) => ({ beforeVerse: s.beforeVerse, text: s.text })),
      reference,
      ...neighbors(index, bookCode, chapter),
    };
  }
}

function attribution(edition: BibleEdition): BibleEditionAttribution {
  const notice = httpUrlSchema.safeParse(edition.rightsRecord.publisherNoticeUrl);
  return {
    id: edition.id,
    name: edition.name,
    abbreviation: edition.abbreviation,
    attribution: edition.attribution,
    noticeUrl: notice.success ? notice.data : null,
  };
}

/** The chapters before and after this one in canon order, crossing book boundaries. */
function neighbors(
  index: BookIndex,
  bookCode: string,
  chapter: number,
): { previous: BibleChapterLink | null; next: BibleChapterLink | null } {
  const books = index.all();
  const at = books.findIndex((b) => b.code === bookCode);
  const book = books[at];
  if (!book) throw new Error('PassageService: book missing from the book index');
  const link = (b: (typeof books)[number], c: number): BibleChapterLink => ({
    bookCode: b.code,
    bookName: b.name,
    chapter: c,
  });
  const before = books[at - 1];
  const after = books[at + 1];
  const previous =
    chapter > 1 ? link(book, chapter - 1) : before ? link(before, before.chapterCount) : null;
  const next =
    chapter < book.chapterCount ? link(book, chapter + 1) : after ? link(after, 1) : null;
  return { previous, next };
}
