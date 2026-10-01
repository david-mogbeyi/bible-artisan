import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Invalid process configuration. The message names each offending variable and why, never its
 * value. `variables` holds the names alone, for the content-free startup failure log.
 */
export class InvalidConfigError extends Error {
  constructor(
    readonly variables: readonly string[],
    detail: string,
  ) {
    super(`Invalid environment configuration: ${detail}`);
    this.name = 'InvalidConfigError';
  }
}

/** 'true'/'false' env strings to booleans; anything else is a config error. */
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** The local web app; the HTTP API's CORS/CSRF allowlist when CORS_ALLOWED_ORIGINS is unset outside production. */
const DEV_WEB_ORIGIN = 'http://localhost:3000';

/** Standard base64 of exactly 32 bytes (`openssl rand -base64 32`). */
const SECRET_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The cursor secret outside production when CURSOR_SECRET is unset: fixed and public, so local
 * and test cursors survive restarts. Never used in production (`cursorSecret` refuses).
 */
const DEV_CURSOR_SECRET = createHash('sha256')
  .update('bible-artisan development-only library cursor secret')
  .digest();

const envSchema = z
  .object({
    /**
     * Required, no default: production safety (dev OTP adapter refused, Secure cookies enforced)
     * keys off `production`, so a deploy that forgot to set it must refuse to start rather than
     * silently run as `development` (fail closed).
     */
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: (issue) =>
        issue.input === undefined
          ? 'is required (development, test, or production)'
          : 'must be development, test, or production',
    }),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /**
     * Browser origins allowed to call the API with credentials. They also gate every mutation
     * (CSRF, `requireTrustedOrigin`), so each entry must be an exact bare origin. Only the HTTP
     * API reads it, through `httpAllowedOrigins` (required there in production, local web app
     * fallback elsewhere); the worker has no HTTP surface and may leave it unset.
     */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((value, ctx) => (value === undefined ? undefined : parseOrigins(value, ctx))),
    DATABASE_URL: z.url(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose']).default('info'),
    /** Email OTP adapter (BIB-10): `stytch` (managed provider) or `dev` (local/test only). */
    OTP_PROVIDER: z.enum(['stytch', 'dev']).default('dev'),
    STYTCH_API_URL: z.url().default('https://test.stytch.com'),
    STYTCH_PROJECT_ID: z.string().min(1).optional(),
    STYTCH_SECRET: z.string().min(1).optional(),
    /** Dev adapter only: when set, the latest code is written to this local (gitignored) file. */
    DEV_OTP_OUTBOX_FILE: z.string().min(1).optional(),
    /** Secure flag on the session cookie. `false` is allowed only outside production. */
    SESSION_COOKIE_SECURE: booleanFlag.default(true),
    /**
     * Key material for the library's encrypted cursors (BIB-21): 32 random bytes, base64. Only
     * the HTTP API reads it, through `cursorSecret` (required there in production, a fixed
     * development secret elsewhere). Rotating it only invalidates outstanding cursors (400, and
     * the web app restarts the list).
     */
    CURSOR_SECRET: z
      .string()
      .regex(SECRET_32_BYTES, { message: 'must be 32 bytes, base64 (openssl rand -base64 32)' })
      .transform((value) => Buffer.from(value, 'base64'))
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.OTP_PROVIDER === 'dev') {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_PROVIDER'],
        message: 'the dev OTP provider cannot run in production',
      });
    }
    if (env.OTP_PROVIDER === 'stytch' && (!env.STYTCH_PROJECT_ID || !env.STYTCH_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STYTCH_SECRET'],
        message: 'STYTCH_PROJECT_ID and STYTCH_SECRET are required when OTP_PROVIDER=stytch',
      });
    }
    if (env.NODE_ENV === 'production' && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'session cookies must be Secure in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.CORS_ALLOWED_ORIGINS?.some((origin) => !origin.startsWith('https://'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'every origin must use https in production',
      });
    }
  });

/**
 * The HTTP API's CORS + CSRF allowlist. Called by `configureApp` before the server listens, so an
 * API process in production without CORS_ALLOWED_ORIGINS refuses to start (fail closed) instead of
 * trusting the local dev origin. Kept out of `loadEnv` because the worker loads the same config
 * and has no HTTP surface. The error never echoes configured values.
 */
export function httpAllowedOrigins(env: Env): string[] {
  if (env.CORS_ALLOWED_ORIGINS !== undefined) return env.CORS_ALLOWED_ORIGINS;
  if (env.NODE_ENV === 'production') {
    throw new InvalidConfigError(
      ['CORS_ALLOWED_ORIGINS'],
      'CORS_ALLOWED_ORIGINS: is required in production for the HTTP API',
    );
  }
  return [DEV_WEB_ORIGIN];
}

/**
 * The library cursor secret (BIB-21). Called by `configureApp` before the server listens, so an
 * API process in production without CURSOR_SECRET refuses to start (fail closed) instead of
 * sealing cursors with the public development secret. Like `httpAllowedOrigins`, kept out of
 * `loadEnv` because the worker loads the same config and issues no cursors. The error never
 * echoes configured values.
 */
export function cursorSecret(env: Env): Buffer {
  if (env.CURSOR_SECRET !== undefined) return env.CURSOR_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new InvalidConfigError(
      ['CURSOR_SECRET'],
      'CURSOR_SECRET: is required in production for the HTTP API',
    );
  }
  return DEV_CURSOR_SECRET;
}

/**
 * Splits a comma-separated origin list. Each entry must be a bare http(s) origin exactly as a
 * browser sends it in the `Origin` header (`scheme://host[:port]`, lowercase, no path, no
 * trailing slash, no wildcard), otherwise it could never match, or would match too much.
 * Issues never echo the configured values.
 */
function parseOrigins(value: string, ctx: z.RefinementCtx): string[] {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'must list at least one origin' });
  }
  for (const origin of origins) {
    if (!isBareHttpOrigin(origin)) {
      ctx.addIssue({
        code: 'custom',
        message: 'each origin must be a bare http(s) origin like https://app.example.com',
      });
      break;
    }
  }
  return origins;
}

function isBareHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    // `*.example.com` is a syntactically valid host to the URL parser; refuse wildcards outright.
    return (
      !value.includes('*') &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof envSchema>;

/** Loads the repo-root .env (if present; real env vars win) and validates it. Fails fast on bad config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const envFile = resolve(__dirname, '../../../../.env');
  if (source === process.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const { issues } = parsed.error;
    throw new InvalidConfigError(
      [...new Set(issues.map((i) => i.path.join('.')))],
      issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}
