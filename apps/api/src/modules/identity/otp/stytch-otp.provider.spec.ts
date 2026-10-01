import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  DependencyUnavailableError,
  RateLimitedError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { OtpProviderRejectedError, StytchOtpProvider } from './stytch-otp.provider';

const config = { apiUrl: 'https://test.stytch.com', projectId: 'project-test-1', secret: 's3cr3t' };
const EMAIL = 'reader@example.test';
const CODE = '482913';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function providerReturning(response: Response | Error): {
  provider: StytchOtpProvider;
  fetchMock: Mock<typeof fetch>;
} {
  const fetchMock = vi.fn<typeof fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return { provider: new StytchOtpProvider(config, fetchMock), fetchMock };
}

/** Thrown errors must never carry the email, code, or credentials (NFR-PRIV-001). */
async function expectContentFree<E extends Error>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => E,
): Promise<E> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(errorClass);
  const text = `${String(error)} ${JSON.stringify(error)}`;
  for (const secret of [EMAIL, CODE, config.secret, config.projectId]) {
    expect(text).not.toContain(secret);
  }
  return error as E;
}

const expectContentFreeOutage = (promise: Promise<unknown>) =>
  expectContentFree(promise, DependencyUnavailableError);

describe('StytchOtpProvider', () => {
  it('sends a 10-minute code with Basic auth and returns the email_id as providerRef', async () => {
    const { provider, fetchMock } = providerReturning(
      json(200, { status_code: 200, user_id: 'user-test-1', email_id: 'email-test-1' }),
    );
    await expect(provider.send(EMAIL)).resolves.toStrictEqual({ providerRef: 'email-test-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://test.stytch.com/v1/otps/email/login_or_create');
    expect(init.method).toBe('POST');
    expect(init.headers).toStrictEqual({
      authorization: `Basic ${Buffer.from('project-test-1:s3cr3t').toString('base64')}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toStrictEqual({ email: EMAIL, expiration_minutes: 10 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('authenticates a code by method_id and returns the user_id as subject', async () => {
    const { provider, fetchMock } = providerReturning(
      json(200, { status_code: 200, user_id: 'user-test-1', method_id: 'email-test-1' }),
    );
    await expect(provider.verify('email-test-1', CODE)).resolves.toStrictEqual({
      status: 'ok',
      subject: 'user-test-1',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://test.stytch.com/v1/otps/authenticate');
    expect(JSON.parse(init.body as string)).toStrictEqual({
      method_id: 'email-test-1',
      code: CODE,
    });
  });

  // Stytch error reference: 404 otp_code_not_found is "The passcode provided was incorrect and
  // could not be authenticated" (https://stytch.com/docs/api/errors/404).
  it('maps 404 otp_code_not_found (incorrect code) to invalid', async () => {
    const { provider } = providerReturning(json(404, { error_type: 'otp_code_not_found' }));
    await expect(provider.verify('email-test-1', CODE)).resolves.toStrictEqual({
      status: 'invalid',
    });
  });

  // Stytch error reference: 401 unable_to_auth_otp_code is "The passcode could not be
  // authenticated because it was either already used or expired" (/docs/api/errors/401).
  it('maps 401 unable_to_auth_otp_code (already used or expired) to expired', async () => {
    const { provider } = providerReturning(json(401, { error_type: 'unable_to_auth_otp_code' }));
    await expect(provider.verify('email-test-1', CODE)).resolves.toStrictEqual({
      status: 'expired',
    });
  });

  it.each([
    ['a provider error (500)', json(500, { error_type: 'internal_server_error' })],
    ['a non-JSON error body', new Response('<html>bad gateway</html>', { status: 502 })],
  ])('treats %s on verify as a retryable dependency outage', async (_label, response) => {
    const { provider } = providerReturning(response);
    await expectContentFreeOutage(provider.verify('email-test-1', CODE));
  });

  it.each([
    ['a 5xx', json(503, { error_type: 'internal_server_error' })],
    ['a non-JSON 5xx', new Response('<html>bad gateway</html>', { status: 502 })],
    [
      'a transient carrier error (400 downstream_carrier_error)',
      json(400, { error_type: 'downstream_carrier_error' }),
    ],
  ])('treats %s on send as a retryable dependency outage', async (_label, response) => {
    const { provider } = providerReturning(response);
    await expectContentFreeOutage(provider.send(EMAIL));
  });

  it.each(['invalid_email', 'invalid_email_domain', 'inactive_email'])(
    'maps a 400 %s on send to a non-retryable validation error that does not echo the email',
    async (errorType) => {
      const { provider } = providerReturning(
        json(400, { error_type: errorType, error_message: `bad email ${EMAIL}` }),
      );
      const error = await expectContentFree(provider.send(EMAIL), ValidationError);
      expect({ message: error.message, fieldErrors: error.fieldErrors }).toStrictEqual({
        message: 'This email address cannot receive a sign-in code',
        fieldErrors: { email: ['This email address cannot receive a sign-in code'] },
      });
    },
  );

  it.each([
    ["Stytch's Retry-After", { 'retry-after': '17' }, 17],
    ['the 60 s default without a Retry-After', {}, 60],
    [
      'the 60 s default for an HTTP-date Retry-After',
      { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      60,
    ],
    ['the 60 s default for an absurd Retry-After', { 'retry-after': '999999' }, 60],
  ])('maps a provider 429 to RATE_LIMITED using %s', async (_label, headers, seconds) => {
    for (const call of ['send', 'verify'] as const) {
      const { provider } = providerReturning(
        json(429, { error_type: 'too_many_requests' }, headers),
      );
      const error = await expectContentFree(
        call === 'send' ? provider.send(EMAIL) : provider.verify('email-test-1', CODE),
        RateLimitedError,
      );
      expect(error.retryAfterSeconds).toBe(seconds);
    }
  });

  it.each([
    [
      'bad credentials (401 unauthorized_credentials)',
      json(401, { error_type: 'unauthorized_credentials' }),
    ],
    ['an unexpected 400 (bad_request)', json(400, { error_type: 'bad_request' })],
    ['a malformed success body', json(200, { unexpected: true })],
  ])('treats %s as a non-retryable provider rejection', async (_label, response) => {
    const { provider } = providerReturning(response.clone());
    await expectContentFree(provider.send(EMAIL), OtpProviderRejectedError);
    const again = providerReturning(response.clone()).provider;
    await expectContentFree(again.verify('email-test-1', CODE), OtpProviderRejectedError);
  });

  it('treats a network failure as a dependency outage without leaking request details', async () => {
    const { provider } = providerReturning(
      new TypeError(`fetch failed for ${EMAIL} with ${CODE} using ${config.secret}`),
    );
    await expectContentFreeOutage(provider.send(EMAIL));
    await expectContentFreeOutage(provider.verify('email-test-1', CODE));
  });
});
