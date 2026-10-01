import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DependencyUnavailableError } from '../src/common/errors/domain-errors';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { User } from '../src/database/models/user.model';
import { DevOtpProvider } from '../src/modules/identity/otp/dev-otp.provider';
import {
  OTP_PROVIDER,
  type OtpProvider,
  type OtpVerifyResult,
} from '../src/modules/identity/otp/otp-provider';
import { createTestApp } from './app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_COOKIE =
  /^ba_session=([A-Za-z0-9_-]{43}); Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function envelope(code: string, message: string, retryable = false): Record<string, unknown> {
  return { code, message, retryable, correlationId: expect.stringMatching(UUID) };
}

const OTP_EXPIRED = envelope('OTP_EXPIRED', 'The code has expired or was already used');
const OTP_INVALID = envelope('OTP_INVALID', 'The code is not correct');
const OTP_EXHAUSTED = envelope('OTP_ATTEMPTS_EXHAUSTED', 'Too many attempts for this code');
const UNAUTHENTICATED = envelope('UNAUTHENTICATED', 'Sign in to continue');

/** A code guaranteed to differ from `code`. */
const wrong = (code: string): string => (code === '000000' ? '111111' : '000000');

function setCookie(res: Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown;
  return Array.isArray(header) ? (header as string[])[0] : undefined;
}

function sessionTokenFrom(res: Response): string {
  const match = SESSION_COOKIE.exec(setCookie(res) ?? '');
  if (!match?.[1]) throw new Error('response did not set a session cookie');
  return match[1];
}

const cookie = (token: string): string => `ba_session=${token}`;

