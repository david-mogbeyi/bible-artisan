import {
  type AnchorProblemCode,
  ANNOTATION_LIMIT_EXCEEDED,
  ANNOTATION_UNCHANGED,
  EDGE_ERROR_MESSAGES,
  type EdgeErrorCode,
  type AnnotationErrorCode,
  LIFECYCLE_TRANSITION_INVALID,
  MAX_ANNOTATIONS_PER_STUDY,
  MAX_NOTE_CHARACTERS,
  MAX_NOTES_PER_STUDY,
  MAX_STUDY_TAGS,
  NOTE_LIMIT_EXCEEDED,
  NOTE_NOT_TRASHED,
  NOTE_REFERENCE_INVALID,
  NOTE_TARGET_NOT_FOUND,
  NOTE_TOO_LONG,
  NOTE_TRASHED,
  NOTE_UNCHANGED,
  NODE_ERROR_MESSAGES,
  type NodeErrorCode,
  type NoteErrorCode,
  QUESTION_NOT_FOUND,
  REFERENCE_NOT_FOUND,
  type ReferenceErrorCode,
  SEARCH_QUERY_IS_REFERENCE,
  STUDY_ARCHIVED,
  STUDY_TRASHED,
  STUDY_UNCHANGED,
  type StudyLifecycleErrorCode,
  TAG_LIMIT_EXCEEDED,
} from '@bible-artisan/contracts';

/**
 * Domain exception classes the global exception filter maps to the shared error envelope
 * (PRD §24). Throw these from module services; never hand-roll a response body in a controller
 * (this ticket's "Business rules": the envelope is the only 4xx/5xx shape /v1 returns).
 *
 * `fieldErrors` and `message` must never carry Scripture text, note/question/conclusion content,
 * or source excerpts (NFR-PRIV-001) — callers are responsible for that; this ticket has no
 * content-bearing route yet to enforce it against.
 */

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(
    message = 'Invalid request',
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** expectedRevision was required but missing from the request (PRD §24, §27). */
export class RevisionMissingError extends Error {
  readonly code = 'REVISION_MISSING';
  constructor(message = 'expectedRevision is required') {
    super(message);
    this.name = 'RevisionMissingError';
  }
}

/** expectedRevision did not match the entity's current revision (stale write). */
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(
    readonly currentRevision: number,
    message = 'Revision conflict',
  ) {
    super(message);
    this.name = 'RevisionConflictError';
  }
}

/**
 * An Idempotency-Key was reused with a different request (method, path, or body) by the same
 * owner (PRD §23 MutationReceipt: "Reject reuse with a different request body"). Mapped to 422:
 * the key is in a state that cannot accept this request. A changed request needs a new key.
 * Fixed message; never echoes the key or body.
 */
export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  constructor(message = 'This Idempotency-Key was already used for a different request') {
    super(message);
    this.name = 'IdempotencyKeyReusedError';
  }
}

/** No valid session on a route that requires one (PRD §24: 401). */
export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor(message = 'Sign in to continue') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export type OtpErrorCode = 'OTP_INVALID' | 'OTP_EXPIRED' | 'OTP_ATTEMPTS_EXHAUSTED';

const OTP_MESSAGES: Record<OtpErrorCode, string> = {
  OTP_INVALID: 'The code is not correct',
  OTP_EXPIRED: 'The code has expired or was already used',
  OTP_ATTEMPTS_EXHAUSTED: 'Too many attempts for this code',
};

/**
 * A sign-in code was refused (FR-AUTH-002). Fixed messages only: never the code or the email
 * (NFR-PRIV-001). Mapped to 422: the challenge is in a state that cannot authenticate.
 */
export class OtpError extends Error {
  constructor(readonly code: OtpErrorCode) {
    super(OTP_MESSAGES[code]);
    this.name = 'OtpError';
  }
}

/** A rate limit was hit (PRD §24: 429 with Retry-After). */
export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests. Try again later',
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * An external dependency (e.g. the email OTP provider) failed or was unreachable (PRD §24: 503).
 * The message is fixed; provider response bodies are never attached.
 */
export class DependencyUnavailableError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  constructor(message = 'A required service is temporarily unavailable') {
    super(message);
    this.name = 'DependencyUnavailableError';
  }
}

const REFERENCE_MESSAGES: Record<ReferenceErrorCode, string> = {
  REFERENCE_MALFORMED: 'This is not a complete Bible reference',
  REFERENCE_UNKNOWN_BOOK: 'No book in this translation matches that name',
  REFERENCE_CHAPTER_OUT_OF_RANGE: 'That chapter does not exist in this book',
  REFERENCE_VERSE_OUT_OF_RANGE: 'That verse does not exist in this chapter',
  REFERENCE_RANGE_REVERSED: 'The passage ends before it starts',
  REFERENCE_RANGE_TOO_LONG: 'A passage can span at most 200 verses',
  REFERENCE_MULTIPLE_PASSAGES: 'Enter one passage from one book at a time',
};

