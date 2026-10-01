/* CLI: tsx src/modules/bible-content/corpus/import-corpus.ts — imports the pinned WEB release. */
import { Logger } from '@nestjs/common';
import { loadEnv } from '../../../config/env';
import { createDatabase } from '../../../database/database';
import { createAppLogger } from '../../observability/logger';
import { runEntrypoint } from '../../observability/entrypoint';
import { importCorpus, readCorpusArtifact } from './corpus-importer';
import { ENGWEBP_RELEASE } from './engwebp-release';

async function main(): Promise<void> {
  const env = loadEnv();
  Logger.overrideLogger(createAppLogger(env));
  const started = Date.now();
  const db = createDatabase(env.DATABASE_URL);
  try {
    const result = await importCorpus(db, readCorpusArtifact(ENGWEBP_RELEASE), ENGWEBP_RELEASE);
    // Counts and checksums only: never verse text or references (NFR-PRIV-001).
    new Logger('Corpus').log('corpus_import', {
      result: result.result,
      edition: ENGWEBP_RELEASE.code,
      release: ENGWEBP_RELEASE.sourceRelease,
      books: result.books,
      chapters: result.chapters,
      verses: result.verses,
      artifactSha256: result.artifactSha256,
      contentSha256: result.contentSha256,
      durationMs: Date.now() - started,
    });
  } finally {
    await db.close();
  }
}

// A failure is one content-free `process_failed` line (error class and the validation error's
// fixed `code`, e.g. CORPUS_ARTIFACT_CHECKSUM), never its message. Exits 1.
void runEntrypoint('corpus-import', main);
