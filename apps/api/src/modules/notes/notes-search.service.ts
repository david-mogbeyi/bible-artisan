import { Injectable } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { Note } from '../../database/models/note.model';

function database(): Sequelize {
  const sequelize = Note.sequelize;
  if (!sequelize) throw new Error('Note model is not initialized');
  return sequelize;
}

/**
 * Library search over note text (BIB-23), for the Study context's library: Notes owns the `note`
 * table, so the library asks here instead of querying it.
 *
 * Literal matching, as for titles and tags (BIB-21): a word matches when it is a substring
 * (`strpos`, never a pattern) of a live note's `search_text`, which is folded exactly like library
 * search words. Trashed notes are not searched. Scoped by the session owner like every library
 * statement. Each word's matches are computed once, in one statement for all words.
 *
 * Follow-up, not done here (PRD section 23: no new indexes or infrastructure without
 * measurements): if note search shows up as slow for large libraries, a `pg_trgm` GIN index on
 * `note.search_text` serves `strpos`-style substring tests via `LIKE` with escaped words.
 */
@Injectable()
export class NotesSearchService {
  /**
   * For each word (in order), the ids of the owner's studies with a live note containing it.
   * Words are already folded (`studySearchTokens`). Bounded by the owner's own studies.
   */
  async studiesMatchingNoteText(ownerId: string, words: readonly string[]): Promise<string[][]> {
    if (words.length === 0) return [];
    const rows = await database().query<{ position: number; studyIds: string[] }>(
      `SELECT w.position::int AS position, array_agg(DISTINCT n.study_id)::text[] AS "studyIds"
         FROM unnest($2::text[]) WITH ORDINALITY AS w(word, position)
         JOIN note n
           ON n.owner_id = $1 AND n.deleted_at IS NULL AND strpos(n.search_text, w.word) > 0
        GROUP BY w.position`,
      { bind: [ownerId, [...words]], type: QueryTypes.SELECT },
    );
    const matches = words.map((): string[] => []);
    for (const row of rows) matches[row.position - 1] = row.studyIds;
    return matches;
  }
}
