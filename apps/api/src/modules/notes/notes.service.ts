import { Injectable } from '@nestjs/common';
import { fn, literal, Op } from 'sequelize';
import {
  createNoteRequestSchema,
  type CreateNoteResponse,
  listNotesQuerySchema,
  MAX_NOTE_CHARACTERS,
  MAX_NOTE_VERSIONS,
  MAX_NOTES_PER_STUDY,
  NOTE_CHECKPOINT_INTERVAL_SECONDS,
  NOTE_LIMIT_EXCEEDED,
  NOTE_NOT_TRASHED,
  NOTE_SCHEMA_VERSION,
  NOTE_TARGET_NOT_FOUND,
  NOTE_TRASHED,
  NOTE_UNCHANGED,
  noteCharacterCount,
  type NoteDocument,
  type NoteListResponse,
  type NoteMutationResponse,
  notePlainText,
  notePreview,
  type NoteResponse,
  noteSearchText,
  noteStateRequestSchema,
  type NoteTarget,
  type NoteVersionListResponse,
  type NoteVersionResponse,
  updateNoteRequestSchema,
} from '@bible-artisan/contracts';
import {
  NotFoundError,
  NoteRuleError,
  NoteTooLongError,
  RevisionConflictError,
} from '../../common/errors/domain-errors';
import { canonicalJson } from '../../common/mutation/fingerprint';
import type { MutationRequestInfo } from '../../common/mutation/mutation-request';
import { MutationResult, MutationService } from '../../common/mutation/mutation.service';
import type { StudyMutation } from '../../common/mutation/study-mutation';
import { requireExpectedRevision } from '../../common/revision/expected-revision';
import { isResourceId } from '../../common/validation/resource-id';
import { parseBody } from '../../common/validation/parse-body';
import { NoteVersion } from '../../database/models/note-version.model';
import { Note } from '../../database/models/note.model';
import { ReferenceService } from '../bible-content/reference/reference.service';
import { StudyAccessService } from '../study/study-access.service';
import { StudyRevisionService } from '../study/study-revision.service';

/**
 * Note events (BIB-23), one per mutation, ids only: never note text, previews, link targets or
 * target labels (PRD section 23, NFR-PRIV-001). Intended visibility, for BIB-55's column:
 * `note_created` is thread-visible (PRD section 13); `note_autosaved` is internal (section 13
 * lists it as such), and so are `note_trashed` / `note_restored`.
 */
export const NOTE_EVENTS = {
  created: 'note_created',
  autosaved: 'note_autosaved',
  trashed: 'note_trashed',
  restored: 'note_restored',
} as const;

/**
 * Plain text read for list and version previews: enough raw characters for a 200-code-point
 * preview after whitespace runs collapse, without loading 50,000-character bodies for a list.
 */
const PREVIEW_SOURCE_SQL = 'left(plain_text, 1000)';

/** A validated document with what the server derives from it. */
interface DerivedNote {
  content: NoteDocument;
  plainText: string;
  searchText: string;
}

/**
 * The plain text is derived here, never taken from the client, and the length limit applies to
 * it (FR-NOTE-004): over the limit is 413 before any transaction, so nothing is written.
 */
function derive(content: NoteDocument): DerivedNote {
  const plainText = notePlainText(content);
  if (noteCharacterCount(plainText) > MAX_NOTE_CHARACTERS) throw new NoteTooLongError();
  return { content, plainText, searchText: noteSearchText(plainText) };
}

/** Documents compared by value: `jsonb` hands objects back with its own key order. */
const sameDocument = (a: NoteDocument, b: NoteDocument): boolean =>
  canonicalJson(a) === canonicalJson(b);

function mutationBody(note: Note, lastEventSequence: string): NoteMutationResponse {
  return {
    id: note.id,
    studyId: note.studyId,
    revision: note.revision,
    targetNodeId: note.targetNodeId,
    characterCount: noteCharacterCount(note.plainText),
    latestVersionNumber: note.latestVersionNumber,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    deletedAt: note.deletedAt?.toISOString() ?? null,
    lastEventSequence,
  };
}

