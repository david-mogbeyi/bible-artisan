import { z } from 'zod';
import { DependencyUnavailableError } from '../../../common/errors/domain-errors';
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

/**
 * Stytch Email OTP (https://stytch.com/docs/api/log-in-or-create-user-by-email-otp and
 * /authenticate-otp), server to server with HTTP Basic auth (project ID + secret). No Stytch
 * sessions are created; the app keeps its own sessions in PostgreSQL.
 *
 * Error mapping (https://stytch.com/docs/api/errors): 404 `otp_code_not_found` is a wrong code;
 * 401 `unable_to_auth_otp_code` is an expired or already-used code. Anything else, including
 * `unauthorized_credentials` (misconfiguration) and 429/5xx, is a dependency failure, so a broken
 * configuration can never masquerade as "wrong code". Thrown errors carry fixed text only.
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
    if (!res.ok) throw new DependencyUnavailableError();
    const parsed = sendResponseSchema.safeParse(await readJson(res));
    if (!parsed.success) throw new DependencyUnavailableError();
    return { providerRef: parsed.data.email_id };
  }

  async verify(providerRef: string, code: string): Promise<OtpVerifyResult> {
    const res = await this.post('/v1/otps/authenticate', { method_id: providerRef, code });
    if (res.ok) {
      const parsed = authenticateResponseSchema.safeParse(await readJson(res));
      if (!parsed.success) throw new DependencyUnavailableError();
      return { status: 'ok', subject: parsed.data.user_id };
    }
    const errorType = errorBodySchema.safeParse(await readJson(res)).data?.error_type;
    if (res.status === 404 && errorType === 'otp_code_not_found') return { status: 'invalid' };
    if (res.status === 401 && errorType === 'unable_to_auth_otp_code') return { status: 'expired' };
    throw new DependencyUnavailableError();
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

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
