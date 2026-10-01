import {
  LIFECYCLE_TRANSITION_INVALID,
  STUDY_ARCHIVED,
  STUDY_TRASH_RETENTION_DAYS,
  STUDY_TRASHED,
} from '@bible-artisan/contracts';
import { literal, Op, type WhereOptions } from 'sequelize';
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

/**
 * When a study trashed at `deletedAt` is permanently deleted (and from when it reads as absent).
 * Display only (`purgeAt` in DTOs): `deletedAt` is a database timestamp, and this is the same
 * fixed span `RECOVERY_CUTOFF_SQL` subtracts, so the date shown is the instant the database
 * clock ends the window.
 */
export function studyPurgeAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_MS);
}

/**
 * The recovery window's cutoff as a SQL expression on the DATABASE clock: a study trashed at or
 * before it is past its window. The single clock source for the lifecycle (BIB-22): `archived_at`
 * and `deleted_at` are written as the database's `now()` (`StudiesService.changeLifecycle`), and
 * every window decision (study reads, the study lock, the Trash listing, the purge) compares them
 * with the database's `now()` through this expression, never with the API's clock, so a skewed
 * app server can neither hide a study early nor purge one late or early.
 *
 * Exact hours, not `interval '30 days'`: day arithmetic on `timestamptz` follows the session's
 * time zone across DST changes, which would drift from `studyPurgeAt` by an hour.
 */
export const RECOVERY_CUTOFF_SQL = `(now() - interval '${STUDY_TRASH_RETENTION_DAYS * 24} hours')`;

/**
 * THE rule that makes a study past its recovery window absent, as SQL over the study row aliased
 * `alias` (a fixed identifier, never user input). Every study-scoped read resolves its study
 * through it (`StudyAccessService`, the study lock, the library), so such a study is the same 404
 * as one that never existed, even before the purge has removed it. `deleted_at` is set exactly
 * while a study is trashed (CHECK), so this is "not trashed, or trashed after the cutoff".
 */
export function withinRecoveryWindowSql(alias: string): string {
  return `(${alias}.deleted_at IS NULL OR ${alias}.deleted_at > ${RECOVERY_CUTOFF_SQL})`;
}

/** `withinRecoveryWindowSql` for a Sequelize query on the `Study` model (aliased `"Study"`). */
export function withinRecoveryWindow(): WhereOptions<Study> {
  return { [Op.and]: [literal(withinRecoveryWindowSql('"Study"'))] };
}
