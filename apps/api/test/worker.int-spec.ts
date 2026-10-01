import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { StudyTrashPurgeService } from '../src/modules/study/trash/study-trash-purge.service';
import { WorkerModule } from '../src/worker.module';

/**
 * The worker's module graph (BIB-22): `worker.ts` resolves the trash purge from `WorkerModule`
 * and schedules it (`scheduleTrashPurge`, unit-tested with fake timers). Compiling the real module
 * here proves the purge and its dependencies (database, MutationService and the study services it
 * pulls in) resolve without booting the long-running worker process.
 */
describe('worker module (BIB-22)', () => {
  it('resolves the trash purge from the worker module and runs it against the database', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    moduleRef.useLogger(false);
    try {
      const purge = moduleRef.get(StudyTrashPurgeService);
      expect(purge).toBeInstanceOf(StudyTrashPurgeService);
      // Earlier suites may leave nothing due; a run must succeed either way.
      expect(await purge.purgeExpired()).toStrictEqual(expect.any(Number));
    } finally {
      await moduleRef.close();
    }
  });
});
