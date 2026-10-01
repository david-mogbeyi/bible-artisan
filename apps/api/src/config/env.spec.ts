import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

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

  it('defaults CORS origins to the local web app outside production', () => {
    const env = loadEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/x' });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
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
    expect(() => loadEnv(production)).toThrow(/CORS_ALLOWED_ORIGINS: is required in production/);
    expect(() =>
      loadEnv({ ...production, CORS_ALLOWED_ORIGINS: 'https://app.example.com,http://x.test' }),
    ).toThrow(/CORS_ALLOWED_ORIGINS: every origin must use https in production/);
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
