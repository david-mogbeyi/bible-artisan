import { Injectable } from '@nestjs/common';
import { MAX_NODES_PER_STUDY, NODE_LIMIT_EXCEEDED } from '@bible-artisan/contracts';
import type { CreationAttributes } from 'sequelize';
import { NodeRuleError } from '../../common/errors/domain-errors';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { StudyBranch } from '../../database/models/study-branch.model';
import { StudyNode } from '../../database/models/study-node.model';
import { Study } from '../../database/models/study.model';

/** The columns of a new node; study and owner come from the mutation's lock. */
export type NewNodeValues = Omit<CreationAttributes<StudyNode>, 'studyId' | 'ownerId'>;

/**
 * The rules every path that adds to a study's graph shares (Study created `study_node` and
 * `study_branch`; Graph starts the other branches and owns their membership, BIB-60), so study creation (BIB-19), a study edit's new main question (BIB-20) and the
 * node API (BIB-25) cannot drift apart. Every method runs inside a mutation's work, under the
 * study row lock, so its counts cannot race another writer of the study.
 */
@Injectable()
export class StudyGraphService {
  /**
   * Inserts a node after checking the live-node cap (NFR-SCALE-002: at most
   * `MAX_NODES_PER_STUDY` live nodes; deleted ones do not count): 422 `NODE_LIMIT_EXCEEDED`
   * otherwise. The only way a node is created, whatever the route.
   */
  async addNode(m: StudyMutation, values: NewNodeValues): Promise<StudyNode> {
    await this.requireRoomForLiveNode(m);
    return m.createChild(StudyNode, values);
  }

  /**
   * 422 `NODE_LIMIT_EXCEEDED` unless the study holds fewer than `MAX_NODES_PER_STUDY` live nodes:
   * the cap every path that makes a node live shares (a create, and BIB-31's restore).
   */
  async requireRoomForLiveNode(m: StudyMutation): Promise<void> {
    const live = await StudyNode.count({
      where: { studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
    });
    if (live >= MAX_NODES_PER_STUDY) throw new NodeRuleError(NODE_LIMIT_EXCEEDED);
  }

  /**
   * When a node is deleted (BIB-31; PRD section 23 "Deleting the main question clears current main
   * pointer but preserves the original question"): clears `study.main_question_node_id` if it names
   * that node, moving the study's revision, and says whether it did. The original-question pointer
   * is never touched. Graph never writes `study` itself.
   */
  async clearMainQuestion(m: StudyMutation, nodeId: string): Promise<boolean> {
    const study = await Study.findOne({
      where: { id: m.studyId, ownerId: m.ownerId },
      attributes: ['revision', 'mainQuestionNodeId'],
      rejectOnEmpty: true,
    });
    if (study.mainQuestionNodeId !== nodeId) return false;
    await m.updateWithExpectedRevision(Study, {
      id: m.studyId,
      expectedRevision: study.revision,
      values: { mainQuestionNodeId: null },
    });
    return true;
  }

  /**
   * The study's branches, oldest first (ties by id), for Graph's snapshot (BIB-28; with their
   * revision since BIB-60). The caller has already resolved the study as the owner's; both ids are
   * in the filter regardless.
   */
  async listBranches(ownerId: string, studyId: string): Promise<StudyBranch[]> {
    return StudyBranch.findAll({
      where: { studyId, ownerId },
      attributes: ['id', 'rootNodeId', 'revision', 'createdAt'],
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
  }

  /**
   * Creates the study's initial branch if it has none yet, and returns its id (null when a branch
   * already exists or there is nothing to root one at). PRD section 10, as BIB-19 decided it: the
   * initial branch is rooted at the study's first question, else at its passage. Precisely:
   *
   * - root = the study's oldest live Question node (created_at, then id); if it has none, its
   *   oldest live Scripture node; if neither, no branch;
   * - called at study creation (so a study created with a question roots at it, one created with
   *   only a passage roots at the passage, and a blank study gets none yet), whenever a Question
   *   node is created (a study edit's `mainQuestion: {text}`, `POST /nodes` with a question), and
   *   when a study edit makes an existing question main (`mainQuestion: {nodeId}`);
   * - so a blank study's first question roots the branch whichever path creates it, and a study
   *   that already has a branch (from its passage or an earlier question) never gets another.
   *
   * A Scripture node added through `POST /nodes` does not root a branch on its own: a blank study
   * waits for its first question. Callers report the returned id as `branchId` on the event of
   * the change that created it.
   */
  async ensureInitialBranch(m: StudyMutation): Promise<string | null> {
    const scope = { studyId: m.studyId, ownerId: m.ownerId };
    if ((await StudyBranch.count({ where: scope })) > 0) return null;
    const oldest = (type: 'question' | 'scripture') =>
      StudyNode.findOne({
        where: { ...scope, type, deletedAt: null },
        attributes: ['id'],
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      });
    const root = (await oldest('question')) ?? (await oldest('scripture'));
    if (!root) return null;
    return (await m.createChild(StudyBranch, { rootNodeId: root.id })).id;
  }
}
