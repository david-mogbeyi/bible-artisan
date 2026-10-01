import { Injectable } from '@nestjs/common';
import {
  type CreateStudyResponse,
  createStudyRequestSchema,
  type ScriptureReference,
  type StudyResponse,
} from '@bible-artisan/contracts';
import { NotFoundError, ReferenceNotFoundError } from '../../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../../common/mutation/mutation.service';
import { parseBody } from '../../../common/validation/parse-body';
import { StudyBranch } from '../../../database/models/study-branch.model';
import { StudyNode } from '../../../database/models/study-node.model';
import { ReferenceService } from '../../bible-content/reference/reference.service';
import { StudyAccessService } from '../study-access.service';
import { deriveStudyTitle } from '../study-title';

/** PRD section 13: the thread-visible event every study starts with. */
const STUDY_CREATED = 'study_created';

/**
 * Creates and reads studies (BIB-19). Creation goes through `MutationService.create`, so the
 * study, its root nodes, its initial branch, its `study_created` event and the Idempotency-Key
 * receipt commit in one transaction or not at all (FR-STUDY-001/002).
 */
@Injectable()
export class StudiesService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly references: ReferenceService,
  ) {}

  async create(ownerId: string, mutation: MutationRequestInfo): Promise<MutationResult> {
    const body = parseBody(createStudyRequestSchema, mutation.body);
    // Before the transaction: no corpus index load inside a mutation, and a bad reference writes
    // nothing at all. Reference rows are immutable and never deleted, and an active edition stays
    // active, so the check cannot go stale before COMMIT; the FK backs it up regardless.
    const reference =
      body.startingReferenceId === undefined
        ? null
        : await this.startingReference(body.startingReferenceId);
    const title = deriveStudyTitle({
      title: body.title,
      referenceLabel: reference?.label,
      question: body.question,
    });

    return this.mutations.create(ownerId, mutation, {
      study: { title, startingReferenceId: reference?.id ?? null },
      work: async (m) => {
        const scripture = reference
          ? await m.createChild(StudyNode, {
              type: 'scripture',
              scriptureReferenceId: reference.id,
            })
          : null;
        const question =
          body.question === undefined
            ? null
            : await m.createChild(StudyNode, {
                type: 'question',
                title: body.question,
                questionStatus: 'open',
              });
        if (question) {
          await m.updateCreatedStudy({
            originalQuestionNodeId: question.id,
            mainQuestionNodeId: question.id,
          });
        }
        // PRD section 10: the question establishes the initial branch; else the passage roots it.
        const root = question ?? scripture;
        const branch = root ? await m.createChild(StudyBranch, { rootNodeId: root.id }) : null;
        // Ids and the reference label only: the title and question are private text the thread
        // reads from the study and node, not copies in the event (PRD section 23).
        const event = await m.appendEvent({
          eventType: STUDY_CREATED,
          payload: {
            startingReferenceId: reference?.id ?? null,
            startingReferenceLabel: reference?.label ?? null,
            scriptureNodeId: scripture?.id ?? null,
            questionNodeId: question?.id ?? null,
            branchId: branch?.id ?? null,
            blank: body.blank === true,
          },
        });
        const created: CreateStudyResponse = {
          studyId: m.studyId,
          // A new study's first revision; every root shares content revision 1 (PRD section 24).
          revision: 1,
          contentRevision: m.contentRevision,
          rootNodeId: scripture?.id ?? null,
          questionNodeId: question?.id ?? null,
          branchId: branch?.id ?? null,
          lastEventSequence: event.sequence,
        };
        return { status: 201, body: created };
      },
    });
  }

  async get(ownerId: string, studyId: string): Promise<StudyResponse> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const scope = { studyId: study.id, ownerId };
    const [question, branch, reference] = await Promise.all([
      study.mainQuestionNodeId === null
        ? null
        : StudyNode.findOne({
            where: { ...scope, id: study.mainQuestionNodeId, type: 'question', deletedAt: null },
          }),
      StudyBranch.findOne({
        where: scope,
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      }),
      study.startingReferenceId === null
        ? null
        : this.references.storedReference(study.startingReferenceId).then((r) => r.reference),
    ]);
    return {
      id: study.id,
      title: study.title,
      lifecycle: study.lifecycle,
      revision: study.revision,
      contentRevision: study.contentRevision,
      startingReference: reference,
      mainQuestion:
        question?.title && question.questionStatus
          ? { nodeId: question.id, text: question.title, status: question.questionStatus }
          : null,
      branchId: branch?.id ?? null,
      createdAt: study.createdAt.toISOString(),
    };
  }

  /** The stored reference, in an active edition; otherwise 422 with nothing written. */
  private async startingReference(referenceId: string): Promise<ScriptureReference> {
    try {
      return (await this.references.storedReference(referenceId)).reference;
    } catch (error) {
      if (error instanceof NotFoundError) throw new ReferenceNotFoundError();
      throw error;
    }
  }
}
