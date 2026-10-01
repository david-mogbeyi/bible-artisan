import { Inject, Injectable } from '@nestjs/common';
import { fn } from 'sequelize';
import {
  type CreateStudyResponse,
  createStudyRequestSchema,
  listStudiesQuerySchema,
  type ScriptureReference,
  type StudyListResponse,
  type StudyLifecycleResponse,
  studyLifecycleRequestSchema,
  type StudyResponse,
  studySearchText,
  studyTitleSortKey,
  type UpdateStudyResponse,
  updateStudyRequestSchema,
} from '@bible-artisan/contracts';
import {
  NotFoundError,
  QuestionNotFoundError,
  ReferenceNotFoundError,
  RevisionConflictError,
  StudyUnchangedError,
} from '../../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../../common/mutation/mutation.service';
import type { StudyMutation } from '../../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../../common/revision/expected-revision';
import { parseBody } from '../../../common/validation/parse-body';
import { ENV } from '../../../config/config.module';
import { cursorSecret, type Env } from '../../../config/env';
import { StudyBranch } from '../../../database/models/study-branch.model';
import { StudyNode } from '../../../database/models/study-node.model';
import { Study } from '../../../database/models/study.model';
import type { AppendEventInput } from '../../thread/thread.service';
import { ReferenceService } from '../../bible-content/reference/reference.service';
import { NotesSearchService } from '../../notes/notes-search.service';
import { StudyAccessService } from '../study-access.service';
import type { StudyLifecycleTransition } from '../study-lifecycle';
import { deriveStudyTitle } from '../study-title';
import { libraryCursorKey } from './library-cursor';
import { listStudies } from './study-library';
import { readStudyState } from './study-state';
import { applyTagChange } from './study-tags';

/** PRD section 13: the thread-visible event every study starts with. */
const STUDY_CREATED = 'study_created';

/**
 * Study edit events (BIB-20), one per real change, ids and booleans only: never the title,
 * description, question or tag text (PRD section 23, NFR-PRIV-001). Intended visibility, for
 * BIB-55's column: `study_renamed`, `question_created` and `main_question_changed` are
 * thread-visible (PRD section 13); the rest are internal (section 11: list actions such as pin and
 * tag make no reasoning events).
 */
export const STUDY_EDIT_EVENTS = {
  renamed: 'study_renamed',
  descriptionChanged: 'study_description_changed',
  questionCreated: 'question_created',
  mainQuestionChanged: 'main_question_changed',
  pinned: 'study_pinned',
  unpinned: 'study_unpinned',
  tagsChanged: 'study_tags_changed',
} as const;

/**
 * One event per lifecycle change (BIB-22), committed with it; no payload but the restored state.
 * Intended visibility, for BIB-55's column: `study_archived` and `study_unarchived` are
 * thread-visible (PRD section 13 lists them); `study_trashed` and `study_restored` are internal.
 */
export const STUDY_LIFECYCLE_EVENTS: Record<StudyLifecycleTransition, string> = {
  archive: 'study_archived',
  unarchive: 'study_unarchived',
  trash: 'study_trashed',
  restore: 'study_restored',
};

/**
 * Creates and reads studies (BIB-19). Creation goes through `MutationService.create`, so the
 * study, its root nodes, its initial branch, its `study_created` event and the Idempotency-Key
 * receipt commit in one transaction or not at all (FR-STUDY-001/002).
 */
