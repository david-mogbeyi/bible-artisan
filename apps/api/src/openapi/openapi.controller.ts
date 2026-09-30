import { Controller, Get } from '@nestjs/common';
import { buildOpenApiDocument } from '@bible-artisan/contracts/openapi';

/**
 * Diagnostic route, no authentication (matches /v1/health). Only apps/api imports the
 * `@bible-artisan/contracts/openapi` subpath — apps/web keeps importing the main barrel, which
 * never pulls in the OpenAPI-generation library.
 */
@Controller('openapi.json')
export class OpenapiController {
  @Get()
  get(): ReturnType<typeof buildOpenApiDocument> {
    return buildOpenApiDocument();
  }
}
