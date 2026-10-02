import { describe, expect, it, vi } from 'vitest';
import { buildOpenApiDocument } from './openapi';

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

describe('buildOpenApiDocument', () => {
  it('documents every path with its success response and the ErrorEnvelope as default', () => {
    const errorResponse = {
      description: 'Error (shared error envelope, PRD section 24)',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
    const uuidParam = (name: string, where = 'path') => ({
      name,
      in: where,
      required: where === 'path',
      schema: { type: 'string', format: 'uuid' },
    });
    const idempotencyHeader = {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string', format: 'uuid' },
    };
    const studyId = uuidParam('studyId');
    const noteId = uuidParam('noteId');
    const json = (name: string) => ({ 'application/json': { schema: ref(name) } });
    /** BIB-23: a note operation, its description checked by the rules it must state. */
    const noteOperation = (
      phrases: string[],
      parameters: unknown[],
      status: number,
      description: string,
      response: string,
      request?: string,
    ): Record<string, unknown> => ({
      description: expect.stringMatching(
        new RegExp(phrases.map((phrase) => `(?=[\\s\\S]*${phrase})`).join('')),
      ),
      security: [{ sessionCookie: [] }],
      parameters,
      ...(request ? { requestBody: { required: true, content: json(request) } } : {}),
      responses: {
        [status]: { description, content: json(response) },
        default: errorResponse,
      },
    });
    const SAME_404 = 'are the same 404';
    const MUTATION = [
      '428',
      '409 with currentRevision',
      'STUDY_ARCHIVED',
      'Idempotency-Key',
      SAME_404,
    ];
    const DOCUMENT = ['allowlist', 'http or https', '413 NOTE_TOO_LONG', '1 MiB is 413'];
    // BIB-22: the four lifecycle routes share everything but the first sentences.
    const lifecycle = (description: string): Record<string, unknown> => ({
      description: `${description} expectedRevision is the study's revision: missing is 428, stale is 409 with currentRevision. The change bumps the revision (never contentRevision) and appends one StudyEvent in the same transaction. Archive, unarchive and trash of a trashed study are 422 STUDY_TRASHED; any other transition not allowed from the current state is 422 LIFECYCLE_TRANSITION_INVALID. Send an Idempotency-Key: a retry with the same key and body replays the original 200. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.`,
      security: [{ sessionCookie: [] }],
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', format: 'uuid' },
        },
        { name: 'studyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('StudyLifecycleRequest') } },
      },
      responses: {
        200: {
          description: 'The study in its new state',
          content: { 'application/json': { schema: ref('UpdateStudyResponse') } },
        },
        default: errorResponse,
      },
    });
    const doc = buildOpenApiDocument();
    expect({ openapi: doc.openapi, servers: doc.servers, paths: doc.paths }).toStrictEqual({
      openapi: '3.0.0',
      servers: [{ url: '/v1' }],
      paths: {
        '/health': {
          get: {
            description:
              'Readiness: the database answers, every shipped migration is applied, and the pinned Bible corpus release is active. Public.',
            responses: {
              200: {
                description: 'Ready',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
                },
              },
              503: {
                description:
                  'Not ready (database down, migrations pending, or Bible corpus missing or corrupt)',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
                },
              },
              default: errorResponse,
            },
          },
        },
        '/health/live': {
          get: {
            description: 'Liveness: the process serves HTTP. Never touches the database. Public.',
            responses: {
              200: {
                description: 'Alive',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/LivenessResponse' },
                  },
                },
              },
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
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('OtpStartRequest') } },
            },
            responses: {
              202: {
                description: 'Code sent',
                content: { 'application/json': { schema: ref('OtpStartResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/auth/otp/verify': {
          post: {
            description:
              'Verifies a sign-in code (max 5 attempts, single use), creates or resumes the account, and sets the session cookie.',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('OtpVerifyRequest') } },
            },
            responses: {
              200: {
                description: 'Signed in; Set-Cookie carries the session',
                content: { 'application/json': { schema: ref('MeResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/auth/logout': {
          post: {
            description: 'Revokes the presented session, if any, and clears the session cookie.',
            responses: { 204: { description: 'Signed out' }, default: errorResponse },
          },
        },
        '/me': {
          get: {
            description: 'Returns the signed-in user.',
            security: [{ sessionCookie: [] }],
            responses: {
              200: {
                description: 'Current user',
                content: { 'application/json': { schema: ref('MeResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/resolve': {
          post: {
            description:
              'Resolves a typed Bible reference against an active edition: a canonical range validated against the imported corpus, book candidates for an ambiguous name, or not_reference. Never returns verse text; an invalid reference is 422, never a nearby verse.',
            security: [{ sessionCookie: [] }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('ResolveReferenceRequest') } },
            },
            responses: {
              200: {
                description: 'Resolution outcome',
                content: { 'application/json': { schema: ref('ResolveReferenceResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/references': {
          post: {
            description:
              'Returns the shared reference for a chapter, or one verse of it, of an active edition, chosen by book code and numbers (no text parsing) and validated against the imported corpus. Without verse it is the whole chapter: the same reference POST /bible/resolve gives for that chapter. A book, chapter or verse the edition lacks is 422 with a reference error code, never a nearby one. Idempotent upsert; never returns verse text.',
            security: [{ sessionCookie: [] }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('BibleReferenceRequest') } },
            },
            responses: {
              200: {
                description: 'The reference',
                content: { 'application/json': { schema: ref('BibleReferenceResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/anchors': {
          post: {
            description:
              "Builds a durable Scripture anchor from a reader selection: edition, book, and per verse a half-open range of Unicode code points into the stored text, plus the quote. The server checks every segment against the imported corpus (consecutive verses, offsets within the text, whole verses for kind verses, contiguous text for kind phrase, quote equal to the stored slices joined by one space) and adds each verse's text_sha256. A mismatch is 422 with an ANCHOR_* code and is never repaired; an unknown or inactive edition is 404. Also returns the shared reference for the covered verses (idempotent upsert). Persists nothing else.",
            security: [{ sessionCookie: [] }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('AnchorSelection') } },
            },
            responses: {
              200: {
                description: 'The anchor and its reference',
                content: { 'application/json': { schema: ref('CaptureAnchorResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/anchors/resolve': {
          post: {
            description:
              'Re-checks a stored anchor against the imported corpus, including every verse checksum. resolved returns the anchor unchanged; unresolved returns it exactly as sent with the first failing reason, and the reference for its verses when they still exist in an active edition, so the reader can reselect. Never moves an anchor to other offsets or verses.',
            security: [{ sessionCookie: [] }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('ResolveAnchorRequest') } },
            },
            responses: {
              200: {
                description: 'Resolution outcome',
                content: { 'application/json': { schema: ref('ResolveAnchorResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/search': {
          get: {
            description:
              'Searches verse text of an active edition. terms: every word must occur (whole words, case-insensitive, no stemming). phrase: the words occur consecutively with matching punctuation. Every result is verified against the stored verse text, which is returned unchanged with code-point highlight ranges. Relevance order, then canonical order; bounded, cursor-paged. A terms query that is a Bible reference with a chapter or verse (or an invalid one) is 422 SEARCH_QUERY_IS_REFERENCE; a terms query that is only a book name, abbreviation or code is searched as keywords and also returns that book as referenceSuggestion.',
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'q',
                in: 'query',
                required: true,
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              {
                name: 'mode',
                in: 'query',
                required: false,
                schema: { type: 'string', enum: ['terms', 'phrase'], default: 'terms' },
              },
              {
                name: 'editionId',
                in: 'query',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
              {
                name: 'book',
                in: 'query',
                required: false,
                schema: { type: 'string', pattern: '^[1-4A-Z][A-Z0-9]{2}$' },
              },
              {
                name: 'cursor',
                in: 'query',
                required: false,
                schema: { type: 'string', maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' },
              },
              {
                name: 'limit',
                in: 'query',
                required: false,
                schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
              },
            ],
            responses: {
              200: {
                description: 'One page of verified results',
                content: { 'application/json': { schema: ref('SearchBibleResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/studies': {
          get: {
            description:
              "Lists the signed-in user's own studies (FR-STUDY-004): pinned studies first, then the rest, each group in the chosen sort (recent: last activity, newest first; created: newest first; title: A to Z by the case-folded title in code-point order, whatever the database collation), ties broken by id. pinnedFirst=false lists every study in the chosen sort, pins ignored (Home's recent studies). q matches studies where every word (case- and width-folded, literal: no wildcards or operators) occurs in the title, the description, one of the study's tag names, or the text of one of its live notes; matchedInNotes says a word was found in a note. tag keeps studies carrying that tag; another user's or an absent tag id matches nothing. Keyset pages: nextCursor is non-null exactly when more studies follow; a cursor is opaque and encrypted, works only for the same user, filters, sort and pinnedFirst, and anything else is 400. state=trashed is the Trash view: trashed studies still inside their 30-day recovery window, each with its purgeAt. No totals.",
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'q',
                in: 'query',
                required: false,
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              {
                name: 'tag',
                in: 'query',
                required: false,
                schema: { type: 'string', format: 'uuid' },
              },
              {
                name: 'state',
                in: 'query',
                required: false,
                schema: {
                  type: 'string',
                  enum: ['active', 'archived', 'trashed'],
                  default: 'active',
                },
              },
              {
                name: 'sort',
                in: 'query',
                required: false,
                schema: { type: 'string', enum: ['recent', 'created', 'title'], default: 'recent' },
              },
              {
                name: 'pinnedFirst',
                in: 'query',
                required: false,
                schema: { type: 'boolean', default: true },
              },
              {
                name: 'cursor',
                in: 'query',
                required: false,
                schema: { type: 'string', maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' },
              },
              {
                name: 'limit',
                in: 'query',
                required: false,
                schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
              },
            ],
            responses: {
              200: {
                description: "One page of the owner's studies",
                content: { 'application/json': { schema: ref('StudyListResponse') } },
              },
              default: errorResponse,
            },
          },
          post: {
            description:
              'Creates a study for the signed-in user in one transaction: the study (revision 1, content revision 1), a Scripture root node for startingReferenceId, a Question node for question, the initial branch (rooted at the question, else the passage), and one study_created event (sequence 1). Needs a question or a starting reference, or blank: true for an untitled empty study. The title, when omitted, is derived from the reference label, else the question. No expectedRevision (nothing exists yet). Send an Idempotency-Key: a retry with the same key and body replays the original 201 (Idempotent-Replayed: true) and never creates a second study; the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED. An unknown reference, or one whose edition is not active, is 422 REFERENCE_NOT_FOUND and nothing is written.',
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('CreateStudyRequest') } },
            },
            responses: {
              201: {
                description: 'The created study',
                content: { 'application/json': { schema: ref('CreateStudyResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/studies/{studyId}': {
          get: {
            description:
              "Returns one of the signed-in user's studies: title, description, lifecycle, pin, revisions, starting reference, main and original questions, tags, initial branch, and purgeAt for a trashed study. Archived and trashed studies stay readable by their owner. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.",
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'studyId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              200: {
                description: 'The study',
                content: { 'application/json': { schema: ref('StudyResponse') } },
              },
              default: errorResponse,
            },
          },
          patch: {
            description:
              "Edits one of the signed-in user's studies (FR-STUDY-003): title, description (null clears it), main question ({text} creates a new open Question node and makes it main; {nodeId} makes an existing live Question node of the study main), pin, and tags as deltas (tags.add: names, reusing the owner's tag with the same normalized key; tags.remove: ids of the study's tags; an item that is already applied is a no-op, and a tag no study uses any more is deleted). The original question is never rewritten; a study that had none gets the first main question as its original. A new Question node counts toward the 2,000 live-node cap (422 NODE_LIMIT_EXCEEDED), and a study without a branch gets its initial branch, rooted at its first question, on any main question change. expectedRevision is the study's revision and covers every field: missing is 428, stale is 409 with currentRevision. One StudyEvent per real change (study_renamed, study_description_changed, question_created, main_question_changed, study_pinned/study_unpinned, study_tags_changed; ids only) commits with the edit; contentRevision moves only for title, description or main question changes. An edit that changes nothing is 422 STUDY_UNCHANGED; more than 20 tags after applying the change is 422 TAG_LIMIT_EXCEEDED; a nodeId that is not a live question of this study is 422 QUESTION_NOT_FOUND. An archived study is 422 STUDY_ARCHIVED and a trashed one 422 STUDY_TRASHED, with nothing written. Send an Idempotency-Key: a retry with the same key and body replays the original 200. Another user's, an absent, a malformed id, and a study trashed 30 or more days ago are the same 404.",
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                schema: { type: 'string', format: 'uuid' },
              },
              {
                name: 'studyId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref('UpdateStudyRequest') } },
            },
            responses: {
              200: {
                description: 'The study as edited',
                content: { 'application/json': { schema: ref('UpdateStudyResponse') } },
              },
              default: errorResponse,
            },
          },
          delete: lifecycle(
            'Moves an active or archived study to the trash (FR-STUDY-006) with everything in it; nothing is deleted yet. It stays readable and restorable for 30 days (purgeAt), then reads as absent and is permanently deleted. study_trashed.',
          ),
        },
        '/studies/{studyId}/archive': {
          post: lifecycle(
            'Archives an active study (FR-STUDY-005): it leaves the active library, stays readable and listed under state=archived, and every other change is 422 STUDY_ARCHIVED until it is unarchived. study_archived.',
          ),
        },
        '/studies/{studyId}/unarchive': {
          post: lifecycle('Makes an archived study active and editable again. study_unarchived.'),
        },
        '/studies/{studyId}/restore': {
          post: lifecycle(
            'Restores a trashed study inside its recovery window to the state it was trashed from (archived if it was archived, else active), with its nodes, events and branches intact. study_restored.',
          ),
        },
        '/studies/{studyId}/notes': {
          post: noteOperation(
            [
              'NOTE_TARGET_NOT_FOUND',
              'NOTE_LIMIT_EXCEEDED',
              'live notes',
              'note_created',
              ...DOCUMENT,
              ...MUTATION,
            ],
            [idempotencyHeader, studyId],
            201,
            'The new note, without its content',
            'CreateNoteResponse',
            'CreateNoteRequest',
          ),
          get: noteOperation(
            ['state=trashed', 'orphaned-note review', SAME_404],
            [
              studyId,
              {
                name: 'state',
                in: 'query',
                required: false,
                schema: { type: 'string', enum: ['active', 'trashed'] },
              },
            ],
            200,
            "The study's notes",
            'NoteListResponse',
          ),
        },
        '/studies/{studyId}/notes/{noteId}': {
          get: noteOperation([SAME_404], [studyId, noteId], 200, 'The note', 'NoteResponse'),
          patch: noteOperation(
            [
              'checkpoint: true',
              '30 seconds',
              'database clock',
              'newest 100',
              'NOTE_UNCHANGED',
              'NOTE_TRASHED',
              ...DOCUMENT,
              ...MUTATION,
            ],
            [idempotencyHeader, studyId, noteId],
            200,
            'The note as saved, without its content',
            'NoteMutationResponse',
            'UpdateNoteRequest',
          ),
          delete: noteOperation(
            ['note trash', 'note_trashed', ...MUTATION],
            [idempotencyHeader, studyId, noteId],
            200,
            'The note in the trash',
            'NoteMutationResponse',
            'NoteStateRequest',
          ),
        },
        '/studies/{studyId}/notes/{noteId}/restore': {
          post: noteOperation(
            ['NOTE_NOT_TRASHED', 'NOTE_LIMIT_EXCEEDED', 'note_restored', ...MUTATION],
            [idempotencyHeader, studyId, noteId],
            200,
            'The restored note',
            'NoteMutationResponse',
            'NoteStateRequest',
          ),
        },
        '/studies/{studyId}/notes/{noteId}/versions': {
          get: noteOperation(
            ['newest first', SAME_404],
            [studyId, noteId],
            200,
            'The versions',
            'NoteVersionListResponse',
          ),
        },
        '/studies/{studyId}/notes/{noteId}/versions/{versionId}': {
          get: noteOperation(
            ['checkpoint: true', SAME_404],
            [studyId, noteId, uuidParam('versionId')],
            200,
            'The version',
            'NoteVersionResponse',
          ),
        },
        '/studies/{studyId}/annotations': {
          post: noteOperation(
            [
              'ANCHOR_\\* code',
              'never adjusted',
              'yellow, green, blue, pink',
              'highlight_created',
              'ANNOTATION_LIMIT_EXCEEDED',
              'no anchor or label',
              ...MUTATION,
            ],
            [idempotencyHeader, studyId],
            201,
            'The new highlight, without its anchor or label',
            'CreateAnnotationResponse',
            'CreateAnnotationRequest',
          ),
          get: noteOperation(
            ['first chapter', 'unresolved', 'never moved', SAME_404],
            [
              studyId,
              {
                name: 'referenceId',
                in: 'query',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            200,
            'The highlights',
            'AnnotationListResponse',
          ),
        },
        '/studies/{studyId}/annotations/{annotationId}': {
          patch: noteOperation(
            [
              'contentRevision does not move',
              'highlight_updated',
              'ANNOTATION_UNCHANGED',
              ...MUTATION,
            ],
            [idempotencyHeader, studyId, uuidParam('annotationId')],
            200,
            'The highlight as saved',
            'AnnotationMutationResponse',
            'UpdateAnnotationRequest',
          ),
          delete: noteOperation(
            ['contentRevision moves', 'highlight_deleted', ...MUTATION],
            [idempotencyHeader, studyId, uuidParam('annotationId')],
            200,
            'The deleted highlight',
            'AnnotationMutationResponse',
            'AnnotationStateRequest',
          ),
        },
        '/studies/{studyId}/nodes': {
          post: {
            ...noteOperation(
              [
                'REFERENCE_NOT_FOUND',
                'focused_existing',
                'contentRevision unchanged',
                'scripture_revisited',
                'explicit_duplicate',
                'canonicalNodeId',
                'never fetched',
                'The server sets origin',
                'scripture_added_to_graph',
                'NODE_LIMIT_EXCEEDED',
                'The response carries no text',
                ...MUTATION,
              ],
              [idempotencyHeader, studyId],
              201,
              'The new node, without its text',
              'CreateNodeResponse',
              'CreateNodeRequest',
            ),
            responses: {
              200: {
                description:
                  'focused_existing: the existing canonical Scripture node, without its text',
                content: json('CreateNodeResponse'),
              },
              201: {
                description: 'The new node, without its text',
                content: json('CreateNodeResponse'),
              },
              default: errorResponse,
            },
          },
          get: noteOperation(
            ['oldest first', '160 characters', SAME_404],
            [studyId],
            200,
            "The study's nodes",
            'NodeListResponse',
          ),
        },
        '/studies/{studyId}/nodes/{nodeId}': {
          get: noteOperation(
            ['never verse text', SAME_404],
            [studyId, uuidParam('nodeId')],
            200,
            'The node',
            'NodeResponse',
          ),
          patch: noteOperation(
            [
              'type never changes',
              'NODE_NOT_EDITABLE',
              'NODE_UNCHANGED',
              'observation_updated',
              ...MUTATION,
            ],
            [idempotencyHeader, studyId, uuidParam('nodeId')],
            200,
            'The node as saved, without its text',
            'NodeMutationResponse',
            'UpdateNodeRequest',
          ),
        },
        '/studies/{studyId}/edges': {
          post: {
            ...noteOperation(
              [
                'FR-GRAPH-004/005/006',
                'two-way',
                'self-edge is 400',
                'EDGE_TARGET_NOT_QUESTION',
                'EDGE_LIMIT_EXCEEDED',
                'outcome existing',
                'nothing is written',
                'never conflicts',
                'node_connected',
                'never carries the note',
                ...MUTATION,
              ],
              [idempotencyHeader, studyId],
              201,
              'The new edge, without its note',
              'CreateEdgeResponse',
              'CreateEdgeRequest',
            ),
            responses: {
              200: {
                description: 'existing: the live edge already there, without its note',
                content: json('CreateEdgeResponse'),
              },
              201: {
                description: 'The new edge, without its note',
                content: json('CreateEdgeResponse'),
              },
              default: errorResponse,
            },
          },
          get: noteOperation(
            ['source or the target', 'oldest first', 'with their notes', SAME_404],
            [studyId, { ...uuidParam('nodeId', 'query'), required: true }],
            200,
            "The node's relationships",
            'EdgeListResponse',
          ),
        },
        '/studies/{studyId}/edges/{edgeId}': {
          patch: noteOperation(
            [
              'never change',
              'EDGE_TYPE_CHANGE_NOT_ALLOWED',
              'EDGE_EXISTS',
              'EDGE_UNCHANGED',
              'edge_updated',
              ...MUTATION,
            ],
            [idempotencyHeader, studyId, uuidParam('edgeId')],
            200,
            'The edge as saved, without its note',
            'EdgeMutationResponse',
            'UpdateEdgeRequest',
          ),
          delete: noteOperation(
            ['soft delete', 'both nodes', 'edge_removed', ...MUTATION],
            [idempotencyHeader, studyId, uuidParam('edgeId')],
            200,
            'The removed edge',
            'EdgeMutationResponse',
            'EdgeStateRequest',
          ),
        },
        '/studies/{studyId}/graph': {
          get: noteOperation(
            [
              'one transaction',
              'GET /nodes',
              'without its note',
              'viewRevision',
              'Library-independent',
              SAME_404,
            ],
            [studyId],
            200,
            "The study's graph",
            'GraphResponse',
          ),
        },
        '/studies/{studyId}/positions': {
          patch: noteOperation(
            [
              '1-100 live nodes',
              'view revision',
              'contentRevision never move',
              'Only the sent nodes change',
              'node_position_saved',
              ...MUTATION,
            ],
            [idempotencyHeader, studyId],
            200,
            'The new view revision',
            'SavePositionsResponse',
            'SavePositionsRequest',
          ),
        },
        '/bible/translations': {
          get: {
            description:
              "Lists the active Bible editions with their attribution and books (canon order, chapter counts), for the reader's translation and book/chapter selectors.",
            security: [{ sessionCookie: [] }],
            responses: {
              200: {
                description: 'Active editions',
                content: { 'application/json': { schema: ref('BibleTranslationsResponse') } },
              },
              default: errorResponse,
            },
          },
        },
        '/bible/passages': {
          get: {
            description:
              "Returns one chapter of an active edition, the reading context: every verse exactly as stored (a verse the edition gives no text for has empty text), the publisher's superscriptions separately, the edition attribution, and the neighboring chapters across books, each with its whole-chapter referenceId. The chapter is the one holding the reference's start, and the reference fixes the edition (reach a chapter or verse with POST /bible/resolve or POST /bible/references first), so only opaque IDs travel in the URL. editionId is optional; an unknown reference, or an editionId that is not the reference's edition, is 404.",
            security: [{ sessionCookie: [] }],
            parameters: [
              {
                name: 'referenceId',
                in: 'query',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
              {
                name: 'editionId',
                in: 'query',
                required: false,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              200: {
                description: 'One chapter',
                content: { 'application/json': { schema: ref('BiblePassageResponse') } },
              },
              default: errorResponse,
            },
          },
        },
      },
    });
    expect(doc.components.securitySchemes).toStrictEqual({
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ba_session' },
    });
  });

  it('builds the document once and returns the same frozen object', () => {
    const doc = buildOpenApiDocument();
    expect(buildOpenApiDocument()).toBe(doc);
    expect(Object.isFrozen(doc.components.schemas)).toBe(true);
  });

  it('generates the error envelope and health schemas', () => {
    const { HealthResponse, LivenessResponse, ErrorEnvelope } =
      buildOpenApiDocument().components.schemas;
    expect({ HealthResponse, LivenessResponse, ErrorEnvelope }).toStrictEqual({
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] },
          database: { type: 'string', enum: ['up', 'down'] },
          migrations: { type: 'string', enum: ['current', 'pending', 'unknown'] },
          corpus: { type: 'string', enum: ['ready', 'missing', 'corrupt', 'unknown'] },
        },
        required: ['status', 'database', 'migrations', 'corpus'],
        additionalProperties: false,
      },
      LivenessResponse: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['ok'] } },
        required: ['status'],
        additionalProperties: false,
      },
      ErrorEnvelope: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          fieldErrors: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          retryable: { type: 'boolean' },
          correlationId: { type: 'string' },
          currentRevision: {
            type: 'integer',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ['code', 'message', 'retryable', 'correlationId'],
        additionalProperties: false,
      },
    });
  });

  it('works when the main barrel is loaded before the /openapi subpath', async () => {
    // Regression: the old zod-to-openapi prototype patch broke when the barrel's schemas were
    // constructed before the patch ran. Fresh module graph, barrel first, then the subpath.
    // (The CJS require-cache variant is covered in apps/api's openapi-import-order.int-spec.ts.)
    vi.resetModules();
    const barrel = await import('./index.js');
    expect(barrel.healthResponseSchema).toBeDefined();
    const openapi = await import('./openapi.js');
    expect(Object.keys(openapi.buildOpenApiDocument().components.schemas)).toStrictEqual([
      'HealthResponse',
      'LivenessResponse',
      'ErrorEnvelope',
      'OtpStartRequest',
      'OtpStartResponse',
      'OtpVerifyRequest',
      'MeResponse',
      'ResolveReferenceRequest',
      'ResolveReferenceResponse',
      'SearchBibleResponse',
      'BibleTranslationsResponse',
      'BiblePassageResponse',
      'BibleReferenceRequest',
      'BibleReferenceResponse',
      'AnchorSelection',
      'CaptureAnchorResponse',
      'ResolveAnchorRequest',
      'ResolveAnchorResponse',
      'CreateStudyRequest',
      'CreateStudyResponse',
      'StudyResponse',
      'StudyListResponse',
      'UpdateStudyRequest',
      'UpdateStudyResponse',
      'StudyLifecycleRequest',
      'CreateNoteRequest',
      'CreateNoteResponse',
      'UpdateNoteRequest',
      'NoteStateRequest',
      'NoteMutationResponse',
      'NoteResponse',
      'NoteListResponse',
      'NoteVersionListResponse',
      'NoteVersionResponse',
      'CreateAnnotationRequest',
      'CreateAnnotationResponse',
      'UpdateAnnotationRequest',
      'AnnotationStateRequest',
      'AnnotationMutationResponse',
      'AnnotationListResponse',
      'CreateNodeRequest',
      'CreateNodeResponse',
      'UpdateNodeRequest',
      'NodeMutationResponse',
      'NodeListResponse',
      'NodeResponse',
      'CreateEdgeRequest',
      'CreateEdgeResponse',
      'UpdateEdgeRequest',
      'EdgeStateRequest',
      'EdgeMutationResponse',
      'EdgeListResponse',
      'GraphResponse',
      'SavePositionsRequest',
      'SavePositionsResponse',
      'NoteBlock',
      'NoteListItem',
    ]);
  });

  it('resolves every $ref to a component, including the recursive note document (BIB-23)', () => {
    const doc = buildOpenApiDocument();
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1] ?? '');
    const unresolved = refs.filter(
      (target) =>
        !target.startsWith('#/components/schemas/') ||
        !(target.slice('#/components/schemas/'.length) in doc.components.schemas),
    );
    expect([refs.length > 0, unresolved, text.includes('"definitions"')]).toStrictEqual([
      true,
      [],
      false,
    ]);
    // The block schema refers to itself (blockquote) and to list items, which refer back.
    expect(JSON.stringify(doc.components.schemas.NoteBlock)).toContain(
      '#/components/schemas/NoteListItem',
    );
    expect(JSON.stringify(doc.components.schemas.NoteListItem)).toContain(
      '#/components/schemas/NoteBlock',
    );
  });
});
