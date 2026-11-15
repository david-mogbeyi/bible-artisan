import { Injectable } from '@nestjs/common';
import {
  DELAYED_SYNC_MS,
  type StudyEventDetail,
  type StudyEventItem,
  type ThreadEventsResponse,
  type ThreadFilter,
  type ThreadOrigin,
  type ThreadRef,
  threadEventsQuerySchema,
} from '@bible-artisan/contracts';
import { Op, type WhereOptions } from 'sequelize';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-errors';
import { parseBody } from '../../../common/validation/parse-body';
import { isResourceId } from '../../../common/validation/resource-id';
import { isUuid } from '../../../common/validation/uuid';
import type { StudyNode } from '../../../database/models/study-node.model';
import { StudyEvent } from '../../../database/models/study-event.model';
import { ReferenceService } from '../../bible-content/reference/reference.service';
import { StudyAccessService } from '../../study/study-access.service';
import { StudyGraphService } from '../../study/study-graph.service';
import { decodeThreadCursor, encodeThreadCursor, type ThreadListing } from './thread-cursor';
import { type DisplayRef, displayText } from './thread-display';

/** PRD section 11's thread filters, as event types. `all` is every type. */
const FILTER_TYPES: Record<Exclude<ThreadFilter, 'all'>, string[]> = {
  questions: ['question_created', 'question_status_changed', 'main_question_changed'],
  conclusions: [
    'conclusion_created',
    'conclusion_updated',
    'conclusion_challenged',
    'conclusion_established',
    'conclusion_abandoned',
    'conclusion_establishment_cleared',
  ],
  navigation: [
    'scripture_opened',
    'scripture_revisited',
    'cross_reference_followed',
    'source_opened',
  ],
};

/**
 * A filter's events. Questions also lists the acceptance of an AI-suggested question: it shares
 * the created question's action, so that card still says the question came from an AI suggestion
 * the user accepted (FR-AI-013) rather than reading as the user's own.
 */
function filterWhere(filter: ThreadFilter): WhereOptions {
  if (filter === 'all') return {};
  if (filter !== 'questions') return { eventType: FILTER_TYPES[filter] };
  return {
    [Op.or]: [
      { eventType: FILTER_TYPES.questions },
      { eventType: 'ai_suggestion_accepted', payloadJson: { capability: 'questions' } },
    ],
  };
}

/** Correlated records shown with one event's details (one action writes a handful at most). */
const CORRELATED_MAX = 50;

const NOUNS: Record<string, string> = {
  scripture: 'a passage',
  question: 'a question',
  observation: 'an observation',
  thought: 'a thought',
  conclusion: 'a conclusion',
  source: 'a source',
};
const LABEL_MAX = 120;