@Injectable()
export class StudiesService {
  /** Seals and opens library cursors (BIB-21), derived once from CURSOR_SECRET. */
  private readonly cursorKey: Buffer;

  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly references: ReferenceService,
    private readonly notesSearch: NotesSearchService,
    @Inject(ENV) env: Env,
  ) {
    this.cursorKey = libraryCursorKey(cursorSecret(env));
  }

  async create(ownerId: string, mutation: MutationRequestInfo): Promise<MutationResult> {
    const body = parseBody(createStudyRequestSchema, mutation.body);
    // Before the transaction: no corpus index load inside a mutation, and a bad reference writes
    // nothing at all. Reference rows are immutable and never deleted, and an active edition stays
    // active, so the check cannot go stale before COMMIT; the FK backs it up regardless.
    const reference =
      body.startingReferenceId === undefined
        ? null
        : await this.startingReference(body.startingReferenceId);
    const title = deriveStudyTitle({
      title: body.title,
      referenceLabel: reference?.label,
      question: body.question,
    });

    return this.mutations.create(ownerId, mutation, {
      study: { title, startingReferenceId: reference?.id ?? null },
      work: async (m) => {
        const scripture = reference
          ? await m.createChild(StudyNode, {
              type: 'scripture',
              scriptureReferenceId: reference.id,
            })
          : null;
        const question =
          body.question === undefined
            ? null
            : await m.createChild(StudyNode, {
                type: 'question',
                title: body.question,
                questionStatus: 'open',
              });
        if (question) {
          await m.updateCreatedStudy({
            originalQuestionNodeId: question.id,
            mainQuestionNodeId: question.id,
          });
        }
        // PRD section 10: the question establishes the initial branch; else the passage roots it.
        const root = question ?? scripture;
        const branch = root ? await m.createChild(StudyBranch, { rootNodeId: root.id }) : null;
        // Ids and the reference label only: the title and question are private text the thread
        // reads from the study and node, not copies in the event (PRD section 23).
        const event = await m.appendEvent({
          eventType: STUDY_CREATED,
          payload: {
            startingReferenceId: reference?.id ?? null,
            startingReferenceLabel: reference?.label ?? null,
            scriptureNodeId: scripture?.id ?? null,
            questionNodeId: question?.id ?? null,
            branchId: branch?.id ?? null,
            blank: body.blank === true,
          },
        });
        const created: CreateStudyResponse = {
          studyId: m.studyId,
          // A new study's first revision; every root shares content revision 1 (PRD section 24).
          revision: 1,
          contentRevision: m.contentRevision,
          rootNodeId: scripture?.id ?? null,
          questionNodeId: question?.id ?? null,
          branchId: branch?.id ?? null,
          lastEventSequence: event.sequence,
        };
        return { status: 201, body: created };
      },
    });
  }

  /**
   * The owner's library page (BIB-21): `GET /v1/studies` query parameters validated with the
   * shared schema (400 before any query), then one owner-scoped listing.
   */
  list(ownerId: string, query: unknown): Promise<StudyListResponse> {
    return listStudies(
      ownerId,
      parseBody(listStudiesQuerySchema, query),
      (ids) => this.references.storedReferences(ids),
      (owner, words) => this.notesSearch.studiesMatchingNoteText(owner, words),
      this.cursorKey,
    );
  }

  async get(ownerId: string, studyId: string): Promise<StudyResponse> {
    const study = await this.access.requireOwnedStudy(ownerId, studyId);
    const [state, reference] = await Promise.all([
      readStudyState(study),
      study.startingReferenceId === null
        ? null
        : this.references.storedReference(study.startingReferenceId).then((r) => r.reference),
    ]);
    return {
      id: study.id,
      ...state,
      startingReference: reference,
      createdAt: study.createdAt.toISOString(),
    };
  }

  /**
   * Edits a study's title, description, main question, pin and tags (BIB-20, FR-STUDY-003) in one
   * `MutationService.execute`: 428 without `expectedRevision`, 400 for a bad body (both before any
   * transaction), then under the study lock:
   *
   * 1. Revision check first, so a stale edit is 409 whatever else it says.
   * 2. Work out what really changes; a field equal to its current value is no change, and an
   *    edit that changes nothing is 422 STUDY_UNCHANGED (rolled back: no receipt, nothing).
   * 3. Write: a new Question node (and the initial branch, for a study without one), the study
   *    row (one revision bump for the whole edit); one event per change.
   *
   * Tag deltas apply before step 2's verdict (see `applyTagChange`), and their 20-tag limit is a
   * 422 TAG_LIMIT_EXCEEDED.
   *
   * The original question is never rewritten; a study without one takes its first main question
   * as the original (the DB trigger refuses any later change). `content_revision` moves only for a
   * new title, description or main question: pin and tags are organizational.
   */
  async update(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateStudyRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        // Locked by the pipeline (receipt -> study); this read joins the transaction.
        const current = await Study.findOne({
          where: { id: m.studyId, ownerId: m.ownerId },
          rejectOnEmpty: true,
        });
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(current.revision);
        }

        const titleChanged = body.title !== undefined && body.title !== current.title;
        const descriptionChanged =
          body.description !== undefined && body.description !== current.description;
        const pinChanged = body.pinned !== undefined && body.pinned !== (current.pinnedAt !== null);
        const target = body.mainQuestion;
        if (target && 'nodeId' in target) await requireLiveQuestion(m, target.nodeId);
        const mainChanged =
          target !== undefined &&
          ('text' in target || target.nodeId !== current.mainQuestionNodeId);
        // Tags apply first: whether they change anything is only known once the deltas have met
        // the study's current tags (and a concurrent orphan cleanup). A refusal below rolls the
        // interim writes back with everything else.
        const tagChange = body.tags === undefined ? null : await applyTagChange(m, body.tags);
        if (!titleChanged && !descriptionChanged && !pinChanged && !mainChanged && !tagChange) {
          throw new StudyUnchangedError();
        }

        // A new main question is a new Question node; the old one (and the original) stay.
        let createdQuestionId: string | null = null;
        let createdBranchId: string | null = null;
        if (target && 'text' in target) {
          const node = await m.createChild(StudyNode, {
            type: 'question',
            title: target.text,
            questionStatus: 'open',
          });
          createdQuestionId = node.id;
          // A blank study's first question roots its initial branch, as at creation.
          const hasBranch = await StudyBranch.count({
            where: { studyId: m.studyId, ownerId: m.ownerId },
          });
          if (hasBranch === 0) {
            createdBranchId = (await m.createChild(StudyBranch, { rootNodeId: node.id })).id;
          }
        }
        const newMainId =
          target === undefined ? null : 'text' in target ? createdQuestionId : target.nodeId;

        const updated = await m.updateWithExpectedRevision(Study, {
          id: m.studyId,
          expectedRevision,
          values: {
            ...(titleChanged && body.title !== undefined
              ? { title: body.title, titleSortKey: studyTitleSortKey(body.title) }
              : {}),
            ...(descriptionChanged ? { description: body.description ?? null } : {}),
            // The library matches the folded title and description (BIB-21); rewritten with them.
            ...(titleChanged || descriptionChanged
              ? {
                  searchText: studySearchText(
                    titleChanged && body.title !== undefined ? body.title : current.title,
                    descriptionChanged ? (body.description ?? null) : current.description,
                  ),
                }
              : {}),
            ...(pinChanged ? { pinnedAt: body.pinned ? new Date() : null } : {}),
            ...(mainChanged && newMainId !== null
              ? {
                  mainQuestionNodeId: newMainId,
                  ...(current.originalQuestionNodeId === null
                    ? { originalQuestionNodeId: newMainId }
                    : {}),
                }
              : {}),
          },
        });

        const events: AppendEventInput[] = [];
        if (titleChanged) events.push({ eventType: STUDY_EDIT_EVENTS.renamed });
        if (descriptionChanged) {
          events.push({
            eventType: STUDY_EDIT_EVENTS.descriptionChanged,
            payload: { cleared: body.description === null },
          });
        }
        if (createdQuestionId !== null) {
          events.push({
            eventType: STUDY_EDIT_EVENTS.questionCreated,
            payload: { questionNodeId: createdQuestionId, branchId: createdBranchId },
          });
        }
        if (mainChanged && newMainId !== null) {
          events.push({
            eventType: STUDY_EDIT_EVENTS.mainQuestionChanged,
            payload: {
              fromNodeId: current.mainQuestionNodeId,
              toNodeId: newMainId,
              originalQuestionNodeId: updated.originalQuestionNodeId,
            },
          });
        }
        if (pinChanged) {
          events.push({
            eventType: body.pinned ? STUDY_EDIT_EVENTS.pinned : STUDY_EDIT_EVENTS.unpinned,
          });
        }
        if (tagChange) {
          events.push({
            eventType: STUDY_EDIT_EVENTS.tagsChanged,
            payload: {
              addedTagIds: tagChange.addedTagIds,
              removedTagIds: tagChange.removedTagIds,
            },
          });
        }
        // At least one: an edit without a change was refused above.
        let lastEventSequence = '';
        for (const input of events) lastEventSequence = (await m.appendEvent(input)).sequence;
        if (titleChanged || descriptionChanged || mainChanged) m.bumpContentRevision();

        const state = await readStudyState(updated);
        const edited: UpdateStudyResponse = {
          id: m.studyId,
          ...state,
          // The row predates the pipeline's counter write at the end of this mutation.
          contentRevision: m.contentRevision,
          lastEventSequence,
        };
        return { status: 200, body: edited };
      },
    });
  }

  /**
   * Archives, unarchives, trashes or restores a study (BIB-22, FR-STUDY-005/006) through
   * `MutationService.execute`: 428 without `expectedRevision` and 400 for any other body field
   * (both before any transaction); then under the study lock the pipeline's lifecycle guard
   * refuses a starting state the transition does not allow (422), and the work writes the new
   * state with one revision check (404 / 409) and one event. `content_revision` does not move:
   * the lifecycle is organizational, not study content. Nothing else about the study changes, so
   * restore returns its nodes, events, branches, pin and tags exactly as they were.
   *
   * The new state's dates follow `study_lifecycle_timestamps_check`, written with the database
   * clock (`now()`) so the recovery window is decided on one clock:
   * - archive: `archived_at` = now;
   * - unarchive: `archived_at` = null;
   * - trash: `deleted_at` = now, `archived_at` kept (it records that the study was archived);
   * - restore: `deleted_at` = null, back to archived when `archived_at` is set, else active.
   */
  async changeLifecycle(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
    transition: StudyLifecycleTransition,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(studyLifecycleRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      lifecycleTransition: transition,
      work: async (m) => {
        // The database clock (`now()`, the transaction's start), the one clock every recovery
        // window decision compares these dates with (`RECOVERY_CUTOFF_SQL`). Typed as a Date for
        // the column; Sequelize writes the fn as SQL, and RETURNING reads back the stored instant.
        const now = fn('now') as unknown as Date;
        const values: Partial<Pick<Study, 'lifecycle' | 'archivedAt' | 'deletedAt'>> =
          transition === 'archive'
            ? { lifecycle: 'archived', archivedAt: now }
            : transition === 'unarchive'
              ? { lifecycle: 'active', archivedAt: null }
              : transition === 'trash'
                ? { lifecycle: 'trashed', deletedAt: now }
                : {
                    // `archived_at` as the pipeline locked it: no second read of the study.
                    lifecycle: m.lockedArchivedAt === null ? 'active' : 'archived',
                    deletedAt: null,
                  };
        const updated = await m.updateWithExpectedRevision(Study, {
          id: m.studyId,
          expectedRevision,
          values,
        });
        const event = await m.appendEvent({
          eventType: STUDY_LIFECYCLE_EVENTS[transition],
          ...(transition === 'restore' ? { payload: { restoredTo: updated.lifecycle } } : {}),
        });
        const changed: StudyLifecycleResponse = {
          id: m.studyId,
          ...(await readStudyState(updated)),
          lastEventSequence: event.sequence,
        };
        return { status: 200, body: changed };
      },
    });
  }

  /** The stored reference, in an active edition; otherwise 422 with nothing written. */
  private async startingReference(referenceId: string): Promise<ScriptureReference> {
    try {
      return (await this.references.storedReference(referenceId)).reference;
    } catch (error) {
      if (error instanceof NotFoundError) throw new ReferenceNotFoundError();
      throw error;
    }
  }
}

/**
 * The new main question named by id must be a live Question node of this study, queried by this
 * study's id and the session owner, so another user's node and an absent one are the same 422.
 */
async function requireLiveQuestion(m: StudyMutation, nodeId: string): Promise<void> {
  const node = await StudyNode.findOne({
    where: {
      id: nodeId,
      studyId: m.studyId,
      ownerId: m.ownerId,
      type: 'question',
      deletedAt: null,
    },
    attributes: ['id'],
  });
  if (!node) throw new QuestionNotFoundError();
}
