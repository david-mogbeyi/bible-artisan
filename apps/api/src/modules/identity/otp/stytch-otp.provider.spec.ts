import { describe, expect, it, type Mock, vi } from 'vitest';
import { DependencyUnavailableError } from '../../../common/errors/domain-errors';
import { StytchOtpProvider } from './stytch-otp.provider';

const config = { apiUrl: 'https://test.stytch.com', projectId: 'project-test-1', secret: 's3cr3t' };
const EMAIL = 'reader@example.test';
const CODE = '482913';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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
async function expectContentFreeOutage(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DependencyUnavailableError);
  const text = `${String(error)} ${JSON.stringify(error)}`;
  for (const secret of [EMAIL, CODE, config.secret, config.projectId]) {
    expect(text).not.toContain(secret);
  }
}

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

  it('maps 404 otp_code_not_found to invalid', async () => {
    const { provider } = providerReturning(json(404, { error_type: 'otp_code_not_found' }));
    await expect(provider.verify('email-test-1', CODE)).resolves.toStrictEqual({
      status: 'invalid',
    });
  });

  it('maps 401 unable_to_auth_otp_code (expired or used) to expired', async () => {
    const { provider } = providerReturning(json(401, { error_type: 'unable_to_auth_otp_code' }));
    await expect(provider.verify('email-test-1', CODE)).resolves.toStrictEqual({
      status: 'expired',
    });
  });

  it.each([
    [
      'bad credentials (401 unauthorized_credentials)',
      json(401, { error_type: 'unauthorized_credentials' }),
    ],
    ['a provider rate limit (429)', json(429, { error_type: 'too_many_requests' })],
    ['a provider error (500)', json(500, { error_type: 'internal_server_error' })],
    ['a non-JSON error body', new Response('<html>bad gateway</html>', { status: 502 })],
    ['a malformed success body', json(200, { unexpected: true })],
  ])('treats %s on verify as a dependency outage', async (_label, response) => {
    const { provider } = providerReturning(response);
    await expectContentFreeOutage(provider.verify('email-test-1', CODE));
  });

  it.each([
    ['a 5xx', json(503, { error_type: 'internal_server_error' })],
    ['a malformed success body', json(200, { user_id: 'u' })],
  ])('treats %s on send as a dependency outage', async (_label, response) => {
    const { provider } = providerReturning(response);
    await expectContentFreeOutage(provider.send(EMAIL));
  });

  it('treats a network failure as a dependency outage without leaking request details', async () => {
    const { provider } = providerReturning(
      new TypeError(`fetch failed for ${EMAIL} with ${CODE} using ${config.secret}`),
    );
    await expectContentFreeOutage(provider.send(EMAIL));
    await expectContentFreeOutage(provider.verify('email-test-1', CODE));
  });
});
