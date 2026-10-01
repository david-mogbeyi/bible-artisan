import { MAX_STUDY_TAGS, tagKey } from '@bible-artisan/contracts';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TagLimitExceededError } from '../../../common/errors/domain-errors';
import type { StudyMutation } from '../../../common/mutation/study-mutation';
import { StudyTag } from '../../../database/models/study-tag.model';
import { Tag } from '../../../database/models/tag.model';

/** One of a study's tags as stored. `name` and `normalizedName` are private text: never logged. */
export interface StudyTagRow {
  id: string;
  name: string;
  normalizedName: string;
}

/** What a tag change really did: the ids that joined and left the study, each sorted. */
export interface AppliedTagChange {
  addedTagIds: string[];
  removedTagIds: string[];
}

function database(): Sequelize {
  const sequelize = Tag.sequelize;
  if (!sequelize) throw new Error('Tag model is not initialized');
  return sequelize;
}

/**
 * The study's tags, sorted by normalized name (then id, for a total order). One query, scoped by
 * the study's own `study_id` and `owner_id` on both tables (the composite FKs guarantee they
 * agree). Inside a mutation it joins the transaction (database/transaction-context.ts). Shared by
 * `GET`/`PATCH` responses (study-state.ts) and tag planning below.
 */
export function studyTagRows(studyId: string, ownerId: string): Promise<StudyTagRow[]> {
  return database().query<StudyTagRow>(
    `SELECT t.id, t.name, t.normalized_name AS "normalizedName"
       FROM study_tag st
       JOIN tag t ON t.owner_id = st.owner_id AND t.id = st.tag_id
      WHERE st.study_id = $1 AND st.owner_id = $2
      ORDER BY t.normalized_name, t.id`,
    { bind: [studyId, ownerId], type: QueryTypes.SELECT },
  );
}

/**
 * Applies a tag delta (`tags.add` names, already normalized by `tagNameSchema` with distinct keys;
 * `tags.remove` ids) to the locked study, in the mutation's transaction. Returns null when the
 * study's tag set ends up as it was, so the caller can answer STUDY_UNCHANGED (its rollback undoes
 * any interim write).
 *
 * - An id the study does not carry, and a name whose key it already carries (and keeps), is a
 *   no-op for that item. Removals apply first, so removing a tag by id and adding a name with the
 *   same key recases it when no other study uses the old row.
 * - The 20-tag limit is checked on the result, under the study lock (only this study's mutations
 *   write its `study_tag` rows, and they all hold that lock), so it holds whatever another device
 *   added first: 422 TAG_LIMIT_EXCEEDED.
 * - A removed tag that no study references any more is deleted, so private tag text never
 *   lingers in the owner's vocabulary (see `deleteOrphanedTags`).
 */
