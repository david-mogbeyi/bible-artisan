import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
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
