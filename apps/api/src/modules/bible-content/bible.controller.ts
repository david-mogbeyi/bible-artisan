import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
  resolveReferenceRequestSchema,
  type ResolveReferenceResponse,
} from '@bible-artisan/contracts';
import { parseBody } from '../../common/validation/parse-body';
import { ReferenceService } from './reference/reference.service';

/**
 * Bible content routes (PRD §24). Authenticated by the global SessionGuard; the corpus and
 * references are shared data, so nothing here is owner-scoped.
 */
@Controller('bible')
export class BibleController {
  constructor(private readonly references: ReferenceService) {}

  /** Resolve a typed reference (FR-BIBLE-001..003). Read + idempotent upsert, so 200. */
  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resolve(@Body() body: unknown): Promise<ResolveReferenceResponse> {
    const { input, editionId } = parseBody(resolveReferenceRequestSchema, body);
    return this.references.resolve(editionId, input);
  }
}
