import {
  LIFECYCLE_TRANSITION_INVALID,
  STUDY_ARCHIVED,
  STUDY_TRASH_RETENTION_DAYS,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { Op, type WhereOptions } from 'sequelize';
import { StudyLifecycleError } from '../../common/errors/domain-errors';
import type { Study } from '../../database/models/study.model';

/**
 * Study lifecycle rules (BIB-22; PRD sections 11, 23, 28; FR-STUDY-005/006). The one place that
 * says which lifecycle changes exist, which state each starts from, and how long the trash keeps a
 * study. The database mirrors the table (`study_lifecycle_transition` trigger and
 * `study_lifecycle_timestamps_check`, migration `add_study_lifecycle`).
 */

export type StudyLifecycle = Study['lifecycle'];

/** The lifecycle routes. `restore` returns a study to the state it was trashed from. */
export type StudyLifecycleTransition = 'archive' | 'unarchive' | 'trash' | 'restore';

/** Which states each transition may start from. Everything else is refused (422). */
export const STUDY_LIFECYCLE_TRANSITIONS: Readonly<
  Record<StudyLifecycleTransition, readonly StudyLifecycle[]>
> = {
  archive: ['active'],
  unarchive: ['archived'],
  trash: ['active', 'archived'],
  restore: ['trashed'],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = STUDY_TRASH_RETENTION_DAYS * DAY_MS;

/**
 * The lifecycle guard every study mutation passes, under the study lock, before its work runs
 * (`MutationService.execute`). A mutation that names no transition (every ordinary edit, now and
 * in later tickets) needs an active study: archived is 422 STUDY_ARCHIVED, trashed is 422
 * STUDY_TRASHED (PRD section 24: 422 for a change the current state does not allow). A lifecycle
 * route needs one of its allowed starting states; a trashed study is STUDY_TRASHED for every
 * transition but restore, and anything else is LIFECYCLE_TRANSITION_INVALID.
 */
export function assertLifecycleAllows(
  lifecycle: StudyLifecycle,
  transition: StudyLifecycleTransition | undefined,
): void {
  const allowed = transition === undefined ? ['active'] : STUDY_LIFECYCLE_TRANSITIONS[transition];
  if (allowed.includes(lifecycle)) return;
  if (lifecycle === 'trashed') throw new StudyLifecycleError(STUDY_TRASHED);
  if (transition === undefined) throw new StudyLifecycleError(STUDY_ARCHIVED);
  throw new StudyLifecycleError(LIFECYCLE_TRANSITION_INVALID);
}

/** When a study trashed at `deletedAt` is permanently deleted (and from when it reads as absent). */
export function studyPurgeAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_MS);
}

/** Studies trashed at or before this instant are past their recovery window at `now`. */
export function trashExpiryCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_MS);
}

/**
 * The WHERE fragment that makes a study past its recovery window absent: every study read and the
 * study lock add it, so such a study is the same 404 as one that never existed, even before the
 * purge has removed it. `deleted_at` is set exactly while a study is trashed (CHECK), so this is
 * "not trashed, or trashed after the cutoff".
 */
export function withinRecoveryWindow(now: Date = new Date()): WhereOptions<Study> {
  return {
    [Op.or]: [{ deletedAt: null }, { deletedAt: { [Op.gt]: trashExpiryCutoff(now) } }],
  };
}
