import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  createNodeRequestSchema,
  type CreateNodeResponse,
  type DeletedNodeListResponse,
  type DerivedFromNote,
  duplicateNodeRequestSchema,
  type DuplicateNodeResponse,
  ESTABLISHMENT_ALONE,
  listNodesQuerySchema,
  MAX_EDGES_PER_STUDY,
  NODE_NOT_DELETED,
  NODE_NOT_DUPLICABLE,
  NODE_NOT_EDITABLE,
  NODE_UNCHANGED,
  type NodeDeleteResponse,
  type NodeListResponse,
  type NodeMutationResponse,
  nodeLabel,
  type NodeResponse,
  type NodeRestoreResponse,
  nodeStateRequestSchema,
  type NodeSummary,
  type NodeVersionListResponse,
  type NodeWarning,
  QUESTION_STATUSES,
  type QuestionStatus,
  type ScriptureReference,
  type SkippedEdgeReason,
  type Source,
  type SourceCitation,
  STATUS_NOT_FOR_NODE_TYPE,
  updateNodeRequestSchema,
} from '@bible-artisan/contracts';
import { fn, literal, Op } from 'sequelize';
import type { z } from 'zod';
import {
  NodeRuleError,
  NotFoundError,
  ReferenceNotFoundError,
  RevisionConflictError,
  ValidationError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { NodeVersion } from '../../database/models/node-version.model';
import { NodeVersionEvidence } from '../../database/models/node-version-evidence.model';
import { StudyEdge } from '../../database/models/study-edge.model';
import { StudyNode } from '../../database/models/study-node.model';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { NotesService } from '../notes/notes.service';
import { StudyAccessService } from '../study/study-access.service';
import { QUESTION_CREATED } from '../study/study-events';
import { type NewNodeValues, StudyGraphService } from '../study/study-graph.service';
import { StudyRevisionService } from '../study/study-revision.service';
import {
  CONCLUSION_EVENTS,
  establishedAtFor,
  isEvidenceIncomplete,
  liveEvidence,
  planConclusionChange,
  releaseConclusionsWithoutSupport,
  supportCounts,
  supportedConclusionOf,
  writeConclusionVersion,
} from './conclusions';

type CreateNodeBody = z.output<typeof createNodeRequestSchema>;
type UpdateNodeBody = z.output<typeof updateNodeRequestSchema>;
type ScriptureBody = Extract<CreateNodeBody, { type: 'scripture' }>;
type NodeValues = NewNodeValues;

/** One node's content for an AI context (BIB-42). `text` values are stored text, verbatim. */
export interface NodeContextContent {
  id: string;
  type: NodeSummary['type'];
  status: NodeSummary['status'];
  established: boolean;
  revision: number;
  text: Record<string, string | null>;
}

/**
 * Node events (BIB-25), one per mutation, ids and enums only: never text, titles, citations,
 * excerpts, URLs or labels (PRD section 23, NFR-PRIV-001). Intended visibility, for BIB-55's
 * column: all thread-visible. BIB-26: `scripture_added_to_graph` carries `duplicateOfNodeId`
 * (the canonical node an explicit duplicate copies, else null), and `scripture_revisited`
 * `{nodeId, referenceId}` records a deliberate Add of a reference the study already holds (the
 * PRD section 10 "another visit event"; not a reader-open visit, which BIB-55 records). `question_created` is the Study module's event with BIB-20's shape
 * (`branchId`: the initial branch a blank study's first question roots, else null; see
 * `StudyGraphService.ensureInitialBranch`). `source_created`, `thought_updated` and
 * `source_updated` are not in PRD section 13's list and are named by analogy.
 *
 * BIB-62: `observation_established {nodeId, observationKind}` (PRD section 13) when the owner marks
 * an observation; `observation_updated` carries `established` and `previousEstablished` (an edit or
 * a removal of the marker). BIB-61: a duplicate's created event carries `duplicateOfNodeId` (the
 * source node); ordinary creates never do. BIB-31: `node_deleted {nodeId, nodeType,
 * removedEdgeCount, promotedCanonicalNodeId, mainQuestionCleared}` and `node_restored {nodeId,
 * nodeType, restoredEdgeCount, skippedEdgeCount, canonicalNodeId}`. All thread-visible.
 */
export const NODE_EVENTS = {
  scripture: 'scripture_added_to_graph',
  scriptureRevisited: 'scripture_revisited',
  question: QUESTION_CREATED,
  observation: 'observation_created',
  thought: 'thought_created',
  conclusion: CONCLUSION_EVENTS.created,
  questionStatusChanged: 'question_status_changed',
  source: 'source_created',
  observationUpdated: 'observation_updated',
  observationEstablished: 'observation_established',
  thoughtUpdated: 'thought_updated',
  sourceUpdated: 'source_updated',
  deleted: 'node_deleted',
  restored: 'node_restored',
} as const;

/** The columns of a new node. `origin` comes from the type, never from the client. */
function newNodeValues(body: CreateNodeBody): NodeValues {
  switch (body.type) {
    case 'scripture':
      return { type: 'scripture', origin: 'scripture', scriptureReferenceId: body.referenceId };
    case 'question':
      return { type: 'question', origin: 'user', title: body.text, questionStatus: 'open' };
    case 'observation':
      return {
        type: 'observation',
        origin: 'user',
        body: body.text,
        observationKind: body.observationKind,
        derivedFromNoteId: body.derivedFromNoteId ?? null,
      };
    case 'thought':
      return {
        type: 'thought',
        origin: 'user',
        body: body.text,
        derivedFromNoteId: body.derivedFromNoteId ?? null,
      };
    case 'conclusion':
      return {
        type: 'conclusion',
        origin: 'user',
        title: body.text,
        conclusionStatus: 'tentative',
      };
    case 'source':
      return { type: 'source', origin: 'external', ...sourceColumns(body.source) };
  }
}

/**
 * The columns of a duplicate (BIB-61; PRD section 12): the source's current content and origin from
 * an explicit column list (never a row spread), with a fresh status. Nothing else: no marker,
 * canonical id, position, membership or version history. A Scripture node is refused.
 */
function duplicateValues(source: StudyNode): NodeValues {
  const { origin } = source;
  switch (source.type) {
    case 'observation':
      return {
        type: 'observation',
        origin,
        body: required(source.body),
        observationKind: required(source.observationKind),
      };
    case 'thought':
      return { type: 'thought', origin, body: required(source.body) };
    case 'question':
      return { type: 'question', origin, title: required(source.title), questionStatus: 'open' };
    case 'conclusion':
      return {
        type: 'conclusion',
        origin,
        title: required(source.title),
        conclusionStatus: 'tentative',
      };
    case 'source':
      return {
        type: 'source',
        origin,
        title: required(source.title),
        payloadJson: required(source.payloadJson),
      };
    case 'scripture':
      throw new NodeRuleError(NODE_NOT_DUPLICABLE);
  }
}

/** A citation as stored: the title in `title`, everything else in `payload_json`. */
function sourceColumns({ title, ...payload }: SourceCitation) {
  return { title, payloadJson: payload };
}

/** BIB-57: a converted node's created event names its note (id only); others carry nothing. */
function derivedFrom(node: StudyNode): { derivedFromNoteId?: string } {
  return node.derivedFromNoteId === null ? {} : { derivedFromNoteId: node.derivedFromNoteId };
}

function createdEvent(node: StudyNode, branchId: string | null, versionId: string | null = null) {
  switch (node.type) {
    case 'scripture':
      return {
        eventType: NODE_EVENTS.scripture,
        payload: {
          nodeId: node.id,
          referenceId: node.scriptureReferenceId,
          duplicateOfNodeId: node.canonicalNodeId,
        },
      };
    case 'question':
      return {
        eventType: NODE_EVENTS.question,
        payload: { questionNodeId: node.id, branchId },
      };
    case 'observation':
      return {
        eventType: NODE_EVENTS.observation,
        payload: {
          nodeId: node.id,
          observationKind: node.observationKind,
          ...derivedFrom(node),
        },
      };
    case 'thought':
      return { eventType: NODE_EVENTS.thought, payload: { nodeId: node.id, ...derivedFrom(node) } };
    case 'conclusion':
      return { eventType: NODE_EVENTS.conclusion, payload: { nodeId: node.id, versionId } };
    case 'source':
      return {
        eventType: NODE_EVENTS.source,
        payload: { nodeId: node.id, sourceKind: node.payloadJson?.kind ?? null },
      };
  }
}

/** The conclusion version a change wrote and the one before it, and what it warned about. */
interface VersionInfo {
  versionId: string | null;
  previousVersionId: string | null;
  warnings: NodeWarning[];
}

const NO_VERSION: VersionInfo = { versionId: null, previousVersionId: null, warnings: [] };

function mutationBody(
  node: StudyNode,
  lastEventSequence: string,
  version: VersionInfo = NO_VERSION,
): NodeMutationResponse {
  return {
    ...version,
    id: node.id,
    studyId: node.studyId,
    type: node.type,
    origin: node.origin,
    revision: node.revision,
    referenceId: node.scriptureReferenceId,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    lastEventSequence,
  };
}

function sourceOf(node: StudyNode): Source {
  const payload = node.payloadJson;
  if (node.title === null || payload === null) throw new Error('source node without a citation');
  return {
    title: node.title,
    kind: payload.kind,
    author: payload.author ?? null,
    workTitle: payload.workTitle ?? null,
    publicationDetails: payload.publicationDetails ?? null,
    url: payload.url ?? null,
    locator: payload.locator ?? null,
    excerpt: payload.excerpt ?? null,
    excerptKind: payload.excerptKind ?? null,
  };
}

function isQuestionStatus(status: string): status is QuestionStatus {
  return (QUESTION_STATUSES as readonly string[]).includes(status);
}

/** The newest version of a conclusion (read under the study lock), or null if it has none. */
async function latestVersionId(nodeId: string): Promise<string | null> {
  const latest = await NodeVersion.findOne({
    where: { nodeId },
    attributes: ['id'],
    order: [['versionNumber', 'DESC']],
  });
  return latest?.id ?? null;
}

/** The column a statement or text lives in, for types whose CHECKs require it. */
function required<T>(value: T | null): T {
  if (value === null) throw new Error('study_node row is missing a column its type requires');
  return value;
}

/**
 * Typed graph nodes (BIB-25; FR-GRAPH-001; PRD sections 8, 12, 15, 16, 23, 24).
 *
 * Every write goes through `MutationService.execute`: one transaction with its Idempotency-Key
 * receipt, the study lock, the lifecycle guard (archived/trashed studies are refused before the
 * work runs), the revision check and exactly one StudyEvent. Every read resolves the study (and a
 * node) through `StudyAccessService`, then queries nodes by study id and owner id.
 *
 * Scripture references are checked by the Bible content context (`ReferenceService`), never read
 * from its tables here, and never repaired: an unknown reference or one whose edition is not
 * active is 422 `REFERENCE_NOT_FOUND`.
 */
@Injectable()
export class NodesService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly studyRevisions: StudyRevisionService,
    private readonly graph: StudyGraphService,
    private readonly references: ReferenceService,
    private readonly notes: NotesService,
  ) {}

  /**
   * `POST /studies/:studyId/nodes`. A new node is a study change: `expectedRevision` is the
   * study's, checked first (so of two creates from one revision, one is 409 before any rule) and
   * bumped. The node cap (`StudyGraphService.addNode`, shared with every node-creating path) is
   * checked under the study lock, and so is a Scripture reference's canonical node
   * (`addScripture`). `content_revision` moves only when a node is created. A question on a study without
   * a branch (a blank one) roots its initial branch (`StudyGraphService.ensureInitialBranch`),
   * reported as the event's `branchId`.
   * A Scripture reference is validated before the transaction, as study creation does: reference
   * rows are immutable and an active edition stays active, so the check cannot go stale, and a
   * refusal writes nothing, not even a receipt.
   */
  async create(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(createNodeRequestSchema, mutation.body);
    if (body.type === 'scripture') await this.requireReference(body.referenceId);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      // A focused existing Scripture node changes no content (PRD section 24); every created
      // node bumps it below.
      bumpsContentRevision: false,
      work: async (m) => {
        const studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
        if (body.type === 'scripture') return this.addScripture(m, body, studyRevision);
        if ((body.type === 'observation' || body.type === 'thought') && body.derivedFromNoteId) {
          await this.notes.requireConvertibleNote(m, body.derivedFromNoteId);
        }
        const { node, event, versionId } = await this.insertNode(m, newNodeValues(body));
        const response: CreateNodeResponse = {
          ...mutationBody(node, event.sequence, {
            versionId,
            previousVersionId: null,
            warnings: [],
          }),
          studyRevision,
          outcome: 'created',
          canonicalNodeId: null,
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * The insert step `create` and `duplicate` share, so the two cannot drift: the node (under the
   * live-node cap), content revision +1, a question's initial branch on a blank study, a
   * conclusion's version 1 (BIB-30), then the created event (with `extra` keys, e.g. a duplicate's
   * `duplicateOfNodeId`).
   */
  private async insertNode(m: StudyMutation, values: NodeValues, extra: object = {}) {
    const node = await this.graph.addNode(m, values);
    m.bumpContentRevision();
    const branchId = node.type === 'question' ? await this.graph.ensureInitialBranch(m) : null;
    const first =
      node.type === 'conclusion' ? await writeConclusionVersion(m, node, 'created', null) : null;
    const created = createdEvent(node, branchId, first?.id ?? null);
    const event = await m.appendEvent({
      eventType: created.eventType,
      payload: { ...created.payload, ...extra },
    });
    return { node, event, versionId: first?.id ?? null };
  }

  /**
   * A node from an accepted AI proposal (BIB-44 questions, BIB-45 passages), inside the AI
   * module's accept mutation (whose revision check is the proposal's). A question becomes an open
   * Question node with an AI origin (PRD section 16: adopted AI text keeps its AI-origin badge),
   * through the same insert step as `create`. A passage becomes the study's canonical Scripture
   * node for the corpus-verified reference, or focuses the live one it already has (no write).
   * The node cap applies. Never changes any existing node.
   */
  async addFromAiProposal(
    m: StudyMutation,
    input: { type: 'question'; text: string } | { type: 'scripture'; referenceId: string },
  ): Promise<{ nodeId: string; outcome: 'created' | 'existing' }> {
    if (input.type === 'question') {
      const { node } = await this.insertNode(m, {
        type: 'question',
        origin: 'ai',
        title: input.text,
        questionStatus: 'open',
      });
      return { nodeId: node.id, outcome: 'created' };
    }
    const canonical = await StudyNode.findOne({
      where: {
        studyId: m.studyId,
        ownerId: m.ownerId,
        type: 'scripture',
        scriptureReferenceId: input.referenceId,
        canonicalNodeId: null,
        deletedAt: null,
      },
    });
    if (canonical) return { nodeId: canonical.id, outcome: 'existing' };
    const node = await this.graph.addNode(m, {
      type: 'scripture',
      origin: 'scripture',
      scriptureReferenceId: input.referenceId,
    });
    m.bumpContentRevision();
    await m.appendEvent(createdEvent(node, null));
    return { nodeId: node.id, outcome: 'created' };
  }

  /**
   * `POST /studies/:studyId/nodes/:nodeId/duplicate` (BIB-61; PRD section 12): a new node of the
   * source's type with its current content and origin (`duplicateValues`), through the same insert
   * step as `create`. `expectedRevision` is the study's. Under the study lock, in order: the source
   * must be a live node of this study (404), the study revision (409), a Scripture source is 422
   * `NODE_NOT_DUPLICABLE`, then the node cap. The source is never modified.
   */
  async duplicate(
    ownerId: string,
    studyId: string,
    nodeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(duplicateNodeRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        if (!isResourceId(nodeId)) throw new NotFoundError();
        const source = await StudyNode.findOne({
          where: { id: nodeId, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
        });
        if (!source) throw new NotFoundError();
        const studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
        const values = duplicateValues(source);
        const { node, event, versionId } = await this.insertNode(m, values, {
          duplicateOfNodeId: source.id,
        });
        const response: DuplicateNodeResponse = {
          ...mutationBody(node, event.sequence, {
            versionId,
            previousVersionId: null,
            warnings: [],
          }),
          studyRevision,
          duplicateOfNodeId: source.id,
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * `DELETE /studies/:studyId/nodes/:nodeId` (BIB-31; PRD section 23 "Integrity and deletion
   * rules"; FR-GRAPH-010). `expectedRevision` is the node's. In one transaction, in order: the node
   * is soft-deleted; every live edge touching it is soft-deleted with `deleted_with_node_id` naming
   * it (one UPDATE; edges removed earlier are untouched); a canonical Scripture node's oldest live
   * duplicate becomes canonical and every other row naming the deleted node is re-pointed to it
   * (after the node's own delete, so the partial unique index never sees two live canonicals); the
   * study's main-question pointer is cleared if it names the node; then every other conclusion that
   * lost its last live support through a removed edge goes through the evidence-loss rule (BIB-30:
   * only the marker is cleared). Notes, positions, branches, versions and events stay.
   */
  async delete(
    ownerId: string,
    studyId: string,
    nodeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(nodeStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedNode(m, nodeId, expectedRevision);
        const deleted = await m.updateWithExpectedRevision(StudyNode, {
          id: current.id,
          expectedRevision,
          values: { deletedAt: fn('now') },
          where: { deletedAt: null },
        });
        const [, removed] = await StudyEdge.update(
          {
            deletedAt: fn('now'),
            deletedWithNodeId: current.id,
            revision: NEXT_REVISION,
          },
          {
            where: {
              studyId: m.studyId,
              ownerId: m.ownerId,
              deletedAt: null,
              [Op.or]: [{ sourceNodeId: current.id }, { targetNodeId: current.id }],
            },
            returning: true,
          },
        );
        const promotedCanonicalNodeId = await promoteCanonical(m, current);
        const mainQuestionCleared = await this.graph.clearMainQuestion(m, current.id);
        const nodeEvent = await m.appendEvent({
          eventType: NODE_EVENTS.deleted,
          payload: {
            nodeId: current.id,
            nodeType: current.type,
            removedEdgeCount: removed.length,
            promotedCanonicalNodeId,
            mainQuestionCleared,
          },
        });
        const affected = removed.flatMap((edge) => {
          const conclusionId = supportedConclusionOf(edge);
          return conclusionId && conclusionId !== current.id ? [conclusionId] : [];
        });
        const released = await releaseConclusionsWithoutSupport(m, affected, {
          deletedNodeId: current.id,
        });
        const response: NodeDeleteResponse = {
          id: deleted.id,
          studyId: deleted.studyId,
          type: deleted.type,
          revision: deleted.revision,
          removedEdgeCount: removed.length,
          promotedCanonicalNodeId,
          mainQuestionCleared,
          establishmentClearedNodeIds: released.clearedNodeIds,
          lastEventSequence: released.lastEventSequence ?? nodeEvent.sequence,
        };
        return { status: 200, body: response };
      },
    });
  }

  /**
   * `POST /studies/:studyId/nodes/:nodeId/restore` (BIB-31). `expectedRevision` is the deleted
   * node's. Under the study lock, in order: 404 (absent or foreign), 409, 422 `NODE_NOT_DELETED`,
   * 422 `NODE_LIMIT_EXCEEDED`; then the node comes back. A Scripture node whose passage has a live
   * canonical node returns as its duplicate (rows naming it are re-pointed first), otherwise as the
   * canonical node. Each edge its deletion removed, oldest first, is restored under the same id when
   * the other end is live, no identical live edge exists and the edge cap has room; otherwise it
   * stays deleted (`endpoint_deleted` hands `deleted_with_node_id` to the other end, so restoring
   * that one brings it back). An established conclusion left without live support loses its marker.
   * Never changes a status, a marker (except that clearing), the main question or branches.
   */
  async restore(
    ownerId: string,
    studyId: string,
    nodeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(nodeStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        if (!isResourceId(nodeId)) throw new NotFoundError();
        const current = await StudyNode.findOne({
          where: { id: nodeId, studyId: m.studyId, ownerId: m.ownerId },
        });
        if (!current) throw new NotFoundError();
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(current.revision);
        }
        if (current.deletedAt === null) throw new NodeRuleError(NODE_NOT_DELETED);
        await this.graph.requireRoomForLiveNode(m);

        const canonicalNodeId = await restoredCanonical(m, current);
        let node = await m.updateWithExpectedRevision(StudyNode, {
          id: current.id,
          expectedRevision,
          values: { deletedAt: null, canonicalNodeId },
        });
        const { restoredEdgeIds, skippedEdges } = await restoreEdges(m, current.id);
        const event = await m.appendEvent({
          eventType: NODE_EVENTS.restored,
          payload: {
            nodeId: node.id,
            nodeType: node.type,
            restoredEdgeCount: restoredEdgeIds.length,
            skippedEdgeCount: skippedEdges.length,
            canonicalNodeId,
          },
        });
        const released =
          node.type === 'conclusion' && node.establishedAt !== null
            ? await releaseConclusionsWithoutSupport(m, [node.id], { restoredNodeId: node.id })
            : { clearedNodeIds: [], lastEventSequence: null };
        if (released.clearedNodeIds.length > 0) {
          node = await StudyNode.findByPk(node.id, { rejectOnEmpty: true });
        }
        const response: NodeRestoreResponse = {
          ...mutationBody(node, released.lastEventSequence ?? event.sequence, {
            versionId: null,
            previousVersionId: null,
            warnings: released.clearedNodeIds.length > 0 ? ['establishment_cleared'] : [],
          }),
          canonicalNodeId,
          restoredEdgeIds,
          skippedEdges,
          establishmentClearedNodeIds: released.clearedNodeIds,
        };
        return { status: 200, body: response };
      },
    });
  }

  /**
   * The Scripture branch of `create` (BIB-26; FR-GRAPH-002/003), under the study lock after the
   * revision check. The study's live canonical node for this exact reference (found from the
   * locked study and owner, never from a client-supplied id) decides the outcome:
   * - none: a new canonical node, 201 `created` (whatever the policy, so a stale "Add a separate
   *   copy" never fails);
   * - one, `focus_existing` (the default): nothing is written to `study_node` and
   *   `content_revision` stays; one `scripture_revisited` event records the deliberate return,
   *   200 `focused_existing` with the existing node's fields;
   * - one, `explicit_duplicate`: a new node naming it as `canonical_node_id` (subject to the
   *   node cap like any node), 201 `explicit_duplicate`.
   * The partial unique index is the database backstop; the study lock means this path never
   * trips it, so a violation would be a bug and stays a 500.
   */
  private async addScripture(m: StudyMutation, body: ScriptureBody, studyRevision: number) {
    // Only live canonical rows count. When a canonical node is soft-deleted, promoting its oldest
    // live duplicate to canonical is BIB-31's responsibility (node delete/restore), not this path's.
    const canonical = await StudyNode.findOne({
      where: {
        studyId: m.studyId,
        ownerId: m.ownerId,
        type: 'scripture',
        scriptureReferenceId: body.referenceId,
        canonicalNodeId: null,
        deletedAt: null,
      },
    });
    if (canonical && body.duplicatePolicy !== 'explicit_duplicate') {
      const event = await m.appendEvent({
        eventType: NODE_EVENTS.scriptureRevisited,
        payload: { nodeId: canonical.id, referenceId: body.referenceId },
      });
      const response: CreateNodeResponse = {
        ...mutationBody(canonical, event.sequence),
        studyRevision,
        outcome: 'focused_existing',
        canonicalNodeId: null,
      };
      return { status: 200, body: response };
    }
    const node = await this.graph.addNode(m, {
      ...newNodeValues(body),
      canonicalNodeId: canonical?.id ?? null,
    });
    m.bumpContentRevision();
    const event = await m.appendEvent(createdEvent(node, null));
    const response: CreateNodeResponse = {
      ...mutationBody(node, event.sequence),
      studyRevision,
      outcome: canonical ? 'explicit_duplicate' : 'created',
      canonicalNodeId: node.canonicalNodeId,
    };
    return { status: 201, body: response };
  }

  /**
   * `PATCH /studies/:studyId/nodes/:nodeId`: new content for an Observation, Thought or Source.
   * `expectedRevision` is the node's. Checked in order, all under the study lock: the pipeline's
   * lifecycle guard first (an archived study is 422 `STUDY_ARCHIVED`, a trashed one 422
   * `STUDY_TRASHED`, whatever the node), then an absent node is 404, a stale revision 409, a type
   * or field not editable here 422 `NODE_NOT_EDITABLE`, and an edit that changes nothing 422
   * `NODE_UNCHANGED`. So a client with an old copy always reloads before it sees a node rule
   * error. The lifecycle refusal coming first is the central guard's property (every study
   * mutation refuses a read-only study before its work runs); it reveals nothing, because the
   * study is already resolved as the caller's own (another owner's study is 404 at the lock).
   */
  async update(
    ownerId: string,
    studyId: string,
    nodeId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateNodeRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedNode(m, nodeId, expectedRevision);
        if (current.type === 'question') return this.changeQuestionStatus(m, current, body);
        if (current.type === 'conclusion') return this.changeConclusion(m, current, body);
        const { values, eventType, payload, warnings } = editOf(current, body);
        const updated = await m.updateWithExpectedRevision(StudyNode, {
          id: current.id,
          expectedRevision,
          values,
          where: { deletedAt: null },
        });
        const event = await m.appendEvent({
          eventType,
          payload: { nodeId: updated.id, ...payload },
        });
        return {
          status: 200,
          body: mutationBody(updated, event.sequence, { ...NO_VERSION, warnings }),
        };
      },
    });
  }

  /**
   * A Question's status (BIB-30; FR-QUESTION-001/002): the only thing about a question a PATCH
   * changes, and only this explicit request ever does (an `answers` relationship, a study edit
   * and every read leave it alone; AI proposals are BIB-44's). Any status may follow any other.
   * One `question_status_changed` event with the previous status.
   */
  private async changeQuestionStatus(m: StudyMutation, current: StudyNode, body: UpdateNodeBody) {
    if (
      body.text !== undefined ||
      body.observationKind !== undefined ||
      body.source !== undefined ||
      body.establishment !== undefined ||
      body.changeReason !== undefined
    ) {
      throw new NodeRuleError(NODE_NOT_EDITABLE);
    }
    const status = body.status;
    if (status === undefined) throw new NodeRuleError(NODE_NOT_EDITABLE);
    if (!isQuestionStatus(status)) {
      throw new ValidationError('Invalid request', { status: [STATUS_NOT_FOR_NODE_TYPE] });
    }
    if (status === current.questionStatus) throw new NodeRuleError(NODE_UNCHANGED);
    const updated = await m.updateWithExpectedRevision(StudyNode, {
      id: current.id,
      expectedRevision: current.revision,
      values: { questionStatus: status },
      where: { deletedAt: null },
    });
    const event = await m.appendEvent({
      eventType: NODE_EVENTS.questionStatusChanged,
      payload: { nodeId: updated.id, status, previousStatus: current.questionStatus },
    });
    return { status: 200, body: mutationBody(updated, event.sequence) };
  }

  /**
   * A Conclusion's explicit actions (BIB-30; FR-CONCLUSION-001...004), applied as one change that
   * writes one immutable version (with a snapshot of the live evidence, which the server counts
   * here under the study lock) and one event. The rules are `planConclusionChange`'s.
   */
  private async changeConclusion(m: StudyMutation, current: StudyNode, body: UpdateNodeBody) {
    if (body.observationKind !== undefined || body.source !== undefined) {
      throw new NodeRuleError(NODE_NOT_EDITABLE);
    }
    const support = supportCounts(await liveEvidence(m, [current.id]), [current.id]);
    const plan = planConclusionChange(
      {
        text: required(current.title),
        status: required(current.conclusionStatus),
        established: current.establishedAt !== null,
      },
      body,
      support.get(current.id) ?? 0,
    );
    const updated = await m.updateWithExpectedRevision(StudyNode, {
      id: current.id,
      expectedRevision: current.revision,
      values: {
        title: plan.text,
        conclusionStatus: plan.status,
        establishedAt: establishedAtFor(plan, current),
      },
      where: { deletedAt: null },
    });
    const previousVersionId = await latestVersionId(current.id);
    const version = await writeConclusionVersion(
      m,
      updated,
      plan.action,
      body.changeReason ?? null,
    );
    const event = await m.appendEvent({
      eventType: plan.eventType,
      payload: {
        nodeId: updated.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        status: plan.status,
        previousStatus: current.conclusionStatus,
        established: plan.established,
        previousEstablished: current.establishedAt !== null,
        statementChanged: plan.statementChanged,
      },
    });
    return {
      status: 200,
      body: mutationBody(updated, event.sequence, {
        versionId: version.id,
        previousVersionId,
        warnings: plan.warnings,
      }),
    };
  }

  /**
   * `GET /studies/:studyId/nodes`: every live node of the study, oldest first (ties by id), each
   * with its label (`nodeLabel`, shared with a note's target; Scripture labels in one batched
   * lookup). Unpaginated and never truncated: every creating path enforces the live-node cap, so
   * the list is bounded by it, and a study over the cap (rows written before the cap existed)
   * still lists all of its nodes rather than silently dropping the newest. Archived and trashed
   * studies stay readable.
   */
  async list(
    ownerId: string,
    studyId: string,
    query: unknown,
  ): Promise<NodeListResponse | DeletedNodeListResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const { state } = parseBody(listNodesQuerySchema, query);
    if (state === 'live') return { items: await this.liveSummaries(ownerId, studyId) };
    // BIB-31: the deleted nodes, newest deletion first (ties by id), unpaginated like the note
    // trash: bounded by what the study ever held.
    const deleted = await StudyNode.findAll({
      where: { studyId, ownerId, deletedAt: { [Op.ne]: null } },
      order: [
        ['deletedAt', 'DESC'],
        ['id', 'ASC'],
      ],
    });
    const summaries = await this.summaries({ studyId, ownerId }, deleted);
    return {
      items: summaries.map((summary, index) => ({
        ...summary,
        deletedAt: required(deleted[index]?.deletedAt ?? null).toISOString(),
      })),
    };
  }

  /** The revisions of some live nodes of a study (BIB-42: is a suggestion still current?). */
  async liveRevisions(
    ownerId: string,
    studyId: string,
    nodeIds: readonly string[],
  ): Promise<Map<string, number>> {
    const ids = nodeIds.filter(isResourceId);
    if (ids.length === 0) return new Map();
    const nodes = await StudyNode.findAll({
      where: { id: ids, studyId, ownerId, deletedAt: null },
      attributes: ['id', 'revision'],
    });
    return new Map(nodes.map((node) => [node.id, node.revision]));
  }

  /**
   * The stored content of some live nodes of a study, for an AI context (BIB-42): each node's
   * type, state, revision and full text: a statement or body as stored, a Source's title, locator
   * and excerpt, a Scripture node's verse text from the corpus (verbatim, at most
   * `scriptureChars`). Absent, deleted, another study's or another owner's ids are simply missing.
   * Private text: never logged.
   */
  async contextContent(
    ownerId: string,
    studyId: string,
    nodeIds: readonly string[],
    scriptureChars: number,
  ): Promise<Map<string, NodeContextContent>> {
    const found = new Map<string, NodeContextContent>();
    const ids = nodeIds.filter(isResourceId);
    if (ids.length === 0) return found;
    const nodes = await StudyNode.findAll({
      where: { id: ids, studyId, ownerId, deletedAt: null },
    });
    for (const node of nodes) {
      let text: Record<string, string | null>;
      if (node.scriptureReferenceId !== null) {
        const passage = await this.references.passageText(
          node.scriptureReferenceId,
          scriptureChars,
        );
        text = { reference: passage?.label ?? null, text: passage?.text ?? null };
      } else if (node.type === 'source') {
        text = {
          title: node.title,
          locator: node.payloadJson?.locator ?? node.payloadJson?.url ?? null,
          excerpt: node.payloadJson?.excerpt ?? null,
          excerptKind: node.payloadJson?.excerptKind ?? null,
        };
      } else {
        text = { text: node.title ?? node.body };
      }
      found.set(node.id, {
        id: node.id,
        type: node.type,
        status: node.questionStatus ?? node.conclusionStatus,
        established: node.establishedAt !== null,
        revision: node.revision,
        text,
      });
    }
    return found;
  }

  /**
   * Every live node of a study the caller has already resolved as the owner's, as list items:
   * the one mapping `GET /nodes` and `GET /graph` (BIB-28) share, so they cannot drift. Two
   * statements whatever the node count (the nodes, then one batched reference lookup); inside a
   * managed transaction both join it.
   */
  async liveSummaries(ownerId: string, studyId: string): Promise<NodeSummary[]> {
    const nodes = await StudyNode.findAll({
      where: { studyId, ownerId, deletedAt: null },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return this.summaries({ studyId, ownerId }, nodes);
  }

  /** These nodes of one study as list items, in the given order (labels in one batched lookup). */
  private async summaries(
    scope: { studyId: string; ownerId: string },
    nodes: StudyNode[],
  ): Promise<NodeSummary[]> {
    const references = await this.references.storedReferences(
      nodes.flatMap((node) => (node.scriptureReferenceId ? [node.scriptureReferenceId] : [])),
    );
    const conclusionIds = nodes.filter((node) => node.type === 'conclusion').map((n) => n.id);
    const support = supportCounts(await liveEvidence(scope, conclusionIds), conclusionIds);
    return nodes.map((node) => ({
      id: node.id,
      type: node.type,
      origin: node.origin,
      label: nodeLabel(node, references),
      status: node.questionStatus ?? node.conclusionStatus,
      observationKind: node.observationKind,
      referenceId: node.scriptureReferenceId,
      canonicalNodeId: node.canonicalNodeId,
      established: node.establishedAt !== null,
      evidenceIncomplete: isEvidenceIncomplete(node.conclusionStatus, support.get(node.id) ?? 0),
      revision: node.revision,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
    }));
  }

  /** BIB-57: the note a node was converted from, and whether it is in the note trash now. */
  private async derivedFromNote(node: StudyNode): Promise<DerivedFromNote> {
    const noteId = node.derivedFromNoteId;
    if (noteId === null) return null;
    const trashed = await this.notes.noteTrashState(node.ownerId, node.studyId, [noteId]);
    // The composite FK keeps the note in this study; it only disappears with the study itself.
    return { id: noteId, trashed: trashed.get(noteId) ?? false };
  }

  /** `GET /studies/:studyId/nodes/:nodeId`: one live node with its full typed content. */
  async get(ownerId: string, studyId: string, nodeId: string): Promise<NodeResponse> {
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId);
    const common = {
      id: node.id,
      studyId: node.studyId,
      origin: node.origin,
      canonicalNodeId: node.canonicalNodeId,
      revision: node.revision,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
    };
    switch (node.type) {
      case 'scripture': {
        const referenceId = required(node.scriptureReferenceId);
        const stored = await this.references.storedReferences([referenceId]);
        const reference: ScriptureReference | null = stored.get(referenceId) ?? null;
        return { type: 'scripture', ...common, reference };
      }
      case 'question':
        return {
          type: 'question',
          ...common,
          text: required(node.title),
          status: required(node.questionStatus),
        };
      case 'observation':
        return {
          type: 'observation',
          ...common,
          text: required(node.body),
          observationKind: required(node.observationKind),
          establishedAt: node.establishedAt?.toISOString() ?? null,
          derivedFromNote: await this.derivedFromNote(node),
        };
      case 'thought':
        return {
          type: 'thought',
          ...common,
          text: required(node.body),
          derivedFromNote: await this.derivedFromNote(node),
        };
      case 'conclusion': {
        const support =
          supportCounts(await liveEvidence({ studyId, ownerId }, [node.id]), [node.id]).get(
            node.id,
          ) ?? 0;
        const version = await NodeVersion.findOne({
          where: { nodeId: node.id, studyId, ownerId },
          attributes: ['id', 'versionNumber'],
          order: [['versionNumber', 'DESC']],
        });
        if (!version) throw new Error('conclusion without a version');
        const status = required(node.conclusionStatus);
        return {
          type: 'conclusion',
          ...common,
          text: required(node.title),
          status,
          establishedAt: node.establishedAt?.toISOString() ?? null,
          evidenceIncomplete: isEvidenceIncomplete(status, support),
          liveEvidenceCount: support,
          version: { id: version.id, number: version.versionNumber },
        };
      }
      case 'source':
        return { type: 'source', ...common, source: sourceOf(node) };
    }
  }

  /**
   * `GET /studies/:studyId/nodes/:nodeId/versions` (BIB-30; FR-CONCLUSION-001/005): a conclusion's
   * immutable versions, newest first, unpaginated, each with its evidence snapshot and what that
   * evidence is now (relationship removed or retyped since, node deleted or edited since). Three
   * statements whatever the history (versions, their evidence, then the edges, nodes and
   * references to label them). A node that is not a conclusion has none. Archived and trashed
   * studies stay readable.
   */
  async versions(
    ownerId: string,
    studyId: string,
    nodeId: string,
  ): Promise<NodeVersionListResponse> {
    const node = await this.access.requireOwnedNode(ownerId, studyId, nodeId);
    if (node.type !== 'conclusion') return { items: [] };
    const versions = await NodeVersion.findAll({
      where: { nodeId: node.id, studyId, ownerId },
      order: [['versionNumber', 'DESC']],
    });
    const evidence = await NodeVersionEvidence.findAll({
      where: { studyId, ownerId, versionId: versions.map((version) => version.id) },
      order: [
        ['role', 'DESC'],
        ['edgeType', 'ASC'],
        ['edgeId', 'ASC'],
      ],
    });
    const edges = await StudyEdge.findAll({
      where: { studyId, ownerId, id: [...new Set(evidence.map((row) => row.edgeId))] },
      attributes: ['id', 'type', 'deletedAt'],
    });
    const nodes = await StudyNode.findAll({
      where: { studyId, ownerId, id: [...new Set(evidence.map((row) => row.nodeId))] },
    });
    const references = await this.references.storedReferences(
      nodes.flatMap((other) => (other.scriptureReferenceId ? [other.scriptureReferenceId] : [])),
    );
    const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
    const nodeById = new Map(nodes.map((other) => [other.id, other]));
    return {
      items: versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        action: version.action as NodeVersionListResponse['items'][number]['action'],
        statement: version.statement,
        status: version.conclusionStatus,
        established: version.established,
        changeReason: version.changeReason,
        createdAt: version.createdAt.toISOString(),
        evidence: evidence
          .filter((row) => row.versionId === version.id)
          .map((row) => {
            const edge = edgeById.get(row.edgeId);
            const other = nodeById.get(row.nodeId);
            if (!edge || !other) throw new Error('evidence row without its edge or node');
            return {
              edgeId: row.edgeId,
              edgeType: row.edgeType,
              role: row.role,
              nodeId: row.nodeId,
              nodeType: other.type,
              label: nodeLabel(other, references),
              nodeRevision: row.nodeRevision,
              nodeVersionId: row.nodeVersionId,
              edgeLive: edge.deletedAt === null && edge.type === row.edgeType,
              nodeLive: other.deletedAt === null,
              nodeChangedSince: other.revision !== row.nodeRevision,
            };
          }),
      })),
    };
  }

  private async requireReference(referenceId: string): Promise<void> {
    try {
      await this.references.storedReference(referenceId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new ReferenceNotFoundError();
      throw error;
    }
  }
}

