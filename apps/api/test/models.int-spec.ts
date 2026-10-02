import { createHash, randomUUID } from 'node:crypto';
import {
  DatabaseError,
  ForeignKeyConstraintError,
  Op,
  QueryTypes,
  type Transaction,
  UniqueConstraintError,
} from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { createDatabase, type Database } from '../src/database/database';
import { Annotation } from '../src/database/models/annotation.model';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleSuperscription } from '../src/database/models/bible-superscription.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { NoteVersion } from '../src/database/models/note-version.model';
import { Note } from '../src/database/models/note.model';
import { ScriptureReference } from '../src/database/models/scripture-reference.model';
import { StudyBranch } from '../src/database/models/study-branch.model';
import { StudyEdge } from '../src/database/models/study-edge.model';
import { StudyNodePosition } from '../src/database/models/study-node-position.model';
import { StudyViewState } from '../src/database/models/study-view-state.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { StudyTag } from '../src/database/models/study-tag.model';
import { Study } from '../src/database/models/study.model';
import { Tag } from '../src/database/models/tag.model';
import { User } from '../src/database/models/user.model';
import { THOUGHT } from './support/nodes';

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

  /** A shared reference row (immutable, never deleted): upserted for the first active verse. */
  async function firstReference(): Promise<ScriptureReference> {
    await db.query(
      `INSERT INTO scripture_reference
         (edition_id, book_code, start_chapter, start_verse, end_chapter, end_verse)
       SELECT v.edition_id, v.book_code, v.chapter, v.verse, v.chapter, v.verse
         FROM bible_verse v
         JOIN bible_edition e ON e.id = v.edition_id AND e.activated_at IS NOT NULL
        ORDER BY v.book_code, v.chapter, v.verse
        LIMIT 1
       ON CONFLICT DO NOTHING`,
    );
    return ScriptureReference.findOne({ rejectOnEmpty: true });
  }

  beforeAll(() => {
    db = createDatabase(loadEnv().DATABASE_URL);
  });

  afterAll(async () => {
    // Deleting a study cascades to its nodes, events and branches (BIB-19).
    await Study.destroy({ where: { id: created.studies } });
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
      archivedAt: null,
      deletedAt: null,
      revision: 1,
      contentRevision: 1,
      lastEventSequence: '0',
      startingReferenceId: null,
      originalQuestionNodeId: null,
      mainQuestionNodeId: null,
      pinnedAt: null,
      lastActivityAt: expect.any(Date),
      searchText: '',
      titleSortKey: '',
      isPinned: false,
      questionNodeType: 'question',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it("writes and reads a Study's last activity, search text and title sort key through the model, and reads the generated pin flag (BIB-21)", async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const lastActivityAt = new Date('2026-10-01T12:34:56.789Z');
    const pinnedAt = new Date('2026-10-01T12:00:00.000Z');
    await study.update({
      lastActivityAt,
      searchText: 'conscience in romans',
      titleSortKey: 'conscience in romans',
      pinnedAt,
    });
    const found = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect([
      found.lastActivityAt,
      found.searchText,
      found.titleSortKey,
      found.isPinned,
    ]).toStrictEqual([lastActivityAt, 'conscience in romans', 'conscience in romans', true]);
    await found.update({ pinnedAt: null });
    expect((await Study.findByPk(study.id, { rejectOnEmpty: true })).isPinned).toBe(false);
  });

  it('archives, trashes and restores a Study through the model, and the database refuses lifecycle dates or transitions that disagree (BIB-22)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const archivedAt = new Date('2026-10-01T12:00:00.000Z');
    const deletedAt = new Date('2026-10-02T12:00:00.000Z');
    await study.update({ lifecycle: 'archived', archivedAt });
    await study.update({ lifecycle: 'trashed', deletedAt });
    let found = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect([found.lifecycle, found.archivedAt, found.deletedAt]).toStrictEqual([
      'trashed',
      archivedAt,
      deletedAt,
    ]);
    // Trashed from archived: restore may only return it to archived.
    await expect(
      found.update({ lifecycle: 'active', archivedAt: null, deletedAt: null }),
    ).rejects.toThrow('study lifecycle transition refused');
    found = await Study.findByPk(study.id, { rejectOnEmpty: true });
    await found.update({ lifecycle: 'archived', deletedAt: null });
    found = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect([found.lifecycle, found.archivedAt, found.deletedAt]).toStrictEqual([
      'archived',
      archivedAt,
      null,
    ]);
    // Dates that disagree with the state.
    await expect(found.update({ archivedAt: null })).rejects.toThrow(
      'study_lifecycle_timestamps_check',
    );
    await expect(
      Study.create({ ownerId: owner.id, title: 'Trashed without a date', lifecycle: 'trashed' }),
    ).rejects.toThrow('study_lifecycle_timestamps_check');
  });

  it('pins a Study and creates a Tag and StudyTag through the models (BIB-20)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const pinnedAt = new Date('2026-10-01T12:00:00.000Z');
    await study.update({ pinnedAt, description: 'Romans first' });
    const pinned = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect([pinned.pinnedAt, pinned.description]).toStrictEqual([pinnedAt, 'Romans first']);

    const tag = await Tag.create({ ownerId: owner.id, name: 'Grace', normalizedName: 'grace' });
    expect(
      (await Tag.findByPk(tag.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toStrictEqual({
      id: expect.stringMatching(UUID),
      ownerId: owner.id,
      name: 'Grace',
      normalizedName: 'grace',
      createdAt: expect.any(Date),
    });
    await StudyTag.create({ studyId: study.id, ownerId: owner.id, tagId: tag.id });
    const pair = await StudyTag.findOne({ where: { studyId: study.id }, rejectOnEmpty: true });
    expect(pair.get({ plain: true })).toStrictEqual({
      studyId: study.id,
      tagId: tag.id,
      ownerId: owner.id,
      createdAt: expect.any(Date),
    });
  });

  it('rejects model-level BIB-20 rows that break their invariants', async () => {
    const owner = await createUser();
    const other = await createUser();
    const study = await createStudy(owner.id);
    const code = async (work: Promise<unknown>): Promise<unknown> =>
      work.then(
        () => 'created',
        (e: unknown) => (e as { parent?: { code?: string } }).parent?.code,
      );
    // Per-owner unique normalized name; another owner may use it.
    await Tag.create({ ownerId: owner.id, name: 'Grace', normalizedName: 'grace' });
    expect(
      await code(Tag.create({ ownerId: owner.id, name: 'grace', normalizedName: 'grace' })),
    ).toBe('23505');
    const othersTag = await Tag.create({
      ownerId: other.id,
      name: 'Grace',
      normalizedName: 'grace',
    });
    // Name bounds, title and description bounds (CHECK).
    expect(
      await code(Tag.create({ ownerId: owner.id, name: 'x'.repeat(51), normalizedName: 'x' })),
    ).toBe('23514');
    expect(await code(Tag.create({ ownerId: owner.id, name: '', normalizedName: 'empty' }))).toBe(
      '23514',
    );
    expect(await code(study.update({ title: '' }))).toBe('23514');
    expect(await code(study.update({ description: 'd'.repeat(2001) }))).toBe('23514');
    // Another owner's tag on this study, under either owner (composite FKs).
    expect(
      await code(StudyTag.create({ studyId: study.id, ownerId: owner.id, tagId: othersTag.id })),
    ).toBe('23503');
    expect(
      await code(StudyTag.create({ studyId: study.id, ownerId: other.id, tagId: othersTag.id })),
    ).toBe('23503');
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

  it('creates a node of each of the six types through the model and reads it back (BIB-25)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const reference = await firstReference();
    const rows = [
      { type: 'scripture', origin: 'scripture', scriptureReferenceId: reference.id },
      { type: 'question', origin: 'user', title: 'What is conscience?', questionStatus: 'open' },
      {
        type: 'observation',
        origin: 'user',
        body: 'Paul appeals to his conscience.',
        observationKind: 'interpretation',
      },
      { type: 'thought', origin: 'user', body: 'A witness?' },
      {
        type: 'conclusion',
        origin: 'user',
        title: 'It bears witness.',
        conclusionStatus: 'tentative',
      },
      {
        type: 'source',
        origin: 'external',
        title: 'Romans commentary',
        payloadJson: { kind: 'commentary', locator: 'p. 12' },
      },
    ] as const;
    const blank = {
      title: null,
      body: null,
      questionStatus: null,
      conclusionStatus: null,
      observationKind: null,
      scriptureReferenceId: null,
      payloadJson: null,
      canonicalNodeId: null,
    };
    for (const row of rows) {
      const node = await StudyNode.create({ studyId: study.id, ownerId: owner.id, ...row });
      const found = await StudyNode.findByPk(node.id, { rejectOnEmpty: true });
      expect(found.get({ plain: true })).toStrictEqual({
        id: expect.stringMatching(UUID),
        studyId: study.id,
        ownerId: owner.id,
        ...blank,
        ...row,
        revision: 1,
        deletedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    }
  });

  it('creates a canonical Scripture node and a labeled duplicate of it through the model (BIB-26)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const reference = await firstReference();
    const scope = { studyId: study.id, ownerId: owner.id };
    const values = { type: 'scripture', origin: 'scripture', scriptureReferenceId: reference.id };
    const canonical = await StudyNode.create({ ...scope, ...values });
    const duplicate = await StudyNode.create({
      ...scope,
      ...values,
      canonicalNodeId: canonical.id,
    });
    const found = await StudyNode.findAll({
      where: { studyId: study.id },
      attributes: ['id', 'canonicalNodeId'],
      order: [['createdAt', 'ASC']],
      raw: true,
    });
    expect(found).toStrictEqual([
      { id: canonical.id, canonicalNodeId: null },
      { id: duplicate.id, canonicalNodeId: canonical.id },
    ]);
    // A second canonical node for the same reference is refused (partial unique index).
    await expect(StudyNode.create({ ...scope, ...values })).rejects.toBeInstanceOf(
      UniqueConstraintError,
    );
  });

  it("rejects a model-level node with another type's columns, an unknown origin, or a source without a URL or locator (CHECK)", async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const scope = { studyId: study.id, ownerId: owner.id };
    for (const row of [
      { ...THOUGHT, origin: 'robot' },
      { ...THOUGHT, title: 'x' },
      { ...THOUGHT, observationKind: 'interpretation' },
      { type: 'observation', origin: 'user', body: 'x' },
      { type: 'conclusion', origin: 'user', title: 'x' },
      { type: 'conclusion', origin: 'user', title: 'x', conclusionStatus: 'proven' },
      { type: 'source', origin: 'external', title: 'x', payloadJson: { kind: 'web' } },
      { type: 'source', origin: 'external', title: 'x'.repeat(201), payloadJson: { locator: 'p' } },
      { type: 'question', origin: 'user', title: 'x', questionStatus: 'open', body: 'x' },
    ]) {
      await expect(StudyNode.create({ ...scope, ...row })).rejects.toBeInstanceOf(DatabaseError);
    }
    expect(await StudyNode.count({ where: { studyId: study.id } })).toBe(0);
  });

  it('creates Question and Scripture nodes, a StudyBranch and the study pointers through the models (BIB-19)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const reference = await firstReference();
    const question = await StudyNode.create({
      studyId: study.id,
      ownerId: owner.id,
      type: 'question',
      origin: 'user',
      title: 'What is conscience?',
      questionStatus: 'open',
    });
    const scripture = await StudyNode.create({
      studyId: study.id,
      ownerId: owner.id,
      type: 'scripture',
      origin: 'scripture',
      scriptureReferenceId: reference.id,
    });
    const branch = await StudyBranch.create({
      studyId: study.id,
      ownerId: owner.id,
      rootNodeId: question.id,
    });
    await study.update({
      startingReferenceId: reference.id,
      originalQuestionNodeId: question.id,
      mainQuestionNodeId: question.id,
    });

    const foundBranch = await StudyBranch.findByPk(branch.id, { rejectOnEmpty: true });
    expect(foundBranch.get({ plain: true })).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      rootNodeId: question.id,
      createdAt: expect.any(Date),
    });
    const foundQuestion = await StudyNode.findByPk(question.id, { rejectOnEmpty: true });
    expect([foundQuestion.title, foundQuestion.questionStatus]).toStrictEqual([
      'What is conscience?',
      'open',
    ]);
    const foundScripture = await StudyNode.findByPk(scripture.id, { rejectOnEmpty: true });
    expect(foundScripture.scriptureReferenceId).toBe(reference.id);
    const foundStudy = await Study.findByPk(study.id, { rejectOnEmpty: true });
    expect([
      foundStudy.startingReferenceId,
      foundStudy.originalQuestionNodeId,
      foundStudy.mainQuestionNodeId,
    ]).toStrictEqual([reference.id, question.id, question.id]);
  });

  it('rejects model-level BIB-19 rows that cross owner or study (StudyBranch, question pointer)', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const study = await createStudy(owner.id);
    const otherStudy = await createStudy(owner.id);
    const foreignNode = await StudyNode.create({
      studyId: otherStudy.id,
      ownerId: owner.id,
      ...THOUGHT,
    });
    const node = await StudyNode.create({ studyId: study.id, ownerId: owner.id, ...THOUGHT });
    await expect(
      StudyBranch.create({ studyId: study.id, ownerId: otherOwner.id, rootNodeId: node.id }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(
      StudyBranch.create({ studyId: study.id, ownerId: owner.id, rootNodeId: foreignNode.id }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(study.update({ mainQuestionNodeId: foreignNode.id })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    // Same study and owner, but not a question: the pointer FKs include the node type.
    for (const pointer of ['mainQuestionNodeId', 'originalQuestionNodeId'] as const) {
      await expect(
        Study.update({ [pointer]: node.id }, { where: { id: study.id } }),
      ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    }
    expect(await StudyBranch.count({ where: { studyId: study.id } })).toBe(0);
  });

  it('rejects a model-level question without a statement (CHECK)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    await expect(
      StudyNode.create({ studyId: study.id, ownerId: owner.id, type: 'question', origin: 'user' }),
    ).rejects.toBeInstanceOf(DatabaseError);
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
      StudyNode.create({ studyId: study.id, ownerId: otherOwner.id, ...THOUGHT }),
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

  it('creates a Note and a NoteVersion with only required fields and reads them back with DB defaults (BIB-23)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const target = await StudyNode.create({
      studyId: study.id,
      ownerId: owner.id,
      ...THOUGHT,
    });
    const content = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
    const note = await Note.create({
      studyId: study.id,
      ownerId: owner.id,
      targetNodeId: target.id,
      richTextJson: content,
      plainText: '',
      searchText: '',
    });
    const [dbNow] = await db.query<{ now: Date }>('SELECT now() AS now', {
      type: QueryTypes.SELECT,
    });
    const version = await NoteVersion.create({
      noteId: note.id,
      studyId: study.id,
      ownerId: owner.id,
      versionNumber: 1,
      richTextJson: content,
      plainText: '',
    });
    expect(
      (await Note.findByPk(note.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      targetNodeId: target.id,
      targetReferenceId: null,
      targetAnchorJson: null,
      richTextJson: content,
      plainText: '',
      searchText: '',
      schemaVersion: 1,
      revision: 1,
      latestVersionNumber: 1,
      deletedAt: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const stored = await NoteVersion.findByPk(version.id, { rejectOnEmpty: true });
    expect(stored.get({ plain: true })).toStrictEqual({
      id: version.id,
      noteId: note.id,
      studyId: study.id,
      ownerId: owner.id,
      versionNumber: 1,
      richTextJson: content,
      plainText: '',
      schemaVersion: 1,
      createdAt: expect.any(Date),
    });
    // created_at is the database clock (its column default), read back from the insert.
    expect(version.createdAt).toStrictEqual(stored.createdAt);
    expect(Math.abs(stored.createdAt.getTime() - (dbNow?.now.getTime() ?? 0))).toBeLessThan(5_000);
  });

  it('rejects model-level notes and versions that cross owner, study or target, break their CHECKs, or update a version (BIB-23)', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const study = await createStudy(owner.id);
    const otherStudy = await createStudy(owner.id);
    const foreignNode = await StudyNode.create({
      studyId: otherStudy.id,
      ownerId: owner.id,
      ...THOUGHT,
    });
    const content = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
    const base = { studyId: study.id, ownerId: owner.id, richTextJson: content, searchText: '' };
    await expect(
      Note.create({ ...base, ownerId: otherOwner.id, plainText: '' }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(
      Note.create({ ...base, targetNodeId: foreignNode.id, plainText: '' }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(Note.create({ ...base, plainText: 'x'.repeat(50_001) })).rejects.toBeInstanceOf(
      DatabaseError,
    );
    await expect(
      Note.create({ ...base, plainText: '', richTextJson: { type: 'paragraph' } }),
    ).rejects.toBeInstanceOf(DatabaseError);
    const note = await Note.create({ ...base, plainText: '' });
    const versionOf = (fields: object) =>
      NoteVersion.create({
        noteId: note.id,
        studyId: study.id,
        ownerId: owner.id,
        versionNumber: 1,
        richTextJson: content,
        plainText: '',
        ...fields,
      });
    await expect(versionOf({ studyId: otherStudy.id })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    await expect(versionOf({ ownerId: otherOwner.id })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    const version = await versionOf({});
    await expect(versionOf({})).rejects.toBeInstanceOf(UniqueConstraintError);
    const updated = await NoteVersion.update(
      { plainText: 'rewritten' },
      { where: { id: version.id } },
    ).catch((e: unknown) => e);
    expect(updated).toBeInstanceOf(DatabaseError);
    expect((updated as DatabaseError).parent).toMatchObject({
      code: '23000',
      message: 'note versions are immutable',
    });
    // A study delete cascades through notes to their versions.
    await Study.destroy({ where: { id: study.id } });
    expect(await NoteVersion.count({ where: { noteId: note.id } })).toBe(0);
    expect(await Note.count({ where: { studyId: study.id } })).toBe(0);
  });

  /** A model-level anchor value: the column stores whatever the API checked; only its root is pinned. */
  const anchorValue = (editionId: string) => ({
    version: 1 as const,
    editionId,
    bookCode: 'ROM',
    kind: 'verses' as const,
    segments: [{ chapter: 9, verse: 1, start: 0, end: 4, textSha256: '0'.repeat(64) }],
    quote: 'I te',
  });

  it('creates an Annotation with only required fields and reads it back with DB defaults (BIB-24)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const reference = await ScriptureReference.findOne({ rejectOnEmpty: true });
    const anchorJson = anchorValue(reference.editionId);
    const annotation = await Annotation.create({
      studyId: study.id,
      ownerId: owner.id,
      referenceId: reference.id,
      editionId: reference.editionId,
      bookCode: reference.bookCode,
      startChapter: reference.startChapter,
      endChapter: reference.endChapter,
      anchorJson,
      colorToken: 'blue',
    });
    expect(
      (await Annotation.findByPk(annotation.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      referenceId: reference.id,
      editionId: reference.editionId,
      bookCode: reference.bookCode,
      startChapter: reference.startChapter,
      endChapter: reference.endChapter,
      anchorJson,
      colorToken: 'blue',
      label: null,
      revision: 1,
      deletedAt: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('rejects model-level annotations and note Scripture targets that cross owners or break their CHECKs; a study delete cascades (BIB-24)', async () => {
    const owner = await createUser();
    const otherOwner = await createUser();
    const study = await createStudy(owner.id);
    const reference = await ScriptureReference.findOne({ rejectOnEmpty: true });
    const anchorJson = anchorValue(reference.editionId);
    const base = {
      studyId: study.id,
      ownerId: owner.id,
      referenceId: reference.id,
      editionId: reference.editionId,
      bookCode: reference.bookCode,
      startChapter: 9,
      endChapter: 9,
      anchorJson,
      colorToken: 'yellow' as const,
    };
    await expect(Annotation.create({ ...base, ownerId: otherOwner.id })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    await expect(Annotation.create({ ...base, referenceId: randomUUID() })).rejects.toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    for (const bad of [
      { colorToken: 'red' },
      { label: '' },
      { label: 'x'.repeat(81) },
      { startChapter: 9, endChapter: 8 },
      { anchorJson: { ...anchorJson, version: 2 } },
    ]) {
      await expect(Annotation.create({ ...base, ...bad } as never)).rejects.toBeInstanceOf(
        DatabaseError,
      );
    }
    await Annotation.create({ ...base, label: '🙂'.repeat(80) });

    const content = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
    const node = await StudyNode.create({ studyId: study.id, ownerId: owner.id, ...THOUGHT });
    const note = { studyId: study.id, ownerId: owner.id, richTextJson: content, plainText: '' };
    const withTarget = await Note.create({
      ...note,
      searchText: '',
      targetReferenceId: reference.id,
      targetAnchorJson: anchorJson,
    });
    expect(
      (await Note.findByPk(withTarget.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toMatchObject({ targetReferenceId: reference.id, targetAnchorJson: anchorJson });
    for (const bad of [
      { targetReferenceId: reference.id },
      { targetAnchorJson: anchorJson },
      { targetReferenceId: reference.id, targetAnchorJson: anchorJson, targetNodeId: node.id },
    ]) {
      await expect(Note.create({ ...note, searchText: '', ...bad })).rejects.toBeInstanceOf(
        DatabaseError,
      );
    }
    await Study.destroy({ where: { id: study.id } });
    expect(await Annotation.count({ where: { studyId: study.id } })).toBe(0);
  });

  it('creates a StudyEdge with only required fields and reads it back with DB defaults; the model cannot cross studies or break its CHECKs (BIB-27)', async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const other = await createStudy(owner.id);
    const scope = { studyId: study.id, ownerId: owner.id };
    const a = await StudyNode.create({ ...scope, ...THOUGHT });
    const b = await StudyNode.create({ ...scope, ...THOUGHT });
    const elsewhere = await StudyNode.create({ studyId: other.id, ownerId: owner.id, ...THOUGHT });
    const edge = await StudyEdge.create({
      ...scope,
      sourceNodeId: a.id,
      targetNodeId: b.id,
      type: 'supports',
      origin: 'user',
    });
    expect(
      (await StudyEdge.findByPk(edge.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toStrictEqual({
      id: expect.stringMatching(UUID),
      studyId: study.id,
      ownerId: owner.id,
      sourceNodeId: a.id,
      targetNodeId: b.id,
      type: 'supports',
      note: null,
      origin: 'user',
      revision: 1,
      deletedAt: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const base = { ...scope, sourceNodeId: b.id, targetNodeId: a.id, origin: 'user' as const };
    await expect(
      StudyEdge.create({ ...base, type: 'supports', targetNodeId: elsewhere.id }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    for (const bad of [
      { type: 'implies' },
      { type: 'supports', targetNodeId: b.id },
      { type: 'supports', note: '' },
      { type: 'supports', note: 'x'.repeat(2001) },
      { type: 'supports', origin: 'external' },
      // Two-way types need the lower id as source; b → a is sorted only if b < a.
      { type: 'related_to', ...(a.id < b.id ? {} : { sourceNodeId: a.id, targetNodeId: b.id }) },
    ]) {
      await expect(StudyEdge.create({ ...base, ...bad } as never)).rejects.toBeInstanceOf(
        DatabaseError,
      );
    }
    await Study.destroy({ where: { id: study.id } });
    expect(await StudyEdge.count({ where: { studyId: study.id } })).toBe(0);
  });

  it("creates a StudyViewState and StudyNodePositions through the models and reads them back with DB defaults; a position cannot name another study's node or break its bounds (BIB-28)", async () => {
    const owner = await createUser();
    const study = await createStudy(owner.id);
    const other = await createStudy(owner.id);
    const scope = { studyId: study.id, ownerId: owner.id };
    const node = await StudyNode.create({ ...scope, ...THOUGHT });
    const elsewhere = await StudyNode.create({ studyId: other.id, ownerId: owner.id, ...THOUGHT });

    const viewState = await StudyViewState.create(scope);
    expect(
      (await StudyViewState.findByPk(viewState.id, { rejectOnEmpty: true })).get({ plain: true }),
    ).toStrictEqual({
      id: expect.stringMatching(UUID),
      ...scope,
      revision: 1,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });

    await StudyNodePosition.create({ ...scope, nodeId: node.id, x: 12.5, y: -7 });
    expect(
      (
        await StudyNodePosition.findOne({
          where: { studyId: study.id, nodeId: node.id },
          rejectOnEmpty: true,
        })
      ).get({ plain: true }),
    ).toStrictEqual({
      ...scope,
      nodeId: node.id,
      x: 12.5,
      y: -7,
      updatedAt: expect.any(Date),
    });
    await expect(
      StudyNodePosition.create({ ...scope, nodeId: elsewhere.id, x: 0, y: 0 }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(
      StudyNodePosition.create({
        studyId: other.id,
        ownerId: owner.id,
        nodeId: node.id,
        x: 0,
        y: 0,
      }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintError);
    await expect(
      StudyNodePosition.create({
        studyId: other.id,
        ownerId: owner.id,
        nodeId: elsewhere.id,
        x: 2e6,
        y: 0,
      }),
    ).rejects.toBeInstanceOf(DatabaseError);
    await Study.destroy({ where: { id: study.id } });
    expect(await StudyNodePosition.count({ where: { studyId: study.id } })).toBe(0);
    expect(await StudyViewState.count({ where: { studyId: study.id } })).toBe(0);
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
    // Since BIB-19 studies and Scripture nodes reference it, so PostgreSQL itself refuses a plain
    // TRUNCATE (0A000) before any trigger runs.
    const plain = await inReferenceTransaction(async (_editionId, transaction) => {
      await db.query('TRUNCATE scripture_reference', { transaction });
    }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(DatabaseError);
    expect((plain as DatabaseError).parent).toMatchObject({ code: '0A000' });
    // CASCADE gets past that check, and the statement trigger still refuses (in a rolled-back
    // transaction, so nothing referencing it is touched either way).
    const error = await inReferenceTransaction(async (_editionId, transaction) => {
      await db.query('TRUNCATE scripture_reference CASCADE', { transaction });
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).parent).toMatchObject({
      code: '23000',
      message: 'scripture_reference is immutable: TRUNCATE is not allowed',
    });
  });
});
