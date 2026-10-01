import type {
  StudyQuestion,
  StudyResponse,
  StudyTag as StudyTagDto,
} from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import { StudyBranch } from '../../../database/models/study-branch.model';
import { StudyNode } from '../../../database/models/study-node.model';
import { StudyTag } from '../../../database/models/study-tag.model';
import { Study } from '../../../database/models/study.model';
import { Tag } from '../../../database/models/tag.model';

/** Everything about a study that `GET` and `PATCH /v1/studies/:studyId` both answer with. */
export type StudyState = Omit<StudyResponse, 'id' | 'startingReference' | 'createdAt'>;

/**
 * Reads a study's editable state (BIB-20): its questions, tags and initial branch, each queried
 * by the study's own `study_id` and `owner_id` (the composite FKs guarantee they agree), so it
 * never reaches another user's rows. Inside a mutation the queries join its transaction.
 * Four bounded queries: the two question pointers, at most 20 tags, one branch.
 */
export async function readStudyState(study: Study): Promise<StudyState> {
  const scope = { studyId: study.id, ownerId: study.ownerId };
  const questionIds = [study.mainQuestionNodeId, study.originalQuestionNodeId].filter(
    (id): id is string => id !== null,
  );
  // Sequential, not Promise.all: inside a mutation every query shares the transaction's one
  // connection, and pg refuses overlapping queries on a client.
  const questions =
    questionIds.length === 0
      ? []
      : await StudyNode.findAll({
          where: { ...scope, id: { [Op.in]: questionIds }, type: 'question', deletedAt: null },
        });
  const tags = await studyTags(study.id, study.ownerId);
  const branch = await StudyBranch.findOne({
    where: scope,
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const question = (id: string | null): StudyQuestion | null => {
    const node = questions.find((q) => q.id === id);
    return node?.title && node.questionStatus
      ? { nodeId: node.id, text: node.title, status: node.questionStatus }
      : null;
  };
  return {
    title: study.title,
    description: study.description,
    lifecycle: study.lifecycle,
    pinned: study.pinnedAt !== null,
    revision: study.revision,
    contentRevision: study.contentRevision,
    mainQuestion: question(study.mainQuestionNodeId),
    originalQuestion: question(study.originalQuestionNodeId),
    tags,
    branchId: branch?.id ?? null,
  };
}

/** The study's tags, sorted by normalized name (then id, for a total order). */
async function studyTags(studyId: string, ownerId: string): Promise<StudyTagDto[]> {
  const pairs = await StudyTag.findAll({ where: { studyId, ownerId }, attributes: ['tagId'] });
  if (pairs.length === 0) return [];
  const tags = await Tag.findAll({
    where: { ownerId, id: { [Op.in]: pairs.map((p) => p.tagId) } },
    order: [
      ['normalizedName', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return tags.map((tag) => ({ id: tag.id, name: tag.name }));
}