/**
 * What a PATCH changes on this node, or why it cannot. Observation: `text` and/or
 * `observationKind`; Thought: `text`; Source: `source`, replaced whole. Anything else (another
 * type, or a field of another type) is `NODE_NOT_EDITABLE`; no change at all is `NODE_UNCHANGED`.
 */
function editOf(
  node: StudyNode,
  body: UpdateNodeBody,
): {
  values: Partial<NodeValues>;
  eventType: string;
  payload: Record<string, unknown>;
  warnings: NodeWarning[];
} {
  const { text, observationKind, source } = body;
  if (
    body.status !== undefined ||
    body.changeReason !== undefined ||
    (body.establishment !== undefined && node.type !== 'observation')
  ) {
    // Statuses and reasons belong to questions and conclusions; the marker to conclusions and
    // observations (BIB-62).
    throw new NodeRuleError(NODE_NOT_EDITABLE);
  }
  switch (node.type) {
    case 'observation':
      return observationEditOf(node, body);
    case 'thought': {
      if (observationKind !== undefined || source !== undefined || text === undefined) {
        throw new NodeRuleError(NODE_NOT_EDITABLE);
      }
      if (text === node.body) throw new NodeRuleError(NODE_UNCHANGED);
      return {
        values: { body: text },
        eventType: NODE_EVENTS.thoughtUpdated,
        payload: {},
        warnings: [],
      };
    }
    case 'source': {
      if (text !== undefined || observationKind !== undefined || source === undefined) {
        throw new NodeRuleError(NODE_NOT_EDITABLE);
      }
      const values = sourceColumns(source);
      if (values.title === node.title && isDeepStrictEqual(values.payloadJson, node.payloadJson)) {
        throw new NodeRuleError(NODE_UNCHANGED);
      }
      return {
        values,
        eventType: NODE_EVENTS.sourceUpdated,
        payload: { sourceKind: source.kind },
        warnings: [],
      };
    }
    default:
      // Questions and conclusions are handled before this (BIB-30); a Scripture node's
      // identity is immutable.
      throw new NodeRuleError(NODE_NOT_EDITABLE);
  }
}

