import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Op } from 'sequelize';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { ReferenceService } from '../src/modules/bible-content/reference/reference.service';
import { createTestApp } from './app';

/** The SQL text of a `db.query` call, whichever form it was called with. */
function sqlOf(sql: unknown): string {
  if (typeof sql === 'string') return sql;
  if (sql && typeof sql === 'object' && 'query' in sql) return String(sql.query);
  return '';
}

const isCorpusAggregation = (sql: string): boolean =>
  /FROM bible_verse/.test(sql) && /GROUP BY book_code, chapter/.test(sql);
const isEditionCheck = (sql: string): boolean =>
  /FROM "bible_edition"/.test(sql) && /count\(/i.test(sql);

/**
 * ReferenceService's per-edition index cache (BIB-15): one single-flight promise covers the
 * active-edition check and the full-corpus aggregation, and a failure is evicted so a later call
 * retries. Each test builds a fresh service, so it starts with an empty cache.
 */
describe('ReferenceService edition index cache', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let editionId: string;

  const queriesMatching = (spy: { mock: { calls: unknown[][] } }, test: (sql: string) => boolean) =>
    spy.mock.calls.filter(([sql]) => test(sqlOf(sql))).length;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    const edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    editionId = edition.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the edition check and the corpus aggregation once for concurrent first calls', async () => {
    const service = new ReferenceService(db);
    const spy = vi.spyOn(db, 'query');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.resolve(editionId, 'Rom 9:1')),
    );
    for (const result of results) expect(result).toStrictEqual(results[0]);
    expect(results[0]).toMatchObject({ outcome: 'resolved', reference: { bookCode: 'ROM' } });
    expect(queriesMatching(spy, isCorpusAggregation)).toBe(1);
    expect(queriesMatching(spy, isEditionCheck)).toBe(1);

    // Later calls reuse the cached index.
    await service.resolve(editionId, 'Rom 9:2');
    expect(queriesMatching(spy, isCorpusAggregation)).toBe(1);
  });

  it('evicts a failed load so the next call retries', async () => {
    const service = new ReferenceService(db);
    const original = db.query.bind(db);
    let failNext = true;
    const spy = vi.spyOn(db, 'query').mockImplementation(((sql: unknown, options: unknown) => {
      if (failNext && isCorpusAggregation(sqlOf(sql))) {
        failNext = false;
        return Promise.reject(new Error('simulated database blip'));
      }
      return (original as (sql: unknown, options: unknown) => Promise<unknown>)(sql, options);
    }) as typeof db.query);

    const failures = await Promise.allSettled(
      Array.from({ length: 3 }, () => service.resolve(editionId, 'Rom 9:1')),
    );
    expect(failures.map((f) => f.status)).toStrictEqual(['rejected', 'rejected', 'rejected']);
    expect(queriesMatching(spy, isCorpusAggregation)).toBe(1);

    const retried = await service.resolve(editionId, 'Rom 9:1');
    expect(retried).toMatchObject({ outcome: 'resolved', reference: { bookCode: 'ROM' } });
    expect(queriesMatching(spy, isCorpusAggregation)).toBe(2);
  });

  it('does not cache an unknown edition: each call checks again, and never aggregates', async () => {
    const service = new ReferenceService(db);
    const spy = vi.spyOn(db, 'query');
    const unknown = randomUUID();
    await expect(service.resolve(unknown, 'Rom 9:1')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.resolve(unknown, 'Rom 9:1')).rejects.toBeInstanceOf(NotFoundError);
    expect(queriesMatching(spy, isEditionCheck)).toBe(2);
    expect(queriesMatching(spy, isCorpusAggregation)).toBe(0);
  });
});
