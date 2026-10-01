import { z } from 'zod';
import { expectedRevisionSchema } from './mutation';
import { updateStudyResponseSchema } from './study-edit';

/**
 * Archiving, trashing and restoring a study (BIB-22; PRD sections 11, 21, 23, 24, 28;
 * FR-STUDY-005, FR-STUDY-006):
 *
 * - `POST /v1/studies/:studyId/archive`   active -> archived
 * - `POST /v1/studies/:studyId/unarchive` archived -> active
 * - `DELETE /v1/studies/:studyId`         active | archived -> trashed
 * - `POST /v1/studies/:studyId/restore`   trashed -> the state it was trashed from
 */

/** PRD section 23: "Study trash retains data for 30 days before physical purge". */
export const STUDY_TRASH_RETENTION_DAYS = 30;

/** 422: any study change other than unarchive or trash, while the study is archived. */
export const STUDY_ARCHIVED = 'STUDY_ARCHIVED';

/** 422: any study change other than restore, while the study is in the trash. */
export const STUDY_TRASHED = 'STUDY_TRASHED';

/** 422: archive of an archived study, unarchive of an active one, restore of one not in trash. */
export const LIFECYCLE_TRANSITION_INVALID = 'LIFECYCLE_TRANSITION_INVALID';

export const STUDY_LIFECYCLE_ERROR_CODES = [
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  LIFECYCLE_TRANSITION_INVALID,
] as const;

export type StudyLifecycleErrorCode = (typeof STUDY_LIFECYCLE_ERROR_CODES)[number];

/**
 * The body of every lifecycle route: only the study revision the client last saw (428 when
 * missing, 409 when stale). Strict, so nothing else can be sent.
 */
export const studyLifecycleRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
});

export type StudyLifecycleRequest = z.infer<typeof studyLifecycleRequestSchema>;

/** 200 from every lifecycle route: the study as `PATCH` answers it, in its new state. */
export const studyLifecycleResponseSchema = updateStudyResponseSchema;

export type StudyLifecycleResponse = z.infer<typeof studyLifecycleResponseSchema>;
