import { createHash, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OTP_TTL_MINUTES, type OtpProvider, type OtpVerifyResult } from './otp-provider';

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
 */
export class DevOtpProvider implements OtpProvider {
  private readonly active = new Map<string, ActiveCode>();

  constructor(
    nodeEnv: string,
    private readonly outboxFile?: string,
  ) {
    if (nodeEnv === 'production') {
      throw new Error('DevOtpProvider cannot run in production');
    }
  }

  async send(email: string): Promise<{ providerRef: string }> {
    const providerRef = `dev-email-${digest(email)}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
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
