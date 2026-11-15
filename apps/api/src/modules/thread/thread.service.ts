import { Injectable } from '@nestjs/common';
import { type StudyEventActorKind, studyEventVisibility } from '@bible-artisan/contracts';
import { StudyEvent } from '../../database/models/study-event.model';
import { isUuid } from '../../common/validation/uuid';
import { StudyLock } from '../study/study-revision.service';

export interface AppendEventInput {
  /** A PRD §13 event family, e.g. `study_renamed`. */
  eventType: string;
  /** Bounded, readable labels only (PRD §23): no full chapters, note bodies, or excerpts. */
  payload?: Record<string, unknown>;
  /** Client occurrence time when known; defaults to now. */
  occurredAt?: Date;
  /** Defaults to `user`. AI-originated events say `ai` (PRD section 13). */
  actorKind?: StudyEventActorKind;
  /**
   * Navigation refs (BIB-55). When left out, `node_id`, `from_node_id`, `branch_id` and
   * `version_id` are derived from the payload keys the domain writers already use.
   */
  nodeId?: string | null;
  fromNodeId?: string | null;
  branchId?: string | null;
  versionId?: string | null;
  parentVisitEventId?: string | null;
  sessionId?: string | null;
  clientMutationId?: string | null;
  /** The request's correlation id; `StudyMutation.appendEvent` fills it in. */
  correlationId?: string | null;
}

export interface AppendedEvent {
  id: string;
  /** Per-study sequence as a decimal string (bigint; never convert with Number()). */
  sequence: string;
}

function uuidOf(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : null;
}

/**
 * The node an event is about, and the node it came from, from its payload (the same rules as the
 * BIB-55 migration's backfill): a connection is about its target and comes from its source; a
 * main-question change from the old question to the new; a new study is about its question, else
 * its passage.
 */
export function derivedRefs(
  eventType: string,
  payload: Record<string, unknown>,
): {
  nodeId: string | null;
  fromNodeId: string | null;
  branchId: string | null;
  versionId: string | null;
} {
  let nodeId: string | null;
  let fromNodeId: string | null = null;
  switch (eventType) {
    case 'study_created':
      nodeId = uuidOf(payload, 'questionNodeId') ?? uuidOf(payload, 'scriptureNodeId');
      break;
    case 'main_question_changed':
      nodeId = uuidOf(payload, 'toNodeId');
      fromNodeId = uuidOf(payload, 'fromNodeId');
      break;
    case 'node_connected':
    case 'edge_removed':
      nodeId = uuidOf(payload, 'targetNodeId');
      fromNodeId = uuidOf(payload, 'sourceNodeId');
      break;
    default:
      nodeId =
        uuidOf(payload, 'nodeId') ??
        uuidOf(payload, 'questionNodeId') ??
        uuidOf(payload, 'rootNodeId');
  }
  return {
    nodeId,
    fromNodeId,
    branchId: uuidOf(payload, 'branchId'),
    versionId: uuidOf(payload, 'versionId'),
  };
}

/**
 * Writes Study Thread events (PRD §13). The only way to insert into `study_event`.
 *
 * `appendEvent` requires the `StudyLock` of a running mutation: the event is written in that
 * mutation's transaction (committed atomically with it, or not at all, FR-THREAD-001), owner and
 * study come from the lock rather than the caller, and its sequence is allocated from the locked
 * study counter. Domain code reaches it through `StudyMutation.appendEvent`
 * (`MutationService.execute`), never directly. Visibility comes from the event type (PRD section
 * 13's internal-only families), never from the caller.
 */
@Injectable()
export class ThreadService {
  async appendEvent(lock: StudyLock, input: AppendEventInput): Promise<AppendedEvent> {
    if (!(lock instanceof StudyLock)) {
      throw new Error('ThreadService.appendEvent requires the mutation StudyLock');
    }
    const { eventType, payload = {}, occurredAt } = input;
    const derived = derivedRefs(eventType, payload);
    const sequence = lock.allocateEventSequence();
    const event = await StudyEvent.create(
      {
        ownerId: lock.ownerId,
        studyId: lock.studyId,
        sequence,
        eventType,
        payloadJson: payload,
        ...(occurredAt ? { occurredAt } : {}),
        visibility: studyEventVisibility(eventType),
        actorKind: input.actorKind ?? 'user',
        nodeId: input.nodeId !== undefined ? input.nodeId : derived.nodeId,
        fromNodeId: input.fromNodeId !== undefined ? input.fromNodeId : derived.fromNodeId,
        branchId: input.branchId !== undefined ? input.branchId : derived.branchId,
        versionId: input.versionId !== undefined ? input.versionId : derived.versionId,
        parentVisitEventId: input.parentVisitEventId ?? null,
        sessionId: input.sessionId ?? null,
        clientMutationId: input.clientMutationId ?? null,
        correlationId: input.correlationId ?? null,
        recordedAt: new Date(),
      },
      { transaction: lock.transaction },
    );
    return { id: event.id, sequence };
  }
}
