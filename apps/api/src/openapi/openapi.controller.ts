import { Controller, Get } from '@nestjs/common';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { buildOpenApiDocument } from './openapi.document';

@Controller('openapi.json')
export class OpenApiController {
  @Get()
  get(): OpenAPIObject {
    return buildOpenApiDocument();
  }
}
