import {
  LIBRARY_CURSOR_INVALID,
  type ParsedListStudiesQuery,
  type ScriptureReference,
  type StudyListItem,
  type StudyListResponse,
  studySearchTokens,
  type StudySort,
} from '@bible-artisan/contracts';
import { QueryTypes, type Sequelize } from 'sequelize';
import { ValidationError } from '../../../common/errors/domain-errors';
import { Study } from '../../../database/models/study.model';
import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  type LibraryListing,
  type LibraryPosition,
  listingFingerprint,
} from './library-cursor';

/** Starting-reference labels for one page, keyed by reference id (`ReferenceService`). */
export type ReferenceLookup = (ids: string[]) => Promise<Map<string, ScriptureReference>>;

interface StudyRow {
  id: string;
  title: string;
  lifecycle: StudyListItem['lifecycle'];
  pinned: boolean;
  startingReferenceId: string | null;
  lastActivityAt: Date;
  createdAt: Date;
  /** The sort timestamp as microsecond UTC text, for the cursor (null for `title`). */
  sortKey: string | null;
}

interface TagRow {
  studyId: string;
  id: string;
  name: string;
}

/** The column each sort orders by within a group, and its direction (ties: id, same way). */
const SORT_COLUMNS: Record<StudySort, { column: string; direction: 'ASC' | 'DESC' }> = {
  recent: { column: 's.last_activity_at', direction: 'DESC' },
  created: { column: 's.created_at', direction: 'DESC' },
  title: { column: 's.title', direction: 'ASC' },
};

/** Pinned first: `false` (pinned) sorts before `true`. */
const UNPINNED = '(s.pinned_at IS NULL)';

const invalidCursor = (): ValidationError =>
  new ValidationError('Invalid request', { cursor: [LIBRARY_CURSOR_INVALID] });

function database(): Sequelize {
  const sequelize = Study.sequelize;
  if (!sequelize) throw new Error('Study model is not initialized');
  return sequelize;
}

/**
 * One page of the owner's library (BIB-21, FR-STUDY-004). Every statement is scoped by the
 * session owner's id, including the tag and search subqueries, so nothing about another user's
 * studies or tags (rows, titles, counts or existence) can reach the response: another user's tag
 * id simply matches nothing, and another user's cursor fails its fingerprint (400).
 *
 * Order: pinned studies first, then the rest; within each group the chosen sort, ties broken by
 * id, so the order is total and keyset pages never repeat or skip a study that did not change
 * between requests.
 *
 * Search: every folded query word must be a substring (`strpos`, a plain bound string, never a
 * pattern) of the study's folded title and description or of one of its tag keys. The query
 * reaches SQL only as bind parameters.
 *
 * Bounded: at most `limit + 1` studies, then one query for their tags and one batched reference
 * lookup.
 */
