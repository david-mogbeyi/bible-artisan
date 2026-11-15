import { MAX_ACCOUNT_STORAGE_BYTES, MAX_EVENTS_PER_STUDY } from '@bible-artisan/contracts';

/** Injection token for the event and storage caps (tests override it with small values). */
export const SAFETY_LIMITS = Symbol('SAFETY_LIMITS');

/**
 * The caps the mutation pipeline enforces (BIB-52; NFR-SCALE-002). The node and edge caps are
 * checked where a node or edge becomes live (`StudyGraphService`, `EdgesService`) and are not
 * configurable here.
 */
export interface SafetyLimits {
  /** Events one study may hold (`study.last_event_sequence`). */
  maxEventsPerStudy: number;
  /** Derived account storage in bytes (`AccountStorageService`). */
  maxAccountStorageBytes: number;
  /**
   * How long a measured account storage figure is reused before it is measured again. Storage
   * grows by at most a few requests' worth in this window, so the cap can be overshot by that
   * much: it is a safety cap, not a quota.
   */
  storageMeasureTtlMs: number;
}

export const DEFAULT_SAFETY_LIMITS: Readonly<SafetyLimits> = {
  maxEventsPerStudy: MAX_EVENTS_PER_STUDY,
  maxAccountStorageBytes: MAX_ACCOUNT_STORAGE_BYTES,
  storageMeasureTtlMs: 60_000,
};
