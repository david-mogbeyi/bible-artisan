import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { type INestApplication, Module } from '@nestjs/common';
import { CORRELATION_ID_HEADER, STUDY_START_REQUIRED } from '@bible-artisan/contracts';
import request, { type Response, type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthChallenge } from '../src/database/models/auth-challenge.model';
import { BibleBook } from '../src/database/models/bible-book.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { BibleVerse } from '../src/database/models/bible-verse.model';
import { Study } from '../src/database/models/study.model';
import { User } from '../src/database/models/user.model';
import { DevOtpProvider } from '../src/modules/identity/otp/dev-otp.provider';
import { OTP_PROVIDER, type OtpProvider } from '../src/modules/identity/otp/otp-provider';
import { SessionService } from '../src/modules/identity/session.service';
import { createAppLogger } from '../src/modules/observability/logger';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';
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
  errorType: string;
  /** The whole error envelope the client gets, minus its correlation ID (the request's). */
  body: Record<string, unknown>;
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
  /** The sentinels a client sent (as opposed to real secrets the flow returns to their owner). */
  const inputs: string[] = [];
  const spies: MockInstance[] = [];

  /** A unique private string; registered so the leak check looks for it. */
  const secret = (label: string): string => {
    const value = track(`SENTINEL-${label}-${randomUUID()}`);
    inputs.push(value);
    return value;
  };
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

  /**
   * Sentinels a response body echoes. An error body may echo none at all; a success body may
   * return the owner's own data (their email, a study ID) but never anything the client sent.
   */
  function echoed(res: Response): string[] {
    const body = res.text.toLowerCase();
    return (res.status >= 400 ? sentinels : inputs).filter((value) =>
      body.includes(value.toLowerCase()),
    );
  }

  /** Waits for, then returns, the lines logged for one request (by its correlation ID). */
  async function linesFor(res: Response): Promise<{ access: LogEntry; errors: LogEntry[] }> {
    const correlationId = res.headers[CORRELATION_ID_HEADER.toLowerCase()] as string;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    return linesForId(correlationId);
  }

  function linesForId(
    correlationId: string,
    timeout = 1000,
  ): Promise<{ access: LogEntry; errors: LogEntry[] }> {
    return vi.waitFor(
      () => {
        const mine = entries().filter((entry) => entry.correlationId === correlationId);
        const access = mine.filter((entry) => entry.message === 'http_request');
        if (access.length !== 1) throw new Error(`expected 1 access line, got ${access.length}`);
        return { access: access[0] as LogEntry, errors: mine.filter((e) => e !== access[0]) };
      },
      { timeout },
    );
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
              code: error.body.code,
              status: access.status,
              correlationId,
              errorType: error.errorType,
            },
          ]
        : [],
    );
    if (error) expect(res.body).toStrictEqual({ ...error.body, correlationId });
    expect(echoed(res)).toStrictEqual([]);
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
    // Deleting a user cascades to their sessions, receipts, studies and every study row (BIB-19).
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
      {
        errorType: 'NotFoundException',
        body: envelope({ code: 'NOT_FOUND', message: 'Not Found' }),
      },
    );
  });

  it('logs a private route without a valid session (401)', async () => {
    const res = await withPrivateChannels(http().get(`/v1/me${query()}`));
    await expectLogged(
      res,
      { method: 'GET', route: '/v1/me', status: 401 },
      { errorType: 'UnauthenticatedError', body: UNAUTHENTICATED },
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
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { email: ['Enter a valid email address'] },
        }),
      },
    );

    const badCode = await withPrivateChannels(http().post('/v1/auth/otp/verify')).send({
      challengeId: secret('challenge'),
      code: secret('otp-code'),
    });
    await expectLogged(
      badCode,
      { method: 'POST', route: '/v1/auth/otp/verify', status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { challengeId: ['Invalid UUID'], code: ['Enter the 6-digit code'] },
        }),
      },
    );
  });

  it('logs Bible reference resolution without the input or the resolved reference', async () => {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    // A letters-only private word: an unknown book name, so a `:` makes it a clear reference.
    const word = (label: string): string => {
      const value = `${label}${randomUUID()
        .replace(/-/g, '')
        .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] ?? 'q')}`;
      inputs.push(track(value));
      return value;
    };

    const keywords = await withPrivateChannels(http().post('/v1/bible/resolve'), cookie).send({
      input: `${secret('keywords')} faith`,
      editionId: edition.id,
    });
    expect(keywords.body).toStrictEqual({ outcome: 'not_reference' });
    await expectLogged(keywords, { method: 'POST', route: '/v1/bible/resolve', status: 200 });

    const unknown = await withPrivateChannels(http().post('/v1/bible/resolve'), cookie).send({
      input: `${word('zq')} 3:16`,
      editionId: edition.id,
    });
    await expectLogged(
      unknown,
      { method: 'POST', route: '/v1/bible/resolve', status: 422 },
      {
        errorType: 'ReferenceInvalidError',
        body: envelope({
          code: 'REFERENCE_UNKNOWN_BOOK',
          message: 'No book in this translation matches that name',
        }),
      },
    );

    const resolved = await withPrivateChannels(http().post('/v1/bible/resolve'), cookie).send({
      input: 'Romans 8:28',
      editionId: edition.id,
    });
    const { reference } = resolved.body as { reference: { id: string; label: string } };
    track(reference.id);
    track(reference.label);
    await expectLogged(resolved, { method: 'POST', route: '/v1/bible/resolve', status: 200 });
  });

  it('logs Bible search without the query, cursor, results or reference', async () => {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const route = { method: 'GET', route: '/v1/bible/search' };
    const searchFor = (params: Record<string, string>): Test =>
      withPrivateChannels(http().get('/v1/bible/search').query(params), cookie);

    // A private query that matches nothing: 200 with an empty page.
    const empty = await searchFor({ q: `${secret('search')} faith`, editionId: edition.id });
    expect(empty.body).toStrictEqual({ results: [], nextCursor: null, referenceSuggestion: null });
    await expectLogged(empty, { ...route, status: 200 });

    // A query with results: the returned verse text, labels and cursor are never logged either.
    const found = await searchFor({ q: 'faith', editionId: edition.id, limit: '2' });
    const page = found.body as {
      results: { text: string; reference: { label: string } }[];
      nextCursor: string;
    };
    expect(page.results).toHaveLength(2);
    for (const result of page.results) {
      track(result.text);
      track(result.reference.label);
    }
    track(page.nextCursor);
    await expectLogged(found, { ...route, status: 200 });
    const next = await searchFor({
      q: 'faith',
      editionId: edition.id,
      limit: '2',
      cursor: page.nextCursor,
    });
    await expectLogged(next, { ...route, status: 200 });

    const invalid = await searchFor({
      q: secret('search'),
      editionId: edition.id,
      cursor: secret('cursor'), // letters, digits and hyphens: passes the shape check
    });
    await expectLogged(
      invalid,
      { ...route, status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { cursor: ['Invalid cursor'] },
        }),
      },
    );

    const unknown = await searchFor({ q: secret('search'), editionId: randomUUID() });
    await expectLogged(
      unknown,
      { ...route, status: 404 },
      { errorType: 'NotFoundError', body: NOT_FOUND },
    );

    // A book-only query: searched, with the book suggested. Neither the book name, the
    // suggestion's label and id, nor the results reach a log line.
    const book = await BibleBook.findOne({
      where: { editionId: edition.id, code: 'HAB' },
      rejectOnEmpty: true,
    });
    const bookOnly = await searchFor({ q: track(book.name), editionId: edition.id });
    const suggested = bookOnly.body as {
      results: { text: string; reference: { label: string } }[];
      referenceSuggestion: { outcome: string; reference: { id: string; label: string } };
    };
    expect(suggested.referenceSuggestion.outcome).toBe('resolved');
    track(suggested.referenceSuggestion.reference.label);
    track(suggested.referenceSuggestion.reference.id);
    for (const result of suggested.results) track(result.text);
    await expectLogged(bookOnly, { ...route, status: 200 });

    const reference = await searchFor({ q: track('Romans 8:28'), editionId: edition.id });
    await expectLogged(
      reference,
      { ...route, status: 422 },
      {
        errorType: 'SearchQueryIsReferenceError',
        body: envelope({
          code: 'SEARCH_QUERY_IS_REFERENCE',
          message: 'This is a Bible reference. Look it up as a reference instead',
        }),
      },
    );
  });

  it('logs Bible passages, structured references and translations without the reference, book, or text', async () => {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const route = { method: 'GET', route: '/v1/bible/passages' };
    const passageFor = (params: Record<string, string>): Test =>
      withPrivateChannels(http().get('/v1/bible/passages').query(params), cookie);
    /** Tracks returned Scripture; short strings are skipped so they cannot match by accident. */
    const trackText = (text: string): void => {
      if (text.length >= 20) track(text);
    };

    const translations = await withPrivateChannels(http().get('/v1/bible/translations'), cookie);
    expect(translations.status).toBe(200);
    await expectLogged(translations, {
      method: 'GET',
      route: '/v1/bible/translations',
      status: 200,
    });

    /** Resolves as the reader does; the id and label are tracked as private. */
    const resolveId = async (input: string): Promise<string> => {
      const resolved = await http()
        .post('/v1/bible/resolve')
        .set('Cookie', `ba_session=${cookie}`)
        .send({ input, editionId: edition.id })
        .expect(200);
      const { reference } = resolved.body as { reference: { id: string; label: string } };
      track(reference.id);
      track(reference.label);
      return reference.id;
    };

    // A chapter with a superscription: neither the reference, the verse text, the title, the book
    // name nor the neighbors reach a log line.
    const psalm = await passageFor({
      editionId: edition.id,
      referenceId: await resolveId('Psalms 3'),
    });
    const body = psalm.body as {
      book: { name: string };
      verses: { text: string }[];
      superscriptions: { text: string }[];
      previous: { referenceId: string };
      next: { referenceId: string };
    };
    track(body.book.name);
    track(body.previous.referenceId);
    track(body.next.referenceId);
    for (const verse of body.verses) trackText(verse.text);
    for (const superscription of body.superscriptions) trackText(superscription.text);
    await expectLogged(psalm, { ...route, status: 200 });

    // Without editionId: the reference fixes the edition.
    const verse = await passageFor({ referenceId: await resolveId('Romans 8:28') });
    for (const v of (verse.body as { verses: { text: string }[] }).verses) trackText(v.text);
    await expectLogged(verse, { ...route, status: 200 });

    // Structured navigation: the book code and numbers travel in the body, which is never logged.
    const referencesRoute = { method: 'POST', route: '/v1/bible/references' };
    const chosen = await withPrivateChannels(http().post('/v1/bible/references'), cookie).send({
      editionId: edition.id,
      bookCode: track('HAB'),
      chapter: 3,
      verse: 17,
    });
    const chosenReference = (chosen.body as { reference: { id: string; label: string } }).reference;
    track(chosenReference.id);
    track(chosenReference.label);
    await expectLogged(chosen, { ...referencesRoute, status: 200 });
    const missing = await withPrivateChannels(http().post('/v1/bible/references'), cookie).send({
      editionId: edition.id,
      bookCode: 'HAB',
      chapter: 4,
    });
    await expectLogged(
      missing,
      { ...referencesRoute, status: 422 },
      {
        errorType: 'ReferenceInvalidError',
        body: envelope({
          code: 'REFERENCE_CHAPTER_OUT_OF_RANGE',
          message: 'That chapter does not exist in this book',
        }),
      },
    );

    const unknown = await passageFor({ editionId: edition.id, referenceId: track(randomUUID()) });
    await expectLogged(
      unknown,
      { ...route, status: 404 },
      { errorType: 'NotFoundError', body: NOT_FOUND },
    );

    const invalid = await passageFor({ editionId: edition.id, referenceId: secret('reference') });
    await expectLogged(
      invalid,
      { ...route, status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { referenceId: ['Invalid UUID'] },
        }),
      },
    );
  });

  it('logs Bible anchors without the quote, reference, offsets or checksums', async () => {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const verse = await BibleVerse.findOne({
      where: { editionId: edition.id, bookCode: 'ROM', chapter: 9, verse: 1 },
      rejectOnEmpty: true,
    });
    const quote = track(Array.from(verse.text).slice(0, 30).join(''));
    track(verse.textSha256);
    const captureRoute = { method: 'POST', route: '/v1/bible/anchors' };
    const resolveRoute = { method: 'POST', route: '/v1/bible/anchors/resolve' };
    const selection = {
      editionId: edition.id,
      bookCode: 'ROM',
      kind: 'phrase',
      segments: [{ chapter: 9, verse: 1, start: 0, end: 30 }],
      quote,
    };

    const captured = await withPrivateChannels(http().post('/v1/bible/anchors'), cookie).send(
      selection,
    );
    const { anchor, reference } = captured.body as {
      anchor: Record<string, unknown>;
      reference: { id: string; label: string };
    };
    track(reference.id);
    track(reference.label);
    await expectLogged(captured, { ...captureRoute, status: 200 });

    const mismatch = await withPrivateChannels(http().post('/v1/bible/anchors'), cookie).send({
      ...selection,
      quote: secret('anchor-quote'),
    });
    await expectLogged(
      mismatch,
      { ...captureRoute, status: 422 },
      {
        errorType: 'AnchorInvalidError',
        body: envelope({
          code: 'ANCHOR_QUOTE_MISMATCH',
          message: 'The selected text does not match this translation',
        }),
      },
    );

    const resolved = await withPrivateChannels(
      http().post('/v1/bible/anchors/resolve'),
      cookie,
    ).send({ anchor });
    expect((resolved.body as { outcome: string }).outcome).toBe('resolved');
    await expectLogged(resolved, { ...resolveRoute, status: 200 });

    // An unresolved anchor comes back as sent (its quote is the client's own), but is never logged.
    const unresolved = await withPrivateChannels(
      http().post('/v1/bible/anchors/resolve'),
      cookie,
    ).send({ anchor: { ...anchor, quote: track(`changed-quote-${randomUUID()}`) } });
    expect((unresolved.body as { reason: string }).reason).toBe('ANCHOR_QUOTE_MISMATCH');
    await expectLogged(unresolved, { ...resolveRoute, status: 200 });
  });

  it('logs a cross-site mutation refused before routing (403)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/logout${query()}`))
      .set('Origin', `https://${secret('origin').toLowerCase()}.example`)
      .send({ note: secret('body') });
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 403 },
      {
        errorType: 'ForbiddenException',
        body: envelope({ code: 'FORBIDDEN', message: 'Forbidden' }),
      },
    );
  });

  it('logs a non-JSON mutation refused before parsing (415)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`))
      .set('Content-Type', 'text/plain')
      .send(secret('text-body'));
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 415 },
      {
        errorType: 'UnsupportedMediaTypeException',
        body: envelope({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported Media Type' }),
      },
    );
  });

  it('logs an oversized body refused by the parser (413)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`)).send({
      email: `${secret('huge-body')}${'x'.repeat(200_000)}`,
    });
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 413 },
      {
        errorType: 'PayloadTooLargeError',
        body: envelope({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload Too Large' }),
      },
    );
  });

  it('logs malformed JSON without echoing it (400)', async () => {
    const res = await withPrivateChannels(http().post(`/v1/auth/otp/start${query()}`))
      .set('Content-Type', 'application/json')
      .send(`{"email": "${secret('malformed-json')}`);
    await expectLogged(
      res,
      { method: 'POST', route: 'unmatched', status: 400 },
      {
        errorType: 'BadRequestException',
        body: envelope({ code: 'BAD_REQUEST', message: 'Bad Request' }),
      },
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
      { errorType: 'NotFoundError', body: NOT_FOUND },
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
      {
        errorType: 'RevisionConflictError',
        body: envelope({
          code: 'REVISION_CONFLICT',
          message: 'Revision conflict',
          currentRevision: 2,
        }),
      },
    );

    const failed = await mutate(
      { expectedRevision: 2, title: secret('title'), failAfterWrite: true },
      track(randomUUID()),
    );
    await expectLogged(
      failed,
      { method: 'POST', route, status: 500 },
      {
        errorType: 'ProbeFailure',
        body: envelope({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }),
      },
    );

    const badKey = await mutate({ expectedRevision: 2, title: secret('title') }, secret('key'));
    await expectLogged(
      badKey,
      { method: 'POST', route, status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { 'Idempotency-Key': ['Must be a UUID'] },
        }),
      },
    );
  });

  it('logs study creation and reads without the title, question, reference, ids, or keys', async () => {
    const edition = await BibleEdition.findOne({ where: { code: 'engwebp' }, rejectOnEmpty: true });
    const resolved = await http()
      .post('/v1/bible/resolve')
      .set('Cookie', `ba_session=${cookie}`)
      .send({ input: 'Rom 9:1', editionId: edition.id })
      .expect(200);
    const { reference } = resolved.body as { reference: { id: string; label: string } };
    track(reference.id);
    track(reference.label);
    const create = (body: Record<string, unknown>, key: string): Test =>
      withPrivateChannels(http().post(`/v1/studies${query()}`), cookie)
        .set('Idempotency-Key', key)
        .send(body);
    const route = { method: 'POST', route: '/v1/studies' };

    // Tracked rather than `secret`: the owner's own GET returns them, which is not an echo.
    const body = {
      title: track(`SENTINEL-study-title-${randomUUID()}`),
      question: track(`SENTINEL-question-${randomUUID()}`),
      startingReferenceId: reference.id,
    };
    const key = track(randomUUID());
    const created = await create(body, key);
    await expectLogged(created, { ...route, status: 201 });
    const created201 = created.body as Record<string, string | null>;
    for (const value of Object.values(created201)) {
      if (typeof value === 'string' && value.length > 1) track(value);
    }
    const replayed = await create(body, key);
    await expectLogged(replayed, { ...route, status: 201 });

    const missingStart = await create({ title: secret('title') }, track(randomUUID()));
    await expectLogged(
      missingStart,
      { ...route, status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { _: [STUDY_START_REQUIRED] },
        }),
      },
    );
    const unknownReference = await create(
      { question: secret('question'), startingReferenceId: track(randomUUID()) },
      track(randomUUID()),
    );
    await expectLogged(
      unknownReference,
      { ...route, status: 422 },
      {
        errorType: 'ReferenceNotFoundError',
        body: envelope({
          code: 'REFERENCE_NOT_FOUND',
          message: 'That passage is not available in an active translation',
        }),
      },
    );

    const readRoute = { method: 'GET', route: '/v1/studies/:studyId' };
    const studyIdCreated = created201.studyId as string;
    const read = await withPrivateChannels(
      http().get(`/v1/studies/${studyIdCreated}${query()}`),
      cookie,
    );
    expect(read.status).toBe(200);
    await expectLogged(read, { ...readRoute, status: 200 });
    const absent = await withPrivateChannels(
      http().get(`/v1/studies/${track(randomUUID())}`),
      cookie,
    );
    await expectLogged(
      absent,
      { ...readRoute, status: 404 },
      { errorType: 'NotFoundError', body: NOT_FOUND },
    );
  });

  it('logs study edits without the title, description, question, tags, ids, or keys', async () => {
    const created = await withPrivateChannels(http().post('/v1/studies'), cookie)
      .send({ question: track(`SENTINEL-question-${randomUUID()}`) })
      .expect(201);
    const studyId = track((created.body as { studyId: string }).studyId);
    const route = { method: 'PATCH', route: '/v1/studies/:studyId' };
    const edit = (body: Record<string, unknown>, key: string, id = studyId): Test =>
      withPrivateChannels(http().patch(`/v1/studies/${id}${query()}`), cookie)
        .set('Idempotency-Key', key)
        .send(body);

    // Tracked rather than `secret`: the owner's own 200 returns them, which is not an echo.
    const body = {
      expectedRevision: 1,
      title: track(`SENTINEL-edit-title-${randomUUID()}`),
      description: track(`SENTINEL-description-${randomUUID()}`),
      mainQuestion: { text: track(`SENTINEL-new-question-${randomUUID()}`) },
      pinned: true,
      tags: { add: [track(`SENTINEL-tag-${randomUUID()}`)] },
    };
    const key = track(randomUUID());
    const edited = await edit(body, key);
    expect(edited.status).toBe(200);
    await expectLogged(edited, { ...route, status: 200 });
    const editedBody = edited.body as { tags: { id: string }[]; mainQuestion: { nodeId: string } };
    track(editedBody.mainQuestion.nodeId);
    for (const tag of editedBody.tags) track(tag.id);
    await expectLogged(await edit(body, key), { ...route, status: 200 });

    const stale = await edit({ ...body, title: secret('stale-title') }, track(randomUUID()));
    await expectLogged(
      stale,
      { ...route, status: 409 },
      {
        errorType: 'RevisionConflictError',
        body: envelope({
          code: 'REVISION_CONFLICT',
          message: 'Revision conflict',
          currentRevision: 2,
        }),
      },
    );
    const duplicated = secret('tag');
    const badTag = await edit(
      { expectedRevision: 2, tags: { add: [duplicated, duplicated.toUpperCase()] } },
      track(randomUUID()),
    );
    expect(badTag.status).toBe(400);
    await expectLogged(
      badTag,
      { ...route, status: 400 },
      { errorType: 'ValidationError', body: badTag.body as Record<string, unknown> },
    );
    const missing = await edit(
      { expectedRevision: 2, mainQuestion: { nodeId: track(randomUUID()) } },
      track(randomUUID()),
    );
    await expectLogged(
      missing,
      { ...route, status: 422 },
      {
        errorType: 'QuestionNotFoundError',
        body: envelope({
          code: 'QUESTION_NOT_FOUND',
          message: 'That question is not part of this study',
        }),
      },
    );
    const absent = await edit(
      { expectedRevision: 1, title: secret('absent') },
      track(randomUUID()),
      track(randomUUID()),
    );
    await expectLogged(
      absent,
      { ...route, status: 404 },
      { errorType: 'NotFoundError', body: NOT_FOUND },
    );
  });

  it('logs archive, trash and restore (BIB-22) without the title, question, ids, or keys', async () => {
    const created = await withPrivateChannels(http().post('/v1/studies'), cookie)
      .send({ title: track(`SENTINEL-lifecycle-title-${randomUUID()}`), blank: true })
      .expect(201);
    const studyId = track((created.body as { studyId: string }).studyId);
    const send = (method: 'post' | 'delete', path: string, revision: number, id = studyId): Test =>
      withPrivateChannels(http()[method](`/v1/studies/${id}${path}${query()}`), cookie)
        .set('Idempotency-Key', track(randomUUID()))
        .send({ expectedRevision: revision });

    const archived = await send('post', '/archive', 1);
    expect(archived.status).toBe(200);
    await expectLogged(archived, {
      method: 'POST',
      route: '/v1/studies/:studyId/archive',
      status: 200,
    });
    const edit = await withPrivateChannels(
      http().patch(`/v1/studies/${studyId}${query()}`),
      cookie,
    ).send({ expectedRevision: 2, title: secret('archived-edit') });
    await expectLogged(
      edit,
      { method: 'PATCH', route: '/v1/studies/:studyId', status: 422 },
      {
        errorType: 'StudyLifecycleError',
        body: envelope({
          code: 'STUDY_ARCHIVED',
          message: 'This study is archived. Unarchive it to make changes',
        }),
      },
    );
    const trashed = await send('delete', '', 2);
    await expectLogged(trashed, { method: 'DELETE', route: '/v1/studies/:studyId', status: 200 });
    const restored = await send('post', '/restore', 3);
    await expectLogged(restored, {
      method: 'POST',
      route: '/v1/studies/:studyId/restore',
      status: 200,
    });
    const unarchived = await send('post', '/unarchive', 4);
    await expectLogged(unarchived, {
      method: 'POST',
      route: '/v1/studies/:studyId/unarchive',
      status: 200,
    });
    const invalid = await send('post', '/unarchive', 5);
    await expectLogged(
      invalid,
      { method: 'POST', route: '/v1/studies/:studyId/unarchive', status: 422 },
      {
        errorType: 'StudyLifecycleError',
        body: envelope({
          code: 'LIFECYCLE_TRANSITION_INVALID',
          message: 'This study is not in a state that allows this change',
        }),
      },
    );
    const absent = await send('post', '/archive', 1, track(randomUUID()));
    await expectLogged(
      absent,
      { method: 'POST', route: '/v1/studies/:studyId/archive', status: 404 },
      { errorType: 'NotFoundError', body: NOT_FOUND },
    );
  });

  it('logs the study library without the search, tag ids, cursor, titles or tags', async () => {
    const route = { method: 'GET', route: '/v1/studies' };
    const listFor = (params: Record<string, string>): Test =>
      withPrivateChannels(http().get('/v1/studies').query(params), cookie);

    // Two studies of this user with private titles and a private tag (the owner's own 200 returns
    // them, so they are tracked for the log check rather than treated as echoed input).
    const title = track(`SENTINEL-library-title-${randomUUID()}`);
    const ids: string[] = [];
    for (const studyTitle of [title, track(`SENTINEL-library-other-${randomUUID()}`)]) {
      const created = await withPrivateChannels(http().post('/v1/studies'), cookie)
        .send({ title: studyTitle, blank: true })
        .expect(201);
      ids.push(track((created.body as { studyId: string }).studyId));
    }
    const tagged = await withPrivateChannels(http().patch(`/v1/studies/${ids[0]}`), cookie)
      .send({ expectedRevision: 1, tags: { add: [track(`SENTINEL-lt-${randomUUID()}`)] } })
      .expect(200);
    const tagIds = (tagged.body as { tags: { id: string }[] }).tags.map((tag) => track(tag.id));

    // A search that finds the study by its private title, through its private tag filter.
    const found = await listFor({ q: title, tag: tagIds[0] ?? '' });
    const foundBody = found.body as { items: { id: string }[] };
    expect(foundBody.items.map((item) => item.id)).toStrictEqual([ids[0]]);
    await expectLogged(found, { ...route, status: 200 });

    // A private search and a foreign tag id that match nothing.
    const none = await listFor({ q: secret('library-search'), tag: track(randomUUID()) });
    expect(none.body).toStrictEqual({ items: [], nextCursor: null });
    await expectLogged(none, { ...route, status: 200 });

    // Paging: the cursor is never logged either.
    const first = await listFor({ limit: '1' });
    const cursor = track((first.body as { nextCursor: string }).nextCursor);
    await expectLogged(first, { ...route, status: 200 });
    await expectLogged(await listFor({ limit: '1', cursor }), { ...route, status: 200 });

    const refused = await listFor({ q: secret('library-search'), cursor: secret('cursor') });
    await expectLogged(
      refused,
      { ...route, status: 400 },
      {
        errorType: 'ValidationError',
        body: envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { cursor: ['Invalid cursor'] },
        }),
      },
    );
  });

  it('logs a request the client aborted with no status, never a default 200', async () => {
    const correlationId = randomUUID();
    // The probe holds its transaction for 1 s; the client gives up after 200 ms.
    const aborted = await withPrivateChannels(
      http().post(`/v1/__test/studies/${studyId}/mutations${query()}`),
      cookie,
    )
      .set('x-correlation-id', correlationId)
      .set('Idempotency-Key', track(randomUUID()))
      .timeout(200)
      .send({ expectedRevision: 2, title: secret('title'), pauseMs: 1000 })
      .then(
        () => 'answered',
        (error: { code?: string; timeout?: number }) => error.timeout ?? error.code,
      );
    expect(aborted).toBe(200);

    const { access, errors } = await linesForId(correlationId, 3000);
    expect(access).toStrictEqual({
      level: 'log',
      pid: expect.any(Number),
      timestamp: expect.any(Number),
      message: 'http_request',
      context: 'HttpRequest',
      method: 'POST',
      route: '/v1/__test/studies/:studyId/mutations',
      status: null,
      durationMs: expect.any(Number),
      correlationId,
      aborted: true,
    });
    expect(errors).toStrictEqual([]);
    // The server still finishes the mutation; wait for its commit before cleanup runs.
    await vi.waitFor(async () => expect((await Study.findByPk(studyId))?.revision).toBe(3), {
      timeout: 3000,
    });
    expect(leaks()).toStrictEqual([]);
  });

  it('uses one correlation ID per request across header, envelope, and every log line', async () => {
    const supplied = randomUUID();
    const res = await http().get('/v1/me').set('x-correlation-id', supplied).expect(401);
    expect(res.headers[CORRELATION_ID_HEADER.toLowerCase()]).toBe(supplied);
    expect(res.body).toStrictEqual({ ...UNAUTHENTICATED, correlationId: supplied });
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
