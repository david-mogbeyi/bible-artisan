import { EXPORT_RATE_LIMIT, MAX_EXPORT_BYTES } from '@bible-artisan/contracts';

/** Injection token for the export size cap and rate limit (tests override it with small values). */
export const EXPORT_LIMITS = Symbol('EXPORT_LIMITS');

export interface ExportLimits {
  /** Largest stored export in UTF-8 bytes; bigger is 413 EXPORT_TOO_LARGE. */
  maxBytes: number;
  /** New exports (study and account together) one owner may create per rolling window. */
  maxExports: number;
  windowSeconds: number;
}

export const DEFAULT_EXPORT_LIMITS: Readonly<ExportLimits> = {
  maxBytes: MAX_EXPORT_BYTES,
  maxExports: EXPORT_RATE_LIMIT.maxExports,
  windowSeconds: EXPORT_RATE_LIMIT.windowSeconds,
};
