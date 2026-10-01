import { Logger } from '@nestjs/common';
import type { StudyTrashPurgeService } from './study-trash-purge.service';

/** How often the worker purges expired trash (BIB-22). Expired studies already read as absent. */
export const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Runs the trash purge now and then every `TRASH_PURGE_INTERVAL_MS`, one run at a time, in the
 * worker. A failed run (database down, a transient conflict) logs one content-free line with the
 * error's class and is retried at the next tick; it never stops the worker. Returns a function
 * that stops the schedule.
 */
export function scheduleTrashPurge(
  purge: Pick<StudyTrashPurgeService, 'purgeExpired'>,
  intervalMs = TRASH_PURGE_INTERVAL_MS,
): () => void {
  const logger = new Logger('StudyTrashPurge');
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await purge.purgeExpired();
    } catch (error) {
      logger.error('trash_purge_failed', {
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
