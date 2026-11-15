import { z } from 'zod';

/**
 * Study and account exports (BIB-47, BIB-48; PRD sections 21, 24, 29; FR-EXPORT-001/002,
 * FR-PRIVACY-001):
 *
 * - `POST /v1/studies/:studyId/exports` exports one owned study as JSON or Markdown.
 * - `POST /v1/me/exports` exports the whole account (preferences and every study).
 * - `GET /v1/exports/:exportId` returns the export's status with a fresh download link.
 * - `GET /v1/exports/:exportId/download?expires=…&signature=…` returns the file.
 *
 * Small studies export synchronously behind the same response contract (PRD section 24), so a
 * created export is already `ready`. The download link is signed and expires after 15 minutes;
 * the stored file expires 24 hours after it was made and is then purged.
 */

export const EXPORT_FORMATS = ['json', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_KINDS = ['study', 'account'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** PRD section 24: "A private signed export URL expires after 15 minutes". */
export const EXPORT_LINK_TTL_SECONDS = 15 * 60;
/** PRD section 24: "object expires after 24 hours". */
export const EXPORT_OBJECT_TTL_HOURS = 24;

/** 422: the download link's signature is valid but it is older than 15 minutes. */
export const EXPORT_LINK_EXPIRED = 'EXPORT_LINK_EXPIRED';

/** Version of the JSON export document. Bump on any incompatible change to its shape. */
export const EXPORT_SCHEMA_VERSION = 1;

export const createExportRequestSchema = z.strictObject({ format: z.enum(EXPORT_FORMATS) });
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

/** 201 from both create routes and 200 from `GET /v1/exports/:exportId`. */
export const exportResponseSchema = z.object({
  id: z.uuid(),
  kind: z.enum(EXPORT_KINDS),
  /** The exported study; null for an account export. */
  studyId: z.uuid().nullable(),
  format: z.enum(EXPORT_FORMATS),
  status: z.literal('ready'),
  fileName: z.string(),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  /** When the stored file is purged (24 hours after creation). */
  expiresAt: z.iso.datetime(),
  /** Path under the API origin, e.g. `/v1/exports/…/download?expires=…&signature=…`. */
  downloadUrl: z.string(),
  /** When `downloadUrl` stops working (15 minutes after this response). */
  downloadUrlExpiresAt: z.iso.datetime(),
});
export type ExportResponse = z.infer<typeof exportResponseSchema>;

export const exportDownloadQuerySchema = z.strictObject({
  expires: z.string().regex(/^\d{1,12}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ExportDownloadQuery = z.infer<typeof exportDownloadQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The JSON export document (FR-EXPORT-001): versioned, with full provenance.
// ---------------------------------------------------------------------------------------------

const timestamp = z.iso.datetime();
const nullableTimestamp = timestamp.nullable();

/** One Scripture passage the study names, with its edition attribution (rights-filtered text). */
export const exportScriptureSchema = z.object({
  referenceId: z.uuid(),
  label: z.string(),
  bookCode: z.string(),
  startChapter: z.number().int(),
  startVerse: z.number().int(),
  endChapter: z.number().int(),
  endVerse: z.number().int(),
  edition: z.object({
    id: z.uuid(),
    abbreviation: z.string(),
    name: z.string(),
    attribution: z.string(),
    noticeUrl: z.string().nullable(),
  }),
  /** The verses exactly as stored, `null` when the edition's rights do not permit export. */
  text: z
    .array(z.object({ chapter: z.number().int(), verse: z.number().int(), text: z.string() }))
    .nullable(),
  /** Why `text` is null: `rights` (the edition does not permit export) or `unavailable`. */
  textOmitted: z.enum(['rights', 'unavailable']).nullable(),
});
export type ExportScripture = z.infer<typeof exportScriptureSchema>;

export const exportNodeSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  origin: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  observationKind: z.string().nullable(),
  questionStatus: z.string().nullable(),
  conclusionStatus: z.string().nullable(),
  establishedAt: nullableTimestamp,
  scriptureReferenceId: z.uuid().nullable(),
  canonicalNodeId: z.uuid().nullable(),
  /** The note an Observation or Thought was converted from (BIB-57), else null. */
  derivedFromNoteId: z.uuid().nullable(),
  /** A Source node's bibliographic metadata (URL, locator, …) as stored. */
  source: z.record(z.string(), z.unknown()).nullable(),
  revision: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  /** Soft-deleted nodes are kept, marked, so evidence that pointed at them stays explainable. */
  deletedAt: nullableTimestamp,
});

export const exportEdgeSchema = z.object({
  id: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  type: z.string(),
  origin: z.string(),
  note: z.string().nullable(),
  revision: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

export const exportConclusionVersionSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  versionNumber: z.number().int(),
  action: z.string(),
  statement: z.string(),
  conclusionStatus: z.string(),
  established: z.boolean(),
  changeReason: z.string().nullable(),
  createdAt: timestamp,
  evidence: z.array(
    z.object({
      edgeId: z.uuid(),
      edgeType: z.string(),
      role: z.enum(['supporting', 'challenging']),
      nodeId: z.uuid(),
      nodeRevision: z.number().int(),
      nodeVersionId: z.uuid().nullable(),
    }),
  ),
});

export const exportNoteSchema = z.object({
  id: z.uuid(),
  targetNodeId: z.uuid().nullable(),
  targetReferenceId: z.uuid().nullable(),
  /** The Scripture anchor exactly as stored, for a note on a passage selection. */
  targetAnchor: z.unknown().nullable(),
  /** The rich-text document (schemaVersion below) and its derived plain text. */
  content: z.unknown(),
  plainText: z.string(),
  schemaVersion: z.number().int(),
  revision: z.number().int(),
  latestVersionNumber: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
  versions: z.array(
    z.object({
      id: z.uuid(),
      versionNumber: z.number().int(),
      content: z.unknown(),
      plainText: z.string(),
      schemaVersion: z.number().int(),
      createdAt: timestamp,
    }),
  ),
});

export const exportHighlightSchema = z.object({
  id: z.uuid(),
  referenceId: z.uuid(),
  anchor: z.unknown(),
  colorToken: z.string(),
  label: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: nullableTimestamp,
});

export const exportEventSchema = z.object({
  id: z.uuid(),
  /** Per-study sequence as a decimal string (bigint). */
  sequence: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: timestamp,
});

export const studyExportSchema = z.object({
  study: z.object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    lifecycle: z.string(),
    tags: z.array(z.string()),
    startingReferenceId: z.uuid().nullable(),
    originalQuestionNodeId: z.uuid().nullable(),
    mainQuestionNodeId: z.uuid().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: nullableTimestamp,
    deletedAt: nullableTimestamp,
  }),
  /**
   * What this export describes: the study's revision, content revision and last Study Thread
   * event at the moment of export, read in one snapshot.
   */
  basis: z.object({
    revision: z.number().int(),
    contentRevision: z.number().int(),
    lastEventSequence: z.string(),
  }),
  /**
   * The living AI summary and its basis. `null` until summaries exist (BIB-43); AI text is
   * never mixed into the user's own content.
   */
  summary: z
    .object({
      text: z.string(),
      basisRevision: z.number().int(),
      basisEventSequence: z.string(),
      generatedAt: timestamp,
    })
    .nullable(),
  scripture: z.array(exportScriptureSchema),
  nodes: z.array(exportNodeSchema),
  edges: z.array(exportEdgeSchema),
  branches: z.array(
    z.object({
      id: z.uuid(),
      rootNodeId: z.uuid(),
      memberNodeIds: z.array(z.uuid()),
      createdAt: timestamp,
    }),
  ),
  conclusionVersions: z.array(exportConclusionVersionSchema),
  notes: z.array(exportNoteSchema),
  highlights: z.array(exportHighlightSchema),
  events: z.array(exportEventSchema),
});
export type StudyExport = z.infer<typeof studyExportSchema>;

const exportHeader = {
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  exportedAt: timestamp,
  generator: z.literal('bible-artisan'),
};

/** A study's JSON export file (FR-EXPORT-001). */
export const studyExportDocumentSchema = z.object({
  schema: z.literal('bible-artisan.study-export'),
  ...exportHeader,
  ...studyExportSchema.shape,
});
export type StudyExportDocument = z.infer<typeof studyExportDocumentSchema>;

/** An account's JSON export file (PRD section 29: "aggregates studies and preferences"). */
export const accountExportDocumentSchema = z.object({
  schema: z.literal('bible-artisan.account-export'),
  ...exportHeader,
  account: z.object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string().nullable(),
    timezone: z.string(),
    createdAt: timestamp,
  }),
  studies: z.array(studyExportSchema),
});
export type AccountExportDocument = z.infer<typeof accountExportDocumentSchema>;

// ---------------------------------------------------------------------------------------------
// Account deletion (BIB-48, FR-PRIVACY-001).
// ---------------------------------------------------------------------------------------------

/**
 * `DELETE /v1/me`: a code from `POST /v1/auth/otp/start` sent to the account's own email, so
 * deletion always follows a fresh OTP (PRD section 29). A challenge for any other email reads as
 * expired.
 */
export const deleteAccountRequestSchema = z.strictObject({
  challengeId: z.uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { message: 'Enter the 6-digit code' }),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

/** PRD section 29: live private data and export objects are purged within seven days. */
export const ACCOUNT_PURGE_WITHIN_DAYS = 7;

export const deleteAccountResponseSchema = z.object({
  deletionRequestedAt: z.iso.datetime(),
  /** The latest moment every live private row and export file is gone. */
  purgeBy: z.iso.datetime(),
});
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

/** 422 from sign-in: this account's deletion was confirmed, so it can no longer sign in. */
export const ACCOUNT_DELETED = 'ACCOUNT_DELETED';