describe('email OTP sign-in and sessions', () => {
  let app: INestApplication<Server>;
  let provider: DevOtpProvider;
  const emails: string[] = [];

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  function newEmail(): string {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  async function start(email: string): Promise<{ challengeId: string; code: string }> {
    const res = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const body = res.body as { challengeId: string };
    const code = provider.latestCodeFor(email.trim().toLowerCase());
    if (!code) throw new Error('no code sent');
    return { challengeId: body.challengeId, code };
  }

  /** Moves every challenge for `email` back in time, past the 60 s resend window. */
  async function passResendWindow(email: string): Promise<void> {
    const challenges = await AuthChallenge.findAll({ where: { normalizedEmail: email } });
    for (const challenge of challenges) {
      await challenge.update({ createdAt: new Date(challenge.createdAt.getTime() - 61_000) });
    }
  }

  async function signIn(email: string, presentedToken?: string): Promise<string> {
    const { challengeId, code } = await start(email);
    const req = http().post('/v1/auth/otp/verify');
    if (presentedToken) void req.set('Cookie', cookie(presentedToken));
    const res = await req.send({ challengeId, code }).expect(200);
    return sessionTokenFrom(res);
  }

  beforeAll(async () => {
    app = await createTestApp();
    const otp = app.get<OtpProvider>(OTP_PROVIDER);
    if (!(otp instanceof DevOtpProvider))
      throw new Error('integration tests need OTP_PROVIDER=dev');
    provider = otp;
  });

  afterAll(async () => {
    await AuthChallenge.destroy({ where: { normalizedEmail: emails } });
    await User.destroy({ where: { normalizedEmail: emails } }); // cascades to auth_session
    await app.close();
  });

  it('signs a new user in: account created, secure session cookie set, /me opens', async () => {
    const email = newEmail();
    const startRes = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    expect(startRes.body).toStrictEqual({
      challengeId: expect.stringMatching(UUID),
      expiresAt: expect.stringMatching(ISO),
      resendAvailableAt: expect.stringMatching(ISO),
    });
    const { challengeId, expiresAt, resendAvailableAt } = startRes.body as {
      challengeId: string;
      expiresAt: string;
      resendAvailableAt: string;
    };
    const sentAt = Date.now();
    expect(Date.parse(expiresAt) - sentAt).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(expiresAt) - sentAt).toBeLessThanOrEqual(10 * 60_000);
    expect(Date.parse(resendAvailableAt) - sentAt).toBeLessThanOrEqual(60_000);

    const code = provider.latestCodeFor(email) ?? '';
    const verifyRes = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code })
      .expect(200);
    const user = await User.findOne({ where: { normalizedEmail: email }, rejectOnEmpty: true });
    expect(verifyRes.body).toStrictEqual({
      id: user.id,
      email,
      displayName: null,
      timezone: 'UTC',
    });
    expect(verifyRes.headers['cache-control']).toBe('no-store');
    expect(user.authSubject).toMatch(/^dev\|[0-9a-f]{32}$/);
    const token = sessionTokenFrom(verifyRes);

    const meRes = await http().get('/v1/me').set('Cookie', cookie(token)).expect(200);
    expect(meRes.body).toStrictEqual({ id: user.id, email, displayName: null, timezone: 'UTC' });
    expect(meRes.headers['cache-control']).toBe('no-store');

    // Only the token's hash is stored.
    const stored = await AuthSession.findAll({ where: { userId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.tokenHash).not.toBe(token);
  });

  it('normalizes the email (trim + lower-case) for the account and the code', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(`  ${email.toUpperCase()} `);
    const res = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
    expect((res.body as { email: string }).email).toBe(email);
  });

  it('resumes an existing account instead of creating a duplicate', async () => {
    const email = newEmail();
    const existing = await User.create({ normalizedEmail: email, displayName: 'Reader' });
    const { challengeId, code } = await start(email);
    const res = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
    expect(res.body).toStrictEqual({
      id: existing.id,
      email,
      displayName: 'Reader',
      timezone: 'UTC',
    });
    expect(await User.count({ where: { normalizedEmail: email } })).toBe(1);
  });

  it('rotates the session on sign-in: the presented session is revoked', async () => {
    const email = newEmail();
    const first = await signIn(email);
    await passResendWindow(email);
    const second = await signIn(email, first);
    expect(second).not.toBe(first);
    expect(
      (await http().get('/v1/me').set('Cookie', cookie(first)).expect(401)).body,
    ).toStrictEqual(UNAUTHENTICATED);
    await http().get('/v1/me').set('Cookie', cookie(second)).expect(200);
  });

  it('refuses a wrong code (OTP_INVALID) without a cookie, then accepts the right one', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(email);
    const bad = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code: wrong(code) })
      .expect(422);
    expect(bad.body).toStrictEqual(OTP_INVALID);
    expect(setCookie(bad)).toBeUndefined();
    await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
  });

  it('allows five attempts per code, then refuses even the right code', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(email);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await http()
        .post('/v1/auth/otp/verify')
        .send({ challengeId, code: wrong(code) })
        .expect(422);
      expect(res.body).toStrictEqual(OTP_INVALID);
    }
    const fifth = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code: wrong(code) })
      .expect(422);
    expect(fifth.body).toStrictEqual(OTP_EXHAUSTED);

    const right = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(422);
    expect(right.body).toStrictEqual(OTP_EXHAUSTED);
    expect(setCookie(right)).toBeUndefined();
    const challenge = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
    expect(challenge.attemptCount).toBe(5);
    expect(challenge.consumedAt).toBeNull();
  });

  it('refuses an expired code (OTP_EXPIRED)', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(email);
    await AuthChallenge.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { id: challengeId } },
    );
    const res = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(422);
    expect(res.body).toStrictEqual(OTP_EXPIRED);
    expect(setCookie(res)).toBeUndefined();
  });

  it('refuses a reused code (OTP_EXPIRED)', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(email);
    await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
    const res = await http().post('/v1/auth/otp/verify').send({ challengeId, code }).expect(422);
    expect(res.body).toStrictEqual(OTP_EXPIRED);
  });

  it('refuses an unknown challenge (OTP_EXPIRED)', async () => {
    const res = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: randomUUID(), code: '123456' })
      .expect(422);
    expect(res.body).toStrictEqual(OTP_EXPIRED);
  });

  it('enforces the 60 s resend window with 429 + Retry-After, then supersedes the old code', async () => {
    const email = newEmail();
    const first = await start(email);

    const limited = await http()
      .post('/v1/auth/otp/start')
      .send({ email: email.toUpperCase() })
      .expect(429);
    expect(limited.body).toStrictEqual(
      envelope('RATE_LIMITED', 'Too many requests. Try again later', true),
    );
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    await passResendWindow(email);
    const second = await start(email);
    expect(second.challengeId).not.toBe(first.challengeId);

    const old = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: first.challengeId, code: first.code })
      .expect(422);
    expect(old.body).toStrictEqual(OTP_EXPIRED);
    await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: second.challengeId, code: second.code })
      .expect(200);
  });

  it('sends only one code when two starts for one email race', async () => {
    const email = newEmail();
    const results = await Promise.all([
      http().post('/v1/auth/otp/start').send({ email }),
      http().post('/v1/auth/otp/start').send({ email }),
    ]);
    expect(results.map((r) => r.status).sort()).toStrictEqual([202, 429]);
    expect(await AuthChallenge.count({ where: { normalizedEmail: email } })).toBe(1);
  });

  it('creates at most one session when two correct verifications race', async () => {
    const email = newEmail();
    const { challengeId, code } = await start(email);
    const results = await Promise.all([
      http().post('/v1/auth/otp/verify').send({ challengeId, code }),
      http().post('/v1/auth/otp/verify').send({ challengeId, code }),
    ]);
    expect(results.map((r) => r.status).sort()).toStrictEqual([200, 422]);
    const user = await User.findOne({ where: { normalizedEmail: email }, rejectOnEmpty: true });
    expect(await AuthSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it.each([
    ['a missing email', {}, { email: ['Invalid input: expected string, received undefined'] }],
    ['a malformed email', { email: 'not-an-email' }, { email: ['Enter a valid email address'] }],
  ])('rejects %s on start with 400 VALIDATION', async (_label, body, fieldErrors) => {
    const res = await http().post('/v1/auth/otp/start').send(body).expect(400);
    expect(res.body).toStrictEqual({
      ...envelope('VALIDATION', 'Invalid request'),
      fieldErrors,
    });
  });

  it('rejects a malformed verify body with 400 VALIDATION', async () => {
    const res = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId: 'nope', code: '12ab' })
      .expect(400);
    expect(res.body).toStrictEqual({
      ...envelope('VALIDATION', 'Invalid request'),
      fieldErrors: { challengeId: ['Invalid UUID'], code: ['Enter the 6-digit code'] },
    });
  });

  describe('JSON-only mutations (login CSRF)', () => {
    const UNSUPPORTED = envelope('UNSUPPORTED_MEDIA_TYPE', 'Unsupported Media Type');

    it('refuses a form-encoded start with 415: no code sent, no challenge kept', async () => {
      const email = newEmail();
      const res = await http().post('/v1/auth/otp/start').type('form').send({ email }).expect(415);
      expect(res.body).toStrictEqual(UNSUPPORTED);
      expect(setCookie(res)).toBeUndefined();
      expect(await AuthChallenge.count({ where: { normalizedEmail: email } })).toBe(0);
      expect(provider.latestCodeFor(email)).toBeUndefined();
    });

    it.each([
      ['form-encoded', 'application/x-www-form-urlencoded'],
      ['text/plain (a JSON-looking form body)', 'text/plain'],
      ['multipart', 'multipart/form-data; boundary=x'],
    ])(
      'refuses a %s verify with 415, sets no cookie, and keeps the code usable',
      async (_label, contentType) => {
        const email = newEmail();
        const { challengeId, code } = await start(email);
        const body =
          contentType === 'text/plain'
            ? JSON.stringify({ challengeId, code })
            : contentType.startsWith('multipart')
              ? `--x\r\nContent-Disposition: form-data; name="code"\r\n\r\n${code}\r\n--x--\r\n`
              : new URLSearchParams({ challengeId, code }).toString();
        const res = await http()
          .post('/v1/auth/otp/verify')
          .set('content-type', contentType)
          .send(body)
          .expect(415);
        expect(res.body).toStrictEqual(UNSUPPORTED);
        expect(setCookie(res)).toBeUndefined();

        // The refused request never reached the handler: no attempt spent, JSON still works.
        const challenge = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
        expect(challenge.attemptCount).toBe(0);
        const ok = await http()
          .post('/v1/auth/otp/verify')
          .set('content-type', 'application/json; charset=utf-8')
          .send(JSON.stringify({ challengeId, code }))
          .expect(200);
        sessionTokenFrom(ok);
      },
    );

    it('refuses a cross-site form logout (no body) with 415 and keeps the session', async () => {
      const token = await signIn(newEmail());
      const res = await http()
        .post('/v1/auth/logout')
        .set('Cookie', cookie(token))
        .set('content-type', 'application/x-www-form-urlencoded')
        .expect(415);
      expect(res.body).toStrictEqual(UNSUPPORTED);
      expect(setCookie(res)).toBeUndefined();
      await http().get('/v1/me').set('Cookie', cookie(token)).expect(200);
      // The web client's JSON logout (Content-Type set, no body) still works.
      await http()
        .post('/v1/auth/logout')
        .set('Cookie', cookie(token))
        .set('content-type', 'application/json')
        .expect(204);
    });

    it('refuses a non-JSON body on a non-standard state-changing method with 415', async () => {
      const token = await signIn(newEmail());
      const res = await http()
        .propfind('/v1/auth/logout')
        .set('Cookie', cookie(token))
        .set('content-type', 'text/plain')
        .send('email=victim@example.test')
        .expect(415);
      expect(res.body).toStrictEqual(UNSUPPORTED);
      await http().get('/v1/me').set('Cookie', cookie(token)).expect(200);
    });
  });

  describe('session validity on /v1/me', () => {
    it.each([
      ['no cookie', undefined],
      ['a malformed cookie', 'ba_session=not-a-token'],
      ['an unknown token', cookie('A'.repeat(43))],
    ])('returns 401 with %s', async (_label, header) => {
      const req = http().get('/v1/me');
      if (header) void req.set('Cookie', header);
      expect((await req.expect(401)).body).toStrictEqual(UNAUTHENTICATED);
    });

    it('returns 401 after more than 7 days idle, but keeps a 6-day-idle session alive', async () => {
      const email = newEmail();
      const token = await signIn(email);
      const user = await User.findOne({ where: { normalizedEmail: email }, rejectOnEmpty: true });

      await AuthSession.update(
        { lastSeenAt: new Date(Date.now() - 6 * DAY_MS) },
        { where: { userId: user.id } },
      );
      await http().get('/v1/me').set('Cookie', cookie(token)).expect(200);
      const touched = await AuthSession.findOne({
        where: { userId: user.id },
        rejectOnEmpty: true,
      });
      expect(Date.now() - touched.lastSeenAt.getTime()).toBeLessThan(60_000);

      await AuthSession.update(
        { lastSeenAt: new Date(Date.now() - 7 * DAY_MS - 60_000) },
        { where: { userId: user.id } },
      );
      expect(
        (await http().get('/v1/me').set('Cookie', cookie(token)).expect(401)).body,
      ).toStrictEqual(UNAUTHENTICATED);
    });

    it('returns 401 past the 30-day absolute expiry even when recently active', async () => {
      const email = newEmail();
      const token = await signIn(email);
      const user = await User.findOne({ where: { normalizedEmail: email }, rejectOnEmpty: true });
      const session = await AuthSession.findOne({
        where: { userId: user.id },
        rejectOnEmpty: true,
      });
      expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(30 * DAY_MS);
      await session.update({ expiresAt: new Date(Date.now() - 1000), lastSeenAt: new Date() });
      await http().get('/v1/me').set('Cookie', cookie(token)).expect(401);
    });
  });

  it('logs out: revokes the session and clears the cookie', async () => {
    const token = await signIn(newEmail());
    const res = await http().post('/v1/auth/logout').set('Cookie', cookie(token)).expect(204);
    expect(setCookie(res)).toBe('ba_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    await http().get('/v1/me').set('Cookie', cookie(token)).expect(401);
    // Signing out without a session is harmless.
    await http().post('/v1/auth/logout').expect(204);
  });

  it('cross-user: each session sees only its own account', async () => {
    const emailA = newEmail();
    const emailB = newEmail();
    const tokenA = await signIn(emailA);
    const tokenB = await signIn(emailB);
    const a = await http().get('/v1/me').set('Cookie', cookie(tokenA)).expect(200);
    const b = await http().get('/v1/me').set('Cookie', cookie(tokenB)).expect(200);
    const [userA, userB] = await Promise.all([
      User.findOne({ where: { normalizedEmail: emailA }, rejectOnEmpty: true }),
      User.findOne({ where: { normalizedEmail: emailB }, rejectOnEmpty: true }),
    ]);
    expect(a.body).toStrictEqual({
      id: userA.id,
      email: emailA,
      displayName: null,
      timezone: 'UTC',
    });
    expect(b.body).toStrictEqual({
      id: userB.id,
      email: emailB,
      displayName: null,
      timezone: 'UTC',
    });
  });

  it('keeps health and OpenAPI public while other routes require a session', async () => {
    await http().get('/v1/health').expect(200);
    await http().get('/v1/openapi.json').expect(200);
  });

  it('never puts the email, code, or session token in logs or error bodies (NFR-PRIV-001)', async () => {
    const logged: unknown[][] = [];
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const email = newEmail();
    const token = await signIn(email);
    await passResendWindow(email);
    const { challengeId, code } = await start(email);
    const bodies = [
      (await http().post('/v1/auth/otp/start').send({ email })).body,
      (
        await http()
          .post('/v1/auth/otp/verify')
          .send({ challengeId, code: wrong(code) })
      ).body,
      (
        await http()
          .post('/v1/auth/otp/start')
          .send({ email: `${email}x` })
      ).body,
      (
        await http()
          .get('/v1/me')
          .set('Cookie', cookie(`${token.slice(0, 42)}Z`))
      ).body,
    ];
    const serialized = JSON.stringify([logged, bodies]);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [email, email.split('@')[0] ?? email, code, token]) {
      expect(serialized).not.toContain(secret);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

/** A scriptable provider, to exercise outages without a real network. */
class ScriptedProvider implements OtpProvider {
  sendFails = false;
  verifyFails = false;
  verifyResult: OtpVerifyResult = { status: 'invalid' };
  private sent = 0;
  send(): Promise<{ providerRef: string }> {
    this.sent += 1;
    return this.sendFails
      ? Promise.reject(new DependencyUnavailableError())
      : Promise.resolve({ providerRef: `scripted-ref-${this.sent}` });
  }
  verify(): Promise<OtpVerifyResult> {
    return this.verifyFails
      ? Promise.reject(new DependencyUnavailableError())
      : Promise.resolve(this.verifyResult);
  }
}

describe('email OTP provider outages', () => {
  let app: INestApplication<Server>;
  const provider = new ScriptedProvider();
  const emails: string[] = [];
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const DEPENDENCY = envelope(
    'DEPENDENCY_UNAVAILABLE',
    'A required service is temporarily unavailable',
    true,
  );

  beforeAll(async () => {
    app = await createTestApp(undefined, {
      override: (builder) => builder.overrideProvider(OTP_PROVIDER).useValue(provider),
    });
  });

  afterAll(async () => {
    await AuthChallenge.destroy({ where: { normalizedEmail: { [Op.in]: emails } } });
    await User.destroy({ where: { normalizedEmail: { [Op.in]: emails } } });
    await app.close();
  });

  it('returns 503 when the code cannot be sent, keeps no challenge, and allows an immediate retry', async () => {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    provider.sendFails = true;
    const res = await http().post('/v1/auth/otp/start').send({ email }).expect(503);
    expect(res.body).toStrictEqual(DEPENDENCY);
    expect(await AuthChallenge.count({ where: { normalizedEmail: email } })).toBe(0);

    provider.sendFails = false;
    await http().post('/v1/auth/otp/start').send({ email }).expect(202);
  });

  it('keeps the previous code verifiable when a resend fails to send', async () => {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    const started = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const { challengeId } = started.body as { challengeId: string };
    const before = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
    // Past the 60 s resend window.
    await before.update({ createdAt: new Date(before.createdAt.getTime() - 61_000) });

    provider.sendFails = true;
    await http().post('/v1/auth/otp/start').send({ email }).expect(503);
    provider.sendFails = false;

    const after = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
    expect(after.expiresAt).toStrictEqual(before.expiresAt);
    expect(await AuthChallenge.count({ where: { normalizedEmail: email } })).toBe(1);
    provider.verifyResult = { status: 'ok', subject: `scripted|${randomUUID()}` };
    try {
      const res = await http()
        .post('/v1/auth/otp/verify')
        .send({ challengeId, code: '123456' })
        .expect(200);
      expect(res.body).toStrictEqual({
        id: expect.stringMatching(UUID),
        email,
        displayName: null,
        timezone: 'UTC',
      });
    } finally {
      provider.verifyResult = { status: 'invalid' };
    }
  });

  it('supersedes the previous code only once a resend has been sent', async () => {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    const first = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const { challengeId } = first.body as { challengeId: string };
    const old = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
    await old.update({ createdAt: new Date(old.createdAt.getTime() - 61_000) });

    await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const res = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code: '123456' })
      .expect(422);
    expect(res.body).toStrictEqual(
      envelope('OTP_EXPIRED', 'The code has expired or was already used'),
    );
  });

  it('returns 503 when the code cannot be checked, without spending an attempt', async () => {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    const started = await http().post('/v1/auth/otp/start').send({ email }).expect(202);
    const { challengeId } = started.body as { challengeId: string };

    provider.verifyFails = true;
    const res = await http()
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code: '123456' })
      .expect(503);
    expect(res.body).toStrictEqual(DEPENDENCY);
    provider.verifyFails = false;

    const challenge = await AuthChallenge.findByPk(challengeId, { rejectOnEmpty: true });
    expect(challenge.attemptCount).toBe(0);
  });
});
