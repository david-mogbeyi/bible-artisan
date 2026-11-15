import { Injectable } from '@nestjs/common';
import {
  INITIAL_VIEW_REVISION,
  RESUME_OPEN_QUESTIONS,
  type ResumeResponse,
  type ResumeTarget,
  type SaveViewStateResponse,
  saveViewStateRequestSchema,
  type ViewState,
} from '@bible-artisan/contracts';
import { NotFoundError } from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { parseBody } from '../../common/validation/parse-body';
import { isUuid } from '../../common/validation/uuid';
import { StudyBranch } from '../../database/models/study-branch.model';
import { StudyBranchMember } from '../../database/models/study-branch-member.model';
import { StudyNode } from '../../database/models/study-node.model';
import { StudyViewState } from '../../database/models/study-view-state.model';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { StudyAccessService } from '../study/study-access.service';
import { ThreadService } from '../thread/thread.service';

/**
 * `view_state_saved {viewRevision, fields}`: internal (PRD section 13), field names only, never a
 * value. A background event: it never starts a session or moves `last_activity_at`.
 */
export const VIEW_STATE_SAVED = 'view_state_saved';

function viewStateOf(row: StudyViewState | null): ViewState {
  return {
    viewRevision: row?.revision ?? INITIAL_VIEW_REVISION,
    selectedNodeId: row?.selectedNodeId ?? null,
    activeBranchId: row?.activeBranchId ?? null,
    activeQuestionNodeId: row?.activeQuestionNodeId ?? null,
    readerReferenceId: row?.readerReferenceId ?? null,
    viewport: row?.viewport ?? null,
    panes: row?.paneState ?? null,
    contextSavedAt: row?.contextSavedAt?.toISOString() ?? null,
  };
}

/**
 * Deterministic resume (BIB-34; PRD sections 11, 18; FR-STUDY-007/008).
 *
 * `PATCH /studies/:id/view-state` saves the workspace's context on the study's view-state row,
 * checked against the **view revision** (the one position saves use): 428 / 409 with the view
 * revision as `currentRevision`. Every id must name this study's live node or its branch, and a
 * reader passage a stored reference (404 otherwise). It moves neither the study revision, the
 * content revision nor `last_activity_at` (PRD section 18: a view change is not activity).
 *
 * `GET /studies/:id/resume` reads only saved state: no AI, so it is the same with AI disabled or
 * failing. Archived and trashed studies (inside their recovery window) are readable too.
 */
