import { describe, expect, it } from 'vitest';
import { resolveReferenceRequestSchema, searchBibleQuerySchema } from './bible';
import { createStudyRequestSchema } from './study';
import {
  hasForbiddenUserTextCharacter,
  USER_TEXT_INVALID_CHARACTERS,
  userTextSchema,
} from './user-text';

const editionId = '00000000-0000-4000-8000-000000000001';

/** Every refused character class, in the middle of otherwise valid text. */
const FORBIDDEN: [string, string][] = [
  ['U+0000', 'a\u0000b'],
  ['U+0001', 'a\u0001b'],
  ['U+0008 (backspace)', 'a\u0008b'],
  ['U+000B (vertical tab)', 'a\u000Bb'],
  ['U+000C (form feed)', 'a\u000Cb'],
  ['U+001B (escape)', 'a\u001Bb'],
  ['U+001F', 'a\u001Fb'],
  ['a lone high surrogate', 'a\uD83Db'],
  ['a lone low surrogate', 'a\uDE00b'],
  ['a trailing high surrogate', 'ab\uD83D'],
  ['a reversed pair', 'a\uDE00\uD83Db'],
];

describe('userTextSchema', () => {
  const schema = userTextSchema({ max: 10 });

  it.each(FORBIDDEN)('refuses %s with the fixed message, never the text', (_, text) => {
    expect(hasForbiddenUserTextCharacter(text)).toBe(true);
    const result = schema.safeParse(text);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toStrictEqual([
      USER_TEXT_INVALID_CHARACTERS,
    ]);
  });

  it('accepts tab, line feed, carriage return, a valid surrogate pair and other Unicode, trimmed', () => {
    expect(schema.parse(' a\tb\nc\r😀 ')).toBe('a\tb\nc\r😀');
    expect(schema.parse('Ἰησοῦς')).toBe('Ἰησοῦς');
    expect(hasForbiddenUserTextCharacter('a\tb\nc\r😀')).toBe(false);
  });

  it('keeps the length rules after trimming', () => {
    expect(schema.safeParse('   ').success).toBe(false);
    expect(schema.safeParse('x'.repeat(11)).success).toBe(false);
    expect(schema.parse(` ${'x'.repeat(10)} `)).toBe('x'.repeat(10));
  });
});

describe('free user text in request schemas refuses control characters and lone surrogates', () => {
  it.each(FORBIDDEN)('%s', (_, text) => {
    const messages = (result: {
      success: boolean;
      error?: { issues: { path: PropertyKey[]; message: string }[] };
    }) => result.error?.issues.map((i) => [i.path.join('.'), i.message]);
    expect(
      messages(createStudyRequestSchema.safeParse({ title: text, question: 'Why?' })),
    ).toStrictEqual([['title', USER_TEXT_INVALID_CHARACTERS]]);
    expect(messages(createStudyRequestSchema.safeParse({ question: text }))).toStrictEqual([
      ['question', USER_TEXT_INVALID_CHARACTERS],
    ]);
    expect(
      messages(resolveReferenceRequestSchema.safeParse({ input: text, editionId })),
    ).toStrictEqual([['input', USER_TEXT_INVALID_CHARACTERS]]);
    expect(messages(searchBibleQuerySchema.safeParse({ q: text, editionId }))).toStrictEqual([
      ['q', USER_TEXT_INVALID_CHARACTERS],
    ]);
  });
});