/**
 * An Observation's PATCH (BIB-25; BIB-62): `establishment` alone marks or unmarks "Established by
 * me" (no evidence needed: an observation is the user's own statement); an edit of `text` and/or
 * `observationKind` saves and clears the marker in the same write (`establishment_cleared`),
 * because the owner established that exact statement and kind. Both together is 400.
 */
function observationEditOf(node: StudyNode, body: UpdateNodeBody): ReturnType<typeof editOf> {
  const { text, observationKind, source, establishment } = body;
  if (source !== undefined) throw new NodeRuleError(NODE_NOT_EDITABLE);
  const established = node.establishedAt !== null;
  if (establishment !== undefined) {
    if (text !== undefined || observationKind !== undefined) {
      throw new ValidationError('Invalid request', { establishment: [ESTABLISHMENT_ALONE] });
    }
    const set = establishment === 'set';
    if (set === established) throw new NodeRuleError(NODE_UNCHANGED);
    if (set) {
      return {
        values: { establishedAt: fn('now') },
        eventType: NODE_EVENTS.observationEstablished,
        payload: { observationKind: node.observationKind },
        warnings: [],
      };
    }
    return {
      values: { establishedAt: null },
      eventType: NODE_EVENTS.observationUpdated,
      payload: {
        observationKind: node.observationKind,
        established: false,
        previousEstablished: true,
      },
      warnings: [],
    };
  }
  const values = {
    body: text ?? node.body,
    observationKind: observationKind ?? node.observationKind,
  };
  if (values.body === node.body && values.observationKind === node.observationKind) {
    throw new NodeRuleError(NODE_UNCHANGED);
  }
  return {
    values: { ...values, establishedAt: null },
    eventType: NODE_EVENTS.observationUpdated,
    payload: {
      observationKind: values.observationKind,
      established: false,
      previousEstablished: established,
    },
    warnings: established ? ['establishment_cleared'] : [],
  };
}