@Injectable()
export class ResumeService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly references: ReferenceService,
    private readonly thread: ThreadService,
  ) {}

  saveViewState(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(saveViewStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const scope = { studyId: m.studyId, ownerId: m.ownerId };
        const values: Partial<
          Pick<
            StudyViewState,
            | 'selectedNodeId'
            | 'activeBranchId'
            | 'activeQuestionNodeId'
            | 'readerReferenceId'
            | 'viewport'
            | 'paneState'
            | 'contextSavedAt'
          >
        > = {};
        if (body.selectedNodeId !== undefined) {
          values.selectedNodeId = body.selectedNodeId;
          if (body.selectedNodeId !== null) {
            const node = await StudyNode.findOne({
              where: { ...scope, id: body.selectedNodeId, deletedAt: null },
              attributes: ['id', 'type'],
            });
            if (!node) throw new NotFoundError();
            // Selecting a question makes it the active question (PRD section 18).
            if (node.type === 'question') values.activeQuestionNodeId = node.id;
          }
        }
        if (body.activeBranchId !== undefined) {
          values.activeBranchId = body.activeBranchId;
          if (body.activeBranchId !== null) {
            const branch = await StudyBranch.count({
              where: { ...scope, id: body.activeBranchId },
            });
            if (branch !== 1) throw new NotFoundError();
          }
        }
        if (body.readerReferenceId !== undefined) {
          values.readerReferenceId = body.readerReferenceId;
          if (body.readerReferenceId !== null) {
            await this.references.storedReference(body.readerReferenceId);
          }
        }
        if (body.viewport !== undefined) values.viewport = body.viewport;
        if (body.panes !== undefined) values.paneState = body.panes;
        // The reader's passage is where to reopen the reader, not a newer resume context: the
        // reader saves it right after recording the visit, which must stay the newer of the two.
        const contextFields = ['selectedNodeId', 'activeBranchId'] as const;
        if (contextFields.some((field) => body[field] !== undefined)) {
          values.contextSavedAt = new Date();
        }

        const existing = await StudyViewState.findOne({ where: scope, attributes: ['id'] });
        // The study lock serializes the lazy insert (the unique key is the backstop).
        const row = existing ?? (await m.createChild(StudyViewState, {}));
        const updated = await m.updateWithExpectedRevision(StudyViewState, {
          id: row.id,
          expectedRevision,
          values,
        });
        const fields = Object.keys(body)
          .filter((key) => key !== 'expectedRevision')
          .sort();
        const event = await m.appendEvent({
          eventType: VIEW_STATE_SAVED,
          payload: { viewRevision: updated.revision, fields },
        });
        const response: SaveViewStateResponse = {
          viewState: viewStateOf(updated),
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }

  async resume(ownerId: string, studyId: string): Promise<ResumeResponse> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const scope = { studyId: study.id, ownerId };
    const [view, branches, lastVisit] = await Promise.all([
      StudyViewState.findOne({ where: scope }),
      StudyBranch.findAll({
        where: scope,
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      }),
      this.thread.lastVisit(ownerId, study.id),
    ]);
    const viewState = viewStateOf(view);

    // Every node the card may name, read live (not soft-deleted) in one statement.
    const candidateIds = [
      viewState.selectedNodeId,
      viewState.activeQuestionNodeId,
      study.mainQuestionNodeId,
      ...branches.map((branch) => branch.rootNodeId),
    ].filter((id): id is string => id !== null);
    const liveNodes = await StudyNode.findAll({
      where: { ...scope, id: [...new Set(candidateIds)], deletedAt: null },
    });
    const live = new Map(liveNodes.map((node) => [node.id, node]));

    const activeBranch = branches.find((branch) => branch.id === viewState.activeBranchId) ?? null;
    const activeBranchRoot = activeBranch ? (live.get(activeBranch.rootNodeId) ?? null) : null;
    let rootLabel: string | null = activeBranchRoot?.title ?? null;
    if (activeBranchRoot && rootLabel === null && activeBranchRoot.scriptureReferenceId) {
      const labels = await this.references.storedReferences([
        activeBranchRoot.scriptureReferenceId,
      ]);
      rootLabel = labels.get(activeBranchRoot.scriptureReferenceId)?.label ?? null;
    }

    const question = (id: string | null) => {
      const node = id ? live.get(id) : undefined;
      return node?.type === 'question' && node.title && node.questionStatus
        ? { nodeId: node.id, text: node.title, status: node.questionStatus }
        : null;
    };
    const activeQuestion =
      question(viewState.activeQuestionNodeId) ?? question(study.mainQuestionNodeId);

    const conclusion = await StudyNode.findOne({
      where: { ...scope, type: 'conclusion', deletedAt: null },
      order: [
        ['updatedAt', 'DESC'],
        ['id', 'ASC'],
      ],
    });

    // Open questions of the active branch (its root and members), else of the whole study.
    let branchNodeIds: string[] | null = null;
    if (activeBranch) {
      const members = await StudyBranchMember.findAll({
        where: { ...scope, branchId: activeBranch.id },
        attributes: ['nodeId'],
      });
      branchNodeIds = [activeBranch.rootNodeId, ...members.map((member) => member.nodeId)];
    }
    const openWhere = {
      ...scope,
      type: 'question' as const,
      questionStatus: 'open' as const,
      deletedAt: null,
      ...(branchNodeIds ? { id: branchNodeIds } : {}),
    };
    const [openItems, openTotal] = await Promise.all([
      StudyNode.findAll({
        where: openWhere,
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: RESUME_OPEN_QUESTIONS,
      }),
      StudyNode.count({ where: openWhere }),
    ]);

    const visitReferenceId = lastVisit?.payloadJson.referenceId;
    const visitLabel = lastVisit?.payloadJson.referenceLabel;
    const lastPassage =
      lastVisit &&
      typeof visitReferenceId === 'string' &&
      isUuid(visitReferenceId) &&
      typeof visitLabel === 'string'
        ? {
            referenceId: visitReferenceId,
            label: visitLabel,
            eventId: lastVisit.id,
            occurredAt: lastVisit.occurredAt.toISOString(),
          }
        : null;

    const target = await this.target({
      scope,
      view,
      live,
      branches,
      activeBranch,
      startingReferenceId: study.startingReferenceId,
      mainQuestionNodeId: study.mainQuestionNodeId,
      lastPassage: lastPassage && lastVisit ? { ...lastPassage, at: lastVisit.recordedAt } : null,
      lastVisitBranchId: lastVisit?.branchId ?? null,
    });

    return {
      studyId: study.id,
      title: study.title,
      lifecycle: study.lifecycle,
      lastActivityAt: study.lastActivityAt.toISOString(),
      activeQuestion,
      activeBranch: activeBranch
        ? { id: activeBranch.id, rootNodeId: activeBranch.rootNodeId, rootLabel }
        : null,
      lastPassage,
      recentConclusion:
        conclusion?.title && conclusion.conclusionStatus
          ? { nodeId: conclusion.id, text: conclusion.title, status: conclusion.conclusionStatus }
          : null,
      openQuestions: {
        items: openItems.map((node) => ({ nodeId: node.id, text: node.title ?? '' })),
        total: openTotal,
      },
      target,
      viewState,
    };
  }

  /**
   * "Resume from Last Point" (PRD section 18, FR-STUDY-007): the saved node while it is live,
   * unless a deliberate visit came after the context was saved (then that passage). A deleted
   * saved node falls back to the nearest surviving branch root (the active branch's, else a
   * branch the node belonged to, else the first branch's), then the starting passage's node,
   * then the study page. With nothing saved and no visit: the main question, else the same
   * fallback chain (not marked as a fallback).
   */
  private async target(input: {
    scope: { studyId: string; ownerId: string };
    view: StudyViewState | null;
    live: Map<string, StudyNode>;
    branches: StudyBranch[];
    activeBranch: StudyBranch | null;
    startingReferenceId: string | null;
    mainQuestionNodeId: string | null;
    lastPassage: { referenceId: string; at: Date } | null;
    lastVisitBranchId: string | null;
  }): Promise<ResumeTarget> {
    const { view, live, activeBranch, lastPassage } = input;
    const branchId = activeBranch?.id ?? null;
    const savedNodeId = view?.selectedNodeId ?? null;
    const savedAt = view?.contextSavedAt ?? null;
    const visitIsNewer = lastPassage !== null && (savedAt === null || lastPassage.at > savedAt);

    if (savedNodeId && !visitIsNewer) {
      if (live.has(savedNodeId)) {
        return { kind: 'node', nodeId: savedNodeId, referenceId: null, branchId, fallback: false };
      }
      return this.fallback(input, savedNodeId, true);
    }
    if (lastPassage) {
      return {
        kind: 'passage',
        nodeId: null,
        referenceId: lastPassage.referenceId,
        branchId: input.lastVisitBranchId ?? branchId,
        fallback: false,
      };
    }
    if (input.mainQuestionNodeId && live.has(input.mainQuestionNodeId)) {
      return {
        kind: 'node',
        nodeId: input.mainQuestionNodeId,
        referenceId: null,
        branchId,
        fallback: false,
      };
    }
    return this.fallback(input, null, false);
  }

  private async fallback(
    input: {
      scope: { studyId: string; ownerId: string };
      live: Map<string, StudyNode>;
      branches: StudyBranch[];
      activeBranch: StudyBranch | null;
      startingReferenceId: string | null;
    },
    deletedNodeId: string | null,
    fallback: boolean,
  ): Promise<ResumeTarget> {
    const { scope, live, branches, activeBranch } = input;
    const candidates: StudyBranch[] = [];
    if (activeBranch) candidates.push(activeBranch);
    if (deletedNodeId) {
      const memberships = await StudyBranchMember.findAll({
        where: { ...scope, nodeId: deletedNodeId },
        attributes: ['branchId'],
      });
      const memberOf = new Set(memberships.map((row) => row.branchId));
      candidates.push(...branches.filter((branch) => memberOf.has(branch.id)));
    }
    candidates.push(...branches);
    const surviving = candidates.find((branch) => live.has(branch.rootNodeId));
    if (surviving) {
      return {
        kind: 'branch_root',
        nodeId: surviving.rootNodeId,
        referenceId: null,
        branchId: surviving.id,
        fallback,
      };
    }
    if (input.startingReferenceId) {
      const start = await StudyNode.findOne({
        where: {
          ...scope,
          type: 'scripture',
          scriptureReferenceId: input.startingReferenceId,
          deletedAt: null,
        },
        attributes: ['id'],
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      if (start) {
        return {
          kind: 'starting_passage',
          nodeId: start.id,
          referenceId: input.startingReferenceId,
          branchId: null,
          fallback,
        };
      }
    }
    return { kind: 'study', nodeId: null, referenceId: null, branchId: null, fallback };
  }
}
