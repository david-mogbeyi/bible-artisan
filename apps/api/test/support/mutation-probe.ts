import { Controller, Header, Module, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import { AppModule } from '../../src/app.module';
import {
  MutationRequest,
  type MutationRequestInfo,
  sendMutationResult,
} from '../../src/common/mutation/mutation-request';
import { MutationModule } from '../../src/common/mutation/mutation.module';
import { MutationService } from '../../src/common/mutation/mutation.service';
import {
  requireExpectedRevision,
  updateWithExpectedRevision,
} from '../../src/common/revision/expected-revision';
import { parseBody } from '../../src/common/validation/parse-body';
import { ParseResourceIdPipe } from '../../src/common/validation/resource-id';
import { Study } from '../../src/database/models/study.model';
import { CurrentUserId } from '../../src/modules/identity/current-user.decorator';
import { StudyRevisionService } from '../../src/modules/study/study-revision.service';
import { StudyModule } from '../../src/modules/study/study.module';
import { ThreadModule } from '../../src/modules/thread/thread.module';
import { ThreadService } from '../../src/modules/thread/thread.service';

const probeBody = z.object({
  expectedRevision: z.number(),
  title: z.string().min(1).max(200),
  /** Test hook: throw after every write (study, content revision, event) to prove rollback. */
  failAfterWrite: z.literal(true).optional(),
});

/** Thrown by the probe's test hook; reaches the client as the generic 500 envelope. */
export class ProbeFailure extends Error {}

/**
 * TEST-ONLY mutation route exercising the whole BIB-12 pipeline end to end the way a real study
 * mutation will (BIB-19+): session owner → `requireExpectedRevision` (428/400) → body validation →
 * `MutationService` (Idempotency-Key receipt, one transaction) → revision-checked study update
 * (409) → content revision bump → `study_renamed` event → reply only after COMMIT. Mounted only
 * by `MutationProbeModule`, never by the production `AppModule`.
 */
@Controller('__test/studies/:studyId/mutations')
class MutationProbeController {
  constructor(
    private readonly mutations: MutationService,
    private readonly studyRevisions: StudyRevisionService,
    private readonly thread: ThreadService,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  async rename(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
    @Res({ passthrough: true })
    response: { status(code: number): unknown; setHeader(n: string, v: string): unknown },
  ): Promise<Record<string, unknown>> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(probeBody, mutation.body);

    const result = await this.mutations.execute(ownerId, mutation, async (transaction) => {
      const study = await updateWithExpectedRevision(Study, {
        where: { id: studyId, ownerId },
        expectedRevision,
        values: { title: body.title },
        transaction,
      });
      const contentRevision = await this.studyRevisions.bumpContentRevision(
        transaction,
        ownerId,
        studyId,
      );
      const event = await this.thread.appendEvent(transaction, {
        ownerId,
        studyId,
        eventType: 'study_renamed',
      });
      if (body.failAfterWrite) throw new ProbeFailure();
      return {
        status: 200,
        body: { studyId, revision: study.revision, contentRevision, eventSequence: event.sequence },
      };
    });
    return sendMutationResult(response, result);
  }
}

/** The real `AppModule` plus the mutation probe route. */
@Module({
  imports: [AppModule, MutationModule, StudyModule, ThreadModule],
  controllers: [MutationProbeController],
})
export class MutationProbeModule {}
