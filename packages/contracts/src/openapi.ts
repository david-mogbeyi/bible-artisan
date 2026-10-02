import { z } from 'zod';
import {
  meResponseSchema,
  otpStartRequestSchema,
  otpStartResponseSchema,
  otpVerifyRequestSchema,
} from './auth';
import {
  biblePassageResponseSchema,
  bibleReferenceRequestSchema,
  bibleReferenceResponseSchema,
  bibleTranslationsResponseSchema,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_CURSOR_LENGTH,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  resolveReferenceRequestSchema,
  resolveReferenceResponseSchema,
  SEARCH_MODES,
  searchBibleResponseSchema,
} from './bible';
import {
  anchorSelectionSchema,
  captureAnchorResponseSchema,
  resolveAnchorRequestSchema,
  resolveAnchorResponseSchema,
} from './anchor';
import {
  annotationListResponseSchema,
  annotationMutationResponseSchema,
  annotationStateRequestSchema,
  createAnnotationRequestSchema,
  createAnnotationResponseSchema,
  HIGHLIGHT_COLORS,
  MAX_ANNOTATIONS_PER_STUDY,
  MAX_HIGHLIGHT_LABEL_LENGTH,
  updateAnnotationRequestSchema,
} from './annotation';
import { errorEnvelopeSchema } from './error-envelope';
import { healthResponseSchema, livenessResponseSchema } from './health';
import {
  createNoteRequestSchema,
  createNoteResponseSchema,
  MAX_NOTE_CHARACTERS,
  MAX_NOTE_REFERENCES,
  MAX_NOTE_VERSIONS,
  MAX_NOTES_PER_STUDY,
  NOTE_CHECKPOINT_INTERVAL_SECONDS,
  NOTE_LIST_STATES,
  noteListResponseSchema,
  noteMutationResponseSchema,
  noteResponseSchema,
  noteStateRequestSchema,
  noteVersionListResponseSchema,
  noteVersionResponseSchema,
  updateNoteRequestSchema,
} from './note';
import {
  createNodeRequestSchema,
  createNodeResponseSchema,
  MAX_NODE_TEXT_LENGTH,
  MAX_NODES_PER_STUDY,
  nodeListResponseSchema,
  nodeMutationResponseSchema,
  nodeResponseSchema,
  updateNodeRequestSchema,
} from './node';
import { createStudyRequestSchema, createStudyResponseSchema, studyResponseSchema } from './study';
import {
  DEFAULT_LIBRARY_LIMIT,
  LIBRARY_STATES,
  MAX_LIBRARY_CURSOR_LENGTH,
  MAX_LIBRARY_LIMIT,
  MAX_LIBRARY_QUERY_LENGTH,
  STUDY_SORTS,
  studyListResponseSchema,
} from './study-library';
import { updateStudyRequestSchema, updateStudyResponseSchema } from './study-edit';
import { studyLifecycleRequestSchema } from './study-lifecycle';

/** JSON-schema object as emitted by `z.toJSONSchema` (OpenAPI 3.0 target). */
type SchemaObject = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: '3.0.0';
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, SchemaObject>;
    schemas: Record<string, SchemaObject>;
  };
}

/**
 * Converts one Zod schema to an OpenAPI 3.0 schema object with Zod 4's built-in converter.
 * Pure function of the schema: no prototype patching, so it works regardless of which module
 * (main barrel or this subpath) was loaded first.
 */
function toSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  return hoistDefinitions(rest);
}

/**
 * Named recursive schemas (`meta({ id })`, e.g. the note document's `NoteBlock`) come out of the
 * converter as local `definitions` referenced as `#/definitions/<id>`, which an OpenAPI document
 * cannot resolve. They become shared components instead (each id converts identically wherever
 * it appears), and their references point there.
 */
const hoisted: Record<string, SchemaObject> = {};

function hoistDefinitions(converted: SchemaObject): SchemaObject {
  const { definitions, ...rest } = converted as SchemaObject & {
    definitions?: Record<string, SchemaObject>;
  };
  const relink = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value).replaceAll('"#/definitions/', '"#/components/schemas/')) as T;
  for (const [id, definition] of Object.entries(definitions ?? {})) {
    if (id.startsWith('__')) throw new Error(`openapi: name the recursive schema ${id} with meta`);
    hoisted[id] = relink(definition);
  }
  return relink(rest);
}

/**
 * A request body schema as the client sends it (Zod's input side), for schemas whose parsing
 * transforms values (e.g. tag normalization), which have no output-side JSON schema.
 */
function toInputSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  });
  return hoistDefinitions(rest);
}

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

/**
 * Every error from /v1 is the shared envelope (the global exception filter guarantees it), so
 * each operation documents it as its `default` response.
 */
const errorResponse = {
  description: 'Error (shared error envelope, PRD section 24)',
  content: { 'application/json': { schema: ref('ErrorEnvelope') } },
};

const jsonBody = (name: string): Record<string, unknown> => ({
  required: true,
  content: { 'application/json': { schema: ref(name) } },
});

const jsonResponse = (description: string, name: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});

const queryParam = (
  name: string,
  required: boolean,
  schema: SchemaObject,
): Record<string, unknown> => ({ name, in: 'query', required, schema });

/** Routes that require the session cookie declare it; every other route is public. */
const sessionCookie = [{ sessionCookie: [] }];

/** Optional on every mutation (PRD section 24); the web app always sends one. */
const idempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', format: 'uuid' },
};

const studyIdParam = {
  name: 'studyId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const uuidPathParam = (name: string): Record<string, unknown> => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

/** What every note route (BIB-23) shares about ownership. */
const NOTE_OWNERSHIP =
  "Another user's, an absent and a malformed study, note or version id, a note of another study, and a study trashed 30 or more days ago are the same 404.";

/** What every note mutation (BIB-23) shares. */
const NOTE_MUTATION_RULES = `Missing expectedRevision is 428, stale is 409 with currentRevision. The change and its StudyEvent (ids only) commit in one transaction; an archived study is 422 STUDY_ARCHIVED and a trashed one 422 STUDY_TRASHED, with nothing written. Send an Idempotency-Key: a retry with the same key and body replays the original response. ${NOTE_OWNERSHIP}`;

const NODE_OWNERSHIP =
  "Another user's, an absent and a malformed study or node id, a node of another study, and a study trashed 30 or more days ago are the same 404.";

/** What every node mutation (BIB-25) shares. */
const NODE_MUTATION_RULES = `Missing expectedRevision is 428, stale is 409 with currentRevision. The change and its StudyEvent commit in one transaction; an archived study is 422 STUDY_ARCHIVED and a trashed one 422 STUDY_TRASHED, with nothing written. Send an Idempotency-Key: a retry with the same key and body replays the original response. ${NODE_OWNERSHIP}`;

/** The note document rules (NFR-SEC-002), for the routes that take one. */
const NOTE_DOCUMENT_RULES = `content is a Tiptap/ProseMirror document checked against an allowlist: paragraph, heading (level 1-3), bulletList, orderedList (start), listItem, blockquote, text, hardBreak and scriptureReference (referenceId and label, at most ${MAX_NOTE_REFERENCES} per note) nodes; bold, italic and link (href only, http or https, no credentials) marks. A scriptureReference must name a reference of an active edition and carry exactly its canonical label, else 422 NOTE_REFERENCE_INVALID; it never creates a node. Anything else (another node, mark or attribute, HTML, an unsafe link, nesting deeper than 12 levels, more than 20,000 nodes) is 400 and nothing is stored. The server derives the plain text; more than ${MAX_NOTE_CHARACTERS.toLocaleString('en-US')} characters of it is 413 NOTE_TOO_LONG, and a body over 1 MiB is 413.`;

/** What every lifecycle route (BIB-22) shares after its own first sentence. */
const LIFECYCLE_RULES =
  "expectedRevision is the study's revision: missing is 428, stale is 409 with currentRevision. The change bumps the revision (never contentRevision) and appends one StudyEvent in the same transaction. Archive, unarchive and trash of a trashed study are 422 STUDY_TRASHED; any other transition not allowed from the current state is 422 LIFECYCLE_TRANSITION_INVALID. Send an Idempotency-Key: a retry with the same key and body replays the original 200. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.";

/** One lifecycle route (BIB-22): same parameters, body and response, its own description. */
const lifecycleOperation = (description: string): Record<string, unknown> => ({
  description: `${description} ${LIFECYCLE_RULES}`,
  security: sessionCookie,
  parameters: [idempotencyKeyHeader, studyIdParam],
  requestBody: jsonBody('StudyLifecycleRequest'),
  responses: {
    200: jsonResponse('The study in its new state', 'UpdateStudyResponse'),
    default: errorResponse,
  },
});

function buildDocument(): OpenApiDocument {
  return {
    openapi: '3.0.0',
    info: { title: 'Bible Artisan API', version: '0.0.0' },
    servers: [{ url: '/v1' }],
    paths: {
      '/health': {
        get: {
          description:
            'Readiness: the database answers, every shipped migration is applied, and the pinned Bible corpus release is active. Public.',
          responses: {
            200: jsonResponse('Ready', 'HealthResponse'),
            503: jsonResponse(
              'Not ready (database down, migrations pending, or Bible corpus missing or corrupt)',
              'HealthResponse',
            ),
            default: errorResponse,
          },
        },
      },
      '/health/live': {
        get: {
          description: 'Liveness: the process serves HTTP. Never touches the database. Public.',
          responses: {
            200: jsonResponse('Alive', 'LivenessResponse'),
            default: errorResponse,
          },
        },
      },
      '/openapi.json': {
        get: {
          description: 'Returns this OpenAPI document.',
          responses: {
            200: {
              description: 'OpenAPI 3.0 document for /v1',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            default: errorResponse,
          },
        },
      },
      '/auth/otp/start': {
        post: {
          description:
            'Sends a 10-minute email sign-in code. Resend for the same email is allowed after 60 s (429 with Retry-After before that).',
          requestBody: jsonBody('OtpStartRequest'),
          responses: {
            202: jsonResponse('Code sent', 'OtpStartResponse'),
            default: errorResponse,
          },
        },
      },
      '/auth/otp/verify': {
        post: {
          description:
            'Verifies a sign-in code (max 5 attempts, single use), creates or resumes the account, and sets the session cookie.',
          requestBody: jsonBody('OtpVerifyRequest'),
          responses: {
            200: jsonResponse('Signed in; Set-Cookie carries the session', 'MeResponse'),
            default: errorResponse,
          },
        },
      },
      '/auth/logout': {
        post: {
          description: 'Revokes the presented session, if any, and clears the session cookie.',
          responses: {
            204: { description: 'Signed out' },
            default: errorResponse,
          },
        },
      },
      '/me': {
        get: {
          description: 'Returns the signed-in user.',
          security: sessionCookie,
          responses: {
            200: jsonResponse('Current user', 'MeResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/resolve': {
        post: {
          description:
            'Resolves a typed Bible reference against an active edition: a canonical range validated against the imported corpus, book candidates for an ambiguous name, or not_reference. Never returns verse text; an invalid reference is 422, never a nearby verse.',
          security: sessionCookie,
          requestBody: jsonBody('ResolveReferenceRequest'),
          responses: {
            200: jsonResponse('Resolution outcome', 'ResolveReferenceResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/references': {
        post: {
          description:
            'Returns the shared reference for a chapter, or one verse of it, of an active edition, chosen by book code and numbers (no text parsing) and validated against the imported corpus. Without verse it is the whole chapter: the same reference POST /bible/resolve gives for that chapter. A book, chapter or verse the edition lacks is 422 with a reference error code, never a nearby one. Idempotent upsert; never returns verse text.',
          security: sessionCookie,
          requestBody: jsonBody('BibleReferenceRequest'),
          responses: {
            200: jsonResponse('The reference', 'BibleReferenceResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/anchors': {
        post: {
          description:
            "Builds a durable Scripture anchor from a reader selection: edition, book, and per verse a half-open range of Unicode code points into the stored text, plus the quote. The server checks every segment against the imported corpus (consecutive verses, offsets within the text, whole verses for kind verses, contiguous text for kind phrase, quote equal to the stored slices joined by one space) and adds each verse's text_sha256. A mismatch is 422 with an ANCHOR_* code and is never repaired; an unknown or inactive edition is 404. Also returns the shared reference for the covered verses (idempotent upsert). Persists nothing else.",
          security: sessionCookie,
          requestBody: jsonBody('AnchorSelection'),
          responses: {
            200: jsonResponse('The anchor and its reference', 'CaptureAnchorResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/anchors/resolve': {
        post: {
          description:
            'Re-checks a stored anchor against the imported corpus, including every verse checksum. resolved returns the anchor unchanged; unresolved returns it exactly as sent with the first failing reason, and the reference for its verses when they still exist in an active edition, so the reader can reselect. Never moves an anchor to other offsets or verses.',
          security: sessionCookie,
          requestBody: jsonBody('ResolveAnchorRequest'),
          responses: {
            200: jsonResponse('Resolution outcome', 'ResolveAnchorResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/search': {
        get: {
          description:
            'Searches verse text of an active edition. terms: every word must occur (whole words, case-insensitive, no stemming). phrase: the words occur consecutively with matching punctuation. Every result is verified against the stored verse text, which is returned unchanged with code-point highlight ranges. Relevance order, then canonical order; bounded, cursor-paged. A terms query that is a Bible reference with a chapter or verse (or an invalid one) is 422 SEARCH_QUERY_IS_REFERENCE; a terms query that is only a book name, abbreviation or code is searched as keywords and also returns that book as referenceSuggestion.',
          security: sessionCookie,
          parameters: [
            queryParam('q', true, {
              type: 'string',
              minLength: 1,
              maxLength: MAX_SEARCH_QUERY_LENGTH,
            }),
            queryParam('mode', false, {
              type: 'string',
              enum: [...SEARCH_MODES],
              default: 'terms',
            }),
            queryParam('editionId', true, { type: 'string', format: 'uuid' }),
            queryParam('book', false, { type: 'string', pattern: '^[1-4A-Z][A-Z0-9]{2}$' }),
            queryParam('cursor', false, {
              type: 'string',
              maxLength: MAX_SEARCH_CURSOR_LENGTH,
              pattern: '^[A-Za-z0-9_-]+$',
            }),
            queryParam('limit', false, {
              type: 'integer',
              minimum: 1,
              maximum: MAX_SEARCH_LIMIT,
              default: DEFAULT_SEARCH_LIMIT,
            }),
          ],
          responses: {
            200: jsonResponse('One page of verified results', 'SearchBibleResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies': {
        get: {
          description:
            "Lists the signed-in user's own studies (FR-STUDY-004): pinned studies first, then the rest, each group in the chosen sort (recent: last activity, newest first; created: newest first; title: A to Z by the case-folded title in code-point order, whatever the database collation), ties broken by id. pinnedFirst=false lists every study in the chosen sort, pins ignored (Home's recent studies). q matches studies where every word (case- and width-folded, literal: no wildcards or operators) occurs in the title, the description, one of the study's tag names, or the text of one of its live notes; matchedInNotes says a word was found in a note. tag keeps studies carrying that tag; another user's or an absent tag id matches nothing. Keyset pages: nextCursor is non-null exactly when more studies follow; a cursor is opaque and encrypted, works only for the same user, filters, sort and pinnedFirst, and anything else is 400. state=trashed is the Trash view: trashed studies still inside their 30-day recovery window, each with its purgeAt. No totals.",
          security: sessionCookie,
          parameters: [
            queryParam('q', false, {
              type: 'string',
              minLength: 1,
              maxLength: MAX_LIBRARY_QUERY_LENGTH,
            }),
            queryParam('tag', false, { type: 'string', format: 'uuid' }),
            queryParam('state', false, {
              type: 'string',
              enum: [...LIBRARY_STATES],
              default: 'active',
            }),
            queryParam('sort', false, {
              type: 'string',
              enum: [...STUDY_SORTS],
              default: 'recent',
            }),
            queryParam('pinnedFirst', false, { type: 'boolean', default: true }),
            queryParam('cursor', false, {
              type: 'string',
              maxLength: MAX_LIBRARY_CURSOR_LENGTH,
              pattern: '^[A-Za-z0-9_-]+$',
            }),
            queryParam('limit', false, {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIBRARY_LIMIT,
              default: DEFAULT_LIBRARY_LIMIT,
            }),
          ],
          responses: {
            200: jsonResponse("One page of the owner's studies", 'StudyListResponse'),
            default: errorResponse,
          },
        },
        post: {
          description:
            'Creates a study for the signed-in user in one transaction: the study (revision 1, content revision 1), a Scripture root node for startingReferenceId, a Question node for question, the initial branch (rooted at the question, else the passage), and one study_created event (sequence 1). Needs a question or a starting reference, or blank: true for an untitled empty study. The title, when omitted, is derived from the reference label, else the question. No expectedRevision (nothing exists yet). Send an Idempotency-Key: a retry with the same key and body replays the original 201 (Idempotent-Replayed: true) and never creates a second study; the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED. An unknown reference, or one whose edition is not active, is 422 REFERENCE_NOT_FOUND and nothing is written.',
          security: sessionCookie,
          parameters: [idempotencyKeyHeader],
          requestBody: jsonBody('CreateStudyRequest'),
          responses: {
            201: jsonResponse('The created study', 'CreateStudyResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}': {
        get: {
          description:
            "Returns one of the signed-in user's studies: title, description, lifecycle, pin, revisions, starting reference, main and original questions, tags, initial branch, and purgeAt for a trashed study. Archived and trashed studies stay readable by their owner. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.",
          security: sessionCookie,
          parameters: [
            {
              name: 'studyId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            200: jsonResponse('The study', 'StudyResponse'),
            default: errorResponse,
          },
        },
        patch: {
          description:
            "Edits one of the signed-in user's studies (FR-STUDY-003): title, description (null clears it), main question ({text} creates a new open Question node and makes it main; {nodeId} makes an existing live Question node of the study main), pin, and tags as deltas (tags.add: names, reusing the owner's tag with the same normalized key; tags.remove: ids of the study's tags; an item that is already applied is a no-op, and a tag no study uses any more is deleted). The original question is never rewritten; a study that had none gets the first main question as its original. expectedRevision is the study's revision and covers every field: missing is 428, stale is 409 with currentRevision. One StudyEvent per real change (study_renamed, study_description_changed, question_created, main_question_changed, study_pinned/study_unpinned, study_tags_changed; ids only) commits with the edit; contentRevision moves only for title, description or main question changes. An edit that changes nothing is 422 STUDY_UNCHANGED; more than 20 tags after applying the change is 422 TAG_LIMIT_EXCEEDED; a nodeId that is not a live question of this study is 422 QUESTION_NOT_FOUND. An archived study is 422 STUDY_ARCHIVED and a trashed one 422 STUDY_TRASHED, with nothing written. Send an Idempotency-Key: a retry with the same key and body replays the original 200. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.",
          security: sessionCookie,
          parameters: [
            idempotencyKeyHeader,
            {
              name: 'studyId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: jsonBody('UpdateStudyRequest'),
          responses: {
            200: jsonResponse('The study as edited', 'UpdateStudyResponse'),
            default: errorResponse,
          },
        },
        delete: lifecycleOperation(
          'Moves an active or archived study to the trash (FR-STUDY-006) with everything in it; nothing is deleted yet. It stays readable and restorable for 30 days (purgeAt), then reads as absent and is permanently deleted. study_trashed.',
        ),
      },
      '/studies/{studyId}/archive': {
        post: lifecycleOperation(
          'Archives an active study (FR-STUDY-005): it leaves the active library, stays readable and listed under state=archived, and every other change is 422 STUDY_ARCHIVED until it is unarchived. study_archived.',
        ),
      },
      '/studies/{studyId}/unarchive': {
        post: lifecycleOperation(
          'Makes an archived study active and editable again. study_unarchived.',
        ),
      },
      '/studies/{studyId}/restore': {
        post: lifecycleOperation(
          'Restores a trashed study inside its recovery window to the state it was trashed from (archived if it was archived, else active), with its nodes, events and branches intact. study_restored.',
        ),
      },
      '/studies/{studyId}/notes': {
        post: {
          description: `Creates a note on the study, on one of its live nodes (targetNodeId; anything else is 422 NOTE_TARGET_NOT_FOUND), or on a Scripture range or phrase (targetAnchor, from POST /bible/anchors, re-checked against the corpus: a mismatch is 422 with the ANCHOR_* code; not together with targetNodeId), with version 1 (FR-NOTE-001). Creating a note is a study change: expectedRevision is the study's revision, which the creation bumps (studyRevision in the response); contentRevision moves. note_created. At most ${MAX_NOTES_PER_STUDY.toLocaleString('en-US')} live notes per study (422 NOTE_LIMIT_EXCEEDED); notes in the note trash do not count. The response carries no content. ${NOTE_DOCUMENT_RULES} ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam],
          requestBody: jsonBody('CreateNoteRequest'),
          responses: {
            201: jsonResponse('The new note, without its content', 'CreateNoteResponse'),
            default: errorResponse,
          },
        },
        get: {
          description: `Lists the study's notes, most recently updated first: state=active (default) the live notes, state=trashed the note trash (its ${MAX_NOTES_PER_STUDY.toLocaleString('en-US')} most recently trashed notes). Each has a plain-text preview and its target node (deleted: true marks a note whose node was deleted, kept for orphaned-note review, FR-NOTE-002). Archived and trashed studies stay readable. ${NOTE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [
            studyIdParam,
            queryParam('state', false, { type: 'string', enum: [...NOTE_LIST_STATES] }),
          ],
          responses: {
            200: jsonResponse("The study's notes", 'NoteListResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/notes/{noteId}': {
        get: {
          description: `Returns one note with its content and target, live or in the note trash. ${NOTE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [studyIdParam, uuidPathParam('noteId')],
          responses: {
            200: jsonResponse('The note', 'NoteResponse'),
            default: errorResponse,
          },
        },
        patch: {
          description: `Saves new content (an autosave) and/or a checkpoint. expectedRevision is the note's. A version is written for checkpoint: true, or when the content changed and the newest version is at least ${NOTE_CHECKPOINT_INTERVAL_SECONDS} seconds old by the database clock, never as a copy of the newest version; only the newest ${MAX_NOTE_VERSIONS} versions are kept. contentRevision moves only when a version is written. note_autosaved {noteId, versionId}. Nothing to change is 422 NOTE_UNCHANGED; a note in the trash is 422 NOTE_TRASHED. The response carries no content. ${NOTE_DOCUMENT_RULES} ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('noteId')],
          requestBody: jsonBody('UpdateNoteRequest'),
          responses: {
            200: jsonResponse('The note as saved, without its content', 'NoteMutationResponse'),
            default: errorResponse,
          },
        },
        delete: {
          description: `Moves the note to the note trash (reversible with restore); it stays readable. A note already in the trash is 422 NOTE_TRASHED. note_trashed. ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('noteId')],
          requestBody: jsonBody('NoteStateRequest'),
          responses: {
            200: jsonResponse('The note in the trash', 'NoteMutationResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/notes/{noteId}/restore': {
        post: {
          description: `Restores a note from the note trash with its content and versions. A live note is 422 NOTE_NOT_TRASHED; when the study already has ${MAX_NOTES_PER_STUDY.toLocaleString('en-US')} live notes, 422 NOTE_LIMIT_EXCEEDED. note_restored. ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('noteId')],
          requestBody: jsonBody('NoteStateRequest'),
          responses: {
            200: jsonResponse('The restored note', 'NoteMutationResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/notes/{noteId}/versions': {
        get: {
          description: `Lists the note's kept versions, newest first, with previews. ${NOTE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [studyIdParam, uuidPathParam('noteId')],
          responses: {
            200: jsonResponse('The versions', 'NoteVersionListResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/notes/{noteId}/versions/{versionId}': {
        get: {
          description: `Returns one version of the note with its content. Restoring it is a PATCH of that content with checkpoint: true. ${NOTE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [studyIdParam, uuidPathParam('noteId'), uuidPathParam('versionId')],
          responses: {
            200: jsonResponse('The version', 'NoteVersionResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/annotations': {
        post: {
          description: `Saves a highlight (FR-BIBLE-006): an anchor from POST /bible/anchors, re-checked against the stored corpus text (checksums, offsets and quote; a mismatch is 422 with the ANCHOR_* code, never adjusted) and stored unchanged, bound to its edition. colorToken is one of ${HIGHLIGHT_COLORS.join(', ')}; label is optional (at most ${MAX_HIGHLIGHT_LABEL_LENGTH} characters, trimmed; empty means none). Creating a highlight is a study change: expectedRevision is the study's revision (studyRevision in the response); contentRevision moves. highlight_created {annotationId, referenceId, colorToken}. At most ${MAX_ANNOTATIONS_PER_STUDY.toLocaleString('en-US')} live highlights per study (422 ANNOTATION_LIMIT_EXCEEDED). The response carries no anchor or label. ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam],
          requestBody: jsonBody('CreateAnnotationRequest'),
          responses: {
            201: jsonResponse(
              'The new highlight, without its anchor or label',
              'CreateAnnotationResponse',
            ),
            default: errorResponse,
          },
        },
        get: {
          description: `Lists the study's highlights on the chapter the reader shows for referenceId (its first chapter), in that reference's edition and book, oldest first. Each anchor is re-checked against the corpus on this read: resolved, or unresolved with the reason and the anchor exactly as stored (never moved). An unknown reference is 404. Archived and trashed studies stay readable. ${NOTE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [
            studyIdParam,
            queryParam('referenceId', true, { type: 'string', format: 'uuid' }),
          ],
          responses: {
            200: jsonResponse('The highlights', 'AnnotationListResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/annotations/{annotationId}': {
        patch: {
          description: `Changes a highlight's color and/or label. expectedRevision is the highlight's. contentRevision does not move (PRD section 17). highlight_updated {annotationId, colorToken}. Nothing to change is 422 ANNOTATION_UNCHANGED. ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('annotationId')],
          requestBody: jsonBody('UpdateAnnotationRequest'),
          responses: {
            200: jsonResponse('The highlight as saved', 'AnnotationMutationResponse'),
            default: errorResponse,
          },
        },
        delete: {
          description: `Deletes a highlight; it is then absent (404). expectedRevision is the highlight's. contentRevision moves. highlight_deleted {annotationId}. ${NOTE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('annotationId')],
          requestBody: jsonBody('AnnotationStateRequest'),
          responses: {
            200: jsonResponse('The deleted highlight', 'AnnotationMutationResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/nodes': {
        post: {
          description: `Creates a typed graph node (FR-GRAPH-001): scripture {referenceId} (from POST /bible/resolve; unknown or in an inactive edition is 422 REFERENCE_NOT_FOUND, never another passage; a live Scripture node with the same reference in the study is 422 SCRIPTURE_NODE_EXISTS), question {text} (status open), observation {text, observationKind}, thought {text}, conclusion {text} (status tentative) or source {source} (a manual citation: title, kind, optional author, workTitle, publicationDetails, an http/https url that is stored and never fetched, locator, excerpt with excerptKind; a url or a locator is required). Statements are at most 4,000 characters, observation and thought text ${MAX_NODE_TEXT_LENGTH.toLocaleString('en-US')}. The server sets origin (scripture, external for a source, else user); a client cannot send origin, status or any other field (400). Creating a node is a study change: expectedRevision is the study's revision (studyRevision in the response); contentRevision moves. One event: scripture_added_to_graph, question_created, observation_created, thought_created, conclusion_created or source_created (ids and enums only). At most ${MAX_NODES_PER_STUDY.toLocaleString('en-US')} live nodes per study (422 NODE_LIMIT_EXCEEDED). The response carries no text. ${NODE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam],
          requestBody: jsonBody('CreateNodeRequest'),
          responses: {
            201: jsonResponse('The new node, without its text', 'CreateNodeResponse'),
            default: errorResponse,
          },
        },
        get: {
          description: `Lists the study's live nodes, oldest first, each with its type, origin, status or observation kind and a label (at most 160 characters of its statement, text or source title; a Scripture node's reference label). Archived and trashed studies stay readable. ${NODE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [studyIdParam],
          responses: {
            200: jsonResponse("The study's nodes", 'NodeListResponse'),
            default: errorResponse,
          },
        },
      },
      '/studies/{studyId}/nodes/{nodeId}': {
        get: {
          description: `Returns one live node with its full typed content: a Scripture node's reference (never verse text), a statement or text with its status or kind, or a source citation. ${NODE_OWNERSHIP}`,
          security: sessionCookie,
          parameters: [studyIdParam, uuidPathParam('nodeId')],
          responses: {
            200: jsonResponse('The node', 'NodeResponse'),
            default: errorResponse,
          },
        },
        patch: {
          description: `Edits an observation (text and/or observationKind), a thought (text) or a source (source, replaced whole). expectedRevision is the node's. A node's type never changes (type is not accepted, 400). Editing a question, conclusion or Scripture node, or a field of another type, is 422 NODE_NOT_EDITABLE; nothing to change is 422 NODE_UNCHANGED. contentRevision moves. One event: observation_updated, thought_updated or source_updated (ids and enums only). The response carries no text. ${NODE_MUTATION_RULES}`,
          security: sessionCookie,
          parameters: [idempotencyKeyHeader, studyIdParam, uuidPathParam('nodeId')],
          requestBody: jsonBody('UpdateNodeRequest'),
          responses: {
            200: jsonResponse('The node as saved, without its text', 'NodeMutationResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/translations': {
        get: {
          description:
            "Lists the active Bible editions with their attribution and books (canon order, chapter counts), for the reader's translation and book/chapter selectors.",
          security: sessionCookie,
          responses: {
            200: jsonResponse('Active editions', 'BibleTranslationsResponse'),
            default: errorResponse,
          },
        },
      },
      '/bible/passages': {
        get: {
          description:
            "Returns one chapter of an active edition, the reading context: every verse exactly as stored (a verse the edition gives no text for has empty text), the publisher's superscriptions separately, the edition attribution, and the neighboring chapters across books, each with its whole-chapter referenceId. The chapter is the one holding the reference's start, and the reference fixes the edition (reach a chapter or verse with POST /bible/resolve or POST /bible/references first), so only opaque IDs travel in the URL. editionId is optional; an unknown reference, or an editionId that is not the reference's edition, is 404.",
          security: sessionCookie,
          parameters: [
            queryParam('referenceId', true, { type: 'string', format: 'uuid' }),
            queryParam('editionId', false, { type: 'string', format: 'uuid' }),
          ],
          responses: {
            200: jsonResponse('One chapter', 'BiblePassageResponse'),
            default: errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ba_session' },
      },
      schemas: {
        HealthResponse: toSchema(healthResponseSchema),
        LivenessResponse: toSchema(livenessResponseSchema),
        ErrorEnvelope: toSchema(errorEnvelopeSchema),
        OtpStartRequest: toSchema(otpStartRequestSchema),
        OtpStartResponse: toSchema(otpStartResponseSchema),
        OtpVerifyRequest: toSchema(otpVerifyRequestSchema),
        MeResponse: toSchema(meResponseSchema),
        ResolveReferenceRequest: toSchema(resolveReferenceRequestSchema),
        ResolveReferenceResponse: toSchema(resolveReferenceResponseSchema),
        SearchBibleResponse: toSchema(searchBibleResponseSchema),
        BibleTranslationsResponse: toSchema(bibleTranslationsResponseSchema),
        BiblePassageResponse: toSchema(biblePassageResponseSchema),
        BibleReferenceRequest: toSchema(bibleReferenceRequestSchema),
        BibleReferenceResponse: toSchema(bibleReferenceResponseSchema),
        AnchorSelection: toSchema(anchorSelectionSchema),
        CaptureAnchorResponse: toSchema(captureAnchorResponseSchema),
        ResolveAnchorRequest: toSchema(resolveAnchorRequestSchema),
        ResolveAnchorResponse: toSchema(resolveAnchorResponseSchema),
        CreateStudyRequest: toSchema(createStudyRequestSchema),
        CreateStudyResponse: toSchema(createStudyResponseSchema),
        StudyResponse: toSchema(studyResponseSchema),
        StudyListResponse: toSchema(studyListResponseSchema),
        UpdateStudyRequest: toInputSchema(updateStudyRequestSchema),
        UpdateStudyResponse: toSchema(updateStudyResponseSchema),
        StudyLifecycleRequest: toSchema(studyLifecycleRequestSchema),
        CreateNoteRequest: toSchema(createNoteRequestSchema),
        CreateNoteResponse: toSchema(createNoteResponseSchema),
        UpdateNoteRequest: toSchema(updateNoteRequestSchema),
        NoteStateRequest: toSchema(noteStateRequestSchema),
        NoteMutationResponse: toSchema(noteMutationResponseSchema),
        NoteResponse: toSchema(noteResponseSchema),
        NoteListResponse: toSchema(noteListResponseSchema),
        NoteVersionListResponse: toSchema(noteVersionListResponseSchema),
        NoteVersionResponse: toSchema(noteVersionResponseSchema),
        CreateAnnotationRequest: toInputSchema(createAnnotationRequestSchema),
        CreateAnnotationResponse: toSchema(createAnnotationResponseSchema),
        UpdateAnnotationRequest: toInputSchema(updateAnnotationRequestSchema),
        AnnotationStateRequest: toSchema(annotationStateRequestSchema),
        AnnotationMutationResponse: toSchema(annotationMutationResponseSchema),
        AnnotationListResponse: toSchema(annotationListResponseSchema),
        CreateNodeRequest: toInputSchema(createNodeRequestSchema),
        CreateNodeResponse: toSchema(createNodeResponseSchema),
        UpdateNodeRequest: toInputSchema(updateNodeRequestSchema),
        NodeMutationResponse: toSchema(nodeMutationResponseSchema),
        NodeListResponse: toSchema(nodeListResponseSchema),
        NodeResponse: toSchema(nodeResponseSchema),
        // Filled while the entries above were converted.
        ...hoisted,
      },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

let cached: OpenApiDocument | undefined;

/**
 * OpenAPI generation for /v1, built directly from the shared Zod schemas. Kept out of the main
 * barrel (`@bible-artisan/contracts`) so apps/web never bundles it; only apps/api imports this
 * subpath (`@bible-artisan/contracts/openapi`). The schemas are static, so the document is built
 * once on first use and the same deep-frozen object is returned afterwards.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  cached ??= deepFreeze(buildDocument());
  return cached;
}
