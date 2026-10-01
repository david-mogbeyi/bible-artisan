import { z } from 'zod';

/**
 * Free text a user types (titles, questions, search and reference input). One rule set on both
 * sides of the wire, so text that cannot be stored or processed safely is a 400 VALIDATION with a
 * fixed field error before any work (and before any transaction or receipt) starts.
 */

/** Fixed field-error copy. Never echoes the submitted text. */
export const USER_TEXT_INVALID_CHARACTERS = 'Remove control or invalid characters';

/**
 * C0 control characters other than tab, line feed and carriage return (U+0000 is refused by
 * PostgreSQL `text` outright), and UTF-16 surrogates that are not part of a valid pair (they cannot
 * be encoded as UTF-8, so they would be silently replaced on the way to the database).
 */
const FORBIDDEN_USER_TEXT =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when `text` holds a character `userTextSchema` refuses. */
export function hasForbiddenUserTextCharacter(text: string): boolean {
  return FORBIDDEN_USER_TEXT.test(text);
}

const FORBIDDEN_USER_TEXT_GLOBAL = new RegExp(FORBIDDEN_USER_TEXT.source, 'g');

/** `text` without any character `userTextSchema` refuses (for derived keys, never for storage). */
export function stripForbiddenUserTextCharacters(text: string): string {
  return text.replace(FORBIDDEN_USER_TEXT_GLOBAL, '');
}

/**
 * A trimmed user-text string of `min`..`max` UTF-16 units (after trimming) with no forbidden
 * character. Compose `.optional()` etc. on the result as needed.
 */
export function userTextSchema({ min = 1, max }: { min?: number; max: number }) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((text) => !hasForbiddenUserTextCharacter(text), {
      message: USER_TEXT_INVALID_CHARACTERS,
    });
}
