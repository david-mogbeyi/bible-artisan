import { Controller, Get, Header, Module, Param } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { ParseResourceIdPipe } from '../../src/common/validation/resource-id';
import { CurrentUserId } from '../../src/modules/identity/current-user.decorator';
import { StudyAccessService } from '../../src/modules/study/study-access.service';
import { StudyModule } from '../../src/modules/study/study.module';

/**
 * TEST-ONLY private routes that exercise the owner-isolation mechanism end to end (session guard
 * -> `@CurrentUserId()` -> `ParseResourceIdPipe` -> `StudyAccessService`) before any real
 * study-scoped route exists (BIB-19+). Mounted only by `OwnerIsolationProbeModule`, never by the
 * production `AppModule`.
 */
@Controller('__test/studies/:studyId')
class OwnerIsolationProbeController {
  constructor(private readonly access: StudyAccessService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async study(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
  ): Promise<{ studyId: string }> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    return { studyId: study.id };
  }

  @Get('nodes/:nodeId')
  @Header('Cache-Control', 'no-store')
  async node(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
  ): Promise<{ studyId: string; nodeId: string }> {
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId);
    return { studyId: node.studyId, nodeId: node.id };
  }
}

/** The real `AppModule` plus the probe routes above. */
@Module({
  imports: [AppModule, StudyModule],
  controllers: [OwnerIsolationProbeController],
})
export class OwnerIsolationProbeModule {}
