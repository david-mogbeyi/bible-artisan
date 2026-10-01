import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** 'true'/'false' env strings to booleans; anything else is a config error. */
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
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
  });

export type Env = z.infer<typeof envSchema>;

/** Loads the repo-root .env (if present; real env vars win) and validates it. Fails fast on bad config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const envFile = resolve(__dirname, '../../../../.env');
  if (source === process.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