export async function listStudies(
  ownerId: string,
  query: ParsedListStudiesQuery,
  references: ReferenceLookup,
): Promise<StudyListResponse> {
  const { state, sort, limit } = query;
  const listing: LibraryListing = {
    ownerId,
    state,
    sort,
    tag: query.tag?.toLowerCase() ?? null,
    tokens: query.q === undefined ? [] : studySearchTokens(query.q),
  };
  const fingerprint = listingFingerprint(listing);
  let after: LibraryPosition | null = null;
  if (query.cursor !== undefined) {
    after = decodeLibraryCursor(query.cursor, fingerprint, sort);
    if (!after) throw invalidCursor();
  }

  const anchorKey =
    after === null ? null : sort === 'title' ? await anchorTitle(ownerId, after.id) : after.key;
  const { sql, bind } = libraryQuery(listing, after && { ...after, key: anchorKey }, limit + 1);
  const rows = await database().query<StudyRow>(sql, { bind, type: QueryTypes.SELECT });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeLibraryCursor(fingerprint, { pinned: last.pinned, key: last.sortKey, id: last.id })
      : null;

  const [tags, startingReferences] = await Promise.all([
    pageTags(
      ownerId,
      page.map((row) => row.id),
    ),
    references(
      page.flatMap((row) => (row.startingReferenceId === null ? [] : [row.startingReferenceId])),
    ),
  ]);
  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      pinned: row.pinned,
      lifecycle: row.lifecycle,
      startingReference:
        row.startingReferenceId === null
          ? null
          : (startingReferences.get(row.startingReferenceId) ?? null),
      tags: tags.filter((tag) => tag.studyId === row.id).map(({ id, name }) => ({ id, name })),
      lastActivityAt: row.lastActivityAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/**
 * The listing statement and its bind parameters (exported so a test can EXPLAIN exactly what
 * runs). `after` is the previous page's last study with its sort key resolved (for `title`, its
 * current title). User input reaches the SQL only as bind parameters; the interpolated pieces are
 * fixed column names and `$n` placeholders.
 */
export function libraryQuery(
  listing: LibraryListing,
  after: LibraryPosition | null,
  rowLimit: number,
): { sql: string; bind: unknown[] } {
  const bind: unknown[] = [listing.ownerId, listing.state];
  const param = (value: unknown): string => {
    bind.push(value);
    return `$${bind.length}`;
  };
  const where = ['s.owner_id = $1', 's.lifecycle = $2'];
  if (listing.tag !== null) {
    where.push(
      `EXISTS (SELECT 1 FROM study_tag st
                WHERE st.owner_id = $1 AND st.study_id = s.id AND st.tag_id = ${param(listing.tag)})`,
    );
  }
  for (const token of listing.tokens) {
    const word = param(token);
    where.push(
      `(strpos(s.search_text, ${word}) > 0
        OR EXISTS (SELECT 1 FROM study_tag st
                     JOIN tag t ON t.owner_id = st.owner_id AND t.id = st.tag_id
                    WHERE st.owner_id = $1 AND st.study_id = s.id
                      AND strpos(t.normalized_name, ${word}) > 0))`,
    );
  }

  const { column, direction } = SORT_COLUMNS[listing.sort];
  if (after) {
    const comparison = direction === 'DESC' ? '<' : '>';
    const keyType = listing.sort === 'title' ? 'text' : 'timestamptz';
    const unpinned = param(!after.pinned);
    where.push(
      `(${UNPINNED} > ${unpinned}
        OR (${UNPINNED} = ${unpinned}
            AND (${column}, s.id) ${comparison} (${param(after.key)}::${keyType}, ${param(after.id)}::uuid)))`,
    );
  }

  const sortKey =
    listing.sort === 'title'
      ? 'NULL::text'
      : `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const sql = `SELECT s.id, s.title, s.lifecycle, s.pinned_at IS NOT NULL AS pinned,
            s.starting_reference_id AS "startingReferenceId",
            s.last_activity_at AS "lastActivityAt", s.created_at AS "createdAt",
            ${sortKey} AS "sortKey"
       FROM study s
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${UNPINNED}, ${column} ${direction}, s.id ${direction}
      LIMIT ${param(rowLimit)}`;
  return { sql, bind };
}

/**
 * The current title of a `title` page's anchor study, looked up by id within the owner's studies
 * (not by lifecycle or filters: the keyset only needs its position). A study that is gone, or
 * another user's, makes the cursor unusable: 400, and the client starts over.
 */
async function anchorTitle(ownerId: string, studyId: string): Promise<string> {
  const anchor = await Study.findOne({ where: { id: studyId, ownerId }, attributes: ['title'] });
  if (!anchor) throw invalidCursor();
  return anchor.title;
}

/** The tags of a page's studies, each study's sorted by normalized name (then id). */
function pageTags(ownerId: string, studyIds: string[]): Promise<TagRow[]> {
  if (studyIds.length === 0) return Promise.resolve([]);
  return database().query<TagRow>(
    `SELECT st.study_id AS "studyId", t.id, t.name
       FROM study_tag st
       JOIN tag t ON t.owner_id = st.owner_id AND t.id = st.tag_id
      WHERE st.owner_id = $1 AND st.study_id = ANY($2::uuid[])
      ORDER BY t.normalized_name, t.id`,
    { bind: [ownerId, studyIds], type: QueryTypes.SELECT },
  );
}
