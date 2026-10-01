import { describe, expect, it } from 'vitest';
import { cursorSecret, httpAllowedOrigins, loadEnv } from './env';

describe('loadEnv', () => {
  it('splits CORS origins and applies defaults', () => {
    const env = loadEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://localhost/x',
      CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.API_PORT).toBe(4000);
  });

  it('defaults the HTTP allowlist to the local web app outside production', () => {
    const env = loadEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/x' });
    expect(env.CORS_ALLOWED_ORIGINS).toBeUndefined();
    expect(httpAllowedOrigins(env)).toStrictEqual(['http://localhost:3000']);
  });

  it.each([
    '*',
    'https://*.bible.test',
    'https://app.bible.test/',
    'https://app.bible.test/path',
    'HTTPS://APP.bible.test',
    'app.bible.test',
    'ftp://app.bible.test',
    'http://localhost:3000, https://evil.test/x',
    ' , ',
  ])('refuses CORS_ALLOWED_ORIGINS=%j without echoing it', (value) => {
    let message = '';
    try {
      loadEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://localhost/x',
        CORS_ALLOWED_ORIGINS: value,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid environment configuration: CORS_ALLOWED_ORIGINS: /);
    expect(message).not.toContain('bible.test');
    expect(message).not.toContain('evil.test');
  });

  it('requires explicit https CORS origins in production', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/x',
      OTP_PROVIDER: 'stytch',
      STYTCH_PROJECT_ID: 'p',
      STYTCH_SECRET: 's',
    };
    // The HTTP API refuses to configure itself without an explicit allowlist (fail closed)...
    expect(() => httpAllowedOrigins(loadEnv(production))).toThrow(
      /CORS_ALLOWED_ORIGINS: is required in production for the HTTP API/,
    );
    expect(
      httpAllowedOrigins(loadEnv({ ...production, CORS_ALLOWED_ORIGINS: 'https://a.test' })),
    ).toStrictEqual(['https://a.test']);
    // ...and an http origin is refused for any process that sets one.
    expect(() =>
      loadEnv({ ...production, CORS_ALLOWED_ORIGINS: 'https://app.example.com,http://x.test' }),
    ).toThrow(/CORS_ALLOWED_ORIGINS: every origin must use https in production/);
  });

  it('loads the worker config in production without CORS_ALLOWED_ORIGINS (no HTTP surface)', () => {
    // WorkerModule loads exactly this config (ConfigModule -> loadEnv) and never calls
    // httpAllowedOrigins, so a production worker must start without the HTTP-only variable.
    const env = loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost/x',
      OTP_PROVIDER: 'stytch',
      STYTCH_PROJECT_ID: 'p',
      STYTCH_SECRET: 's',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });

  it('fails closed without NODE_ENV instead of defaulting to development', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://localhost/x' })).toThrow(
      /NODE_ENV: is required \(development, test, or production\)/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://localhost/x', NODE_ENV: 'prod' })).toThrow(
      /NODE_ENV: must be development, test, or production/,
    );
  });
});

describe('loadEnv: email OTP and session settings', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/x' };

  it('defaults to the dev OTP provider and Secure cookies', () => {
    const env = loadEnv(base);
    expect(env.OTP_PROVIDER).toBe('dev');
    expect(env.SESSION_COOKIE_SECURE).toBe(true);
    expect(env.STYTCH_API_URL).toBe('https://test.stytch.com');
  });

  it('refuses the dev OTP provider in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'dev' })).toThrow(
      /OTP_PROVIDER: the dev OTP provider cannot run in production/,
    );
  });

  it('refuses to start in production when OTP_PROVIDER is left at its dev default', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /OTP_PROVIDER: the dev OTP provider cannot run in production/,
    );
  });

  it('requires Stytch credentials when OTP_PROVIDER=stytch, without echoing values', () => {
    let message = '';
    try {
      loadEnv({ ...base, OTP_PROVIDER: 'stytch', STYTCH_PROJECT_ID: 'project-live-123' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/STYTCH_PROJECT_ID and STYTCH_SECRET are required/);
    expect(message).not.toContain('project-live-123');
  });

  it('accepts a complete Stytch production configuration', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      OTP_PROVIDER: 'stytch',
      STYTCH_API_URL: 'https://api.stytch.com',
      STYTCH_PROJECT_ID: 'project-live-123',
      STYTCH_SECRET: 'secret-live-123',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    expect(env.OTP_PROVIDER).toBe('stytch');
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://app.example.com']);
  });

  it('allows non-Secure cookies only outside production', () => {
    expect(loadEnv({ ...base, SESSION_COOKIE_SECURE: 'false' }).SESSION_COOKIE_SECURE).toBe(false);
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        OTP_PROVIDER: 'stytch',
        STYTCH_PROJECT_ID: 'p',
        STYTCH_SECRET: 's',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow(/session cookies must be Secure in production/);
  });

  it('rejects a non-boolean SESSION_COOKIE_SECURE', () => {
    expect(() => loadEnv({ ...base, SESSION_COOKIE_SECURE: 'yes' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
  });
});

describe('cursorSecret (BIB-21)', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://localhost/x',
    OTP_PROVIDER: 'stytch',
    STYTCH_PROJECT_ID: 'p',
    STYTCH_SECRET: 's',
  };
  const secret = Buffer.alloc(32, 7).toString('base64');

  it('uses CURSOR_SECRET when set, as its 32 bytes', () => {
    expect(cursorSecret(loadEnv({ ...production, CURSOR_SECRET: secret }))).toStrictEqual(
      Buffer.alloc(32, 7),
    );
  });

  it('refuses to run the HTTP API in production without it, without echoing values', () => {
    expect(() => cursorSecret(loadEnv(production))).toThrow(
      /^Invalid environment configuration: CURSOR_SECRET: is required in production for the HTTP API$/,
    );
  });

  it('falls back to one fixed development secret outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const fallback = cursorSecret(loadEnv({ NODE_ENV, DATABASE_URL: 'postgres://localhost/x' }));
      expect(fallback).toHaveLength(32);
      expect(fallback).toStrictEqual(
        cursorSecret(loadEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/x' })),
      );
    }
  });

  it.each([
    Buffer.alloc(16, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    Buffer.alloc(32, 1).toString('base64url'),
    `${secret} `,
    'not base64 at all, but long enough to be forty-four chars!',
  ])('refuses a CURSOR_SECRET that is not 32 base64 bytes, without echoing it', (value) => {
    let message = '';
    try {
      loadEnv({ ...production, CURSOR_SECRET: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'Invalid environment configuration: CURSOR_SECRET: must be 32 bytes, base64 (openssl rand -base64 32)',
    );
  });
});
