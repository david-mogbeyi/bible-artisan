/**
 * Domain exceptions mapped to the shared error envelope (PRD §24) by
 * `DomainExceptionFilter`. Throw these from services/controllers instead of hand-rolling a
 * response body. `message`/`fieldErrors` must never carry Scripture text, note/question/
 * conclusion content, or source excerpts (NFR-PRIV-001) — no route in this ticket surfaces
 * such content yet, but every future caller of these classes must keep that invariant.
 */

/** Absent or unauthorized resource. Owner scoping must make both cases indistinguishable. */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** A malformed DTO or otherwise invalid request body/params/query. */
export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly fieldErrors?: Record<string, string[]>;
  constructor(message = 'Invalid request', fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'ValidationError';
    this.fieldErrors = fieldErrors;
  }
}

/** A mutation endpoint was called without the required `expectedRevision` (PRD §24, §27). */
export class RevisionMissingError extends Error {
  readonly code = 'REVISION_MISSING';
  constructor(message = 'expectedRevision is required') {
    super(message);
    this.name = 'RevisionMissingError';
  }
}

/** `expectedRevision` no longer matches the entity's current revision. */
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  readonly currentRevision: number;
  constructor(currentRevision: number, message = 'Revision conflict') {
    super(message);
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
  }
}
