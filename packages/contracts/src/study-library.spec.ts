import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CURSOR_INVALID,
  LIBRARY_QUERY_EMPTY,
  LIBRARY_QUERY_TOO_MANY_WORDS,
  listStudiesQuerySchema,
  studySearchText,
  studySearchTokens,
  studyTitleSortKey,
  TITLE_SORT_KEY_LENGTH,
} from './study-library';
import { TAG_DUPLICATE, tagChangeSchema, tagKey } from './study-edit';
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

  it('folds Greek sigma the same wherever it stands, so a fragment finds the word it is part of', () => {
    // "ΑΣ" alone lowercases to "ας" (final sigma) but to "ασ" inside "ΑΣΤΗΡ": the fold must not.
    const [fragment] = studySearchTokens('ΑΣ');
    expect(fragment).toBe('ασ');
    expect(studySearchText('ΑΣΤΗΡ', null).includes(fragment ?? '~')).toBe(true);
    expect(studySearchTokens('ἸΗΣΟΥΣ Ἰησοῦς ἸΗΣΟΥ')).toStrictEqual(['ἰησουσ', 'ἰησοῦσ', 'ἰησου']);
    for (const text of ['ς', 'σ', 'Σ', 'λόγος', 'ΛΌΓΟΣ', 'λόγοσ', 'ΣΑΣ', 'Σ.Σ']) {
      expect(tagKey(text)).not.toContain('\u03c2');
    }
    expect(tagKey('λόγος')).toBe(tagKey('ΛΌΓΟΣ'));
    expect(tagKey('λόγος')).toBe(tagKey('λόγοσ'));
  });

  it('treats Greek tag names that differ only in sigma form or case as one tag', () => {
    expect(tagChangeSchema.safeParse({ add: ['Λόγος', 'λόγοσ'] }).error?.issues).toStrictEqual([
      expect.objectContaining({ path: ['add'], message: TAG_DUPLICATE }),
    ]);
    expect(tagChangeSchema.safeParse({ add: ['ΑΣ', 'ας'] }).success).toBe(false);
    expect(tagChangeSchema.safeParse({ add: ['ας', 'αστηρ'] }).success).toBe(true);
  });

  it('sorts titles by their fold, cut to the sort key length in code points', () => {
    expect(studyTitleSortKey('Grace ALONE')).toBe('grace alone');
    expect(studyTitleSortKey('ΛΌΓΟΣ')).toBe(studyTitleSortKey('λόγος'));
    // Astral characters count as one code point and are never split.
    const long = '\u{1D400}'.repeat(TITLE_SORT_KEY_LENGTH + 5);
    expect(Array.from(studyTitleSortKey(long))).toHaveLength(TITLE_SORT_KEY_LENGTH);
    expect(studyTitleSortKey(long)).toBe('a'.repeat(TITLE_SORT_KEY_LENGTH));
    const emoji = '\u{1F600}'.repeat(TITLE_SORT_KEY_LENGTH + 1);
    expect(studyTitleSortKey(emoji)).toBe('\u{1F600}'.repeat(TITLE_SORT_KEY_LENGTH));
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
      pinnedFirst: true,
      limit: 50,
    });
    expect(
      listStudiesQuerySchema.parse({
        q: ' grace ',
        tag: '00000000-0000-4000-8000-00000000000a',
        state: 'archived',
        sort: 'title',
        pinnedFirst: 'false',
        cursor: 'abc_-1',
        limit: '7',
      }),
    ).toStrictEqual({
      q: 'grace',
      tag: '00000000-0000-4000-8000-00000000000a',
      state: 'archived',
      sort: 'title',
      pinnedFirst: false,
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
    for (const pinnedFirst of ['1', 'yes', 'TRUE', '']) {
      expect(issuesOf({ pinnedFirst }).map((i) => i.path)).toStrictEqual([['pinnedFirst']]);
    }
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

  it('accepts only base64url cursors up to 2,048 characters', () => {
    expect(issuesOf({ cursor: 'a+b' })).toStrictEqual([
      { path: ['cursor'], message: LIBRARY_CURSOR_INVALID },
    ]);
    expect(issuesOf({ cursor: 'a'.repeat(2048) })).toStrictEqual([]);
    expect(issuesOf({ cursor: 'a'.repeat(2049) }).map((i) => i.path)).toStrictEqual([['cursor']]);
  });
});
