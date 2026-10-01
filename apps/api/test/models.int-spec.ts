import { createHash, randomUUID } from 'node:crypto';
import {
  DatabaseError,
  ForeignKeyConstraintError,
  Op,
  type Transaction,
  UniqueConstraintError,
} from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleSuperscription } from '../src/database/models/bible-superscription.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { ScriptureReference } from '../src/database/models/scripture-reference.model';
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
    await MutationReceipt.destroy({ where: { ownerId: created.users } });
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
      lastEventSequence: '0',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('creates a MutationReceipt through the model; keys are unique per owner, not globally', async () => {
    const owner = await createUser();
    const other = await createUser();
    const idempotencyKey = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const required = {
      idempotencyKey,
      route: 'POST /v1/studies',
      requestHash: 'f'.repeat(64),
      expiresAt,
    };
    await MutationReceipt.create({ ownerId: owner.id, ...required });
    const found = await MutationReceipt.findOne({
      where: { ownerId: owner.id, idempotencyKey },
      rejectOnEmpty: true,
    });
    expect(found.get({ plain: true })).toStrictEqual({
      ownerId: owner.id,
      idempotencyKey,
      route: 'POST /v1/studies',
      requestHash: 'f'.repeat(64),
      responseStatus: null,
      responseBody: null,
      createdAt: expect.any(Date),
      expiresAt,
    });

    await found.update({ responseStatus: 201, responseBody: { id: 'x', nested: { n: 1 } } });
    const completed = await MutationReceipt.findOne({
      where: { ownerId: owner.id, idempotencyKey },
      rejectOnEmpty: true,
    });
    expect([completed.responseStatus, completed.responseBody]).toStrictEqual([
      201,
      { id: 'x', nested: { n: 1 } },
    ]);

    await expect(MutationReceipt.create({ ownerId: owner.id, ...required })).rejects.toBeInstanceOf(
      UniqueConstraintError,
    );
    await expect(MutationReceipt.create({ ownerId: other.id, ...required })).resolves.toBeDefined();
  });

  it.each([
    ['a request hash that is not 64 hex characters', { requestHash: 'not-a-hash' }],
    ['a non-2xx response status', { responseStatus: 409, responseBody: {} }],
    ['a status without a body', { responseStatus: 200 }],
    ['an expiry not after creation', { expiresAt: new Date(Date.now() - 1000) }],
  ])('rejects a MutationReceipt with %s', async (_, override) => {
    const owner = await createUser();
    await expect(
      MutationReceipt.create({
        ownerId: owner.id,
        idempotencyKey: randomUUID(),
        route: 'POST /v1/studies',
        requestHash: 'f'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        ...override,
      }),
    ).rejects.toBeInstanceOf(DatabaseError);
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

  // Corpus rows cannot be deleted once written (immutability triggers), so these run inside a
  // transaction that is always rolled back. The verse carries empty text: no Scripture is typed.
  it('creates a BibleEdition, BibleBook and BibleVerse through the models with DB-equivalent defaults', async () => {
    const rollback = new Error('rollback');
    const emptySha = createHash('sha256').update('').digest('hex');
    await expect(
      db.transaction(async (transaction) => {
        const edition = await BibleEdition.create(
          {
            code: 'modeltest',
            name: 'Model test',
            abbreviation: 'MT',
            language: 'en',
            canon: 'protestant',
            sourceUrl: 'https://example.test/artifact.zip',
            sourceRelease: '2099-01-01',
            artifactSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64),
            verseCount: 1,
            superscriptionCount: 1,
            licenseStatus: 'public_domain',
            attribution: 'test',
            rightsRecord: { publisher: 'test' },
          },
          { transaction },
        );
        const foundEdition = await BibleEdition.findByPk(edition.id, {
          rejectOnEmpty: true,
          transaction,
        });
        expect(foundEdition.get({ plain: true })).toStrictEqual({
          id: expect.stringMatching(UUID),
          code: 'modeltest',
          name: 'Model test',
          abbreviation: 'MT',
          language: 'en',
          canon: 'protestant',
          sourceUrl: 'https://example.test/artifact.zip',
          sourceRelease: '2099-01-01',
          artifactSha256: 'a'.repeat(64),
          contentSha256: 'b'.repeat(64),
          verseCount: 1,
          superscriptionCount: 1,
          licenseStatus: 'public_domain',
          attribution: 'test',
          rightsRecord: { publisher: 'test' },
          activatedAt: null,
          createdAt: expect.any(Date),
        });

        await BibleBook.create(
          {
            editionId: edition.id,
            code: 'TST',
            sequence: 1,
            name: 'Test',
            abbreviation: 'Tst',
            chapterCount: 1,
          },
          { transaction },
        );
        const book = await BibleBook.findOne({ where: { editionId: edition.id }, transaction });
        expect(book?.get({ plain: true })).toStrictEqual({
          editionId: edition.id,
          code: 'TST',
          sequence: 1,
          name: 'Test',
          abbreviation: 'Tst',
          chapterCount: 1,
        });

        await BibleVerse.create(
          {
            editionId: edition.id,
            bookCode: 'TST',
            chapter: 1,
            verse: 1,
            text: '',
            textSha256: emptySha,
          },
          { transaction },
        );
        const verse = await BibleVerse.findOne({ where: { editionId: edition.id }, transaction });
        expect(verse?.get({ plain: true })).toStrictEqual({
          editionId: edition.id,
          bookCode: 'TST',
          chapter: 1,
          verse: 1,
          text: '',
          textSha256: emptySha,
          searchVector: '',
        });

        // Placeholder text, not Scripture.
        const lineSha = createHash('sha256').update('a').digest('hex');
        await BibleSuperscription.create(
          {
            editionId: edition.id,
            bookCode: 'TST',
            chapter: 1,
            beforeVerse: 1,
            text: 'a',
            textSha256: lineSha,
          },
          { transaction },
        );
        const superscription = await BibleSuperscription.findOne({
          where: { editionId: edition.id },
          transaction,
        });
        expect(superscription?.get({ plain: true })).toStrictEqual({
          editionId: edition.id,
          bookCode: 'TST',
          chapter: 1,
          beforeVerse: 1,
          text: 'a',
          textSha256: lineSha,
        });

        // The composite FK: a verse must belong to a book of its edition.
        await expect(
          BibleVerse.create(
            {
              editionId: edition.id,
              bookCode: 'GEN',
              chapter: 1,
              verse: 1,
              text: '',
              textSha256: emptySha,
            },
            { transaction },
          ),
        ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  // BIB-16: `searchVector` is generated by PostgreSQL from `text` and can never be written.
  it('generates BibleVerse.searchVector from the text and refuses a written value', async () => {
    const rollback = new Error('rollback');
    const text = 'Alpha, beta’s Alpha'; // placeholder text, not Scripture
    const textSha256 = createHash('sha256').update(text).digest('hex');
    const verseRow = (editionId: string, verse: number) => ({
      editionId,
      bookCode: 'TST',
      chapter: 1,
      verse,
      text,
      textSha256,
    });
    await expect(
      db.transaction(async (transaction) => {
        const edition = await BibleEdition.create(
          {
            code: 'vectortest',
            name: 'Vector test',
            abbreviation: 'VT',
            language: 'en',
            canon: 'protestant',
            sourceUrl: 'https://example.test/artifact.zip',
            sourceRelease: '2099-01-01',
            artifactSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64),
            verseCount: 1,
            superscriptionCount: 0,
            licenseStatus: 'public_domain',
            attribution: 'test',
            rightsRecord: { publisher: 'test' },
          },
          { transaction },
        );
        await BibleBook.create(
          {
            editionId: edition.id,
            code: 'TST',
            sequence: 1,
            name: 'Test',
            abbreviation: 'Tst',
            chapterCount: 1,
          },
          { transaction },
        );
        await BibleVerse.create(verseRow(edition.id, 1), { transaction });
        const verse = await BibleVerse.findOne({ where: { editionId: edition.id }, transaction });
        expect(verse?.searchVector).toBe("'alpha':1,4 'beta':2 's':3");

        const error = await BibleVerse.create(
          { ...verseRow(edition.id, 2), searchVector: "'forged':1" },
          { transaction },
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).parent).toMatchObject({ code: '428C9' });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('rejects a BibleBook with an invalid code (CHECK)', async () => {
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (transaction) => {
        const edition = await BibleEdition.create(
          {
            code: 'modeltest',
            name: 'Model test',
            abbreviation: 'MT',
            language: 'en',
            canon: 'protestant',
            sourceUrl: 'https://example.test/artifact.zip',
            sourceRelease: '2099-01-01',
            artifactSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64),
            verseCount: 1,
            superscriptionCount: 1,
            licenseStatus: 'public_domain',
            attribution: 'test',
            rightsRecord: {},
          },
          { transaction },
        );
        await expect(
          BibleBook.create(
            {
              editionId: edition.id,
              code: 'genesis',
              sequence: 1,
              name: 'Test',
              abbreviation: 'Tst',
              chapterCount: 1,
            },
            { transaction },
          ),
        ).rejects.toBeInstanceOf(DatabaseError);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('rejects a BibleSuperscription before a verse that does not exist (composite FK)', async () => {
    await expect(superscriptionAttempt({ beforeVerse: 2, text: 'a' })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
  });

  it('rejects an empty BibleSuperscription (CHECK)', async () => {
    await expect(superscriptionAttempt({ beforeVerse: 1, text: '' })).rejects.toBeInstanceOf(
      DatabaseError,
    );
  });

  it('rejects a BibleEdition created already active (insert trigger)', async () => {
    const error = await BibleEdition.create({
      code: 'modeltest',
      name: 'Model test',
      abbreviation: 'MT',
      language: 'en',
      canon: 'protestant',
      sourceUrl: 'https://example.test/artifact.zip',
      sourceRelease: '2099-01-01',
      artifactSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      verseCount: 1,
      superscriptionCount: 0,
      licenseStatus: 'public_domain',
      attribution: 'test',
      rightsRecord: {},
      activatedAt: new Date(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({ code: '23000' });
    expect(await BibleEdition.count({ where: { code: 'modeltest' } })).toBe(0);
  });

  /**
   * Creates an inactive edition with one book and one empty verse (1:1), then a superscription
   * with the given placement and text, all in a transaction that is always rolled back. Resolves
   * only if the superscription insert succeeded.
   */
  async function superscriptionAttempt(line: { beforeVerse: number; text: string }): Promise<void> {
    const rollback = new Error('rollback');
    const emptySha = createHash('sha256').update('').digest('hex');
    const outcome = await db
      .transaction(async (transaction) => {
        const edition = await BibleEdition.create(
          {
            code: 'modeltest',
            name: 'Model test',
            abbreviation: 'MT',
            language: 'en',
            canon: 'protestant',
            sourceUrl: 'https://example.test/artifact.zip',
            sourceRelease: '2099-01-01',
            artifactSha256: 'a'.repeat(64),
            contentSha256: 'b'.repeat(64),
            verseCount: 1,
            superscriptionCount: 1,
            licenseStatus: 'public_domain',
            attribution: 'test',
            rightsRecord: {},
          },
          { transaction },
        );
        await BibleBook.create(
          {
            editionId: edition.id,
            code: 'TST',
            sequence: 1,
            name: 'Test',
            abbreviation: 'Tst',
            chapterCount: 1,
          },
          { transaction },
        );
        await BibleVerse.create(
          {
            editionId: edition.id,
            bookCode: 'TST',
            chapter: 1,
            verse: 1,
            text: '',
            textSha256: emptySha,
          },
          { transaction },
        );
        await BibleSuperscription.create(
          {
            editionId: edition.id,
            bookCode: 'TST',
            chapter: 1,
            beforeVerse: line.beforeVerse,
            text: line.text,
            textSha256: createHash('sha256').update(line.text).digest('hex'),
          },
          { transaction },
        );
        throw rollback;
      })
      .catch((e: unknown) => e);
    if (outcome !== rollback) throw outcome;
  }

  /**
   * Runs `work` against the active WEB edition inside a transaction that is always rolled back,
   * so no scripture_reference row outlives the test. Resolves with what `work` resolved, or
   * rejects with what it threw.
   */
  async function inReferenceTransaction<T>(
    work: (editionId: string, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    const edition = await BibleEdition.findOne({
      where: { code: 'engwebp', activatedAt: { [Op.ne]: null } },
      rejectOnEmpty: true,
    });
    const rollback = new Error('rollback');
    let result: { value: T } | { error: unknown } | undefined;
    await expect(
      db.transaction(async (transaction) => {
        try {
          result = { value: await work(edition.id, transaction) };
        } catch (error) {
          result = { error };
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    if (!result) throw new Error('no result');
    if ('error' in result) throw result.error;
    return result.value;
  }

  const romans = (startVerse: number, endVerse: number) => ({
    bookCode: 'ROM',
    startChapter: 1,
    startVerse,
    endChapter: 1,
    endVerse,
  });

  it('creates a ScriptureReference through the model and reads it back with defaults', async () => {
    const read = await inReferenceTransaction(async (editionId, transaction) => {
      const created = await ScriptureReference.create(
        { editionId, ...romans(1, 2) },
        { transaction },
      );
      const found = await ScriptureReference.findByPk(created.id, { transaction });
      return { editionId, found: found?.get({ plain: true }) };
    });
    expect(read.found).toStrictEqual({
      id: expect.stringMatching(UUID),
      editionId: read.editionId,
      ...romans(1, 2),
      createdAt: expect.any(Date),
    });
  });

  it('rejects a ScriptureReference endpoint that is not a corpus verse (composite FK)', async () => {
    await expect(
      inReferenceTransaction((editionId, transaction) =>
        ScriptureReference.create({ editionId, ...romans(1, 999) }, { transaction }),
      ),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
  });

  it('rejects a reversed ScriptureReference range (CHECK)', async () => {
    const error = await inReferenceTransaction((editionId, transaction) =>
      ScriptureReference.create({ editionId, ...romans(2, 1) }, { transaction }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({
      code: '23514',
      constraint: 'scripture_reference_order_check',
    });
  });

  it('rejects a duplicate ScriptureReference range for the same edition (UNIQUE)', async () => {
    await expect(
      inReferenceTransaction(async (editionId, transaction) => {
        await ScriptureReference.create({ editionId, ...romans(3, 4) }, { transaction });
        await ScriptureReference.create({ editionId, ...romans(3, 4) }, { transaction });
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('refuses to update a ScriptureReference (immutable identity)', async () => {
    const error = await inReferenceTransaction(async (editionId, transaction) => {
      const created = await ScriptureReference.create(
        { editionId, ...romans(5, 6) },
        { transaction },
      );
      await created.update({ endVerse: 7 }, { transaction });
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({
      code: '23000',
      message: 'scripture_reference is immutable: UPDATE is not allowed',
    });
  });

  it('refuses to delete a ScriptureReference, so its range can never mint a new id', async () => {
    const error = await inReferenceTransaction(async (editionId, transaction) => {
      const created = await ScriptureReference.create(
        { editionId, ...romans(8, 9) },
        { transaction },
      );
      await created.destroy({ transaction });
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({
      code: '23000',
      message: 'scripture_reference is immutable: DELETE is not allowed',
    });
  });

  it('refuses to truncate scripture_reference', async () => {
    const error = await inReferenceTransaction(async (_editionId, transaction) => {
      await db.query('TRUNCATE scripture_reference', { transaction });
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({
      code: '23000',
      message: 'scripture_reference is immutable: TRUNCATE is not allowed',
    });
  });
});
