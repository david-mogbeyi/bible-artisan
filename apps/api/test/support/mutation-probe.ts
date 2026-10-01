import { Controller, Inject, Module, Param, Post } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { AppModule } from '../../src/app.module';
import {
  MutationRequest,
  type MutationRequestInfo,
} from '../../src/common/mutation/mutation-request';
import { MutationModule } from '../../src/common/mutation/mutation.module';
import { MutationResult, MutationService } from '../../src/common/mutation/mutation.service';
import type { StudyMutation } from '../../src/common/mutation/study-mutation';
import { requireExpectedRevision } from '../../src/common/revision/expected-revision';
import { parseBody } from '../../src/common/validation/parse-body';
import { ParseResourceIdPipe } from '../../src/common/validation/resource-id';
import { DATABASE } from '../../src/database/database.module';
import type { Database } from '../../src/database/database';
import { StudyNode } from '../../src/database/models/study-node.model';
import { Study } from '../../src/database/models/study.model';
import { CurrentUserId } from '../../src/modules/identity/current-user.decorator';

const renameBody = z.object({
  expectedRevision: z.number(),
  title: z.string().min(1).max(200),
  /** Test hook: throw after every write (study, event) to prove rollback. */
  failAfterWrite: z.literal(true).optional(),
  /** Test hook: the status the work reports (a create-style route answers 201). */
  status: z.union([z.literal(200), z.literal(201)]).optional(),
  /** Test hook: sleep this long inside the transaction after the first write. */
  pauseMs: z.number().int().min(0).max(2000).optional(),
  /** Test hook: a study-level change that also writes every node of the study. */
  touchNodes: z.literal(true).optional(),
});

const nodeBody = z.object({
  expectedRevision: z.number(),
  pauseMs: z.number().int().min(0).max(2000).optional(),
});

/** Thrown by the probe's test hook; reaches the client as the generic 500 envelope. */
export class ProbeFailure extends Error {}

/** Holds the transaction (and its locks) open for `ms`, to force two mutations to interleave. */
async function pause(db: Database, ms: number | undefined): Promise<void> {
  if (!ms) return;
  // No `transaction` option: it joins the mutation transaction automatically.
  await db.query('SELECT pg_sleep($1)', { bind: [ms / 1000], type: QueryTypes.SELECT });
}

/**
 * TEST-ONLY mutation routes exercising the whole BIB-12 pipeline end to end the way real study
 * mutations will (BIB-19+): session owner → `requireExpectedRevision` (428/400) → body validation →
 * `MutationService.execute` (Idempotency-Key receipt, study lock, one transaction) → revision
 * check (409) → event → the returned `MutationResult` becomes the response via the global
 * interceptor, only after COMMIT. Mounted only by `MutationProbeModule`, never by `AppModule`.
 */
@Controller('__test/studies/:studyId')
class MutationProbeController {
  constructor(
    private readonly mutations: MutationService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** A study-level content mutation: rename (optionally also writing the study's nodes). */
  @Post('mutations')
  async rename(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(renameBody, mutation.body);

    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m: StudyMutation) => {
        const study = await m.updateWithExpectedRevision(Study, {
          id: studyId,
          expectedRevision,
          values: { title: body.title },
        });
        await pause(this.db, body.pauseMs);
        if (body.touchNodes) {
          await StudyNode.update(
            { deletedAt: null },
            { where: { studyId, ownerId, deletedAt: null } },
          );
        }
        const event = await m.appendEvent({ eventType: 'study_renamed' });
        if (body.failAfterWrite) throw new ProbeFailure();
        return {
          status: body.status ?? 200,
          body: {
            studyId,
            revision: study.revision,
            contentRevision: m.contentRevision,
            eventSequence: event.sequence,
          },
        };
      },
    });
  }

  /** A child-row content mutation: a revision-checked node update. */
  @Post('nodes/:nodeId/mutations')
  async touchNode(
    @CurrentUserId() ownerId: string,
    @Param('studyId', ParseResourceIdPipe) studyId: string,
    @Param('nodeId', ParseResourceIdPipe) nodeId: string,
    @MutationRequest() mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(nodeBody, mutation.body);

    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const node = await m.updateWithExpectedRevision(StudyNode, {
          id: nodeId,
          expectedRevision,
          values: {},
          where: { deletedAt: null },
        });
        await pause(this.db, body.pauseMs);
        const event = await m.appendEvent({ eventType: 'node_updated' });
        return {
          status: 200,
          body: {
            nodeId,
            revision: node.revision,
            contentRevision: m.contentRevision,
            eventSequence: event.sequence,
          },
        };
      },
    });
  }
}

/** The real `AppModule` plus the mutation probe routes. */
@Module({
  imports: [AppModule, MutationModule],
  controllers: [MutationProbeController],
})
export class MutationProbeModule {}
