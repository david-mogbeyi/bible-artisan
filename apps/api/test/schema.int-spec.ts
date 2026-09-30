import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database/database';

/**
 * Proves the migrations from BIB-9 create the four foundation tables and that the composite
 * study_id/owner_id -> study(id, owner_id) FK makes a mismatched owner unwritable at the
 * database level (NFR-SEC-001), independent of any application-level guard.
 */
describe('foundation schema', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(process.env.DATABASE_URL!);
  });

  afterEach(async () => {
    await sql`truncate table study_event, study_node, study, "user" cascade`.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('creates user, study, study_node, and study_event', async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('user', 'study', 'study_node', 'study_event')
      order by table_name
    `.execute(db);

    expect(tables.rows.map((r) => r.table_name)).toStrictEqual([
      'study',
      'study_event',
      'study_node',
      'user',
    ]);
  });

  it('rejects a study_node insert whose owner_id does not match its study', async () => {
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    await sql`insert into "user" (id, normalized_email) values (${ownerId}, ${`${ownerId}@example.com`})`.execute(
      db,
    );
    await sql`insert into "user" (id, normalized_email) values (${otherOwnerId}, ${`${otherOwnerId}@example.com`})`.execute(
      db,
    );
    const studyId = randomUUID();
    await sql`insert into study (id, owner_id, title) values (${studyId}, ${ownerId}, 'Test study')`.execute(
      db,
    );

    await expect(
      sql`insert into study_node (study_id, owner_id, type) values (${studyId}, ${otherOwnerId}, 'scripture')`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it('rejects a study_event insert whose owner_id does not match its study', async () => {
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    await sql`insert into "user" (id, normalized_email) values (${ownerId}, ${`${ownerId}@example.com`})`.execute(
      db,
    );
    await sql`insert into "user" (id, normalized_email) values (${otherOwnerId}, ${`${otherOwnerId}@example.com`})`.execute(
      db,
    );
    const studyId = randomUUID();
    await sql`insert into study (id, owner_id, title) values (${studyId}, ${ownerId}, 'Test study')`.execute(
      db,
    );

    await expect(
      sql`insert into study_event (study_id, owner_id, sequence, event_type) values (${studyId}, ${otherOwnerId}, 1, 'study_created')`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it('accepts a study_node insert whose owner_id matches its study', async () => {
    const ownerId = randomUUID();
    await sql`insert into "user" (id, normalized_email) values (${ownerId}, ${`${ownerId}@example.com`})`.execute(
      db,
    );
    const studyId = randomUUID();
    await sql`insert into study (id, owner_id, title) values (${studyId}, ${ownerId}, 'Test study')`.execute(
      db,
    );

    await expect(
      sql`insert into study_node (study_id, owner_id, type) values (${studyId}, ${ownerId}, 'scripture')`.execute(
        db,
      ),
    ).resolves.toBeDefined();
  });
});
