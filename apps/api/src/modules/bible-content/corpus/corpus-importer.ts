import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import type { Database } from '../../../database/database';
import { BibleBook } from '../../../database/models/bible-book.model';
import { BibleEdition } from '../../../database/models/bible-edition.model';
import { BibleSuperscription } from '../../../database/models/bible-superscription.model';
import { BibleVerse } from '../../../database/models/bible-verse.model';
import {
  CorpusValidationError,
  type CorpusRelease,
  type ParsedCorpus,
  parseArtifact,
  validateCorpus,
} from './corpus';

/** Committed publisher artifacts (`apps/api/corpus`), resolved the same way from src and dist. */
export const CORPUS_DIR = path.resolve(__dirname, '../../../../corpus');

/** Rows per INSERT: keeps each statement well under PostgreSQL's 65,535 bind-parameter limit. */
const INSERT_BATCH = 2000;

/** What one import run did. Counts and checksums only: safe to log (NFR-PRIV-001). */
export interface CorpusImportResult {
  result: 'imported' | 'already_current';
  editionId: string;
  books: number;
  chapters: number;
  verses: number;
  superscriptions: number;
  artifactSha256: string;
  contentSha256: string;
}

export function readCorpusArtifact(release: CorpusRelease, dir: string = CORPUS_DIR): Buffer {
  return readFileSync(path.join(dir, release.artifactPath));
}

/**
 * Imports a release from its artifact bytes, the only exported import path: `parseArtifact`
 * verifies the artifact's SHA-256 against the pinned release before reading anything else, then
 * the corpus is validated and written.
 */
export async function importCorpus(
  db: Database,
  archive: Buffer,
  release: CorpusRelease,
): Promise<CorpusImportResult> {
  return importParsedCorpus(db, parseArtifact(archive, release), release);
}

/**
 * Validates a parsed corpus against the release, then writes and activates it in ONE transaction,
 * so a failure at any point leaves the database exactly as it was (PRD §20: a bad import never
 * replaces the active release). Idempotent per (code, source_release):
 * - absent: insert edition (not yet active), books, verses, superscriptions; activate. The activation trigger
 *   re-verifies counts and checksums in SQL before COMMIT.
 * - present with the same artifact checksum: recompute the stored content checksum in SQL and
 *   return `already_current` without writing.
 * - present with a different artifact checksum, or not active: refuse.
 * Concurrent runs queue on a table lock, so the second one sees the first one's committed edition.
 */
async function importParsedCorpus(
  db: Database,
  corpus: ParsedCorpus,
  release: CorpusRelease,
): Promise<CorpusImportResult> {
  validateCorpus(corpus, release);
  const counts = {
    books: corpus.books.length,
    chapters: corpus.books.reduce((n, b) => n + b.chapterCount, 0),
    verses: corpus.verses.length,
    superscriptions: corpus.superscriptions.length,
    artifactSha256: release.artifactSha256,
    contentSha256: release.contentSha256,
  };

  return db.transaction(async (transaction) => {
    // A full import is one long transaction: lift the pool's request-sized statement timeout
    // for this transaction only, as migrations do.
    await db.query('SET LOCAL statement_timeout = 0', { transaction });
    await db.query('LOCK TABLE bible_edition IN SHARE ROW EXCLUSIVE MODE', { transaction });

    const existing = await BibleEdition.findOne({
      where: { code: release.code, sourceRelease: release.sourceRelease },
      transaction,
    });
    if (existing) {
      if (existing.artifactSha256 !== release.artifactSha256) {
        throw new CorpusValidationError(
          'CORPUS_RELEASE_CONFLICT',
          'this release is already stored from a different artifact',
        );
      }
      if (!existing.activatedAt) {
        throw new CorpusValidationError('CORPUS_RELEASE_INACTIVE', 'stored release is not active');
      }
      const [stored] = await db.query<{ sha: string }>(
        'SELECT bible_edition_content_sha256($1) AS sha',
        { bind: [existing.id], type: QueryTypes.SELECT, transaction },
      );
      if (stored?.sha !== release.contentSha256 || existing.contentSha256 !== stored.sha) {
        throw new CorpusValidationError(
          'CORPUS_STORED_CHECKSUM',
          'stored release no longer matches its checksum',
        );
      }
      return { result: 'already_current', editionId: existing.id, ...counts };
    }

    const edition = await BibleEdition.create(
      {
        code: release.code,
        name: release.name,
        abbreviation: release.abbreviation,
        language: release.language,
        canon: release.canon,
        sourceUrl: release.sourceUrl,
        sourceRelease: release.sourceRelease,
        artifactSha256: release.artifactSha256,
        contentSha256: release.contentSha256,
        verseCount: corpus.verses.length,
        superscriptionCount: corpus.superscriptions.length,
        licenseStatus: release.licenseStatus,
        attribution: release.attribution,
        rightsRecord: release.rightsRecord,
      },
      { transaction },
    );
    await BibleBook.bulkCreate(
      corpus.books.map((book) => ({ ...book, editionId: edition.id })),
      { transaction },
    );
    for (let i = 0; i < corpus.verses.length; i += INSERT_BATCH) {
      await BibleVerse.bulkCreate(
        corpus.verses.slice(i, i + INSERT_BATCH).map((verse) => ({
          ...verse,
          editionId: edition.id,
        })),
        { transaction },
      );
    }
    await BibleSuperscription.bulkCreate(
      corpus.superscriptions.map((line) => ({ ...line, editionId: edition.id })),
      { transaction },
    );
    await edition.update({ activatedAt: new Date() }, { transaction });
    return { result: 'imported', editionId: edition.id, ...counts };
  });
}
