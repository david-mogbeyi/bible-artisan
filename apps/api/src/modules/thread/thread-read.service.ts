import { Injectable } from '@nestjs/common';
import { StudyEvent } from '../../database/models/study-event.model';

/** One recorded event as the AI context reads it: type and time, never its payload. */
export interface RecentEvent {
  id: string;
  sequence: string;
  eventType: string;
  occurredAt: Date;
}

/**
 * Read side of the Study Thread for other modules (BIB-39: the AI context assembler reads recent
 * events here instead of querying `study_event`). The caller has already resolved the study as
 * the owner's; both ids are in the filter regardless.
 */
@Injectable()
export class ThreadReadService {
  async recentEvents(ownerId: string, studyId: string, limit: number): Promise<RecentEvent[]> {
    const rows = await StudyEvent.findAll({
      where: { ownerId, studyId },
      attributes: ['id', 'sequence', 'eventType', 'occurredAt'],
      order: [['sequence', 'DESC']],
      limit,
    });
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
    }));
  }
}