/**
 * Rich notes on a study or one of its nodes (BIB-23; FR-NOTE-001/002/004, NFR-SEC-002).
 *
 * Every write goes through `MutationService.execute`: one transaction with its Idempotency-Key
 * receipt, the study lock, the lifecycle guard (archived/trashed studies are refused before the
 * work runs), the revision check and one StudyEvent. Every read resolves the study through
 * `StudyAccessService` (owner from the session, the 30-day trash window), then queries the note
 * by its own id, study id and owner id.
 *
 * Versions: creation writes version 1. A save writes a new version when the client asks for a
 * checkpoint, or when the content changed and the newest version is at least
 * `NOTE_CHECKPOINT_INTERVAL_SECONDS` old by the database clock; never a version identical to the
 * newest one. Only the newest `MAX_NOTE_VERSIONS` are kept. Version numbering and pruning run
 * under the study lock every mutation of the study queues on, so they cannot race.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly mutations: MutationService,
    private readonly access: StudyAccessService,
    private readonly studyRevisions: StudyRevisionService,
    private readonly references: ReferenceService,
  ) {}

  /**
   * `POST /studies/:studyId/notes`. A new note is a study change: `expectedRevision` is the
   * study's, checked first (stale is always 409) and bumped. Content revision moves.
   */
  async create(
    ownerId: string,
    studyId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(createNoteRequestSchema, mutation.body);
    const note = derive(body.content);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const studyRevision = await this.studyRevisions.checkStudyRevision(m, expectedRevision);
        const targetNodeId = body.targetNodeId ?? null;
        if (targetNodeId !== null) await this.requireLiveTarget(m, targetNodeId);
        await requireRoomForLiveNote(m);

        const created = await m.createChild(Note, {
          targetNodeId,
          richTextJson: note.content,
          plainText: note.plainText,
          searchText: note.searchText,
          schemaVersion: NOTE_SCHEMA_VERSION,
          latestVersionNumber: 1,
        });
        const version = await m.createChild(NoteVersion, {
          noteId: created.id,
          versionNumber: 1,
          richTextJson: note.content,
          plainText: note.plainText,
          schemaVersion: NOTE_SCHEMA_VERSION,
        });
        const event = await m.appendEvent({
          eventType: NOTE_EVENTS.created,
          payload: { noteId: created.id, targetNodeId, versionId: version.id },
        });
        const response: CreateNoteResponse = {
          ...mutationBody(created, event.sequence),
          studyRevision,
        };
        return { status: 201, body: response };
      },
    });
  }

  /**
   * `PATCH /studies/:studyId/notes/:noteId`: new content (an autosave) and/or a checkpoint.
   * `expectedRevision` is the note's. Content revision moves only when a version is written
   * (PRD section 17: note checkpoints are significant; keystroke autosaves are not).
   */
  async update(
    ownerId: string,
    studyId: string,
    noteId: string,
    mutation: MutationRequestInfo,
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    const body = parseBody(updateNoteRequestSchema, mutation.body);
    const next = body.content === undefined ? null : derive(body.content);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: false,
      work: async (m) => {
        const current = await lockedNote(m, noteId, expectedRevision);
        if (current.deletedAt !== null) throw new NoteRuleError(NOTE_TRASHED);

        const contentChanged = next !== null && !sameDocument(next.content, current.richTextJson);
        const latest = await NoteVersion.findOne({
          where: { noteId: current.id, studyId: m.studyId, ownerId: m.ownerId },
          order: [['versionNumber', 'DESC']],
          attributes: [
            'richTextJson',
            // On the database clock, like every other time window (BIB-22).
            [
              literal(
                `created_at <= now() - make_interval(secs => ${NOTE_CHECKPOINT_INTERVAL_SECONDS})`,
              ),
              'intervalElapsed',
            ],
          ],
          rejectOnEmpty: true,
        });
        const resulting = contentChanged && next ? next.content : current.richTextJson;
        const versionDue =
          body.checkpoint === true || (contentChanged && latest.get('intervalElapsed') === true);
        const writeVersion = versionDue && !sameDocument(resulting, latest.richTextJson);
        if (!contentChanged && !writeVersion) throw new NoteRuleError(NOTE_UNCHANGED);

        const versionNumber = current.latestVersionNumber + 1;
        const updated = await m.updateWithExpectedRevision(Note, {
          id: current.id,
          expectedRevision,
          values: {
            ...(contentChanged && next
              ? {
                  richTextJson: next.content,
                  plainText: next.plainText,
                  searchText: next.searchText,
                }
              : {}),
            ...(writeVersion ? { latestVersionNumber: versionNumber } : {}),
          },
          where: { deletedAt: null },
        });

        let versionId: string | null = null;
        if (writeVersion) {
          const version = await m.createChild(NoteVersion, {
            noteId: updated.id,
            versionNumber,
            richTextJson: updated.richTextJson,
            plainText: updated.plainText,
            schemaVersion: NOTE_SCHEMA_VERSION,
          });
          versionId = version.id;
          // Numbers are contiguous from the oldest kept one, so this keeps the newest 100.
          await NoteVersion.destroy({
            where: {
              noteId: updated.id,
              studyId: m.studyId,
              ownerId: m.ownerId,
              versionNumber: { [Op.lte]: versionNumber - MAX_NOTE_VERSIONS },
            },
          });
          m.bumpContentRevision();
        }
        const event = await m.appendEvent({
          eventType: NOTE_EVENTS.autosaved,
          payload: { noteId: updated.id, versionId },
        });
        return { status: 200, body: mutationBody(updated, event.sequence) };
      },
    });
  }

  /**
   * `DELETE` (to the note trash) and `POST …/restore`. `expectedRevision` is the note's. Notes in
   * the trash stay readable and restorable; they leave only with their study (purge) or user.
   */
  async changeState(
    ownerId: string,
    studyId: string,
    noteId: string,
    mutation: MutationRequestInfo,
    change: 'trash' | 'restore',
  ): Promise<MutationResult> {
    const expectedRevision = requireExpectedRevision(mutation.body);
    parseBody(noteStateRequestSchema, mutation.body);
    return this.mutations.execute(ownerId, mutation, {
      studyId,
      bumpsContentRevision: true,
      work: async (m) => {
        const current = await lockedNote(m, noteId, expectedRevision);
        if (change === 'trash' && current.deletedAt !== null) {
          throw new NoteRuleError(NOTE_TRASHED);
        }
        if (change === 'restore' && current.deletedAt === null) {
          throw new NoteRuleError(NOTE_NOT_TRASHED);
        }
        // A restored note counts toward the cap again.
        if (change === 'restore') await requireRoomForLiveNote(m);
        const updated = await m.updateWithExpectedRevision(Note, {
          id: current.id,
          expectedRevision,
          // The database clock, as for study trash (BIB-22). Sequelize writes the fn as SQL and
          // RETURNING reads the stored instant back.
          values: { deletedAt: change === 'trash' ? (fn('now') as unknown as Date) : null },
        });
        const event = await m.appendEvent({
          eventType: change === 'trash' ? NOTE_EVENTS.trashed : NOTE_EVENTS.restored,
          payload: { noteId: updated.id },
        });
        return { status: 200, body: mutationBody(updated, event.sequence) };
      },
    });
  }

  /** `GET /studies/:studyId/notes?state=active|trashed`: summaries, most recently updated first. */
  async list(ownerId: string, studyId: string, query: unknown): Promise<NoteListResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const { state } = parseBody(listNotesQuerySchema, query);
    const rows = await Note.findAll({
      where: {
        studyId,
        ownerId,
        deletedAt: state === 'active' ? null : { [Op.ne]: null },
      },
      attributes: [
        'id',
        'revision',
        'targetNodeId',
        'createdAt',
        'updatedAt',
        'deletedAt',
        [literal(PREVIEW_SOURCE_SQL), 'previewSource'],
        [literal('char_length(plain_text)'), 'characterCount'],
      ],
      order: [
        ['updatedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      // Live notes are capped at this many; the trash is not, so it lists its newest.
      limit: MAX_NOTES_PER_STUDY,
    });
    const targets = await this.targets(
      ownerId,
      studyId,
      rows.map((row) => row.targetNodeId),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        target: row.targetNodeId === null ? null : (targets.get(row.targetNodeId) ?? null),
        preview: notePreview(String(row.get('previewSource'))),
        characterCount: Number(row.get('characterCount')),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
      })),
    };
  }

  /** `GET /studies/:studyId/notes/:noteId`: the note with its content (live or trashed). */
  async get(ownerId: string, studyId: string, noteId: string): Promise<NoteResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const note = await this.ownedNote(ownerId, studyId, noteId);
    const targets = await this.targets(ownerId, studyId, [note.targetNodeId]);
    return {
      id: note.id,
      studyId: note.studyId,
      revision: note.revision,
      target: note.targetNodeId === null ? null : (targets.get(note.targetNodeId) ?? null),
      content: note.richTextJson,
      characterCount: noteCharacterCount(note.plainText),
      latestVersionNumber: note.latestVersionNumber,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
      deletedAt: note.deletedAt?.toISOString() ?? null,
    };
  }

  /** `GET …/notes/:noteId/versions`: the kept checkpoints, newest first, without content. */
  async versions(
    ownerId: string,
    studyId: string,
    noteId: string,
  ): Promise<NoteVersionListResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    const note = await this.ownedNote(ownerId, studyId, noteId);
    const rows = await NoteVersion.findAll({
      where: { noteId: note.id, studyId, ownerId },
      attributes: [
        'id',
        'versionNumber',
        'createdAt',
        [literal(PREVIEW_SOURCE_SQL), 'previewSource'],
        [literal('char_length(plain_text)'), 'characterCount'],
      ],
      order: [['versionNumber', 'DESC']],
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        versionNumber: row.versionNumber,
        preview: notePreview(String(row.get('previewSource'))),
        characterCount: Number(row.get('characterCount')),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** `GET …/notes/:noteId/versions/:versionId`: one checkpoint with its content. */
  async version(
    ownerId: string,
    studyId: string,
    noteId: string,
    versionId: string,
  ): Promise<NoteVersionResponse> {
    await this.access.requireOwnedStudy(ownerId, studyId);
    if (!isResourceId(noteId) || !isResourceId(versionId)) throw new NotFoundError();
    const version = await NoteVersion.findOne({
      where: { id: versionId, noteId, studyId, ownerId },
    });
    if (!version) throw new NotFoundError();
    return {
      id: version.id,
      noteId: version.noteId,
      versionNumber: version.versionNumber,
      content: version.richTextJson,
      characterCount: noteCharacterCount(version.plainText),
      createdAt: version.createdAt.toISOString(),
    };
  }

  /**
   * A note's target must be a live node of this study, looked up through the Study context
   * (`requireOwnedNode`: the locked study's id and the session owner, in the mutation's
   * transaction). Another user's node, another study's, a deleted and an absent one are the same
   * 422. The composite FK backs this up in the database.
   */
  private async requireLiveTarget(m: StudyMutation, nodeId: string): Promise<void> {
    try {
      await this.access.requireOwnedNode(m.ownerId, m.studyId, nodeId, {
        transaction: m.transaction,
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw new NoteRuleError(NOTE_TARGET_NOT_FOUND);
      throw error;
    }
  }

  /** A note of this (already resolved) study and owner, live or trashed; otherwise 404. */
  private async ownedNote(ownerId: string, studyId: string, noteId: string): Promise<Note> {
    if (!isResourceId(noteId)) throw new NotFoundError();
    const note = await Note.findOne({ where: { id: noteId, studyId, ownerId } });
    if (!note) throw new NotFoundError();
    return note;
  }

  /**
   * The target nodes of these notes, deleted ones included (orphaned-note review, FR-NOTE-002),
   * with their labels: a question's text, a Scripture node's reference label. One node query and
   * one batched reference lookup.
   */
  private async targets(
    ownerId: string,
    studyId: string,
    nodeIds: (string | null)[],
  ): Promise<Map<string, NoteTarget>> {
    const ids = [...new Set(nodeIds.filter((id): id is string => id !== null))];
    const found = new Map<string, NoteTarget>();
    if (ids.length === 0) return found;
    const nodes = await this.access.ownedNodesIncludingDeleted(ownerId, studyId, ids);
    const references = await this.references.storedReferences(
      nodes.flatMap((node) => (node.scriptureReferenceId ? [node.scriptureReferenceId] : [])),
    );
    for (const node of nodes) {
      const label = node.scriptureReferenceId
        ? (references.get(node.scriptureReferenceId)?.label ?? null)
        : node.title;
      found.set(node.id, {
        nodeId: node.id,
        nodeType: node.type,
        label,
        deleted: node.deletedAt !== null,
      });
    }
    return found;
  }
}

/**
 * The note being changed, read inside the mutation (the study lock is held, so no other mutation
 * of the study can change it meanwhile): absent, another study's or another owner's is 404; a
 * stale `expectedRevision` is 409 before any state rule, so a client working from an old copy
 * always reloads first.
 */
async function lockedNote(m: StudyMutation, noteId: string, expectedRevision: number) {
  if (!isResourceId(noteId)) throw new NotFoundError();
  const note = await Note.findOne({
    where: { id: noteId, studyId: m.studyId, ownerId: m.ownerId },
  });
  if (!note) throw new NotFoundError();
  if (note.revision !== expectedRevision) throw new RevisionConflictError(note.revision);
  return note;
}

/**
 * The cap counts live notes only (`MAX_NOTES_PER_STUDY`): moving notes to the note trash makes
 * room, and restoring one needs room again. Counted under the study lock, so it cannot race.
 */
async function requireRoomForLiveNote(m: StudyMutation): Promise<void> {
  const live = await Note.count({
    where: { studyId: m.studyId, ownerId: m.ownerId, deletedAt: null },
  });
  if (live >= MAX_NOTES_PER_STUDY) throw new NoteRuleError(NOTE_LIMIT_EXCEEDED);
}