export async function applyTagChange(
  m: StudyMutation,
  change: { add?: string[]; remove?: string[] },
): Promise<AppliedTagChange | null> {
  const before = await studyTagRows(m.studyId, m.ownerId);
  const beforeIds = new Set(before.map((tag) => tag.id));
  const removeIds = new Set((change.remove ?? []).filter((id) => beforeIds.has(id)));
  const kept = before.filter((tag) => !removeIds.has(tag.id));
  const keptKeys = new Set(kept.map((tag) => tag.normalizedName));
  const add = (change.add ?? [])
    .map((name) => ({ name, key: tagKey(name) }))
    .filter((tag) => !keptKeys.has(tag.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (removeIds.size === 0 && add.length === 0) return null;
  if (kept.length + add.length > MAX_STUDY_TAGS) throw new TagLimitExceededError();

  if (removeIds.size > 0) {
    const ids = [...removeIds].sort();
    await StudyTag.destroy({ where: { studyId: m.studyId, ownerId: m.ownerId, tagId: ids } });
    await deleteOrphanedTags(m.ownerId, ids);
  }
  const addedIds = add.length === 0 ? [] : await ownerTagIds(m.ownerId, add);
  for (const tagId of addedIds) await m.createChild(StudyTag, { tagId });

  const after = new Set([...kept.map((tag) => tag.id), ...addedIds]);
  const addedTagIds = [...after].filter((id) => !beforeIds.has(id)).sort();
  const removedTagIds = [...beforeIds].filter((id) => !after.has(id)).sort();
  return addedTagIds.length === 0 && removedTagIds.length === 0
    ? null
    : { addedTagIds, removedTagIds };
}

/**
 * Deletes those of `tagIds` (the owner's, in id order) that no study references any more.
 *
 * Another study of the same owner (a different study lock) may be adding one of these tags at
 * the same moment, so the delete must never remove a row that study is about to pair with:
 *
 * 1. `SELECT … FOR UPDATE` locks the rows first. It conflicts with the `FOR KEY SHARE` lock an
 *    adder takes (`ownerTagIds`) and holds until it commits, so it waits for any adder that got
 *    there first.
 * 2. The `DELETE … NOT EXISTS` is a new statement, so under READ COMMITTED it sees every pairing
 *    committed before the lock was granted, and keeps a tag that another study now uses. No new
 *    pairing can commit meanwhile: the adder's `FOR KEY SHARE` waits for this transaction.
 *
 * (A single `DELETE … WHERE NOT EXISTS` would not do: after waiting on an adder's lock,
 * PostgreSQL deletes the row without re-running the subquery, and the cascade would silently
 * drop the other study's new pairing.)
 */
async function deleteOrphanedTags(ownerId: string, tagIds: string[]): Promise<void> {
  const sequelize = database();
  await sequelize.query(
    `SELECT id FROM tag WHERE owner_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    { bind: [ownerId, tagIds], type: QueryTypes.SELECT },
  );
  await sequelize.query(
    `DELETE FROM tag t
      WHERE t.owner_id = $1 AND t.id = ANY($2::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM study_tag st WHERE st.owner_id = t.owner_id AND st.tag_id = t.id
        )`,
    { bind: [ownerId, tagIds], type: QueryTypes.DELETE },
  );
}

/** Attempts at finding or creating the tags before giving up (see `ownerTagIds`). */
const TAG_UPSERT_ATTEMPTS = 3;

/**
 * The ids of the owner's tags for `tags` (key order), creating the missing ones, each locked
 * `FOR KEY SHARE` until commit so no concurrent orphan cleanup can delete it before this
 * transaction pairs it with the study. Sorted by id.
 *
 * - `INSERT … ON CONFLICT (owner_id, normalized_name) DO NOTHING` in key order: two studies of
 *   one owner adding the same new name converge on one row (the second INSERT waits on the
 *   first's uncommitted row, then skips it once it commits). An existing tag keeps its stored
 *   display name.
 * - The locking SELECT skips a row another transaction deleted while this one waited for it (an
 *   orphan cleanup that won the race), so the loop inserts it afresh, with this request's
 *   display name. Bounded: each retry needs another study to delete the same tag again.
 */
async function ownerTagIds(
  ownerId: string,
  tags: { name: string; key: string }[],
): Promise<string[]> {
  const sequelize = database();
  let missing = tags;
  const found = new Map<string, string>();
  for (let attempt = 1; missing.length > 0; attempt += 1) {
    if (attempt > TAG_UPSERT_ATTEMPTS) throw new Error('ownerTagIds: a tag row kept disappearing');
    await sequelize.query(
      `INSERT INTO tag (owner_id, name, normalized_name)
       SELECT $1, t.name, t.normalized_name
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(name, normalized_name, ord)
        ORDER BY t.ord
       ON CONFLICT (owner_id, normalized_name) DO NOTHING`,
      {
        bind: [ownerId, missing.map((t) => t.name), missing.map((t) => t.key)],
        type: QueryTypes.INSERT,
      },
    );
    const rows = await sequelize.query<{ id: string; normalizedName: string }>(
      `SELECT id, normalized_name AS "normalizedName" FROM tag
        WHERE owner_id = $1 AND normalized_name = ANY($2::text[])
        ORDER BY normalized_name
        FOR KEY SHARE`,
      { bind: [ownerId, missing.map((t) => t.key)], type: QueryTypes.SELECT },
    );
    for (const row of rows) found.set(row.normalizedName, row.id);
    missing = missing.filter((t) => !found.has(t.key));
  }
  return [...found.values()].sort();
}
