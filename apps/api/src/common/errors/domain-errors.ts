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
