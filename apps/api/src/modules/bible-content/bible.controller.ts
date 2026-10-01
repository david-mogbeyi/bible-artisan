import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import {
  biblePassageQuerySchema,
  type BiblePassageResponse,
  bibleReferenceRequestSchema,
  type BibleReferenceResponse,
  type BibleTranslationsResponse,
  resolveReferenceRequestSchema,
  type ResolveReferenceResponse,
  searchBibleQuerySchema,
  type SearchBibleResponse,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
import { PassageService } from './passage/passage.service';
import { ReferenceService } from './reference/reference.service';
import { SearchService } from './search/search.service';

/**
 * Bible content routes (PRD §24). Authenticated by the global SessionGuard; the corpus and
 * references are shared data, so nothing here is owner-scoped.
 */
@Controller('bible')
export class BibleController {
  constructor(
    private readonly references: ReferenceService,
    private readonly searchService: SearchService,
    private readonly passages: PassageService,
  ) {}

  /** Active editions with attribution and books, for the reader's selectors (BIB-17). */
  @Get('translations')
  @Header('Cache-Control', 'no-store')
  async translations(): Promise<BibleTranslationsResponse> {
    return this.passages.translations();
  }

  /**
   * The chapter holding a resolved reference, verbatim from the corpus (BIB-17, FR-BIBLE-009).
   * The reference fixes the edition. Only opaque IDs travel in the URL; the access line records
   * only the route pattern.
   */
  @Get('passages')
  @Header('Cache-Control', 'no-store')
  async passage(@Query() query: unknown): Promise<BiblePassageResponse> {
    return this.passages.passage(parseBody(biblePassageQuerySchema, query));
  }

  /** Resolve a typed reference (FR-BIBLE-001..003). Read + idempotent upsert, so 200. */
  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resolve(@Body() body: unknown): Promise<ResolveReferenceResponse> {
    const { input, editionId } = parseBody(resolveReferenceRequestSchema, body);
    return this.references.resolve(editionId, input);
  }

  /**
   * The shared reference for a chapter or verse chosen by structure (BIB-17): book code and
   * numbers in the body (never logged), validated against the corpus, no text parsing. Read +
   * idempotent upsert, so 200.
   */
  @Post('references')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reference(@Body() body: unknown): Promise<BibleReferenceResponse> {
    const { editionId, bookCode, chapter, verse } = parseBody(bibleReferenceRequestSchema, body);
    return {
      reference: await this.references.chapterReference(editionId, bookCode, chapter, verse),
    };
  }

  /**
   * Search verse text by all terms or a verified phrase (FR-BIBLE-004/005). Read-only. The query
   * string travels in the URL (PRD §24), so it is never logged: the access line records only the
   * route pattern.
   */
  @Get('search')
  @Header('Cache-Control', 'no-store')
  async search(@Query() query: unknown): Promise<SearchBibleResponse> {
    return this.searchService.search(parseBody(searchBibleQuerySchema, query));
  }
}
