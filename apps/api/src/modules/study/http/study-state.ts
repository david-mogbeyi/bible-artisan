import type { StudyQuestion, StudyResponse } from '@bible-artisan/contracts';
import { Op } from 'sequelize';
import { activeTransaction } from '../../../database/transaction-context';
import { StudyBranch } from '../../../database/models/study-branch.model';
import { StudyNode } from '../../../database/models/study-node.model';
import type { Study } from '../../../database/models/study.model';
import { studyTagRows } from './study-tags';

/** Everything about a study that `GET` and `PATCH /v1/studies/:studyId` both answer with. */
export type StudyState = Omit<StudyResponse, 'id' | 'startingReference' | 'createdAt'>;

/**
 * Reads a study's editable state (BIB-20): its questions, tags and initial branch, each queried
 * by the study's own `study_id` and `owner_id` (the composite FKs guarantee they agree), so it
 * never reaches another user's rows. Three bounded queries: the two question pointers, at most
 * 20 tags, one branch.
 *
 * Outside a transaction (`GET`) they run in parallel on pooled connections. Inside a mutation
 * they join its transaction, whose one connection pg cannot share between overlapping queries,
 * so there they run one after another.
 */
export async function readStudyState(study: Study): Promise<StudyState> {
  const scope = { studyId: study.id, ownerId: study.ownerId };
  const questionIds = [study.mainQuestionNodeId, study.originalQuestionNodeId].filter(
    (id): id is string => id !== null,
  );
  const readQuestions = (): Promise<StudyNode[]> =>
    questionIds.length === 0
      ? Promise.resolve([])
      : StudyNode.findAll({
          where: { ...scope, id: { [Op.in]: questionIds }, type: 'question', deletedAt: null },
        });
  const readTags = () => studyTagRows(study.id, study.ownerId);
  const readBranch = () =>
    StudyBranch.findOne({
      where: scope,
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
  const [questions, tags, branch] =
    activeTransaction() === undefined
      ? await Promise.all([readQuestions(), readTags(), readBranch()])
      : [await readQuestions(), await readTags(), await readBranch()];
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
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
    branchId: branch?.id ?? null,
  };
}
