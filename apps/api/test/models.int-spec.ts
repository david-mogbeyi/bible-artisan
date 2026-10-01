import { randomUUID } from 'node:crypto';
import { DatabaseError, ForeignKeyConstraintError, UniqueConstraintError } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Exercises every model THROUGH Sequelize (not raw SQL), passing only the required fields so the
 * model-side defaults and column mappings are what's under test. Does not assume an empty
 * database; deletes exactly the rows it creates.
 */
describe('Sequelize models against the real schema', () => {
  let db: Database;
  const created = { users: [] as string[], studies: [] as string[], challenges: [] as string[] };

  async function createUser(): Promise<User> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    created.users.push(user.id);
    return user;
  }

  async function createStudy(ownerId: string): Promise<Study> {
    const study = await Study.create({ ownerId, title: 'Conscience in Romans' });
    created.studies.push(study.id);
    return study;
  }

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    const studyId = created.studies;
    await StudyEvent.destroy({ where: { studyId } });
    await StudyNode.destroy({ where: { studyId } });
    await Study.destroy({ where: { id: studyId } });
    await AuthChallenge.destroy({ where: { id: created.challenges } });
    await AuthSession.destroy({ where: { userId: created.users } });
    await User.destroy({ where: { id: created.users } });
    await db.close();
  });

  it('creates a User with only required fields and reads it back with DB-equivalent defaults', async () => {
    const user = await createUser();
    const found = await User.findByPk(user.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      normalizedEmail: user.normalizedEmail,
      authSubject: null,
      displayName: null,
      timezone: 'UTC',
      createdAt: expect.any(Date),
    });
    expect(found.id).toBe(user.id);
  });

  it('creates a Study with only required fields and reads it back', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const found = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: study.id,
      ownerId: owner.id,
      title: 'Conscience in Romans',
      description: null,
      lifecycle: 'active',
      revision: 1,
      contentRevision: 1,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('creates a StudyNode with only required fields and reads it back', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const node = await StudyNode.create({ studyId: study.id, ownerId: owner.id, type: 'question' });
    const found = await StudyNode.findByPk(node.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      type: 'question',
      revision: 1,
      deletedAt: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('creates a StudyEvent with only required fields; bigint sequence round-trips as an exact string', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    // 2^53 + 1: not representable as a JS number, so a number-typed field would silently round it.
    const sequence = '9007199254740993';
    const event = await StudyEvent.create({
      studyId: study.id,
      ownerId: owner.id,
      sequence,
      eventType: 'study.created',
    });
    const found = await StudyEvent.findByPk(event.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      sequence,
      eventType: 'study.created',
      payloadJson: {},
      occurredAt: expect.any(Date),
    });
    expect(typeof found.sequence).toBe('string');
  });

  it('rejects a model-level StudyNode create whose owner_id does not own the study', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const study = await createStudy(owner.id);
    await expect(
      StudyNode.create({ studyId: study.id, ownerId: otherOwner.id, type: 'question' }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    expect(await StudyNode.count({ where: { studyId: study.id } })).toBe(0);
  });

  it('rejects a model-level StudyEvent create whose owner_id does not own the study', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const study = await createStudy(owner.id);
    await expect(
      StudyEvent.create({
        studyId: study.id,
        ownerId: otherOwner.id,
        sequence: '1',
        eventType: 'study.created',
      }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    expect(await StudyEvent.count({ where: { studyId: study.id } })).toBe(0);
  });

  it('creates an AuthChallenge with only required fields and reads it back with defaults', async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    const challenge = await AuthChallenge.create({
      normalizedEmail: `${randomUUID()}@example.test`,
      expiresAt,
    });
    created.challenges.push(challenge.id);
    const found = await AuthChallenge.findByPk(challenge.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      normalizedEmail: challenge.normalizedEmail,
      providerRef: null,
      attemptCount: 0,
      expiresAt,
      consumedAt: null,
      createdAt: expect.any(Date),
    });
  });

  it('rejects an AuthChallenge attempt count above five (CHECK)', async () => {
    const challenge = await AuthChallenge.create({
      normalizedEmail: `${randomUUID()}@example.test`,
      expiresAt: new Date(),
    });
    created.challenges.push(challenge.id);
    await expect(challenge.update({ attemptCount: 6 })).rejects.toBeInstanceOf(DatabaseError);
  });

  it('creates an AuthSession with only required fields and reads it back with defaults', async () => {
    const user = await createUser();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000);
    const session = await AuthSession.create({
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      expiresAt,
    });
    const found = await AuthSession.findByPk(session.id, { rejectOnEmpty: true });
    expect(found.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      createdAt: expect.any(Date),
      lastSeenAt: expect.any(Date),
      expiresAt,
      revokedAt: null,
    });
    await expect(
      AuthSession.create({ userId: user.id, tokenHash: 'a'.repeat(64), expiresAt }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('rejects an AuthSession for a user that does not exist', async () => {
    await expect(
      AuthSession.create({
        userId: randomUUID(),
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
  });
});
