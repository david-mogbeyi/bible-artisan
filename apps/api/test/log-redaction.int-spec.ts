import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { type INestApplication, Module } from '@nestjs/common';
import { CORRELATION_ID_HEADER } from '@bible-artisan/contracts';
import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { AuthSession } from '../src/database/models/auth-session.model';
import { MutationReceipt } from '../src/database/models/mutation-receipt.model';
import { StudyEvent } from '../src/database/models/study-event.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { DevOtpProvider } from '../src/modules/identity/otp/dev-otp.provider';
import { OTP_PROVIDER, type OtpProvider } from '../src/modules/identity/otp/otp-provider';
import { SessionService } from '../src/modules/identity/session.service';
import { createAppLogger } from '../src/modules/observability/logger';
import { createTestApp } from './app';
import { MutationProbeModule } from './support/mutation-probe';
import { OwnerIsolationProbeModule } from './support/owner-isolation-probe';

/** The real AppModule plus the test-only private study routes (path params, mutations). */
@Module({ imports: [OwnerIsolationProbeModule, MutationProbeModule] })
class LogProbeModule {}

/** Every key an access line or error line may carry: the logger's own plus the allowlist. */
const LOGGER_KEYS = ['level', 'pid', 'timestamp', 'message', 'context'];
const ACCESS_KEYS = new Set([
  ...LOGGER_KEYS,
  'method',
  'route',
  'status',
  'durationMs',
  'correlationId',
  'aborted',
]);
const ERROR_KEYS = new Set([...LOGGER_KEYS, 'code', 'status', 'correlationId', 'errorType']);

type LogEntry = Record<string, unknown>;

interface ExpectedError {
  code: string;
  errorType: string;
}

/**
 * NFR-PRIV-001 (BIB-13). Boots the app with the PRODUCTION logger (JSON, every level enabled) and
 * captures everything the process writes (stdout, stderr, and console.* in case anything bypasses
 * the logger). Requests carry unique sentinel strings in every channel a client controls: path,
 * path params, query string, headers (custom, User-Agent, Referer, Origin, a non-UUID
 * x-correlation-id, a non-UUID Idempotency-Key), cookies, and JSON or raw bodies. Real secrets
 * the flow produces (OTP code, session token, email, study ID, a valid Idempotency-Key) are
 * tracked the same way. No sentinel may appear anywhere in the output, on success or error
 * paths, for matched routes, unmatched routes, and requests refused before routing. Each request
 * must also produce exactly one access line with exactly the expected allowlisted fields, so the
 * test cannot pass by logging nothing.
 */
