import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';

/** Points the integration suite at DATABASE_URL_TEST and migrates it once per run. */
export default async function setup(): Promise<void> {
  const envFile = resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL_TEST;
  if (!url)
    throw new Error('DATABASE_URL_TEST is required for integration tests (see .env.example)');
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';

  const db = createDatabase(url);
  try {
    await migrateToLatest(db);
  } finally {
    await db.close();
  }
}
