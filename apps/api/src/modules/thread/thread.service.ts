import { Injectable } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { StudyEvent } from '../../database/models/study-event.model';
import { StudyRevisionService } from '../study/study-revision.service';

export interface AppendEventInput {
  /** From the session, never the request. */
  ownerId: string;
  studyId: string;
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
 * `appendEvent` takes the caller's transaction and refuses to run without one, so an event is
 * committed atomically with the domain mutation it records, or not at all (FR-THREAD-001). It
 * allocates the event's per-study sequence from the study row counter in that same transaction.
 */
@Injectable()
export class ThreadService {
  constructor(private readonly studyRevisions: StudyRevisionService) {}

  async appendEvent(transaction: Transaction, input: AppendEventInput): Promise<AppendedEvent> {
    if (!(transaction instanceof Transaction)) {
      throw new Error('ThreadService.appendEvent requires the mutation transaction');
    }
    const { ownerId, studyId, eventType, payload = {}, occurredAt } = input;
    const sequence = await this.studyRevisions.nextEventSequence(transaction, ownerId, studyId);
    const event = await StudyEvent.create(
      {
        ownerId,
        studyId,
        sequence,
        eventType,
        payloadJson: payload,
        ...(occurredAt ? { occurredAt } : {}),
      },
      { transaction },
    );
    return { id: event.id, sequence };
  }
}
