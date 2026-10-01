import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CURSOR_INVALID,
  LIBRARY_QUERY_EMPTY,
  LIBRARY_QUERY_TOO_MANY_WORDS,
  listStudiesQuerySchema,
  studySearchText,
  studySearchTokens,
} from './study-library';
import { tagKey } from './study-edit';
import { USER_TEXT_INVALID_CHARACTERS } from './user-text';

const issuesOf = (query: unknown) => {
  const result = listStudiesQuerySchema.safeParse(query);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

describe('studySearchTokens / studySearchText', () => {
  it('folds the query exactly like stored text, distinct words in typed order', () => {
    expect(studySearchTokens('  Conscience  ROMANS conscience ')).toStrictEqual([
      'conscience',
      'romans',
    ]);
    expect(studySearchTokens('Stra\u00DFe')).toStrictEqual(['strasse']);
    // Invisible characters vanish; full-width letters are plain letters.
    expect(studySearchTokens('gr\u200Bace \uFF21')).toStrictEqual(['grace', 'a']);
    expect(studySearchTokens('\u200B')).toStrictEqual([]);
  });

  it('keeps search operators and wildcards as literal characters', () => {
    expect(studySearchTokens(`100% a_b c:* 'x' &|! \\`)).toStrictEqual([
      '100%',
      'a_b',
      'c:*',
      "'x'",
      '&|!',
      '\\',
    ]);
  });

  it('stores the folded title and description on separate lines', () => {
    expect(studySearchText('Grace ALONE', null)).toBe('grace alone');
    expect(studySearchText('Grace', 'Romans\n\n5')).toBe('grace\nromans 5');
    expect(studySearchText('İstanbul', null)).toBe(tagKey('istanbul'));
  });
});

describe('listStudiesQuerySchema', () => {
  it('defaults state, sort and limit, and parses limit from its decimal form', () => {
    expect(listStudiesQuerySchema.parse({})).toStrictEqual({
      state: 'active',
      sort: 'recent',
      limit: 50,
    });
    expect(
      listStudiesQuerySchema.parse({
        q: ' grace ',
        tag: '00000000-0000-4000-8000-00000000000a',
        state: 'archived',
        sort: 'title',
        cursor: 'abc_-1',
        limit: '7',
      }),
    ).toStrictEqual({
      q: 'grace',
      tag: '00000000-0000-4000-8000-00000000000a',
      state: 'archived',
      sort: 'title',
      cursor: 'abc_-1',
      limit: 7,
    });
  });

  it('refuses unknown parameters, trashed, bad sorts and out-of-range limits', () => {
    expect(issuesOf({ ownerId: 'x' }).length).toBe(1);
    expect(issuesOf({ state: 'trashed' }).map((i) => i.path)).toStrictEqual([['state']]);
    expect(issuesOf({ sort: 'updated' }).map((i) => i.path)).toStrictEqual([['sort']]);
    for (const limit of ['0', '51', '-1', '1.5', '05', '', 'ten']) {
      expect(issuesOf({ limit }).map((i) => i.path)).toStrictEqual([['limit']]);
    }
    expect(issuesOf({ tag: 'not-a-uuid' }).map((i) => i.path)).toStrictEqual([['tag']]);
    // Repeated parameters arrive as arrays.
    expect(issuesOf({ q: ['a', 'b'] }).map((i) => i.path)).toStrictEqual([['q']]);
  });

  it('refuses an empty, invisible, over-long or over-wordy search with fixed copy', () => {
    expect(issuesOf({ q: '   ' }).map((i) => i.path)).toStrictEqual([['q']]);
    expect(issuesOf({ q: '\u200B' })).toStrictEqual([
      { path: ['q'], message: LIBRARY_QUERY_EMPTY },
    ]);
    expect(issuesOf({ q: 'a'.repeat(201) }).map((i) => i.path)).toStrictEqual([['q']]);
    expect(issuesOf({ q: 'a b c d e f g h i j k' })).toStrictEqual([
      { path: ['q'], message: LIBRARY_QUERY_TOO_MANY_WORDS },
    ]);
    expect(issuesOf({ q: 'a b c d e f g h i j' })).toStrictEqual([]);
    expect(issuesOf({ q: 'bad\u0000' })).toStrictEqual([
      { path: ['q'], message: USER_TEXT_INVALID_CHARACTERS },
    ]);
  });

  it('accepts only base64url cursors up to 512 characters', () => {
    expect(issuesOf({ cursor: 'a+b' })).toStrictEqual([
      { path: ['cursor'], message: LIBRARY_CURSOR_INVALID },
    ]);
    expect(issuesOf({ cursor: 'a'.repeat(513) }).map((i) => i.path)).toStrictEqual([['cursor']]);
  });
});
