import type { z } from 'zod';

/**
 * Shared AI output validation (BIB-41; PRD section 25 "Validate output with shared JSON
 * schemas/Zod", FR-AI-005, FR-AI-006). Every capability's model text goes through here before
 * anything is published:
 *
 * - `parseStructured`: JSON only, then the capability's strict Zod schema. A strict schema is also
 *   the status protection: the model cannot add a `status`, an "established" flag, a tool call or
 *   any other key the schema does not name. A `not_json` or `schema` failure may get one
 *   constrained repair (the runner asks once more with the same context and trust rules); then
 *   the job fails closed and no result is published.
 * - `unknown_id`: an id that is not in the job's context manifest (invented, or another study's
 *   or another user's: the manifest is assembled owner-scoped) rejects the whole output, so the
 *   prior valid artifact stays current. Never repaired.
 * - Item-level rules (a quote that is not exact stored text, unsupported certainty) drop the item,
 *   never "repair" it.
 *
 * Errors carry a fixed reason only: never model text (NFR-PRIV-001).
 */
export type OutputValidationReason = 'not_json' | 'schema' | 'unknown_id';

export class OutputValidationError extends Error {
  constructor(readonly reason: OutputValidationReason) {
    super(`AI output failed validation: ${reason}`);
    this.name = 'OutputValidationError';
  }

  /** Whether one constrained repair attempt may fix it (PRD section 25: "invalid JSON"). */
  get repairable(): boolean {
    return this.reason === 'not_json' || this.reason === 'schema';
  }
}

/**
 * One Markdown code fence around the whole answer (```json … ``` or ``` … ```), as models often
 * send JSON. Anchored at both ends, so text before or after the fence is not stripped.
 */
const SURROUNDING_FENCE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * The answer without surrounding whitespace and at most one surrounding code fence. Nothing more
 * lenient: prose around the fence, or a second fence, still fails as `not_json`.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = SURROUNDING_FENCE.exec(trimmed);
  return fenced ? (fenced[1] ?? '').trim() : trimmed;
}

/**
 * Model text → the capability's schema output, or `OutputValidationError`. No coercion beyond
 * `stripFence`.
 */
export function parseStructured<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    throw new OutputValidationError('not_json');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new OutputValidationError('schema');
  return result.data;
}

/** Every id must name a manifest entry; otherwise the whole output is rejected (FR-AI-006). */
export function assertInManifest(ids: Iterable<string>, manifestIds: ReadonlySet<string>): void {
  for (const id of ids) {
    if (!manifestIds.has(id.toLowerCase())) throw new OutputValidationError('unknown_id');
  }
}

/**
 * A model quote must be an exact substring of the cited item's stored text (PRD section 25: "A
 * model quote must match the cited stored text"); for Scripture that is the corpus text. No
 * normalization, no nearest match.
 */
export function quoteMatches(quote: string, storedTexts: readonly string[] | undefined): boolean {
  return quote.length > 0 && (storedTexts ?? []).some((text) => text.includes(quote));
}

const CERTAINTY =
  /\b(prove[sn]?|proving|proof|certainly|undeniabl[ey]|definitively|indisputabl[ey]|without (?:a )?doubt)\b/i;
const QUOTED = /"[^"]*"|“[^”]*”/g;

/**
 * Unsupported certainty (PRD section 16: "'proves' requires quoted user attribution"; section 25:
 * responses with unsupported certainty fail validation policy). Words inside quotation marks
 * (the user's own words, attributed) do not count.
 */
export function claimsCertainty(text: string): boolean {
  return CERTAINTY.test(text.replace(QUOTED, ''));
}

/** The fixed instruction for the one repair attempt: same context, same trust rules. */
export const REPAIR_INSTRUCTION =
  'Your previous answer was not valid JSON in the required shape. Answer again with JSON only, exactly in the required shape, following every rule above.';