describe('content-redacted operational logs', () => {
  let app: INestApplication<Server>;
  let otp: DevOtpProvider;
  let cookie: string;
  let studyId: string;
  const userIds: string[] = [];
  const otpEmails: string[] = [];
  const captured: string[] = [];
  const sentinels: string[] = [];
  const spies: MockInstance[] = [];

  /** A unique private string; registered so the leak check looks for it. */
  const secret = (label: string): string => track(`SENTINEL-${label}-${randomUUID()}`);
  function track(value: string): string {
    sentinels.push(value);
    return value;
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** Adds private content to the query string and every header channel of a request. */
  function withPrivateChannels(req: Test, sessionCookie?: string): Test {
    return req
      .set('X-Private-Note', secret('header'))
      .set('User-Agent', secret('user-agent'))
      .set('Referer', `https://example.test/${secret('referer')}`)
      .set('x-correlation-id', secret('correlation'))
      .set('Cookie', `ba_session=${sessionCookie ?? secret('cookie')}; theme=${secret('cookie')}`);
  }

  /** A query string full of private search-like content. */
  const query = (): string =>
    `?q=${secret('query')}&ref=Romans+9%3A1&note=${encodeURIComponent(secret('query-note'))}`;

  /** The structured JSON lines the process wrote. Every captured line must be JSON. */
  function entries(): LogEntry[] {
    return captured
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogEntry);
  }

  /** Sentinels found in the output. Digit-only secrets ignore the logger's numeric fields. */
  function leaks(): string[] {
    const output = captured
      .join('')
      .replace(/"(timestamp|pid|durationMs|status)":[\d.]+/g, '')
      .toLowerCase();
    return sentinels.filter((value) => output.includes(value.toLowerCase()));
  }

  /** Waits for, then returns, the lines logged for one request (by its correlation ID). */
  async function linesFor(res: Response): Promise<{ access: LogEntry; errors: LogEntry[] }> {
    const correlationId = res.headers[CORRELATION_ID_HEADER.toLowerCase()];
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    return vi.waitFor(() => {
      const mine = entries().filter((entry) => entry.correlationId === correlationId);
      const access = mine.filter((entry) => entry.message === 'http_request');
      if (access.length !== 1) throw new Error(`expected 1 access line, got ${access.length}`);
      return { access: access[0] as LogEntry, errors: mine.filter((e) => e !== access[0]) };
    });
  }

  /** Asserts the request's whole log output: one access line, and an error line iff expected. */
  async function expectLogged(
    res: Response,
    access: { method: string; route: string; status: number },
    error?: ExpectedError,
  ): Promise<void> {
    expect(res.status).toBe(access.status);
    const correlationId = res.headers[CORRELATION_ID_HEADER.toLowerCase()];
    const lines = await linesFor(res);
    expect(lines.access).toStrictEqual({
      level: 'log',
      pid: expect.any(Number),
      timestamp: expect.any(Number),
      message: 'http_request',
      context: 'HttpRequest',
      ...access,
      durationMs: expect.any(Number),
      correlationId,
    });
    expect(lines.errors).toStrictEqual(
      error
        ? [
            {
              level: access.status >= 500 ? 'error' : 'warn',
              pid: expect.any(Number),
              timestamp: expect.any(Number),
              message: 'http_error',
              context: 'AllExceptionsFilter',
              code: error.code,
              status: access.status,
              correlationId,
              errorType: error.errorType,
            },
          ]
        : [],
    );
    if (error) {
      expect((res.body as { correlationId?: unknown }).correlationId).toBe(correlationId);
    }
    expect(leaks()).toStrictEqual([]);
  }

  beforeAll(async () => {
    const capture = (chunk: unknown): boolean => {
      captured.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString(),
      );
      return true;
    };
    spies.push(
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
    );
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      spies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          captured.push(`${JSON.stringify({ console: args.map((a) => inspect(a)).join(' ') })}\n`);
        }),
      );
    }

    app = await createTestApp(LogProbeModule, {
      logger: createAppLogger({ NODE_ENV: 'production', LOG_LEVEL: 'verbose' }),
    });
    const provider = app.get<OtpProvider>(OTP_PROVIDER);
    if (!(provider instanceof DevOtpProvider)) throw new Error('tests need OTP_PROVIDER=dev');
    otp = provider;

    const user = await User.create({ normalizedEmail: track(`${randomUUID()}@example.test`) });
    userIds.push(user.id);
    const db = app.get<Database>(DATABASE);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    cookie = track(token);
    studyId = track((await Study.create({ ownerId: user.id, title: secret('study-title') })).id);
  });

  afterAll(async () => {
    const otpUsers = await User.findAll({ where: { normalizedEmail: otpEmails } });
    userIds.push(...otpUsers.map((user) => user.id));
    await StudyEvent.destroy({ where: { ownerId: userIds } });
    await MutationReceipt.destroy({ where: { ownerId: userIds } });
    await Study.destroy({ where: { ownerId: userIds } });
    await AuthSession.destroy({ where: { userId: userIds } });
    await AuthChallenge.destroy({ where: { normalizedEmail: otpEmails } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
    for (const spy of spies) spy.mockRestore();
  });

  it('logs a public success with only the route pattern', async () => {
    const res = await withPrivateChannels(http().get(`/v1/health${query()}`));
    await expectLogged(res, { method: 'GET', route: '/v1/health', status: 200 });
  });

  it('logs an unmatched route as "unmatched", never its path', async () => {
    const res = await withPrivateChannels(
      http().get(`/v1/${secret('path')}/romans-9-1/${secret('path')}${query()}`),
    );
    await expectLogged(
      res,
      { method: 'GET', route: 'unmatched', status: 404 },
      { code: 'NOT_FOUND', errorType: 'NotFoundException' },
    );
  });

  it('logs a private route without a valid session (401)', async () => {
    const res = await withPrivateChannels(http().get(`/v1/me${query()}`));
    await expectLogged(
      res,
      { method: 'GET', route: '/v1/me', status: 401 },
      { code: 'UNAUTHENTICATED', errorType: 'UnauthenticatedError' },
    );
  });

  it('logs a signed-in read without the response body or session token', async () => {
    const res = await withPrivateChannels(http().get(`/v1/me${query()}`), cookie);
    await expectLogged(res, { method: 'GET', route: '/v1/me', status: 200 });
  });

  it('logs an OTP sign-in without the email, code, or new session token', async () => {
    const email = track(`sentinel-${randomUUID()}@example.test`);
    otpEmails.push(email);
    const started = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`)).send({
      email,
    });
    await expectLogged(started, { method: 'POST', route: '/v1/auth/otp/start', status: 202 });

    const code = track(otp.latestCodeFor(email) ?? 'missing-code');
    const { challengeId } = started.body as { challengeId: string };
    const verified = await withPrivateChannels(http().post('/v1/auth/otp/verify')).send({
      challengeId: track(challengeId),
      code,
    });
    for (const header of [verified.headers['set-cookie'] ?? []].flat()) {
      track(/^ba_session=([^;]+)/.exec(header)?.[1] ?? 'no-session-cookie');
    }
    await expectLogged(verified, { method: 'POST', route: '/v1/auth/otp/verify', status: 200 });
  });

  it('logs OTP validation failures without the submitted values', async () => {
    const badEmail = await withPrivateChannels(http().post('/v1/auth/otp/start')).send({
      email: secret('not-an-email'),
    });
    await expectLogged(
      badEmail,
      { method: 'POST', route: '/v1/auth/otp/start', status: 400 },
      { code: 'VALIDATION', errorType: 'ValidationError' },
    );

    const badCode = await withPrivateChannels(http().post('/v1/auth/otp/verify')).send({
      challengeId: secret('challenge'),
      code: secret('otp-code'),
    });
    await expectLogged(
      badCode,
      { method: 'POST', route: '/v1/auth/otp/verify', status: 400 },
      { code: 'VALIDATION', errorType: 'ValidationError' },
    );
  });

  it('logs a cross-site mutation refused before routing (403)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/logout${query()}`))
      .set('Origin', `https://${secret('origin').toLowerCase()}.example`)
      .send({ note: secret('body') });
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 403 },
      { code: 'FORBIDDEN', errorType: 'ForbiddenException' },
    );
  });

  it('logs a non-JSON mutation refused before parsing (415)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`))
      .set('Content-Type', 'text/plain')
      .send(secret('text-body'));
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 415 },
      { code: 'UNSUPPORTED_MEDIA_TYPE', errorType: 'UnsupportedMediaTypeException' },
    );
  });

  it('logs an oversized body refused by the parser (413)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`)).send({
      email: `${secret('huge-body')}${'x'.repeat(200_000)}`,
    });
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 413 },
      { code: 'PAYLOAD_TOO_LARGE', errorType: 'PayloadTooLargeError' },
    );
  });

  it('logs malformed JSON without echoing it (400)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`))
      .set('Content-Type', 'application/json')
      .send(`{"email": "${secret('malformed-json')}`);
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 400 },
      { code: 'BAD_REQUEST', errorType: 'BadRequestException' },
    );
  });

  it('logs a private path param by its pattern only (404)', async () => {
    const res = await withPrivateChannels(
      http().get(`/v1/__test/studies/${secret('param')}${query()}`),
      cookie,
    );
    await expectLogged(
      res,
      { method: 'GET', route: '/v1/__test/studies/:studyId', status: 404 },
      { code: 'NOT_FOUND', errorType: 'NotFoundError' },
    );
  });

  it('logs study mutations (success, conflict, failure) without IDs, keys, or content', async () => {
    const path = `/v1/__test/studies/${studyId}/mutations`;
    const mutate = (body: Record<string, unknown>, key: string): Test =>
      withPrivateChannels(http().post(`${path}${query()}`), cookie)
        .set('Idempotency-Key', key)
        .send(body);
    const route = '/v1/__test/studies/:studyId/mutations';

    const ok = await mutate({ expectedRevision: 1, title: secret('title') }, track(randomUUID()));
    await expectLogged(ok, { method: 'POST', route, status: 200 });

    const stale = await mutate(
      { expectedRevision: 1, title: secret('title') },
      track(randomUUID()),
    );
    await expectLogged(
      stale,
      { method: 'POST', route, status: 409 },
      { code: 'REVISION_CONFLICT', errorType: 'RevisionConflictError' },
    );

    const failed = await mutate(
      { expectedRevision: 2, title: secret('title'), failAfterWrite: true },
      track(randomUUID()),
    );
    await expectLogged(
      failed,
      { method: 'POST', route, status: 500 },
      { code: 'INTERNAL_ERROR', errorType: 'ProbeFailure' },
    );

    const badKey = await mutate({ expectedRevision: 2, title: secret('title') }, secret('key'));
    await expectLogged(
      badKey,
      { method: 'POST', route, status: 400 },
      { code: 'VALIDATION', errorType: 'ValidationError' },
    );
  });

  it('uses one correlation ID per request across header, envelope, and every log line', async () => {
    const supplied = randomUUID();
    const res = await http().get('/v1/me').set('x-correlation-id', supplied).expect(401);
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toBe(supplied);
    expect((res.body as { correlationId: string }).correlationId).toBe(supplied);
    const { access, errors } = await linesFor(res);
    expect([access, ...errors].map((entry) => entry.correlationId)).toStrictEqual([
      supplied,
      supplied,
    ]);
  });

  it('writes only structured lines whose keys are all allowlisted', () => {
    const all = entries();
    const requestLines = all.filter((entry) => entry.message === 'http_request');
    const errorLines = all.filter((entry) => entry.message === 'http_error');
    expect(requestLines.length).toBeGreaterThanOrEqual(17);
    expect(errorLines.length).toBeGreaterThanOrEqual(12);
    for (const entry of requestLines) {
      expect(Object.keys(entry).filter((key) => !ACCESS_KEYS.has(key))).toStrictEqual([]);
    }
    for (const entry of errorLines) {
      expect(Object.keys(entry).filter((key) => !ERROR_KEYS.has(key))).toStrictEqual([]);
    }
    expect(all.filter((entry) => 'console' in entry)).toStrictEqual([]);
    expect(leaks()).toStrictEqual([]);
  });
});
