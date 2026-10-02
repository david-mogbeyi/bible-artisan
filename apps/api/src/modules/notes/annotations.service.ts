import { Injectable } from '@nestjs/common';
import { fn, Op } from 'sequelize';
import {
  ANNOTATION_LIMIT_EXCEEDED,
  ANNOTATION_UNCHANGED,
  type AnnotationListResponse,
  type AnnotationMutationResponse,
  annotationStateRequestSchema,
  createAnnotationRequestSchema,
  type CreateAnnotationResponse,
  listAnnotationsQuerySchema,
  MAX_ANNOTATIONS_PER_STUDY,
  type ResolveAnchorResponse,
  type ScriptureAnchor,
  updateAnnotationRequestSchema,
} from '@bible-artisan/contracts';
import {
  AnchorInvalidError,
  AnnotationRuleError,
  NotFoundError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { Annotation } from '../../database/models/annotation.model';
import { AnchorService } from '../bible-content/anchor/anchor.service';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { StudyAccessService } from '../study/study-access.service';
import { StudyRevisionService } from '../study/study-revision.service';

/**
 * Highlight events (BIB-24), one per mutation, ids and enums only: never the quote, offsets or
 * label (PRD section 23, NFR-PRIV-001). Intended visibility, for BIB-55's column:
 * `highlight_created` is thread-visible; `highlight_updated` and `highlight_deleted` are internal.
 */
export const HIGHLIGHT_EVENTS = {
  created: 'highlight_created',
  updated: 'highlight_updated',
  deleted: 'highlight_deleted',
} as const;

function mutationBody(row: Annotation, lastEventSequence: string): AnnotationMutationResponse {
  return {
    id: row.id,
    studyId: row.studyId,
    revision: row.revision,
    colorToken: row.colorToken,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    lastEventSequence,
  };
}

/** The first and last chapter an anchor's segments touch (segments are in canon order). */
function chaptersOf(anchor: ScriptureAnchor): { startChapter: number; endChapter: number } {
  const first = anchor.segments[0];
  const last = anchor.segments[anchor.segments.length - 1];
  if (!first || !last) throw new Error('AnnotationsService: an anchor has at least one segment');
  return { startChapter: first.chapter, endChapter: last.chapter };
}

/**
 * Highlights on Scripture (BIB-24; FR-BIBLE-006/007, PRD sections 14, 15, 23).
 *
 * Every write goes through `MutationService.execute`: one transaction with its Idempotency-Key
 * receipt, the study lock, the lifecycle guard (archived/trashed studies are refused before the
 * work runs), the revision check and one StudyEvent. Every read resolves the study through
 * `StudyAccessService`, then queries highlights by study id and owner id.
 *
 * Anchors are checked by the Bible content context (`AnchorService`), never read from its tables
 * here: on create (anything but a match is 422 with the anchor code; the anchor is stored exactly
 * as checked) and again on every read, where a highlight that no longer matches is returned as
 * unresolved with its original quote. Nothing ever moves an anchor to other text.
 */
@Injectable()
export class AnnotationsService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly studyRevisions: StudyRevisionService,
    private readonly references: ReferenceService,
    private readonly anchors: AnchorService,
  ) {}

  /**
   * `POST /studies/:studyId/annotations`. A new highlight is a study change: `expectedRevision` is
   * the study's, checked first and bumped; content revision moves. The anchor is re-checked before
   * the transaction (its only write is the idempotent upsert of the shared reference row).
   */
  async create(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(createAnnotationRequestSchema, mutation.body);
    const resolution = await this.anchors.resolve(body.anchor);
    if (resolution.outcome === 'unresolved') throw new AnchorInvalidError(resolution.reason);
    const { anchor, reference } = resolution;
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
        await requireRoomForHighlight(m);
        const created = await m.createChild(Annotation, {
          referenceId: reference.id,
          editionId: anchor.editionId,
          bookCode: anchor.bookCode,
          ...chaptersOf(anchor),
          anchorJson: anchor,
          colorToken: body.colorToken,
          label: body.label ?? null,
        });
        const event = await m.appendEvent({
          eventType: HIGHLIGHT_EVENTS.created,
          payload: {
            annotationId: created.id,
            referenceId: created.referenceId,
            colorToken: created.colorToken,
          },
        });
        const response: CreateAnnotationResponse = {
          ...mutationBody(created, event.sequence),
          studyRevision,
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * `PATCH …/annotations/:annotationId`: a new color and/or label. `expectedRevision` is the
   * highlight's. Content revision does not move (PRD section 17: highlight-color changes are not
   * significant).
   */
  async update(
    ownerId: string,
    studyId: string,
    annotationId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateAnnotationRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const current = await lockedHighlight(m, annotationId, expectedRevision);
        const colorToken = body.colorToken ?? current.colorToken;
        const label = body.label === undefined ? current.label : body.label;
        if (colorToken === current.colorToken && label === current.label) {
          throw new AnnotationRuleError(ANNOTATION_UNCHANGED);
        }
        const updated = await m.updateWithExpectedRevision(Annotation, {
          id: current.id,
          expectedRevision,
          values: { colorToken, label },
          where: { deletedAt: null },
        });
        const event = await m.appendEvent({
          eventType: HIGHLIGHT_EVENTS.updated,
          payload: { annotationId: updated.id, colorToken: updated.colorToken },
        });
        return { status: 200, body: mutationBody(updated, event.sequence) };
      },
    });
  }

  /** `DELETE …/annotations/:annotationId`: the highlight's revision. Content revision moves. */
  async remove(
    ownerId: string,
    studyId: string,
    annotationId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(annotationStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedHighlight(m, annotationId, expectedRevision);
        const updated = await m.updateWithExpectedRevision(Annotation, {
          id: current.id,
          expectedRevision,
          // The database clock, as for note and study trash (BIB-22/23).
          values: { deletedAt: fn('now') },
          where: { deletedAt: null },
        });
        const event = await m.appendEvent({
          eventType: HIGHLIGHT_EVENTS.deleted,
          payload: { annotationId: updated.id },
        });
        return { status: 200, body: mutationBody(updated, event.sequence) };
      },
    });
  }

  /**
   * `GET /studies/:studyId/annotations?referenceId=`: the live highlights on the chapter the
   * reader shows for that reference (its first chapter) in the reference's edition and book,
   * oldest first, each re-checked against the corpus. Archived and trashed studies stay readable.
   */
  async list(ownerId: string, studyId: string, query: unknown): Promise<AnnotationListResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const { referenceId } = parseBody(listAnnotationsQuerySchema, query);
    const { reference } = await this.references.storedReference(referenceId);
    const chapter = reference.startChapter;
    const rows = await Annotation.findAll({
      where: {
        studyId,
        ownerId,
        deletedAt: null,
        editionId: reference.editionId,
        bookCode: reference.bookCode,
        startChapter: { [Op.lte]: chapter },
        endChapter: { [Op.gte]: chapter },
      },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
      // Live highlights are capped per study, so this bounds the list.
      limit: MAX_ANNOTATIONS_PER_STUDY,
    });
    const problems = await this.anchors.checkStored(rows.map((row) => row.anchorJson));
    const stored = await this.references.storedReferences(rows.map((row) => row.referenceId));
    return {
      items: rows.map((row, index) => {
        const problem = problems[index] ?? null;
        const own = stored.get(row.referenceId) ?? null;
        let resolution: ResolveAnchorResponse;
        if (problem === null && own !== null) {
          resolution = { outcome: 'resolved', anchor: row.anchorJson, reference: own };
        } else {
          resolution = {
            outcome: 'unresolved',
            reason: problem ?? 'ANCHOR_EDITION_UNAVAILABLE',
            anchor: row.anchorJson,
            reference: own,
          };
        }
        return {
          id: row.id,
          revision: row.revision,
          colorToken: row.colorToken,
          label: row.label,
          resolution,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  }
}

/**
 * The live highlight being changed, read inside the mutation (the study lock is held): absent,
 * deleted, another study's or another owner's is 404; a stale `expectedRevision` is 409 before
 * any state rule, so a client working from an old copy always reloads first.
 */
async function lockedHighlight(m: StudyMutation, annotationId: string, expectedRevision: number) {
  if (!isResourceId(annotationId)) throw new NotFoundError();
  const row = await Annotation.findOne({
    where: { id: annotationId, studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (!row) throw new NotFoundError();
  if (row.revision !== expectedRevision) throw new RevisionConflictError(row.revision);
  return row;
}

/** Live highlights only count; counted under the study lock, so concurrent creates cannot race. */
async function requireRoomForHighlight(m: StudyMutation): Promise<void> {
  const live = await Annotation.count({
    where: { studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (live >= MAX_ANNOTATIONS_PER_STUDY) {
    throw new AnnotationRuleError(ANNOTATION_LIMIT_EXCEEDED);
  }
}
