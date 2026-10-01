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
import { studyPurgeAt, trashExpiryCutoff } from '../study-lifecycle';
import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  type LibraryListing,
  type LibraryPosition,
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
  deletedAt: Date | null;
  /** The sort value as the cursor carries it: microsecond UTC text, or the title sort key. */
  sortKey: string;
}

interface TagRow {
  studyId: string;
  id: string;
  name: string;
}

/**
 * Per sort: the ordering expression within a group, its direction (ties: id, the same way), the
 * cursor's text form of it, and the type a cursor value is cast to. Each has an index whose
 * columns are `(owner_id, lifecycle, is_pinned, <expression>, id)` in this direction, so a page
 * is a range scan of one index per group (migration `add_study_library`).
 *
 * `title` orders by `title_sort_key` (the API's fold of the title, `studyTitleSortKey`) in
 * `COLLATE "C"`: code-point order, identical whatever the database's default collation.
 */
const SORTS: Record<
  StudySort,
  { order: string; direction: 'ASC' | 'DESC'; text: string; seekValue: (param: string) => string }
> = {
  recent: {
    order: 's.last_activity_at',
    direction: 'DESC',
    text: `to_char(s.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    seekValue: (param) => `${param}::timestamptz`,
  },
  created: {
    order: 's.created_at',
    direction: 'DESC',
    text: `to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    seekValue: (param) => `${param}::timestamptz`,
  },
  title: {
    order: 's.title_sort_key COLLATE "C"',
    direction: 'ASC',
    text: 's.title_sort_key',
    seekValue: (param) => `${param}::text COLLATE "C"`,
  },
};

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
 * id simply matches nothing, and another user's cursor fails to decode (400).
 *
 * Order: with `pinnedFirst` (the library), pinned studies first, then the rest; without it
 * (Home's recent studies), one list. Within that, the chosen sort, ties broken by id, so the
 * order is total and keyset pages never repeat or skip a study that did not change between
 * requests. `cursorKey` seals and opens cursors (`library-cursor.ts`).
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
  cursorKey: Buffer,
): Promise<StudyListResponse> {
  const { state, sort, pinnedFirst, limit } = query;
  const listing: LibraryListing = {
    ownerId,
    state,
    sort,
    pinnedFirst,
    tag: query.tag?.toLowerCase() ?? null,
    tokens: query.q === undefined ? [] : studySearchTokens(query.q),
  };
  let after: LibraryPosition | null = null;
  if (query.cursor !== undefined) {
    after = decodeLibraryCursor(cursorKey, query.cursor, listing);
    if (!after) throw invalidCursor();
  }

  const { sql, bind } = libraryQuery(listing, after, limit + 1);
  const rows = await database().query<StudyRow>(sql, { bind, type: QueryTypes.SELECT });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeLibraryCursor(cursorKey, listing, {
          pinned: last.pinned,
          key: last.sortKey,
          id: last.id,
        })
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
      purgeAt: row.deletedAt === null ? null : studyPurgeAt(row.deletedAt).toISOString(),
    })),
    nextCursor,
  };
}

/**
 * The listing statement and its bind parameters (exported so a test can EXPLAIN exactly what
 * runs). `after` is the previous page's last study, exactly as the cursor captured it.
 *
 * Each pin group is its own subquery, ordered like its index and limited to `rowLimit`: the
 * group's equality (`is_pinned` / `NOT is_pinned`) plus the owner and lifecycle pin the leading
 * index columns, and the row comparison `(sort value, id) <|> (cursor value, cursor id)` is the
 * index scan's start condition. So a deep page seeks straight to its position instead of reading
 * every earlier row. `UNION ALL` then merges at most `2 × rowLimit` rows:
 *
 * - `pinnedFirst`: groups in order. Once the cursor is in the unpinned group, the pinned
 *   subquery is left out; while it is in the pinned group, only that group seeks.
 * - otherwise both groups seek from the cursor and the merge interleaves them by sort value.
 *
 * User input reaches the SQL only as bind parameters; the interpolated pieces are fixed column
 * names, fixed expressions and `$n` placeholders.
 *
 * `state=trashed` (the Trash view, BIB-22) lists only studies inside their recovery window at
 * `now`; one trashed 30 or more days ago reads as absent everywhere, here too.
 */
export function libraryQuery(
  listing: LibraryListing,
  after: LibraryPosition | null,
  rowLimit: number,
  now: Date = new Date(),
): { sql: string; bind: unknown[] } {
  const bind: unknown[] = [listing.ownerId, listing.state];
  const param = (value: unknown): string => {
    bind.push(value);
    return `$${bind.length}`;
  };
  const filters: string[] = [];
  if (listing.state === 'trashed') {
    filters.push(`s.deleted_at > ${param(trashExpiryCutoff(now))}::timestamptz`);
  }
  if (listing.tag !== null) {
    filters.push(
      `EXISTS (SELECT 1 FROM study_tag st
                WHERE st.owner_id = $1 AND st.study_id = s.id AND st.tag_id = ${param(listing.tag)})`,
    );
  }
  for (const token of listing.tokens) {
    const word = param(token);
    filters.push(
      `(strpos(s.search_text, ${word}) > 0
        OR EXISTS (SELECT 1 FROM study_tag st
                     JOIN tag t ON t.owner_id = st.owner_id AND t.id = st.tag_id
                    WHERE st.owner_id = $1 AND st.study_id = s.id
                      AND strpos(t.normalized_name, ${word}) > 0))`,
    );
  }

  const { order, direction, text, seekValue } = SORTS[listing.sort];
  const seek =
    after &&
    `(${order}, s.id) ${direction === 'DESC' ? '<' : '>'} (${seekValue(param(after.key))}, ${param(after.id)}::uuid)`;
  const limit = param(rowLimit);

  const groups: string[] = [];
  for (const pinned of [true, false]) {
    let groupSeek: string | null = seek;
    if (after && listing.pinnedFirst && pinned !== after.pinned) {
      // The pinned group is finished once the cursor is past it; the unpinned group starts from
      // its top while the cursor is still among the pinned.
      if (pinned) continue;
      groupSeek = null;
    }
    const where = [
      's.owner_id = $1',
      's.lifecycle = $2',
      pinned ? 's.is_pinned' : 'NOT s.is_pinned',
      ...filters,
      ...(groupSeek ? [groupSeek] : []),
    ];
    groups.push(`(SELECT s.id, s.title, s.lifecycle, s.is_pinned AS pinned,
                s.starting_reference_id AS "startingReferenceId",
                s.last_activity_at AS "lastActivityAt", s.created_at AS "createdAt",
                s.deleted_at AS "deletedAt", ${order} AS "sortValue", ${text} AS "sortKey"
           FROM study s
          WHERE ${where.join('\n            AND ')}
          ORDER BY ${order} ${direction}, s.id ${direction}
          LIMIT ${limit})`);
  }

  const sql = `SELECT page.id, page.title, page.lifecycle, page.pinned, page."startingReferenceId",
            page."lastActivityAt", page."createdAt", page."deletedAt", page."sortKey"
       FROM (${groups.join('\n         UNION ALL\n         ')}) page
      ORDER BY ${listing.pinnedFirst ? 'page.pinned DESC, ' : ''}page."sortValue"${listing.sort === 'title' ? ' COLLATE "C"' : ''} ${direction}, page.id ${direction}
      LIMIT ${limit}`;
  return { sql, bind };
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
