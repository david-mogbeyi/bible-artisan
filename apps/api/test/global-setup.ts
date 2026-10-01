import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';
import {
  importCorpus,
  readCorpusArtifact,
} from '../src/modules/bible-content/corpus/corpus-importer';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';

/**
 * Points the integration suite at DATABASE_URL_TEST, migrates it, and imports the pinned Bible
 * corpus (a no-op when already active), once per run.
 */
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
    await importCorpus(db, readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
  } finally {
    await db.close();
  }
}