/**
 * A typed Bible reference cannot be resolved (FR-BIBLE-002, PRD §24: 422). The code says which
 * part is wrong; the message is fixed per code and never echoes the input, a book name, or a
 * number (NFR-PRIV-001). No nearby verse is ever offered in its place.
 */
export class ReferenceInvalidError extends Error {
  constructor(readonly code: ReferenceErrorCode) {
    super(REFERENCE_MESSAGES[code]);
    this.name = 'ReferenceInvalidError';
  }
}

/**
 * A request body names a `scripture_reference` id that does not exist or whose edition is not
 * active (BIB-19's starting passage; PRD section 24: 422 invalid reference). Not a 404: the
 * request names no private resource, it carries an unusable value. Fixed message; never echoes
 * the id, and no other passage is ever substituted.
 */
export class ReferenceNotFoundError extends Error {
  readonly code = REFERENCE_NOT_FOUND;
  constructor() {
    super('That passage is not available in an active translation');
    this.name = 'ReferenceNotFoundError';
  }
}

/**
 * A terms-mode search input is a Bible reference (PRD §14: reference lookup takes precedence, and
 * a malformed reference gets a correction rather than a misleading keyword result). Mapped to
 * 422; the client resolves the input with POST /bible/resolve instead. Fixed message only.
 */
export class SearchQueryIsReferenceError extends Error {
  readonly code = SEARCH_QUERY_IS_REFERENCE;
  constructor() {
    super('This is a Bible reference. Look it up as a reference instead');
    this.name = 'SearchQueryIsReferenceError';
  }
}

const ANCHOR_MESSAGES: Record<AnchorProblemCode, string> = {
  ANCHOR_EDITION_UNAVAILABLE: 'That translation is not available',
  ANCHOR_VERSE_NOT_FOUND: 'The selection names a verse this translation does not have',
  ANCHOR_NOT_CONTIGUOUS: 'The selection must be one continuous passage',
  ANCHOR_CHECKSUM_MISMATCH: 'The verse text has changed since this selection was made',
  ANCHOR_OFFSET_OUT_OF_RANGE: 'The selection runs past the end of a verse',
  ANCHOR_KIND_MISMATCH: 'A verse selection must cover whole verses',
  ANCHOR_EMPTY: 'The selection must start and end on selected text',
  ANCHOR_QUOTE_MISMATCH: 'The selected text does not match this translation',
};

/**
 * A selection does not match the stored corpus text (BIB-18, PRD §14; 422). The code says which
 * rule failed; the message is fixed per code and never echoes the quote, a reference or an
 * offset (NFR-PRIV-001). The anchor is never adjusted to fit.
 */
export class AnchorInvalidError extends Error {
  constructor(readonly code: AnchorProblemCode) {
    super(ANCHOR_MESSAGES[code]);
    this.name = 'AnchorInvalidError';
  }
}

/**
 * A study edit names, as the new main question, a node that is not a live Question node of that
 * study (BIB-20; PRD section 24: 422). Another user's node and an absent one take this same path,
 * so the response says nothing about which. Fixed message; never echoes the id.
 */
export class QuestionNotFoundError extends Error {
  readonly code = QUESTION_NOT_FOUND;
  constructor() {
    super('That question is not part of this study');
    this.name = 'QuestionNotFoundError';
  }
}

/**
 * A study edit in which every field already has the submitted value (BIB-20; 422). Nothing is
 * written: no revision, no event, no receipt.
 */
export class StudyUnchangedError extends Error {
  readonly code = STUDY_UNCHANGED;
  constructor() {
    super('The study already has these values');
    this.name = 'StudyUnchangedError';
  }
}

/**
 * A study edit whose tag change would leave the study with more than `MAX_STUDY_TAGS` tags
 * (BIB-20; 422). The limit is checked after the deltas apply, under the study lock, so it holds
 * whatever another device added meanwhile. Nothing is written.
 */
export class TagLimitExceededError extends Error {
  readonly code = TAG_LIMIT_EXCEEDED;
  constructor() {
    super(`A study can have at most ${MAX_STUDY_TAGS} tags`);
    this.name = 'TagLimitExceededError';
  }
}

