import { describe, expect, it } from 'vitest';
import { StudyLifecycleError } from '../../common/errors/domain-errors';
import {
  assertLifecycleAllows,
  type StudyLifecycle,
  type StudyLifecycleTransition,
  studyPurgeAt,
  trashExpiryCutoff,
} from './study-lifecycle';

/** What the guard answers: 'ok' or the 422 code. */
function verdict(
  lifecycle: StudyLifecycle,
  transition: StudyLifecycleTransition | undefined,
): string {
  try {
    assertLifecycleAllows(lifecycle, transition);
    return 'ok';
  } catch (error) {
    if (error instanceof StudyLifecycleError) return error.code;
    throw error;
  }
}

describe('study lifecycle guard (BIB-22)', () => {
  it('allows exactly the transition table, and ordinary mutations only on active studies', () => {
    const lifecycles: StudyLifecycle[] = ['active', 'archived', 'trashed'];
    const transitions = [undefined, 'archive', 'unarchive', 'trash', 'restore'] as const;
    const table = Object.fromEntries(
      transitions.map((t) => [t ?? 'edit', lifecycles.map((l) => verdict(l, t))]),
    );
    expect(table).toStrictEqual({
      // Columns: active, archived, trashed.
      edit: ['ok', 'STUDY_ARCHIVED', 'STUDY_TRASHED'],
      archive: ['ok', 'LIFECYCLE_TRANSITION_INVALID', 'STUDY_TRASHED'],
      unarchive: ['LIFECYCLE_TRANSITION_INVALID', 'ok', 'STUDY_TRASHED'],
      trash: ['ok', 'ok', 'STUDY_TRASHED'],
      restore: ['LIFECYCLE_TRANSITION_INVALID', 'LIFECYCLE_TRANSITION_INVALID', 'ok'],
    });
  });

  it('purges 30 days after trashing, and treats exactly that age as past the window', () => {
    const deletedAt = new Date('2026-10-01T12:00:00.000Z');
    expect(studyPurgeAt(deletedAt).toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(trashExpiryCutoff(studyPurgeAt(deletedAt)).getTime()).toBe(deletedAt.getTime());
  });
});
