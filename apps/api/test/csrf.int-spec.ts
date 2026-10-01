import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { User } from '../src/database/models/user.model';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN = {
  code: 'FORBIDDEN',
  message: 'Forbidden',
  retryable: false,
  correlationId: expect.stringMatching(UUID),
};

/**
 * CSRF (PRD §29): a state-changing request from a browser origin outside CORS_ALLOWED_ORIGINS is
 * refused with 403 before body parsing, the session guard, or the handler, on public sign-in
 * routes and cookie-authenticated routes alike.
 */
describe('cross-site mutation protection', () => {
  let app: INestApplication<Server>;
  let allowedOrigin: string;
  let user: User;
  let cookie: string;
  const emails: string[] = [];

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  function newEmail(): string {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  async function challengeCount(email: string): Promise<number> {
    return AuthChallenge.count({ where: { normalizedEmail: email } });
  }

  async function liveSessionCount(): Promise<number> {
    return AuthSession.count({ where: { userId: user.id, revokedAt: null } });
  }

  beforeAll(async () => {
    app = await createTestApp();
    const [first] = app.get<Env>(ENV).CORS_ALLOWED_ORIGINS;
    if (!first) throw new Error('test env has no CORS origin');
    allowedOrigin = first;
    user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    const db = app.get<Database>(DATABASE);
    const sessions = app.get(SessionService);
    const { token } = await db.transaction((transaction) => sessions.create(user.id, transaction));
    cookie = `ba_session=${token}`;
  });

  afterAll(async () => {
    await AuthChallenge.destroy({ where: { normalizedEmail: emails } });
    await AuthSession.destroy({ where: { userId: user.id } });
    await User.destroy({ where: { normalizedEmail: emails } });
    await User.destroy({ where: { id: user.id } });
    await app.close();
  });

  describe('public sign-in route (login CSRF)', () => {
    it.each([
      ['a foreign Origin', { Origin: 'https://evil.test' }],
      ['Origin: null', { Origin: 'null' }],
      ['no Origin and Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ])('refuses %s with 403 before the handler runs', async (_, headers) => {
      const email = newEmail();
      const res = await http().post('/v1/auth/otp/start').set(headers).send({ email }).expect(403);
      expect(res.body).toStrictEqual(FORBIDDEN);
      expect(JSON.stringify(res.body)).not.toContain('evil.test');
      expect(await challengeCount(email)).toBe(0);
    });

    it('refuses the allowed host under another scheme or with a trailing slash', async () => {
      const otherScheme = allowedOrigin.startsWith('https://')
        ? allowedOrigin.replace('https://', 'http://')
        : allowedOrigin.replace('http://', 'https://');
      for (const origin of [otherScheme, `${allowedOrigin}/`]) {
        const res = await http()
          .post('/v1/auth/otp/start')
          .set('Origin', origin)
          .send({ email: newEmail() })
          .expect(403);
        expect(res.body).toStrictEqual(FORBIDDEN);
      }
    });

    it('refuses a cross-site form post with 403 (origin check runs before the JSON check)', async () => {
      const res = await http()
        .post('/v1/auth/otp/start')
        .set('Origin', 'https://evil.test')
        .type('form')
        .send({ email: newEmail() })
        .expect(403);
      expect(res.body).toStrictEqual(FORBIDDEN);
    });

    it('lets the allowed Origin through to normal handling', async () => {
      const email = newEmail();
      await http()
        .post('/v1/auth/otp/start')
        .set('Origin', allowedOrigin)
        .send({ email })
        .expect(202);
      expect(await challengeCount(email)).toBe(1);
    });

    it.each([
      ['no browser headers (non-browser client)', {}],
      ['Sec-Fetch-Site: same-origin', { 'Sec-Fetch-Site': 'same-origin' }],
    ])('lets %s through', async (_, headers) => {
      const email = newEmail();
      await http().post('/v1/auth/otp/start').set(headers).send({ email }).expect(202);
      expect(await challengeCount(email)).toBe(1);
    });
  });

  describe('cookie-authenticated mutation', () => {
    it('refuses a foreign-origin logout with 403 and leaves the session live', async () => {
      const res = await http()
        .post('/v1/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.test')
        .expect(403);
      expect(res.body).toStrictEqual(FORBIDDEN);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await liveSessionCount()).toBe(1);
    });
  });

  describe('reads', () => {
    it('does not apply to GET, even from a foreign origin', async () => {
      await http()
        .get('/v1/me')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.test')
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(200);
    });
  });
});