const STUDY_LIFECYCLE_MESSAGES: Record<StudyLifecycleErrorCode, string> = {
  [STUDY_ARCHIVED]: 'This study is archived. Unarchive it to make changes',
  [STUDY_TRASHED]: 'This study is in the trash. Restore it to make changes',
  [LIFECYCLE_TRANSITION_INVALID]: 'This study is not in a state that allows this change',
};

/**
 * A study change the study's lifecycle state does not allow (BIB-22; PRD section 24: 422 for an
 * invalid state transition): any edit of an archived (`STUDY_ARCHIVED`) or trashed
 * (`STUDY_TRASHED`) study, or a lifecycle route from a state it does not start from
 * (`LIFECYCLE_TRANSITION_INVALID`). Raised by the mutation pipeline's guard under the study lock,
 * so nothing is written. Fixed messages.
 */
export class StudyLifecycleError extends Error {
  constructor(readonly code: StudyLifecycleErrorCode) {
    super(STUDY_LIFECYCLE_MESSAGES[code]);
    this.name = 'StudyLifecycleError';
  }
}

const NOTE_MESSAGES: Record<NoteErrorCode, string> = {
  [NOTE_TARGET_NOT_FOUND]: 'That item is not part of this study',
  [NOTE_LIMIT_EXCEEDED]: `A study can have at most ${MAX_NOTES_PER_STUDY.toLocaleString('en-US')} notes outside the note trash`,
  [NOTE_UNCHANGED]: 'The note already has this content and version',
  [NOTE_TRASHED]: 'This note is in the trash. Restore it to make changes',
  [NOTE_NOT_TRASHED]: 'This note is not in the trash',
  [NOTE_REFERENCE_INVALID]: 'A Bible reference link in this note could not be verified',
};

/**
 * A note change the note's or study's state cannot apply (BIB-23; PRD section 24: 422): a target
 * that is not a live node of the study (another user's, another study's, a deleted and an absent
 * node are all the same), the per-study note cap, an edit that changes nothing, and trash/restore
 * from the wrong state. Raised under the study lock, so nothing is written. Fixed messages.
 */
export class NoteRuleError extends Error {
  constructor(readonly code: NoteErrorCode) {
    super(NOTE_MESSAGES[code]);
    this.name = 'NoteRuleError';
  }
}

const ANNOTATION_MESSAGES: Record<AnnotationErrorCode, string> = {
  [ANNOTATION_LIMIT_EXCEEDED]: `A study can have at most ${MAX_ANNOTATIONS_PER_STUDY.toLocaleString('en-US')} highlights`,
  [ANNOTATION_UNCHANGED]: 'The highlight already has this color and label',
};

/**
 * A highlight change the study's or highlight's state cannot apply (BIB-24; PRD section 24: 422):
 * the per-study highlight cap, or an edit that changes nothing. Raised under the study lock, so
 * nothing is written. Fixed messages: never the label or quote.
 */
export class AnnotationRuleError extends Error {
  constructor(readonly code: AnnotationErrorCode) {
    super(ANNOTATION_MESSAGES[code]);
    this.name = 'AnnotationRuleError';
  }
}

/**
 * A note's derived plain text is longer than the documented limit (FR-NOTE-004, PRD section 15;
 * section 24: 413 payload too large). Checked before any transaction, so nothing is written; the
 * client keeps its draft. Fixed message naming the limit, never the content.
 */
export class NoteTooLongError extends Error {
  readonly code = NOTE_TOO_LONG;
  constructor() {
    super(`A note can have at most ${MAX_NOTE_CHARACTERS.toLocaleString('en-US')} characters`);
    this.name = 'NoteTooLongError';
  }
}

/**
 * A node change the study's or node's state cannot apply (BIB-25; PRD section 24: 422): a second
 * live Scripture node for the same reference, the per-study node cap, an edit of a type or field
 * not editable here, or an edit that changes nothing. Raised under the study lock, so nothing is
 * written. Fixed messages: never a node's text, a label or a reference.
 */
export class NodeRuleError extends Error {
  constructor(readonly code: NodeErrorCode) {
    super(NODE_ERROR_MESSAGES[code]);
    this.name = 'NodeRuleError';
  }
}

/**
 * A relationship change the study's or edge's state cannot apply (BIB-27; PRD section 24: 422):
 * `answers` / `raises_question` into a node that is not a Question, the per-study edge cap, a type
 * change across direction classes, a retype that would duplicate another live edge, or an edit
 * that changes nothing. Raised under the study lock, so nothing is written. Fixed messages: never
 * a node's text, a label or a note.
 */
export class EdgeRuleError extends Error {
  constructor(readonly code: EdgeErrorCode) {
    super(EDGE_ERROR_MESSAGES[code]);
    this.name = 'EdgeRuleError';
  }
}
