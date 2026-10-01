import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, Transaction } from 'sequelize';
import { MutationService } from '../../../common/mutation/mutation.service';
import type { Database } from '../../../database/database';
import { DATABASE } from '../../../database/database.module';
import { deleteOrphanedTags, lockTagVocabularies } from '../http/study-tags';
import { RECOVERY_CUTOFF_SQL } from '../study-lifecycle';

/** Studies purged per transaction, so one run never holds many row locks at once. */
export const PURGE_BATCH_SIZE = 100;

/**
 * The purge's selection: up to `$1` studies past their recovery window by the database clock,
 * oldest first, skipping any another purge holds. Served by the partial index
 * `study_trash_purge_idx (deleted_at, id) WHERE lifecycle = 'trashed'`.
 */
export const DUE_STUDIES_SQL = `SELECT id, owner_id AS "ownerId" FROM study
  WHERE lifecycle = 'trashed' AND deleted_at <= ${RECOVERY_CUTOFF_SQL}
  ORDER BY deleted_at, id
  LIMIT $1
  FOR UPDATE SKIP LOCKED`;

interface DueStudy {
  id: string;
  ownerId: string;
}

/**
 * Physically deletes studies whose 30-day trash recovery window has ended (BIB-22; PRD section
 * 23: "Study trash retains data for 30 days before physical purge"). They already read as absent
 * (404) everywhere from the moment the window ends (`withinRecoveryWindowSql`); this removes the
 * rows. Both decide "past the window" on the database clock, so they agree to the instant.
 *
 * Each batch is one transaction:
 *
 * 1. Lock up to `PURGE_BATCH_SIZE` due studies (`FOR UPDATE SKIP LOCKED`, so two workers never
 *    wait on each other). No mutation can hold one of them: the study lock refuses a study past
 *    its window, so nothing can restore it in between.
 * 2. Delete those owners' expired mutation receipts, whose stored responses can still hold the
 *    study's title, questions and tags (`MutationService.deleteExpiredReceipts`). This comes
 *    before the vocabulary locks: a request taking over an expired receipt holds that row and
 *    then wants the vocabulary lock, so waiting on it while holding the vocabulary lock could
 *    deadlock.
 * 3. Take their owners' tag-vocabulary locks (`lockTagVocabularies`, sorted), as every tag
 *    writer does, note their tags, then `DELETE FROM study`: BIB-19's cascades remove every
 *    node, event, branch and study_tag row with it.
 * 4. Delete the tags no study uses any more (BIB-20's race-safe orphan cleanup, under those
 *    locks), so private tag text does not outlive the study.
 *
 * Idempotent and safe to run anywhere at any time; it needs no job lease (BIB-39 owns the job
 * runner). The worker runs it on start and hourly.
 */
@Injectable()
export class StudyTrashPurgeService {
  private readonly logger = new Logger('StudyTrashPurge');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly mutations: MutationService,
  ) {}

  /**
   * Purges every study past its recovery window by the database clock (`RECOVERY_CUTOFF_SQL`),
   * never the worker's own clock; returns how many were purged.
   */
  async purgeExpired(): Promise<number> {
    const started = Date.now();
    let purged = 0;
    for (;;) {
      const batch = await this.purgeBatch();
      purged += batch;
      if (batch < PURGE_BATCH_SIZE) break;
    }
    // Counts and duration only (NFR-PRIV-001).
    this.logger.log('trash_purged', { studies: purged, durationMs: Date.now() - started });
    return purged;
  }

  private purgeBatch(): Promise<number> {
    return this.db.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
      async (transaction) => {
        const due = await this.db.query<DueStudy>(DUE_STUDIES_SQL, {
          bind: [PURGE_BATCH_SIZE],
          transaction,
          type: QueryTypes.SELECT,
        });
        if (due.length === 0) return 0;
        const ids = due.map((study) => study.id);
        const owners = [...new Set(due.map((study) => study.ownerId))].sort();
        await this.mutations.deleteExpiredReceipts(owners);
        // Before any of these owners' tag rows is touched (BIB-20's lock order: study rows, then
        // the owner's vocabulary lock, then tag rows), so a concurrent tag change on another of
        // their studies cannot deadlock with the orphan cleanup below.
        await lockTagVocabularies(owners);
        const tags = await this.db.query<{ ownerId: string; tagId: string }>(
          `SELECT DISTINCT owner_id AS "ownerId", tag_id AS "tagId" FROM study_tag
            WHERE study_id = ANY($1::uuid[])
            ORDER BY owner_id, tag_id`,
          { bind: [ids], transaction, type: QueryTypes.SELECT },
        );
        await this.db.query(`DELETE FROM study WHERE id = ANY($1::uuid[])`, {
          bind: [ids],
          transaction,
          type: QueryTypes.DELETE,
        });
        for (const ownerId of owners) {
          const tagIds = tags.filter((tag) => tag.ownerId === ownerId).map((tag) => tag.tagId);
          if (tagIds.length > 0) await deleteOrphanedTags(ownerId, tagIds);
        }
        return due.length;
      },
    );
  }
}
