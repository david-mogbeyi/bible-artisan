import { expectedRevisionSchema } from '@bible-artisan/contracts';
import { z } from 'zod';
import { RevisionMissingError, ValidationError } from '../errors/domain-errors';
import { parseBody } from '../validation/parse-body';

const expectedRevisionBody = z.object({ expectedRevision: expectedRevisionSchema });

/**
 * The `expectedRevision` a mutation body must carry (PRD §24, §27). Call it before parsing the
 * rest of the body so a missing revision is always 428, whatever else is wrong:
 * - body not a JSON object → 400 `VALIDATION`;
 * - `expectedRevision` absent or null → 428 `REVISION_MISSING`;
 * - present but not an integer in 1..2^31-1 → 400 `VALIDATION` on `expectedRevision`.
 *
 * The check itself is `StudyMutation.updateWithExpectedRevision`, inside `MutationService.execute`.
 */
export function requireExpectedRevision(body: unknown): number {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Invalid request', { _: ['Expected a JSON object'] });
  }
  const value = (body as Record<string, unknown>).expectedRevision;
  if (value === undefined || value === null) throw new RevisionMissingError();
  return parseBody(expectedRevisionBody, { expectedRevision: value }).expectedRevision;
}
