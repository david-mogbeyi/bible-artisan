import { Injectable } from '@nestjs/common';
import { StudyEvent } from '../../database/models/study-event.model';
import { StudyLock } from '../study/study-revision.service';

export interface AppendEventInput {
  /** A PRD §13 event family, e.g. `study_renamed`. */
  eventType: string;
  /** Bounded, readable labels only (PRD §23): no full chapters, note bodies, or excerpts. */
  payload?: Record<string, unknown>;
  /** Client occurrence time when known; defaults to now. */
  occurredAt?: Date;
}

export interface AppendedEvent {
  id: string;
  /** Per-study sequence as a decimal string (bigint; never convert with Number()). */
  sequence: string;
}

/**
 * Writes Study Thread events (PRD §13). The only way to insert into `study_event`.
 *
 * `appendEvent` requires the `StudyLock` of a running mutation: the event is written in that
 * mutation's transaction (committed atomically with it, or not at all, FR-THREAD-001), owner and
 * study come from the lock rather than the caller, and its sequence is allocated from the locked
 * study counter. Domain code reaches it through `StudyMutation.appendEvent`
 * (`MutationService.execute`), never directly.
 */
@Injectable()
export class ThreadService {
  async appendEvent(lock: StudyLock, input: AppendEventInput): Promise<AppendedEvent> {
    if (!(lock instanceof StudyLock)) {
      throw new Error('ThreadService.appendEvent requires the mutation StudyLock');
    }
    const { eventType, payload = {}, occurredAt } = input;
    const sequence = lock.allocateEventSequence();
    const event = await StudyEvent.create(
      {
        ownerId: lock.ownerId,
        studyId: lock.studyId,
        sequence,
        eventType,
        payloadJson: payload,
        ...(occurredAt ? { occurredAt } : {}),
      },
      { transaction: lock.transaction },
    );
    return { id: event.id, sequence };
  }
}
