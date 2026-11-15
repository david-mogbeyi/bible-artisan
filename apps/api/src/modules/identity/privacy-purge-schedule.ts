import { Logger } from '@nestjs/common';

/** How often the worker purges deleted accounts and expired exports (BIB-47, BIB-48). */
export const PRIVACY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface PrivacyPurges {
  accounts: { purgeDeleted(): Promise<number> };
  exports: { purgeExpired(): Promise<number> };
}

/**
 * Runs the privacy purges now and then every `PRIVACY_PURGE_INTERVAL_MS`, one run at a time, in
 * the worker: deleted accounts first (PRD section 29: within seven days, and tombstones reapplied
 * before serving users after a restore), then export files past their 24 hours. A failed run logs
 * one content-free line with the error's class and is retried at the next tick; it never stops
 * the worker. Returns a function that stops the schedule.
 */
export function schedulePrivacyPurge(
  purges: PrivacyPurges,
  intervalMs = PRIVACY_PURGE_INTERVAL_MS,
): () => void {
  const logger = new Logger('PrivacyPurge');
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await purges.accounts.purgeDeleted();
      await purges.exports.purgeExpired();
    } catch (error) {
      logger.error('privacy_purge_failed', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => clearInterval(timer);
}
