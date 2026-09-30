import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

describe('loadEnv', () => {
  it('splits CORS origins and applies defaults', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://localhost/x',
      CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.API_PORT).toBe(4000);
  });

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});
