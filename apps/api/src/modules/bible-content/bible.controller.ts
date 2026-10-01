import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import {
  anchorSelectionSchema,
  biblePassageQuerySchema,
  type BiblePassageResponse,
  bibleReferenceRequestSchema,
  type BibleReferenceResponse,
  type BibleTranslationsResponse,
  type CaptureAnchorResponse,
  resolveAnchorRequestSchema,
  type ResolveAnchorResponse,
  resolveReferenceRequestSchema,
  type ResolveReferenceResponse,
  searchBibleQuerySchema,
  type SearchBibleResponse,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
import { AnchorService } from './anchor/anchor.service';
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
    private readonly anchors: AnchorService,
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
   * Build a durable anchor from a reader selection (BIB-18, FR-BIBLE-006): checked against the
   * stored text, never adjusted (422 `ANCHOR_*`). The selection and quote travel only in the body,
   * which is never logged. Read + idempotent shared reference upsert, so 200.
   */
  @Post('anchors')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async captureAnchor(@Body() body: unknown): Promise<CaptureAnchorResponse> {
    return this.anchors.capture(parseBody(anchorSelectionSchema, body));
  }

  /** Re-check a stored anchor (BIB-18): resolved, or unresolved with a reason; never repaired. */
  @Post('anchors/resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resolveAnchor(@Body() body: unknown): Promise<ResolveAnchorResponse> {
    return this.anchors.resolve(parseBody(resolveAnchorRequestSchema, body).anchor);
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
