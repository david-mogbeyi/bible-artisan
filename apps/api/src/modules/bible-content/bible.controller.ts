import { Body, Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import {
  resolveReferenceRequestSchema,
  type ResolveReferenceResponse,
  searchBibleQuerySchema,
  type SearchBibleResponse,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
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
  ) {}

  /** Resolve a typed reference (FR-BIBLE-001..003). Read + idempotent upsert, so 200. */
  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resolve(@Body() body: unknown): Promise<ResolveReferenceResponse> {
    const { input, editionId } = parseBody(resolveReferenceRequestSchema, body);
    return this.references.resolve(editionId, input);
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
