import { createHash, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OTP_TTL_MINUTES, type OtpProvider, type OtpVerifyResult } from './otp-provider';

/** The sign-in code every email gets with the dev provider in local development. */
export const DEV_FIXED_OTP_CODE = '000000';

interface ActiveCode {
  email: string;
  code: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Local development and test stand-in for the managed provider (selected by `OTP_PROVIDER=dev`,
 * refused in production by env validation and again here). Mirrors the provider semantics the app
 * relies on: one active code per email, ten-minute expiry, single use. Codes live in memory only.
 * They are never logged; when `outboxFile` is set the latest code is written to that local file
 * (mode 0600) so a developer can sign in without email delivery.
 *
 * With NODE_ENV=development every code is DEV_FIXED_OTP_CODE (000000), so local sign-in needs no
 * outbox lookup. Tests keep random codes so wrong-code and superseded-code paths stay meaningful.
 */
export class DevOtpProvider implements OtpProvider {
  private readonly active = new Map<string, ActiveCode>();
  private readonly fixedCode: string | undefined;

  constructor(
    nodeEnv: string,
    private readonly outboxFile?: string,
  ) {
    if (nodeEnv === 'production') {
      throw new Error('DevOtpProvider cannot run in production');
    }
    this.fixedCode = nodeEnv === 'development' ? DEV_FIXED_OTP_CODE : undefined;
  }

  async send(email: string): Promise<{ providerRef: string }> {
    const providerRef = `dev-email-${digest(email)}`;
    const code = this.fixedCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + OTP_TTL_MINUTES * 60_000;
    this.active.set(providerRef, { email, code, expiresAt, used: false });
    if (this.outboxFile) {
      await mkdir(dirname(this.outboxFile), { recursive: true });
      await writeFile(
        this.outboxFile,
        `${JSON.stringify({ to: email, code, expiresAt: new Date(expiresAt).toISOString() })}\n`,
        { mode: 0o600 },
      );
    }
    return { providerRef };
  }

  verify(providerRef: string, code: string): Promise<OtpVerifyResult> {
    const entry = this.active.get(providerRef);
    if (!entry || entry.used || entry.expiresAt <= Date.now()) {
      return Promise.resolve({ status: 'expired' });
    }
    if (entry.code !== code) return Promise.resolve({ status: 'invalid' });
    entry.used = true;
    return Promise.resolve({ status: 'ok', subject: `dev|${digest(entry.email)}` });
  }

  /** Test/dev helper: the latest code sent to `email`, if any. */
  latestCodeFor(email: string): string | undefined {
    return this.active.get(`dev-email-${digest(email)}`)?.code;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
