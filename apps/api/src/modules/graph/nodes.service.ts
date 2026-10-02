import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  createNodeRequestSchema,
  type CreateNodeResponse,
  NODE_NOT_EDITABLE,
  NODE_UNCHANGED,
  type NodeListResponse,
  type NodeMutationResponse,
  nodeLabel,
  type NodeResponse,
  type ScriptureReference,
  type Source,
  type SourceCitation,
  updateNodeRequestSchema,
} from '@bible-artisan/contracts';
import type { z } from 'zod';
import {
  NodeRuleError,
  NotFoundError,
  ReferenceNotFoundError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { StudyNode } from '../../database/models/study-node.model';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { StudyAccessService } from '../study/study-access.service';
import { QUESTION_CREATED } from '../study/study-events';
import { type NewNodeValues, StudyGraphService } from '../study/study-graph.service';
import { StudyRevisionService } from '../study/study-revision.service';

type CreateNodeBody = z.output<typeof createNodeRequestSchema>;
type UpdateNodeBody = z.output<typeof updateNodeRequestSchema>;
type ScriptureBody = Extract<CreateNodeBody, { type: 'scripture' }>;
type NodeValues = NewNodeValues;

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
 */
export const NODE_EVENTS = {
  scripture: 'scripture_added_to_graph',
  scriptureRevisited: 'scripture_revisited',
  question: QUESTION_CREATED,
  observation: 'observation_created',
  thought: 'thought_created',
  conclusion: 'conclusion_created',
  source: 'source_created',
  observationUpdated: 'observation_updated',
  thoughtUpdated: 'thought_updated',
  sourceUpdated: 'source_updated',
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
      };
    case 'thought':
      return { type: 'thought', origin: 'user', body: body.text };
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

/** A citation as stored: the title in `title`, everything else in `payload_json`. */
function sourceColumns({ title, ...payload }: SourceCitation) {
  return { title, payloadJson: payload };
}

function createdEvent(node: StudyNode, branchId: string | null) {
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
        payload: { nodeId: node.id, observationKind: node.observationKind },
      };
    case 'thought':
      return { eventType: NODE_EVENTS.thought, payload: { nodeId: node.id } };
    case 'conclusion':
      return { eventType: NODE_EVENTS.conclusion, payload: { nodeId: node.id } };
    case 'source':
      return {
        eventType: NODE_EVENTS.source,
        payload: { nodeId: node.id, sourceKind: node.payloadJson?.kind ?? null },
      };
  }
}

function mutationBody(node: StudyNode, lastEventSequence: string): NodeMutationResponse {
  return {
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
        const node = await this.graph.addNode(m, newNodeValues(body));
        m.bumpContentRevision();
        const branchId = node.type === 'question' ? await this.graph.ensureInitialBranch(m) : null;
        const event = await m.appendEvent(createdEvent(node, branchId));
        const response: CreateNodeResponse = {
          ...mutationBody(node, event.sequence),
          studyRevision,
          outcome: 'created',
          canonicalNodeId: null,
        };
        return { status: 201, body: response };
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
        const { values, eventType, payload } = editOf(current, body);
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
        return { status: 200, body: mutationBody(updated, event.sequence) };
      },
    });
  }

  /**
   * `GET /studies/:studyId/nodes`: every live node of the study, oldest first (ties by id), each
   * with its label (`nodeLabel`, shared with a note's target; Scripture labels in one batched
   * lookup). Unpaginated and never truncated: every creating path enforces the live-node cap, so
   * the list is bounded by it, and a study over the cap (rows written before the cap existed)
   * still lists all of its nodes rather than silently dropping the newest. Archived and trashed
   * studies stay readable.
   */
  async list(ownerId: string, studyId: string): Promise<NodeListResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const nodes = await StudyNode.findAll({
      where: { studyId, ownerId, deletedAt: null },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    const references = await this.references.storedReferences(
      nodes.flatMap((node) => (node.scriptureReferenceId ? [node.scriptureReferenceId] : [])),
    );
    return {
      items: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        origin: node.origin,
        label: nodeLabel(node, references),
        status: node.questionStatus ?? node.conclusionStatus,
        observationKind: node.observationKind,
        referenceId: node.scriptureReferenceId,
        canonicalNodeId: node.canonicalNodeId,
        revision: node.revision,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
      })),
    };
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
        };
      case 'thought':
        return { type: 'thought', ...common, text: required(node.body) };
      case 'conclusion':
        return {
          type: 'conclusion',
          ...common,
          text: required(node.title),
          status: required(node.conclusionStatus),
        };
      case 'source':
        return { type: 'source', ...common, source: sourceOf(node) };
    }
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
): { values: Partial<NodeValues>; eventType: string; payload: Record<string, unknown> } {
  const { text, observationKind, source } = body;
  switch (node.type) {
    case 'observation': {
      if (source !== undefined) throw new NodeRuleError(NODE_NOT_EDITABLE);
      const values = {
        body: text ?? node.body,
        observationKind: observationKind ?? node.observationKind,
      };
      if (values.body === node.body && values.observationKind === node.observationKind) {
        throw new NodeRuleError(NODE_UNCHANGED);
      }
      return {
        values,
        eventType: NODE_EVENTS.observationUpdated,
        payload: { observationKind: values.observationKind },
      };
    }
    case 'thought': {
      if (observationKind !== undefined || source !== undefined || text === undefined) {
        throw new NodeRuleError(NODE_NOT_EDITABLE);
      }
      if (text === node.body) throw new NodeRuleError(NODE_UNCHANGED);
      return { values: { body: text }, eventType: NODE_EVENTS.thoughtUpdated, payload: {} };
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
      };
    }
    default:
      // Questions are never rewritten in place (BIB-20 makes a new one), conclusions version
      // every semantic edit (BIB-30), and a Scripture node's identity is immutable.
      throw new NodeRuleError(NODE_NOT_EDITABLE);
  }
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
