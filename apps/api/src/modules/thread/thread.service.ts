import { Injectable } from '@nestjs/common';
import {
  isMeaningfulEventType,
  SCRIPTURE_OPENED,
  SESSION_IDLE_MS,
  type SessionEndReason,
  type StudyEventActorKind,
  studyEventVisibility,
} from '@bible-artisan/contracts';
import { StudyEvent } from '../../database/models/study-event.model';
import { StudySession } from '../../database/models/study-session.model';
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
  clientMutationId?: string | null;
  /** The request's correlation id; `StudyMutation.appendEvent` fills it in. */
  correlationId?: string | null;
  /**
   * The request's browser tab (BIB-33); `StudyMutation.appendEvent` fills it in. A meaningful
   * event from a tab starts or continues that tab's session in this study and records its id.
   */
  tabInstanceId?: string | null;
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
    case 'edge_restored':
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

export const SESSION_STARTED = 'session_started';
export const SESSION_ENDED = 'session_ended';

/** The session a mutation's events joined, resolved once per study lock. */
interface ResolvedSession {
  tabInstanceId: string;
  session: StudySession;
}

/**
 * Writes Study Thread events (PRD §13). The only way to insert into `study_event`, and (BIB-33)
 * the only writer of `study_session`.
 *
 * `appendEvent` requires the `StudyLock` of a running mutation: the event is written in that
 * mutation's transaction (committed atomically with it, or not at all, FR-THREAD-001), owner and
 * study come from the lock rather than the caller, and its sequence is allocated from the locked
 * study counter. Domain code reaches it through `StudyMutation.appendEvent`
 * (`MutationService.execute`), never directly. Visibility comes from the event type (PRD section
 * 13's internal-only families), never from the caller.
 *
 * Sessions (BIB-33; PRD sections 8, 23): one browser tab's period of meaningful activity in one
 * study. A meaningful event (anything but layout, view-state and session bookkeeping) from a tab
 * joins that tab's open session in the study, or starts one (`session_started`) when there is
 * none or the open one has been idle more than 30 minutes; the idle one is closed first
 * (`session_ended`, reason `inactivity`) and its events keep their session (nothing earlier is
 * rewritten). Reads, restoration and background saves never start a session. Tabs never share a
 * session; they share the study revision. Everything runs under the study row lock, so two
 * requests cannot open two sessions for one tab; the partial unique index is the backstop.
 */
@Injectable()
export class ThreadService {
  private readonly sessions = new WeakMap<StudyLock, ResolvedSession>();

  async appendEvent(lock: StudyLock, input: AppendEventInput): Promise<AppendedEvent> {
    if (!(lock instanceof StudyLock)) {
      throw new Error('ThreadService.appendEvent requires the mutation StudyLock');
    }
    const meaningful = isMeaningfulEventType(input.eventType);
    const session =
      meaningful && input.tabInstanceId
        ? await this.joinSession(lock, input.tabInstanceId, input.occurredAt ?? new Date())
        : null;
    const event = await this.insert(lock, input, session?.id ?? null);
    if (meaningful) lock.noteMeaningfulEvent();
    if (session) {
      const values: { lastVisitEventId?: string; activeBranchId?: string } = {};
      if (input.eventType === SCRIPTURE_OPENED) values.lastVisitEventId = event.id;
      if (event.branchId) values.activeBranchId = event.branchId;
      if (Object.keys(values).length > 0) {
        await session.update(values, { transaction: lock.transaction });
      }
    }
    return { id: event.id, sequence: event.sequence };
  }

  /**
   * The study's last deliberate visit (BIB-34's resume), owner-scoped, or null. A read: callers
   * pass the session's owner and an owned study.
   */
  lastVisit(ownerId: string, studyId: string): Promise<StudyEvent | null> {
    return StudyEvent.findOne({
      where: { ownerId, studyId, eventType: SCRIPTURE_OPENED },
      order: [['sequence', 'DESC']],
    });
  }

  /**
   * Explicit exit (BIB-33): ends this tab's open session in the study with a `session_ended`
   * event (reason `exit`), or returns null, writing nothing, when the tab has none.
   */
  async endTabSession(
    lock: StudyLock,
    tabInstanceId: string,
    correlationId: string | null,
  ): Promise<{ sessionId: string; sequence: string } | null> {
    if (!(lock instanceof StudyLock)) {
      throw new Error('ThreadService.endTabSession requires the mutation StudyLock');
    }
    lock.assertHeld();
    const open = await this.openSession(lock, tabInstanceId);
    if (!open) return null;
    const event = await this.close(lock, open, 'exit', new Date(), correlationId);
    this.sessions.delete(lock);
    return { sessionId: open.id, sequence: event.sequence };
  }

  private openSession(lock: StudyLock, tabInstanceId: string): Promise<StudySession | null> {
    return StudySession.findOne({
      where: { ownerId: lock.ownerId, studyId: lock.studyId, tabInstanceId, endedAt: null },
      transaction: lock.transaction,
    });
  }

  private async joinSession(
    lock: StudyLock,
    tabInstanceId: string,
    at: Date,
  ): Promise<StudySession> {
    const resolved = this.sessions.get(lock);
    if (resolved?.tabInstanceId === tabInstanceId) return resolved.session;

    let session = await this.openSession(lock, tabInstanceId);
    if (session && at.getTime() - session.lastMeaningfulActivityAt.getTime() > SESSION_IDLE_MS) {
      // Closed as of its last activity plus the idle window (never later than now).
      const endedAt = new Date(
        Math.min(session.lastMeaningfulActivityAt.getTime() + SESSION_IDLE_MS, Date.now()),
      );
      await this.close(lock, session, 'inactivity', endedAt, null);
      session = null;
    }
    if (session) {
      if (at > session.lastMeaningfulActivityAt) {
        await session.update({ lastMeaningfulActivityAt: at }, { transaction: lock.transaction });
      }
    } else {
      session = await StudySession.create(
        {
          ownerId: lock.ownerId,
          studyId: lock.studyId,
          tabInstanceId,
          startedAt: at,
          lastMeaningfulActivityAt: at,
        },
        { transaction: lock.transaction },
      );
      await this.insert(lock, { eventType: SESSION_STARTED, occurredAt: at }, session.id);
    }
    this.sessions.set(lock, { tabInstanceId, session });
    return session;
  }

  private async close(
    lock: StudyLock,
    session: StudySession,
    reason: SessionEndReason,
    endedAt: Date,
    correlationId: string | null,
  ): Promise<StudyEvent> {
    const end = endedAt < session.startedAt ? session.startedAt : endedAt;
    await session.update({ endedAt: end, endReason: reason }, { transaction: lock.transaction });
    return this.insert(
      lock,
      { eventType: SESSION_ENDED, payload: { reason }, occurredAt: end, correlationId },
      session.id,
    );
  }

  private insert(
    lock: StudyLock,
    input: AppendEventInput,
    sessionId: string | null,
  ): Promise<StudyEvent> {
    const { eventType, payload = {}, occurredAt } = input;
    const derived = derivedRefs(eventType, payload);
    const sequence = lock.allocateEventSequence();
    return StudyEvent.create(
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
        sessionId,
        clientMutationId: input.clientMutationId ?? null,
        correlationId: input.correlationId ?? null,
        recordedAt: new Date(),
      },
      { transaction: lock.transaction },
    );
  }
}
