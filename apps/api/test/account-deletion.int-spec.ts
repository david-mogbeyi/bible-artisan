import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { CreateStudyResponse, DeleteAccountResponse } from '@bible-artisan/contracts';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AccountDeletion } from '../src/database/models/account-deletion.model';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { ExportFile } from '../src/database/models/export-file.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { Note } from '../src/database/models/note.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { StudyNode } from '../src/database/models/study-node.model';
import { Study } from '../src/database/models/study.model';
import { Tag } from '../src/database/models/tag.model';
import { User } from '../src/database/models/user.model';
import { AccountPurgeService } from '../src/modules/identity/account-purge.service';
import { DevOtpProvider } from '../src/modules/identity/otp/dev-otp.provider';
import { OTP_PROVIDER, type OtpProvider } from '../src/modules/identity/otp/otp-provider';
import { createTestApp } from './app';
import { envelope, UNAUTHENTICATED } from './support/envelopes';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_COOKIE = /^ba_session=([A-Za-z0-9_-]{43});/;
const DAY_MS = 24 * 60 * 60 * 1000;

const ACCOUNT_DELETED = envelope({
  code: 'ACCOUNT_DELETED',
  message: 'This account was deleted and can no longer sign in',
});
const OTP_EXPIRED = envelope({
  code: 'OTP_EXPIRED',
  message: 'The code has expired or was already used',
});
const OTP_INVALID = envelope({ code: 'OTP_INVALID', message: 'The code is not correct' });

/** A code guaranteed to differ from `code`. */
const wrong = (code: string): string => (code === '000000' ? '111111' : '000000');

