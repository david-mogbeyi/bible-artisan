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
import { errorEnvelopeSchema } from './error-envelope';
import { healthResponseSchema, livenessResponseSchema } from './health';
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
  return rest;
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
  return rest;
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
            "Lists the signed-in user's own studies (FR-STUDY-004): pinned studies first, then the rest, each group in the chosen sort (recent: last activity, newest first; created: newest first; title: A to Z by the case-folded title in code-point order, whatever the database collation), ties broken by id. pinnedFirst=false lists every study in the chosen sort, pins ignored (Home's recent studies). q matches studies where every word (case- and width-folded, literal: no wildcards or operators) occurs in the title, the description or one of the study's tag names. tag keeps studies carrying that tag; another user's or an absent tag id matches nothing. Keyset pages: nextCursor is non-null exactly when more studies follow; a cursor is opaque and encrypted, works only for the same user, filters, sort and pinnedFirst, and anything else is 400. Trashed studies are never listed. No totals.",
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
            "Returns one of the signed-in user's studies: title, description, lifecycle, pin, revisions, starting reference, main and original questions, tags and initial branch. Another user's, an absent, and a malformed id are the same 404.",
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
            "Edits one of the signed-in user's studies (FR-STUDY-003): title, description (null clears it), main question ({text} creates a new open Question node and makes it main; {nodeId} makes an existing live Question node of the study main), pin, and tags as deltas (tags.add: names, reusing the owner's tag with the same normalized key; tags.remove: ids of the study's tags; an item that is already applied is a no-op, and a tag no study uses any more is deleted). The original question is never rewritten; a study that had none gets the first main question as its original. expectedRevision is the study's revision and covers every field: missing is 428, stale is 409 with currentRevision. One StudyEvent per real change (study_renamed, study_description_changed, question_created, main_question_changed, study_pinned/study_unpinned, study_tags_changed; ids only) commits with the edit; contentRevision moves only for title, description or main question changes. An edit that changes nothing is 422 STUDY_UNCHANGED; more than 20 tags after applying the change is 422 TAG_LIMIT_EXCEEDED; a nodeId that is not a live question of this study is 422 QUESTION_NOT_FOUND. Send an Idempotency-Key: a retry with the same key and body replays the original 200. Another user's, an absent, and a malformed id are the same 404.",
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
