import { tagKey } from '@bible-artisan/contracts';
import { Op, QueryTypes } from 'sequelize';
import type { StudyMutation } from '../../../common/mutation/study-mutation';
import { StudyTag } from '../../../database/models/study-tag.model';
import { Tag } from '../../../database/models/tag.model';

/** How a submitted tag set differs from a study's current one. */
export interface TagSetChange {
  /** Submitted names (normalized) whose key the study does not carry yet, sorted by key. */
  add: { name: string; key: string }[];
  /** Ids of the study's tags whose key is not in the submitted set. */
  removeTagIds: string[];
}

/**
 * Compares the submitted names (already normalized by `tagNameSchema`, with distinct keys) with
 * the study's tags, by key, without writing anything. Null when the sets are the same, so
 * submitting "grace" for a study tagged "Grace" is no change.
 */
export async function planTagSet(m: StudyMutation, names: string[]): Promise<TagSetChange | null> {
  const pairs = await StudyTag.findAll({
    where: { studyId: m.studyId, ownerId: m.ownerId },
    attributes: ['tagId'],
  });
  const current =
    pairs.length === 0
      ? []
      : await Tag.findAll({
          where: { ownerId: m.ownerId, id: { [Op.in]: pairs.map((p) => p.tagId) } },
          attributes: ['id', 'normalizedName'],
        });
  const currentKeys = new Set(current.map((tag) => tag.normalizedName));
  const wanted = new Map(names.map((name) => [tagKey(name), name]));
  const add = [...wanted]
    .filter(([key]) => !currentKeys.has(key))
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const removeTagIds = current
    .filter((tag) => !wanted.has(tag.normalizedName))
    .map((tag) => tag.id)
    .sort();
  return add.length === 0 && removeTagIds.length === 0 ? null : { add, removeTagIds };
}

/**
 * Applies a planned change in the mutation's transaction and returns the added tags' ids, sorted.
 *
 * New names become the owner's tags through `INSERT … ON CONFLICT (owner_id, normalized_name)
 * DO NOTHING`, in key order, then one SELECT reads the ids. Two mutations of different studies of
 * the same owner (they hold different study locks) adding the same new name converge on one tag:
 * the second INSERT waits on the first's uncommitted row, then skips it once it commits, and READ
 * COMMITTED lets the following SELECT see it (or inserts it, if the first rolled back). Key order
 * keeps two such mutations from waiting on each other's rows in opposite orders. An existing tag
 * keeps its stored display name.
 */
export async function applyTagSet(m: StudyMutation, change: TagSetChange): Promise<string[]> {
  if (change.removeTagIds.length > 0) {
    await StudyTag.destroy({
      where: { studyId: m.studyId, ownerId: m.ownerId, tagId: { [Op.in]: change.removeTagIds } },
      transaction: m.transaction,
    });
  }
  if (change.add.length === 0) return [];
  const sequelize = Tag.sequelize;
  if (!sequelize) throw new Error('Tag model is not initialized');
  await sequelize.query(
    `INSERT INTO tag (owner_id, name, normalized_name)
     SELECT $1, t.name, t.normalized_name
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(name, normalized_name, ord)
      ORDER BY t.ord
     ON CONFLICT (owner_id, normalized_name) DO NOTHING`,
    {
      bind: [m.ownerId, change.add.map((t) => t.name), change.add.map((t) => t.key)],
      transaction: m.transaction,
      type: QueryTypes.INSERT,
    },
  );
  const tags = await Tag.findAll({
    where: { ownerId: m.ownerId, normalizedName: { [Op.in]: change.add.map((t) => t.key) } },
    attributes: ['id'],
    transaction: m.transaction,
  });
  if (tags.length !== change.add.length) throw new Error('applyTagSet: a tag row is missing');
  const ids = tags.map((tag) => tag.id).sort();
  for (const tagId of ids) await m.createChild(StudyTag, { tagId });
  return ids;
}
