import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { ExportResponse } from '@bible-artisan/contracts';
import { ParseResourceIdPipe } from '../../common/validation/resource-id';
import { CurrentUserId } from '../identity/current-user.decorator';
import { ExportsService } from './exports.service';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Study and account exports (BIB-47, BIB-48). The owner is always the session's; another user's,
 * an absent, a malformed and an expired id are the same 404. Creating an export changes no study
 * data, so it takes no expectedRevision and writes no StudyEvent.
 */
@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post('studies/:studyId/exports')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  createStudyExport(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Body() body: unknown,
  ): Promise<ExportResponse> {
    return this.exports.createStudyExport(ownerId, studyId, body);
  }

  @Post('me/exports')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  createAccountExport(
    @CurrentUserId() ownerId: string,
    @Body() body: unknown,
  ): Promise<ExportResponse> {
    return this.exports.createAccountExport(ownerId, body);
  }

  @Get('exports/:exportId')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUserId() ownerId: string,
    @Param('exportId', ParseResourceIdPipe) exportId: string,
  ): Promise<ExportResponse> {
    return this.exports.get(ownerId, exportId);
  }

  @Get('exports/:exportId/download')
  async download(
    @CurrentUserId() ownerId: string,
    @Param('exportId', ParseResourceIdPipe) exportId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<string> {
    const file = await this.exports.download(ownerId, exportId, query);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return file.body;
  }
}
