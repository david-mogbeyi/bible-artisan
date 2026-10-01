import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevOtpProvider } from './dev-otp.provider';

afterEach(() => {
  vi.useRealTimers();
});

describe('DevOtpProvider', () => {
  it('refuses to run in production', () => {
    expect(() => new DevOtpProvider('production')).toThrow(/cannot run in production/);
  });

  it('verifies the latest code once, with a stable subject per email', async () => {
    const provider = new DevOtpProvider('test');
    const { providerRef } = await provider.send('a@example.test');
    const code = provider.latestCodeFor('a@example.test') ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(provider.verify(providerRef, wrong)).resolves.toStrictEqual({ status: 'invalid' });
    const ok = await provider.verify(providerRef, code);
    expect(ok).toStrictEqual({
      status: 'ok',
      subject: expect.stringMatching(/^dev\|[0-9a-f]{32}$/),
    });
    await expect(provider.verify(providerRef, code)).resolves.toStrictEqual({ status: 'expired' });
  });

  it('supersedes the previous code on resend and expires codes after 10 minutes', async () => {
    vi.useFakeTimers();
    const provider = new DevOtpProvider('test');
    const { providerRef } = await provider.send('b@example.test');
    const first = provider.latestCodeFor('b@example.test') ?? '';
    await provider.send('b@example.test');
    const second = provider.latestCodeFor('b@example.test') ?? '';
    if (first !== second) {
      await expect(provider.verify(providerRef, first)).resolves.toStrictEqual({
        status: 'invalid',
      });
    }
    vi.advanceTimersByTime(10 * 60_000);
    await expect(provider.verify(providerRef, second)).resolves.toStrictEqual({
      status: 'expired',
    });
  });

  it('writes the latest code to the outbox file (owner-only) when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'otp-outbox-'));
    try {
      const file = join(dir, 'nested', 'outbox.json');
      const provider = new DevOtpProvider('development', file);
      await provider.send('c@example.test');
      const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      expect(written).toStrictEqual({
        to: 'c@example.test',
        code: provider.latestCodeFor('c@example.test'),
        expiresAt: expect.any(String),
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
