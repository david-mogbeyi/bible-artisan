import { z } from 'zod';
import { MAX_EDGES_PER_STUDY } from './edge';
import { MAX_NODES_PER_STUDY } from './node';

/**
 * Safety caps (NFR-SCALE-002, BIB-52): 2,000 live nodes and 6,000 live edges per study (enforced
 * where nodes and edges become live, `NODE_LIMIT_EXCEEDED` / `EDGE_LIMIT_EXCEEDED`), 100,000
 * events per study and 500 MB of derived account storage (enforced by the mutation pipeline).
 * Each one warns at 80%. At a cap the study (or account) stays readable, exportable and
 * deletable; only additions are refused, with a fixed explanation.
 */

/** NFR-SCALE-002: Study Thread events one study may hold. */
export const MAX_EVENTS_PER_STUDY = 100_000;
/**
 * NFR-SCALE-002: derived account storage, excluding the shared Bible text (500 MB, counted in
 * binary megabytes like `MAX_EXPORT_BYTES`).
 */
export const MAX_ACCOUNT_STORAGE_BYTES = 500 * 1024 * 1024;
/** NFR-SCALE-002: "warn at 80%". */
export const LIMIT_WARNING_RATIO = 0.8;

/**
 * 422: the study holds `MAX_EVENTS_PER_STUDY` events. Reading, exporting, archiving, trashing and
 * removals still work; anything that adds to the study is refused.
 */
export const STUDY_EVENT_LIMIT_REACHED = 'STUDY_EVENT_LIMIT_REACHED';
/**
 * 422: the account's derived storage is at `MAX_ACCOUNT_STORAGE_BYTES`. Reading, exporting,
 * archiving, trashing and removals still work; anything that adds is refused.
 */
export const STORAGE_LIMIT_REACHED = 'STORAGE_LIMIT_REACHED';

export const LIMIT_ERROR_CODES = [STUDY_EVENT_LIMIT_REACHED, STORAGE_LIMIT_REACHED] as const;
export type LimitErrorCode = (typeof LIMIT_ERROR_CODES)[number];

/** `ok` below 80%, `warning` from 80%, `reached` at the cap. */
export const LIMIT_STATES = ['ok', 'warning', 'reached'] as const;
export type LimitState = (typeof LIMIT_STATES)[number];

/** The state of `used` against `limit` (NFR-SCALE-002). */
export function limitState(used: number, limit: number): LimitState {
  if (used >= limit) return 'reached';
  if (used >= limit * LIMIT_WARNING_RATIO) return 'warning';
  return 'ok';
}

export const limitUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  state: z.enum(LIMIT_STATES),
});
export type LimitUsage = z.infer<typeof limitUsageSchema>;

/**
 * `GET /v1/studies/:studyId/limits`: the study's live nodes, live edges and events, and the
 * owner's derived account storage, each against its cap. Counts only, never content.
 */
export const studyLimitsResponseSchema = z.object({
  nodes: limitUsageSchema,
  edges: limitUsageSchema,
  events: limitUsageSchema,
  storage: limitUsageSchema,
});
export type StudyLimitsResponse = z.infer<typeof studyLimitsResponseSchema>;

/** The caps, by resource, for clients that word their own messages. */
export const SAFETY_CAPS = {
  nodes: MAX_NODES_PER_STUDY,
  edges: MAX_EDGES_PER_STUDY,
  events: MAX_EVENTS_PER_STUDY,
  storage: MAX_ACCOUNT_STORAGE_BYTES,
} as const;

export const LIMIT_ERROR_MESSAGES: Record<LimitErrorCode, string> = {
  [STUDY_EVENT_LIMIT_REACHED]: `This study has reached its history limit of ${MAX_EVENTS_PER_STUDY.toLocaleString('en-US')} events. You can still read, export, archive or delete it; start a new study to continue`,
  [STORAGE_LIMIT_REACHED]: `Your account has reached its storage limit of ${MAX_ACCOUNT_STORAGE_BYTES / 1024 / 1024} MB. You can still read, export and delete; delete studies you no longer need to make room`,
};