function bounded(text: string | null): string | null {
  if (text === null) return null;
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('')}…` : chars.join('');
}

function stringOf(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function idOf(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return isUuid(value) ? value.toLowerCase() : null;
}

/** Labels for one page of events: nodes (live or deleted), branch roots, references. */
interface Labels {
  nodes: Map<string, StudyNode>;
  references: Map<string, string>;
  branchRoots: Map<string, string>;
}

/**
 * Reads the Study Thread (BIB-32; PRD sections 11, 13, 24; FR-THREAD-002/005/006, NFR-PERF-005).
 * Pages are at most 50 records, by a sequence keyset, newest first by default. Internal-only
 * events are left out unless asked for. Every event becomes a card with deterministic copy;
 * events of one action share a correlation id, which the client groups into one card and
 * `GET /events/:eventId` expands into its raw records.
 */
@Injectable()
export class ThreadEventsService {
  constructor(
    private readonly access: StudyAccessService,
    private readonly graph: StudyGraphService,
    private readonly references: ReferenceService,
  ) {}

  async list(ownerId: string, studyId: string, query: unknown): Promise<ThreadEventsResponse> {
    const q = parseBody(threadEventsQuerySchema, query);
    await this.access.requireOwnedStudy(ownerId, studyId);
    const listing: ThreadListing = {
      filter: q.filter,
      order: q.order,
      branchId: q.branchId ?? null,
      includeInternal: q.includeInternal === 'true',
    };
    let after: string | null = null;
    if (q.cursor !== undefined) {
      after = decodeThreadCursor(q.cursor, listing);
      if (after === null)
        throw new ValidationError('Invalid request', { cursor: ['Invalid cursor'] });
    }
    const where: WhereOptions = {
      studyId,
      ownerId,
      ...(listing.includeInternal ? {} : { visibility: 'visible' }),
      ...filterWhere(listing.filter),
      ...(listing.branchId ? { branchId: listing.branchId } : {}),
      ...(after !== null
        ? { sequence: listing.order === 'desc' ? { [Op.lt]: after } : { [Op.gt]: after } }
        : {}),
    };
    const rows = await StudyEvent.findAll({
      where,
      order: [['sequence', listing.order === 'desc' ? 'DESC' : 'ASC']],
      limit: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await this.toItems(ownerId, studyId, page),
      nextCursor: rows.length > q.limit && last ? encodeThreadCursor(listing, last.sequence) : null,
    };
  }

  async get(ownerId: string, studyId: string, eventId: string): Promise<StudyEventDetail> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    if (!isResourceId(eventId)) throw new NotFoundError();
    const event = await StudyEvent.findOne({ where: { id: eventId, studyId, ownerId } });
    if (!event) throw new NotFoundError();
    const correlated = event.correlationId
      ? await StudyEvent.findAll({
          where: { studyId, ownerId, correlationId: event.correlationId },
          order: [['sequence', 'ASC']],
          limit: CORRELATED_MAX,
        })
      : [event];
    const items = await this.toItems(ownerId, studyId, [event, ...correlated]);
    const [first, ...rest] = items;
    if (!first) throw new Error('ThreadEventsService: the event vanished');
    return {
      event: first,
      schemaVersion: event.schemaVersion,
      details: event.payloadJson,
      correlated: rest,
    };
  }

  private async toItems(
    ownerId: string,
    studyId: string,
    rows: StudyEvent[],
  ): Promise<StudyEventItem[]> {
    const labels = await this.labels(ownerId, studyId, rows);
    return rows.map((row) => this.toItem(row, labels));
  }

  private async labels(ownerId: string, studyId: string, rows: StudyEvent[]): Promise<Labels> {
    const branchRoots = new Map<string, string>();
    if (rows.some((row) => row.branchId !== null)) {
      for (const branch of await this.graph.listBranches(ownerId, studyId)) {
        branchRoots.set(branch.id, branch.rootNodeId);
      }
    }
    const nodeIds = new Set<string>();
    for (const row of rows) {
      if (row.nodeId) nodeIds.add(row.nodeId);
      if (row.fromNodeId) nodeIds.add(row.fromNodeId);
      const root = row.branchId ? branchRoots.get(row.branchId) : undefined;
      if (root) nodeIds.add(root);
    }
    const nodes = new Map<string, StudyNode>();
    for (const node of await this.access.ownedNodesIncludingDeleted(ownerId, studyId, [
      ...nodeIds,
    ])) {
      nodes.set(node.id, node);
    }
    const referenceIds = new Set<string>();
    for (const node of nodes.values()) {
      if (node.scriptureReferenceId) referenceIds.add(node.scriptureReferenceId);
    }
    for (const row of rows) {
      const referenceId = idOf(row.payloadJson, 'referenceId');
      if (referenceId && !stringOf(row.payloadJson, 'referenceLabel'))
        referenceIds.add(referenceId);
    }
    const references = new Map<string, string>();
    for (const [id, reference] of await this.references.storedReferences([...referenceIds])) {
      references.set(id, reference.label);
    }
    return { nodes, references, branchRoots };
  }

  private nodeRef(id: string, labels: Labels): ThreadRef {
    const node = labels.nodes.get(id);
    if (!node) return { kind: 'node', id, label: null, deleted: true };
    let label: string | null = null;
    if (node.type === 'scripture' && node.scriptureReferenceId) {
      label = labels.references.get(node.scriptureReferenceId) ?? null;
    } else if (node.type === 'question' || node.type === 'conclusion' || node.type === 'source') {
      label = bounded(node.title);
    }
    return { kind: 'node', id, label, deleted: node.deletedAt !== null };
  }

  /** A node's ref for the copy: its label, or its type's noun ("a thought"). */
  private displayRef(ref: ThreadRef | null, labels: Labels): DisplayRef | null {
    if (!ref) return null;
    const node = ref.kind === 'node' ? labels.nodes.get(ref.id) : undefined;
    return node ? { ...ref, noun: NOUNS[node.type] ?? 'a node' } : ref;
  }

  private toItem(row: StudyEvent, labels: Labels): StudyEventItem {
    const payload = row.payloadJson;
    const referenceId = idOf(payload, 'referenceId');
    const edgeId = idOf(payload, 'edgeId');
    let targetRef: ThreadRef | null = null;
    if (row.nodeId) {
      targetRef = this.nodeRef(row.nodeId, labels);
    } else if (referenceId) {
      const label =
        stringOf(payload, 'referenceLabel') ?? labels.references.get(referenceId) ?? null;
      targetRef = { kind: 'reference', id: referenceId, label, deleted: false };
    } else if (edgeId) {
      targetRef = { kind: 'edge', id: edgeId, label: null, deleted: false };
    }

    let originRef: ThreadOrigin | null = null;
    const originKind = stringOf(payload, 'originKind');
    if (originKind !== null) {
      const originEventId = idOf(payload, 'originEventId');
      const originReferenceId = idOf(payload, 'originReferenceId');
      let ref: ThreadRef | null = null;
      if (row.fromNodeId) ref = this.nodeRef(row.fromNodeId, labels);
      else if (originEventId)
        ref = { kind: 'event', id: originEventId, label: null, deleted: false };
      else if (originReferenceId) {
        ref = {
          kind: 'reference',
          id: originReferenceId,
          label: stringOf(payload, 'originReferenceLabel'),
          deleted: false,
        };
      }
      originRef = { kind: originKind, ref };
    } else if (row.fromNodeId) {
      originRef = { kind: 'node', ref: this.nodeRef(row.fromNodeId, labels) };
    }

    const root = row.branchId ? labels.branchRoots.get(row.branchId) : undefined;
    const branch: DisplayRef | null = root ? this.nodeRef(root, labels) : null;
    const text = displayText({
      type: row.eventType,
      payload,
      target: this.displayRef(targetRef, labels),
      origin: this.displayRef(originRef?.ref ?? null, labels),
      branch: row.eventType === 'scripture_opened' ? branch : null,
    });

    return {
      id: row.id,
      sequence: row.sequence,
      type: row.eventType,
      visibility: row.visibility,
      actorKind: row.actorKind,
      occurredAt: row.occurredAt.toISOString(),
      recordedAt: row.recordedAt.toISOString(),
      sessionId: row.sessionId,
      displayText: text,
      targetRef,
      originRef,
      branchId: row.branchId,
      parentVisitEventId: row.parentVisitEventId,
      correlationId: row.correlationId,
      delayedSync: row.recordedAt.getTime() - row.occurredAt.getTime() > DELAYED_SYNC_MS,
    };
  }
}