/** BIB-48: account deletion with a fresh OTP, immediate sign-out, purge and tombstones. */
describe('account deletion and purge (BIB-48)', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let provider: DevOtpProvider;
  const emails: string[] = [];

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  function newEmail(): string {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  /** Moves every challenge for `email` back past the 60 s resend window. */
  async function passResendWindow(email: string): Promise<void> {
    await db.query(
      `UPDATE auth_challenge SET created_at = created_at - interval '61 seconds'
        WHERE normalized_email = $1`,
      { bind: [email] },
    );
  }

  async function start(email: string): Promise<{ challengeId: string; code: string }> {
    await passResendWindow(email);
    const res = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const code = provider.latestCodeFor(email);
    if (!code) throw new Error('no code sent');
    return { challengeId: (res.body as { challengeId: string }).challengeId, code };
  }

  async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
    const { challengeId, code } = await start(email);
    const res = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
    const header = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    const token = SESSION_COOKIE.exec(header)?.[1];
    if (!token) throw new Error('no session cookie');
    return { cookie: `ba_session=${token}`, userId: (res.body as { id: string }).id };
  }

  const me = (cookie: string): Promise<Response> =>
    http()
      .get('/v1/me')
      .set('Cookie', cookie)
      .then((res) => res);

  function deleteAccount(cookie: string | null, body: object): Promise<Response> {
    let req = http().delete('/v1/me');
    if (cookie) req = req.set('Cookie', cookie);
    return req.send(body).then((res) => res);
  }

  /** A study with a tag and a note, and an account export: private rows in every kind of table. */
  async function privateData(cookie: string): Promise<string> {
    const created = await http()
      .post('/v1/studies')
      .set('Cookie', cookie)
      .send({ question: 'Who bears witness?' })
      .expect(201);
    const { studyId } = created.body as CreateStudyResponse;
    const revision = async () => (await Study.findByPk(studyId, { rejectOnEmpty: true })).revision;
    await http()
      .patch(`/v1/studies/${studyId}`)
      .set('Cookie', cookie)
      .send({ expectedRevision: await revision(), tags: { add: ['Private tag'] } })
      .expect(200);
    await http()
      .post(`/v1/studies/${studyId}/notes`)
      .set('Cookie', cookie)
      .send({
        expectedRevision: await revision(),
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Private' }] }],
        },
      })
      .expect(201);
    await http().post('/v1/me/exports').set('Cookie', cookie).send({ format: 'json' }).expect(201);
    return studyId;
  }

  /** Every private row of the user, by table: all zero once purged. */
  async function privateRows(userId: string, email: string): Promise<Record<string, number>> {
    return {
      user: await User.count({ where: { id: userId } }),
      study: await Study.count({ where: { ownerId: userId } }),
      study_node: await StudyNode.count({ where: { ownerId: userId } }),
      study_event: await StudyEvent.count({ where: { ownerId: userId } }),
      note: await Note.count({ where: { ownerId: userId } }),
      tag: await Tag.count({ where: { ownerId: userId } }),
      auth_session: await AuthSession.count({ where: { userId } }),
      auth_challenge: await AuthChallenge.count({ where: { normalizedEmail: email } }),
      mutation_receipt: await MutationReceipt.count({ where: { ownerId: userId } }),
      export_file: await ExportFile.count({ where: { ownerId: userId } }),
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    const otp = app.get<OtpProvider>(OTP_PROVIDER);
    if (!(otp instanceof DevOtpProvider))
      throw new Error('integration tests need OTP_PROVIDER=dev');
    provider = otp;
  });

  afterAll(async () => {
    await AuthChallenge.destroy({ where: { normalizedEmail: emails } });
    await User.destroy({ where: { normalizedEmail: emails } });
    await app.close();
  });

  it("DELETE /v1/me deletes only the signed-in user's account: sign-in and every session stop at once, the purge removes every private row, and another user keeps theirs", async () => {
    const email = newEmail();
    const alice = await signIn(email);
    const second = await signIn(email); // another device
    await privateData(alice.cookie);
    const bobEmail = newEmail();
    const bob = await signIn(bobEmail);
    const bobStudy = await privateData(bob.cookie);
    // Alice has AI on (BIB-40): deletion switches it off, which cancels her AI jobs.
    await User.update(
      { aiEnabled: true, aiConsentVersion: 'test-consent', aiConsentedAt: new Date() },
      { where: { id: alice.userId } },
    );

    const { challengeId, code } = await start(email);
    const res = await deleteAccount(alice.cookie, { challengeId, code });
    expect([res.status, res.body]).toStrictEqual([
      202,
      { deletionRequestedAt: expect.stringMatching(ISO), purgeBy: expect.stringMatching(ISO) },
    ]);
    const body = res.body as DeleteAccountResponse;
    expect(Date.parse(body.purgeBy) - Date.parse(body.deletionRequestedAt)).toBe(7 * DAY_MS);
    expect(res.headers['set-cookie']).toStrictEqual([
      expect.stringMatching(/^ba_session=; Path=\/; Max-Age=0;/),
    ]);

    // Immediately: no session of the account is served, and sign-in is refused.
    for (const cookie of [alice.cookie, second.cookie]) {
      const after = await me(cookie);
      expect([after.status, after.body]).toStrictEqual([401, UNAUTHENTICATED]);
    }
    const again = await start(email);
    const refused = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: again.challengeId, code: again.code });
    expect([refused.status, refused.body]).toStrictEqual([422, ACCOUNT_DELETED]);
    expect(await AccountDeletion.findByPk(alice.userId)).toMatchObject({
      userId: alice.userId,
      purgedAt: null,
    });
    expect(await User.findByPk(alice.userId, { rejectOnEmpty: true })).toMatchObject({
      deletionRequestedAt: expect.any(Date),
      aiEnabled: false,
    });

    // The purge workflow removes every live private row and export file.
    expect(await new AccountPurgeService(db).purgeDeleted()).toBeGreaterThanOrEqual(1);
    expect(await privateRows(alice.userId, email)).toStrictEqual({
      user: 0,
      study: 0,
      study_node: 0,
      study_event: 0,
      note: 0,
      tag: 0,
      auth_session: 0,
      auth_challenge: 0,
      mutation_receipt: 0,
      export_file: 0,
    });
    const tombstone = await AccountDeletion.findByPk(alice.userId, { rejectOnEmpty: true });
    expect(tombstone.purgedAt).toBeInstanceOf(Date);

    // Bob is untouched.
    expect((await me(bob.cookie)).status).toBe(200);
    expect(await Study.count({ where: { id: bobStudy } })).toBe(1);
    expect(await ExportFile.count({ where: { ownerId: bob.userId } })).toBe(1);
  });

  it('refuses a code sent to another email, a wrong code, and no session, changing nothing', async () => {
    const email = newEmail();
    const alice = await signIn(email);
    const otherEmail = newEmail();
    const other = await start(otherEmail);

    const foreign = await deleteAccount(alice.cookie, other);
    expect([foreign.status, foreign.body]).toStrictEqual([422, OTP_EXPIRED]);
    const own = await start(email);
    const wrongCode = await deleteAccount(alice.cookie, { ...own, code: wrong(own.code) });
    expect([wrongCode.status, wrongCode.body]).toStrictEqual([422, OTP_INVALID]);
    const anonymous = await deleteAccount(null, own);
    expect([anonymous.status, anonymous.body]).toStrictEqual([401, UNAUTHENTICATED]);
    const malformed = await deleteAccount(alice.cookie, { challengeId: own.challengeId });
    expect(malformed.status).toBe(400);

    expect((await me(alice.cookie)).status).toBe(200);
    expect(
      (await User.findByPk(alice.userId, { rejectOnEmpty: true })).deletionRequestedAt,
    ).toBeNull();
    expect(await AccountDeletion.count({ where: { userId: alice.userId } })).toBe(0);
    // The other email's challenge was not spent by the refused attempt.
    expect(
      (await AuthChallenge.findByPk(other.challengeId, { rejectOnEmpty: true })).attemptCount,
    ).toBe(0);
  });

  it('reapplies the deletion tombstone to an account a backup restore brings back: never served, purged again', async () => {
    const email = newEmail();
    const alice = await signIn(email);
    const { challengeId, code } = await start(email);
    expect((await deleteAccount(alice.cookie, { challengeId, code })).status).toBe(202);
    await new AccountPurgeService(db).purgeDeleted();
    expect(await User.count({ where: { id: alice.userId } })).toBe(0);

    // A restore from before the deletion: the user row (without the deletion mark), a study and a
    // live session come back; the tombstone table still holds the deletion.
    await db.query(`INSERT INTO "user" (id, normalized_email) VALUES ($1, $2)`, {
      bind: [alice.userId, email],
    });
    await Study.create({ ownerId: alice.userId, title: 'Restored' });
    const token = 'r'.repeat(43);
    await db.query(
      `INSERT INTO auth_session (user_id, token_hash, expires_at)
       VALUES ($1, encode(sha256($2::bytea), 'hex'), now() + interval '1 day')`,
      { bind: [alice.userId, token] },
    );

    const served = await me(`ba_session=${token}`);
    expect([served.status, served.body]).toStrictEqual([401, UNAUTHENTICATED]);
    const signInAgain = await start(email);
    const refused = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: signInAgain.challengeId, code: signInAgain.code });
    expect([refused.status, refused.body]).toStrictEqual([422, ACCOUNT_DELETED]);

    expect(await new AccountPurgeService(db).purgeDeleted()).toBeGreaterThanOrEqual(1);
    expect(await privateRows(alice.userId, email)).toMatchObject({
      user: 0,
      study: 0,
      auth_session: 0,
    });
  });
});
