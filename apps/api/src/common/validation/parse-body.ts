import { z } from 'zod';
import { ValidationError } from '../errors/domain-errors';

/**
 * Validates an untrusted request body with its contract schema, or throws `ValidationError`
 * (400) with per-field messages. Zod's messages name the rule, never the submitted value, so no
 * request content is echoed back (NFR-PRIV-001).
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw new ValidationError('Invalid request', fieldErrors);
}