/** `revision + 1` in an UPDATE's values (bulk updates outside `updateWithExpectedRevision`). */
const NEXT_REVISION = literal('revision + 1') as unknown as number;

/**
 * BIB-31, after `node` (already soft-deleted) when it was a canonical Scripture node with live
 * duplicates: its oldest live duplicate (created_at, then id) becomes canonical, then every other
 * row naming the deleted node, live or deleted, names the promoted one. Each changed row's revision
 * moves, so a client holding an old copy gets 409. Returns the promoted node's id, or null.
 */
async function promoteCanonical(m: StudyMutation, node: StudyNode): Promise<string | null> {
  if (node.type !== 'scripture' || node.canonicalNodeId !== null) return null;
  const scope = { studyId: m.studyId, ownerId: m.ownerId };
  const oldest = await StudyNode.findOne({
    where: { ...scope, canonicalNodeId: node.id, deletedAt: null },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (!oldest) return null;
  await m.updateWithExpectedRevision(StudyNode, {
    id: oldest.id,
    expectedRevision: oldest.revision,
    values: { canonicalNodeId: null },
  });
  await StudyNode.update(
    { canonicalNodeId: oldest.id, revision: NEXT_REVISION },
    { where: { ...scope, canonicalNodeId: node.id } },
  );
  return oldest.id;
}

/**
 * BIB-31: the canonical node a restored Scripture node must name. When its passage already has a
 * live canonical node C, every row naming the restored node is re-pointed to C first (so the
 * canonical-target trigger never sees a chain) and C is returned: it comes back as C's duplicate.
 * Otherwise null: it comes back canonical. Any other type: null.
 */
async function restoredCanonical(m: StudyMutation, node: StudyNode): Promise<string | null> {
  if (node.type !== 'scripture') return null;
  const scope = { studyId: m.studyId, ownerId: m.ownerId };
  const live = await StudyNode.findOne({
    where: {
      ...scope,
      type: 'scripture',
      scriptureReferenceId: node.scriptureReferenceId,
      canonicalNodeId: null,
      deletedAt: null,
    },
    attributes: ['id'],
  });
  if (!live) return null;
  await StudyNode.update(
    { canonicalNodeId: live.id, revision: NEXT_REVISION },
    { where: { ...scope, canonicalNodeId: node.id } },
  );
  return live.id;
}

/**
 * BIB-31: brings back the edges `nodeId`'s deletion removed (now that it is live again), oldest
 * first, under their own ids. Each one is restored, or stays deleted with a reason:
 * `endpoint_deleted` (the other end is deleted; `deleted_with_node_id` is handed to it so its own
 * restore brings the edge back), `duplicate` (an identical live edge exists: the user's newer edge
 * wins) or `limit` (the study's edge cap).
 */
async function restoreEdges(m: StudyMutation, nodeId: string) {
  const scope = { studyId: m.studyId, ownerId: m.ownerId };
  const edges = await StudyEdge.findAll({
    where: { ...scope, deletedWithNodeId: nodeId },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const restoredEdgeIds: string[] = [];
  const skippedEdges: { edgeId: string; reason: SkippedEdgeReason }[] = [];
  if (edges.length === 0) return { restoredEdgeIds, skippedEdges };
  const otherIds = edges.map((e) => (e.sourceNodeId === nodeId ? e.targetNodeId : e.sourceNodeId));
  const liveOthers = new Set(
    (
      await StudyNode.findAll({
        where: { ...scope, id: [...new Set(otherIds)], deletedAt: null },
        attributes: ['id'],
      })
    ).map((n) => n.id),
  );
  let liveEdges = await StudyEdge.count({ where: { ...scope, deletedAt: null } });
  for (const [index, edge] of edges.entries()) {
    const otherId = otherIds[index] as string;
    let reason: SkippedEdgeReason | null = null;
    if (!liveOthers.has(otherId)) reason = 'endpoint_deleted';
    else {
      const twin = await StudyEdge.findOne({
        where: {
          ...scope,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          type: edge.type,
          deletedAt: null,
        },
        attributes: ['id'],
      });
      if (twin) reason = 'duplicate';
      else if (liveEdges >= MAX_EDGES_PER_STUDY) reason = 'limit';
    }
    const values =
      reason === null
        ? { deletedAt: null, deletedWithNodeId: null }
        : { deletedWithNodeId: reason === 'endpoint_deleted' ? otherId : null };
    await StudyEdge.update(
      { ...values, revision: NEXT_REVISION },
      { where: { ...scope, id: edge.id } },
    );
    if (reason === null) {
      restoredEdgeIds.push(edge.id);
      liveEdges += 1;
    } else skippedEdges.push({ edgeId: edge.id, reason });
  }
  return { restoredEdgeIds, skippedEdges };
}

/**
 * The live node being changed, read inside the mutation (the study lock is held, so no other
 * mutation of the study can change it meanwhile): absent, deleted, another study's or another
 * owner's is 404; a stale `expectedRevision` is 409 before any rule.
 */
async function lockedNode(m: StudyMutation, nodeId: string, expectedRevision: number) {
  if (!isResourceId(nodeId)) throw new NotFoundError();
  const node = await StudyNode.findOne({
    where: { id: nodeId, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (!node) throw new NotFoundError();
  if (node.revision !== expectedRevision) throw new RevisionConflictError(node.revision);
  return node;
}
