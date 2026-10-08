import { Injectable } from '@nestjs/common';
import {
  createEdgeRequestSchema,
  type CreateEdgeResponse,
  EDGE_EXISTS,
  EDGE_LIMIT_EXCEEDED,
  EDGE_TARGET_NOT_QUESTION,
  EDGE_TYPE_CHANGE_NOT_ALLOWED,
  EDGE_UNCHANGED,
  type EdgeListResponse,
  type EdgeMutationResponse,
  edgeStateRequestSchema,
  type EdgeType,
  isSymmetricEdgeType,
  listEdgesQuerySchema,
  MAX_EDGES_PER_STUDY,
  requiresQuestionTarget,
  updateEdgeRequestSchema,
} from '@bible-artisan/contracts';
import { fn, Op } from 'sequelize';
import {
  EdgeRuleError,
  NotFoundError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { StudyEdge } from '../../database/models/study-edge.model';
import { StudyNode } from '../../database/models/study-node.model';
import type { AppendedEvent } from '../thread/thread.service';
import { StudyAccessService } from '../study/study-access.service';
import { StudyRevisionService } from '../study/study-revision.service';
import { releaseLostEvidence } from './conclusions';

/**
 * Edge events (BIB-27), one per changing request, ids and enums only: never the note, node text
 * or labels (PRD section 23, NFR-PRIV-001). Intended visibility, for BIB-55's column: all
 * thread-visible (PRD section 13). `edge_updated` keeps the previous type (section 23 "events
 * preserve prior semantics"); prior note text is not kept (recorded deviation, see BIB-27).
 */
export const EDGE_EVENTS = {
  connected: 'node_connected',
  updated: 'edge_updated',
  removed: 'edge_removed',
} as const;

/** What to connect. Ids are lower-case uuids (as `createEdgeRequestSchema` outputs them). */
export interface ConnectInput {
  sourceNodeId: string;
  targetNodeId: string;
  type: EdgeType;
  note?: string | null;
}

export type ConnectResult =
  /** A live edge already joins these nodes with this type: nothing was written. */
  | { outcome: 'existing'; edge: StudyEdge }
  | { outcome: 'created'; edge: StudyEdge; event: AppendedEvent };

export interface ConnectOptions {
  /**
   * Runs after the dedup lookup found no live edge, before anything else is checked or written:
   * the connect route checks the study's revision here, so a duplicate connect never conflicts.
   */
  beforeCreate?: () => Promise<unknown>;
}

/**
 * Connects two live nodes of the mutation's study (FR-GRAPH-004/005/006; PRD section 12), inside
 * any study mutation's `work` (the connect route now; BIB-55's Follow into Study and BIB-57's
 * derived-from later, in their own transactions). Under the study lock, in order:
 *
 * 1. Two-way types are normalized to `source < target` (lower-case uuid strings sort as
 *    PostgreSQL's uuid order does), so B→A finds A→B.
 * 2. Dedup: the live edge with these endpoints and type, if any, is returned as `existing` and
 *    nothing is written. The caller decides what that means for its mutation (the connect route
 *    declares `m.unchanged()`). The note sent with a duplicate is not applied.
 * 3. `beforeCreate`, then both endpoints must be live nodes of this study and owner (absent,
 *    deleted, another study's or another owner's: 404; the composite FKs refuse them in SQL too),
 *    `answers` / `raises_question` need a Question target (422), and the study holds fewer than
 *    `MAX_EDGES_PER_STUDY` live edges (422).
 * 4. Insert (`origin: 'user'`), content revision +1, one `node_connected` event.
 *
 * A malformed id is 404 before any query. A self-edge is the caller's 400 (the request schema);
 * the CHECK is the backstop. The partial
 * unique index is the dedup backstop: the study lock serializes this path, so a violation would
 * be a bug and stays a 500.
 */
export async function connectNodes(
  m: StudyMutation,
  input: ConnectInput,
  { beforeCreate }: ConnectOptions = {},
): Promise<ConnectResult> {
  const { type } = input;
  // A malformed id is the same 404 as an absent node, and never reaches PostgreSQL (a 500).
  if (!isResourceId(input.sourceNodeId) || !isResourceId(input.targetNodeId)) {
    throw new NotFoundError();
  }
  const [sourceNodeId, targetNodeId] =
    isSymmetricEdgeType(type) && input.sourceNodeId > input.targetNodeId
      ? [input.targetNodeId, input.sourceNodeId]
      : [input.sourceNodeId, input.targetNodeId];

  const existing = await StudyEdge.findOne({
    where: {
      studyId: m.studyId,
      ownerId: m.ownerId,
      sourceNodeId,
      targetNodeId,
      type,
      deletedAt: null,
    },
  });
  if (existing) return { outcome: 'existing', edge: existing };

  await beforeCreate?.();

  const endpoints = await StudyNode.findAll({
    where: {
      id: [sourceNodeId, targetNodeId],
      studyId: m.studyId,
      ownerId: m.ownerId,
      deletedAt: null,
    },
    attributes: ['id', 'type'],
  });
  const target = endpoints.find((node) => node.id === targetNodeId);
  if (!target || !endpoints.some((node) => node.id === sourceNodeId)) throw new NotFoundError();
  if (requiresQuestionTarget(type) && target.type !== 'question') {
    throw new EdgeRuleError(EDGE_TARGET_NOT_QUESTION);
  }
  const live = await StudyEdge.count({
    where: { studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (live >= MAX_EDGES_PER_STUDY) throw new EdgeRuleError(EDGE_LIMIT_EXCEEDED);

  const edge = await m.createChild(StudyEdge, {
    sourceNodeId,
    targetNodeId,
    type,
    note: input.note ?? null,
    origin: 'user',
  });
  m.bumpContentRevision();
  const event = await m.appendEvent({
    eventType: EDGE_EVENTS.connected,
    payload: { edgeId: edge.id, sourceNodeId, targetNodeId, edgeType: type },
  });
  return { outcome: 'created', edge, event };
}

function edgeFields(
  edge: StudyEdge,
): Omit<EdgeMutationResponse, 'lastEventSequence' | 'establishmentClearedNodeIds'> {
  return {
    id: edge.id,
    studyId: edge.studyId,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    type: edge.type,
    origin: edge.origin,
    revision: edge.revision,
    createdAt: edge.createdAt.toISOString(),
    updatedAt: edge.updatedAt.toISOString(),
  };
}

function mutationBody(
  edge: StudyEdge,
  lastEventSequence: string,
  establishmentClearedNodeIds: string[],
): EdgeMutationResponse {
  return { ...edgeFields(edge), lastEventSequence, establishmentClearedNodeIds };
}

/**
 * Typed relationships (BIB-27). Every write goes through `MutationService.execute` (Idempotency-Key
 * receipt, study lock, lifecycle guard, revision check, one StudyEvent in the same transaction);
 * reads resolve the study and node through `StudyAccessService`, then query edges by study id and
 * owner id. Responses carry ids and enums, never the note: they are stored on receipts.
 */
@Injectable()
export class EdgesService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly studyRevisions: StudyRevisionService,
  ) {}

  /**
   * `POST /studies/:studyId/edges`. `expectedRevision` is the study's. A duplicate is 200
   * `existing` with no write at all (`m.unchanged()`: no event, no revision or counter change),
   * found before the revision check, so it never conflicts; a new edge checks and bumps the study
   * revision, then is 201 `created`.
   */
  async create(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(createEdgeRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      // Only a created edge changes content (connectNodes bumps it); `existing` changes nothing.
      bumpsContentRevision: false,
      work: async (m) => {
        let studyRevision = 0;
        const result = await connectNodes(m, body, {
          beforeCreate: async () => {
            studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
          },
        });
        if (result.outcome === 'existing') {
          m.unchanged();
          const response: CreateEdgeResponse = {
            ...edgeFields(result.edge),
            lastEventSequence: null,
            studyRevision: await this.studyRevisions.currentRevision(m),
            outcome: 'existing',
          };
          return { status: 200, body: response };
        }
        const response: CreateEdgeResponse = {
          ...edgeFields(result.edge),
          lastEventSequence: result.event.sequence,
          studyRevision,
          outcome: 'created',
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * `GET /studies/:studyId/edges?nodeId=`: the live edges where that live node is source or
   * target, oldest first (ties by id), with their notes. Unpaginated, bounded by the edge cap.
   * Archived and trashed studies stay readable.
   */
  async list(ownerId: string, studyId: string, query: unknown): Promise<EdgeListResponse> {
    const { nodeId } = parseBody(listEdgesQuerySchema, query);
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId);
    const edges = await StudyEdge.findAll({
      where: {
        studyId: node.studyId,
        ownerId,
        deletedAt: null,
        [Op.or]: [{ sourceNodeId: node.id }, { targetNodeId: node.id }],
      },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return {
      items: edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        type: edge.type,
        origin: edge.origin,
        note: edge.note,
        revision: edge.revision,
        createdAt: edge.createdAt.toISOString(),
        updatedAt: edge.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * `PATCH /studies/:studyId/edges/:edgeId`: a new `type` (same direction class) and/or `note`.
   * `expectedRevision` is the edge's. Checked in order under the study lock (after the pipeline's
   * lifecycle guard): absent edge 404, stale 409, then the rules (422): a type across direction
   * classes, `answers` / `raises_question` into a non-Question, a type another live edge between
   * the same endpoints already has, and no change at all.
   */
  async update(
    ownerId: string,
    studyId: string,
    edgeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateEdgeRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedEdge(m, edgeId, expectedRevision);
        const type = body.type ?? current.type;
        const note = body.note === undefined ? current.note : body.note;
        if (type !== current.type) await checkRetype(m, current, type);
        if (type === current.type && note === current.note) {
          throw new EdgeRuleError(EDGE_UNCHANGED);
        }
        const updated = await m.updateWithExpectedRevision(StudyEdge, {
          id: current.id,
          expectedRevision,
          values: { type, note },
          where: { deletedAt: null },
        });
        const event = await m.appendEvent({
          eventType: EDGE_EVENTS.updated,
          payload: {
            edgeId: updated.id,
            edgeType: type,
            previousEdgeType: current.type,
            noteChanged: note !== current.note,
          },
        });
        // A retype can end the edge's life as supporting evidence (BIB-30); a note-only edit
        // cannot lose any.
        const lost =
          type === current.type ? null : await releaseLostEvidence(m, edgeBefore(current));
        return {
          status: 200,
          body: mutationBody(
            updated,
            lost?.lastEventSequence ?? event.sequence,
            lost?.clearedNodeIds ?? [],
          ),
        };
      },
    });
  }

  /**
   * `DELETE /studies/:studyId/edges/:edgeId`: soft delete (database clock). Both nodes and every
   * other edge stay. `expectedRevision` is the edge's; an already removed edge is 404.
   */
  async remove(
    ownerId: string,
    studyId: string,
    edgeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(edgeStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedEdge(m, edgeId, expectedRevision);
        const before = edgeBefore(current);
        const removed = await m.updateWithExpectedRevision(StudyEdge, {
          id: current.id,
          expectedRevision,
          values: { deletedAt: fn('now') },
          where: { deletedAt: null },
        });
        const event = await m.appendEvent({
          eventType: EDGE_EVENTS.removed,
          payload: {
            edgeId: removed.id,
            sourceNodeId: removed.sourceNodeId,
            targetNodeId: removed.targetNodeId,
            edgeType: removed.type,
          },
        });
        const lost = await releaseLostEvidence(m, before);
        return {
          status: 200,
          body: mutationBody(
            removed,
            lost.lastEventSequence ?? event.sequence,
            lost.clearedNodeIds,
          ),
        };
      },
    });
  }
}

/** The edge's id, type and endpoints, copied before a change (`current` is the pre-change row). */
function edgeBefore(edge: StudyEdge) {
  return {
    id: edge.id,
    type: edge.type,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  };
}

/** The rules a type change must pass (PATCH), after the revision check. */
async function checkRetype(m: StudyMutation, edge: StudyEdge, type: EdgeType): Promise<void> {
  if (isSymmetricEdgeType(type) !== isSymmetricEdgeType(edge.type)) {
    throw new EdgeRuleError(EDGE_TYPE_CHANGE_NOT_ALLOWED);
  }
  if (requiresQuestionTarget(type)) {
    const target = await StudyNode.findOne({
      where: { id: edge.targetNodeId, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
      attributes: ['type'],
    });
    if (target?.type !== 'question') throw new EdgeRuleError(EDGE_TARGET_NOT_QUESTION);
  }
  const duplicate = await StudyEdge.findOne({
    where: {
      studyId: m.studyId,
      ownerId: m.ownerId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type,
      deletedAt: null,
    },
    attributes: ['id'],
  });
  if (duplicate) throw new EdgeRuleError(EDGE_EXISTS);
}

/**
 * The live edge being changed, read inside the mutation (the study lock is held): absent,
 * removed, another study's or another owner's is 404; a stale `expectedRevision` is 409 before
 * any rule, so a client with an old copy always reloads first.
 */
async function lockedEdge(m: StudyMutation, edgeId: string, expectedRevision: number) {
  if (!isResourceId(edgeId)) throw new NotFoundError();
  const edge = await StudyEdge.findOne({
    where: { id: edgeId, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (!edge) throw new NotFoundError();
  if (edge.revision !== expectedRevision) throw new RevisionConflictError(edge.revision);
  return edge;
}
