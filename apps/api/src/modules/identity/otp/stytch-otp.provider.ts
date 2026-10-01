import { z } from 'zod';
import {
  DependencyUnavailableError,
  RateLimitedError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { OTP_TTL_MINUTES, type OtpProvider, type OtpVerifyResult } from './otp-provider';

export interface StytchConfig {
  apiUrl: string;
  projectId: string;
  secret: string;
}

const sendResponseSchema = z.object({ email_id: z.string().min(1) });
const authenticateResponseSchema = z.object({ user_id: z.string().min(1) });
const errorBodySchema = z.object({ error_type: z.string() }).partial();

/** Per-call budget for the provider round trip, so a hung provider can't hold a request open. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Stytch documents no Retry-After on its 429s; used when the header is absent or unusable. */
export const DEFAULT_PROVIDER_RETRY_AFTER_SECONDS = 60;
const MAX_PROVIDER_RETRY_AFTER_SECONDS = 3600;

/**
 * Stytch 400s on send that mean "this address can't get a code" (docs: /api/errors/400):
 * `invalid_email` (not properly formatted or missing), `invalid_email_domain`, and
 * `inactive_email` (hard bounce). They are the user's to fix, so they are not retryable.
 */
const UNUSABLE_EMAIL_ERRORS: ReadonlySet<string> = new Set([
  'invalid_email',
  'invalid_email_domain',
  'inactive_email',
]);
/** Fixed copy: never echoes the address (NFR-PRIV-001). */
const UNUSABLE_EMAIL_MESSAGE = 'This email address cannot receive a sign-in code';

/**
 * Stytch refused our request for a reason retrying won't fix and the user can't act on: bad
 * credentials (`unauthorized_credentials`), an unexpected 4xx, or a 2xx body we can't read.
 * Maps to a non-retryable 500 (the filter logs only this class name). Fixed message only.
 */
export class OtpProviderRejectedError extends Error {
  constructor() {
    super('The email OTP provider rejected the request');
    this.name = 'OtpProviderRejectedError';
  }
}

/**
 * Stytch Email OTP (https://stytch.com/docs/api/log-in-or-create-user-by-email-otp and
 * /authenticate-otp), server to server with HTTP Basic auth (project ID + secret). No Stytch
 * sessions are created; the app keeps its own sessions in PostgreSQL.
 *
 * Error mapping, per Stytch's error reference (https://stytch.com/docs/api/errors/400, /401,
 * /404, /429):
 * - verify: 404 `otp_code_not_found` ("The passcode provided was incorrect") → `invalid`;
 *   401 `unable_to_auth_otp_code` ("either already used or expired") → `expired`.
 * - send: 400 `invalid_email` / `invalid_email_domain` / `inactive_email` → 400 VALIDATION.
 * - both: 429 → 429 RATE_LIMITED (Stytch's Retry-After if sent, else 60 s); 5xx, the 400
 *   `downstream_carrier_error` ("could be temporary"), network failure, or timeout → 503
 *   retryable; any other 4xx (e.g. `unauthorized_credentials`) or an unreadable success body →
 *   `OtpProviderRejectedError` (500, not retryable). A broken configuration can therefore never
 *   masquerade as "wrong code" or as a retryable outage. Thrown errors carry fixed text only.
 */
export class StytchOtpProvider implements OtpProvider {
  constructor(
    private readonly config: StytchConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(email: string): Promise<{ providerRef: string }> {
    const res = await this.post('/v1/otps/email/login_or_create', {
      email,
      expiration_minutes: OTP_TTL_MINUTES,
    });
    if (!res.ok) {
      const errorType = await readErrorType(res);
      if (res.status === 400 && errorType !== undefined && UNUSABLE_EMAIL_ERRORS.has(errorType)) {
        throw new ValidationError(UNUSABLE_EMAIL_MESSAGE, { email: [UNUSABLE_EMAIL_MESSAGE] });
      }
      throw failureFor(res, errorType);
    }
    const parsed = sendResponseSchema.safeParse(await readJson(res));
    if (!parsed.success) throw new OtpProviderRejectedError();
    return { providerRef: parsed.data.email_id };
  }

  async verify(providerRef: string, code: string): Promise<OtpVerifyResult> {
    const res = await this.post('/v1/otps/authenticate', { method_id: providerRef, code });
    if (res.ok) {
      const parsed = authenticateResponseSchema.safeParse(await readJson(res));
      if (!parsed.success) throw new OtpProviderRejectedError();
      return { status: 'ok', subject: parsed.data.user_id };
    }
    const errorType = await readErrorType(res);
    if (res.status === 404 && errorType === 'otp_code_not_found') return { status: 'invalid' };
    if (res.status === 401 && errorType === 'unable_to_auth_otp_code') return { status: 'expired' };
    throw failureFor(res, errorType);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const credentials = Buffer.from(`${this.config.projectId}:${this.config.secret}`).toString(
      'base64',
    );
    try {
      return await this.fetchFn(new URL(path, this.config.apiUrl), {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network failure or timeout. The original error is dropped on purpose: it can include the
      // request URL/body details, which must not reach logs.
      throw new DependencyUnavailableError();
    }
  }
}

/** The error for a non-2xx response that isn't an endpoint-specific outcome. */
function failureFor(res: Response, errorType: string | undefined): Error {
  if (res.status === 429) return new RateLimitedError(retryAfterSecondsOf(res));
  if (res.status >= 500 || errorType === 'downstream_carrier_error') {
    return new DependencyUnavailableError();
  }
  return new OtpProviderRejectedError();
}

/** Stytch's `Retry-After` in whole seconds when it is a sane delta, otherwise the default. */
function retryAfterSecondsOf(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  return seconds >= 1 && seconds <= MAX_PROVIDER_RETRY_AFTER_SECONDS
    ? seconds
    : DEFAULT_PROVIDER_RETRY_AFTER_SECONDS;
}

async function readErrorType(res: Response): Promise<string | undefined> {
  return errorBodySchema.safeParse(await readJson(res)).data?.error_type;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
