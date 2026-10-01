import type { ReferenceErrorCode } from '@bible-artisan/contracts';

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
