import { expect } from 'vitest';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The per-request correlation ID: the only dynamic field of an error envelope. */
const correlationId: unknown = expect.stringMatching(UUID);

/** Whole-body expectations for the shared error envelope (PRD §24); only correlationId varies. */
export const NOT_FOUND = {
  code: 'NOT_FOUND',
  message: 'Resource not found',
  retryable: false,
  correlationId,
};

export const UNAUTHENTICATED = {
  code: 'UNAUTHENTICATED',
  message: 'Sign in to continue',
  retryable: false,
  correlationId,
};

/**
 * A whole-body error envelope expectation (PRD §24). `correlationId` defaults to any UUID; pass the
 * request's actual ID when the test knows it.
 */
export function envelope(
  fields: {
    code: string;
    message: string;
    retryable?: boolean;
    fieldErrors?: Record<string, string[]>;
    currentRevision?: number;
  },
  id: unknown = correlationId,
): Record<string, unknown> {
  return { retryable: false, ...fields, correlationId: id };
}
