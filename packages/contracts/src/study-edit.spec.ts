import { describe, expect, it } from 'vitest';
import {
  MAX_STUDY_TAGS,
  normalizeTagName,
  STUDY_EDIT_EMPTY,
  TAG_CHANGE_EMPTY,
  TAG_DUPLICATE,
  TAG_EMPTY,
  TAG_TOO_LONG,
  tagKey,
  TOO_MANY_TAGS,
  updateStudyRequestSchema,
} from './study-edit';
import { USER_TEXT_INVALID_CHARACTERS } from './user-text';

const nodeId = '00000000-0000-4000-8000-00000000000A';

const issuesOf = (body: unknown) => {
  const result = updateStudyRequestSchema.safeParse(body);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

describe('normalizeTagName / tagKey', () => {
  it('applies NFC, trims, and collapses whitespace runs; the key is case-folded', () => {
    expect(normalizeTagName('  Grace \t alone \n')).toBe('Grace alone');
    // "a" + a combining acute accent composes to one code point.
    expect(normalizeTagName('Gra\u0301ce')).toBe('Gr\u00e1ce');
    expect(tagKey(' GRACE  Alone')).toBe('grace alone');
    expect(tagKey('Gra\u0301ce')).toBe(tagKey('GR\u00c1CE'));
  });

  it('folds sharp s like full case folding: STRASSE, Straße and STRAẞE are one tag', () => {
    expect(tagKey('Stra\u00dfe')).toBe('strasse');
    expect(tagKey('STRASSE')).toBe('strasse');
    expect(tagKey('STRA\u1e9eE')).toBe('strasse');
    // The display name keeps what the user typed.
    expect(normalizeTagName('Stra\u00dfe')).toBe('Stra\u00dfe');
  });

  it('treats dotted and dotless I as plain i in every form', () => {
    for (const name of [
      '\u0130stanbul',
      'I\u0307stanbul',
      'i\u0307stanbul',
      'Istanbul',
      'istanbul',
    ]) {
      expect(tagKey(name)).toBe('istanbul');
    }
    expect(tagKey('\u0131l\u0131k')).toBe('ilik');
  });

  it('removes zero-width and other format characters, and folds compatibility forms', () => {
    for (const name of [
      'gr\u200bace',
      '\ufeffgrace',
      'gra\u200dce\u200c',
      'grace\u2060',
      '\uff27\uff52\uff41\uff43\uff45',
      'gra\u00a0\u200bce',
    ]) {
      expect(tagKey(name).replace(' ', '')).toBe('grace');
    }
    expect(tagKey('a \u200b b')).toBe('a b');
    expect(tagKey('\ufb01sh')).toBe('fish');
    expect(tagKey('\u200b')).toBe('');
  });
});

describe('updateStudyRequestSchema', () => {
  it('accepts each editable field, trimming and normalizing text', () => {
    expect(
      updateStudyRequestSchema.parse({
        expectedRevision: 3,
        title: '  New title ',
        description: ' Notes ',
        mainQuestion: { text: ' Why? ' },
        pinned: true,
        tags: { add: ['  grace  alone', 'Faith'], remove: [nodeId] },
      }),
    ).toStrictEqual({
      expectedRevision: 3,
      title: 'New title',
      description: 'Notes',
      mainQuestion: { text: 'Why?' },
      pinned: true,
      tags: { add: ['grace alone', 'Faith'], remove: [nodeId.toLowerCase()] },
    });
    expect(
      updateStudyRequestSchema.parse({ expectedRevision: 1, mainQuestion: { nodeId } }),
    ).toStrictEqual({ expectedRevision: 1, mainQuestion: { nodeId: nodeId.toLowerCase() } });
    expect(
      updateStudyRequestSchema.parse({ expectedRevision: 1, description: null }),
    ).toStrictEqual({ expectedRevision: 1, description: null });
    expect(
      updateStudyRequestSchema.parse({ expectedRevision: 1, tags: { remove: [nodeId] } }),
    ).toStrictEqual({ expectedRevision: 1, tags: { remove: [nodeId.toLowerCase()] } });
  });

  it('needs at least one editable field', () => {
    expect(issuesOf({ expectedRevision: 1 })).toStrictEqual([
      { path: [], message: STUDY_EDIT_EMPTY },
    ]);
  });

  it('refuses unknown members, a cleared title, an empty description, and a question with both forms', () => {
    expect(issuesOf({ expectedRevision: 1, title: 'x', ownerId: nodeId })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, title: null })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, title: '   ' })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, description: '' })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, mainQuestion: { text: 'Why?', nodeId } })).toHaveLength(
      1,
    );
    expect(issuesOf({ expectedRevision: 1, mainQuestion: null })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, description: 'x'.repeat(2001) })).toHaveLength(1);
  });

  it('refuses duplicate, empty, long, control-character, and too many tags with fixed copy', () => {
    const add = (names: string[]) => ({ expectedRevision: 1, tags: { add: names } });
    expect(issuesOf(add(['Grace', ' grace ']))).toStrictEqual([
      { path: ['tags', 'add'], message: TAG_DUPLICATE },
    ]);
    expect(issuesOf(add(['  ']))).toStrictEqual([{ path: ['tags', 'add', 0], message: TAG_EMPTY }]);
    expect(issuesOf(add(['x'.repeat(51)]))).toStrictEqual([
      { path: ['tags', 'add', 0], message: TAG_TOO_LONG },
    ]);
    expect(issuesOf(add(['a\u000bb']))).toStrictEqual([
      { path: ['tags', 'add', 0], message: USER_TEXT_INVALID_CHARACTERS },
    ]);
    const many = Array.from({ length: MAX_STUDY_TAGS + 1 }, (_, i) => `t${i}`);
    expect(issuesOf(add(many))).toStrictEqual([{ path: ['tags', 'add'], message: TOO_MANY_TAGS }]);
    expect(issuesOf(add(many.slice(1)))).toStrictEqual([]);
  });

  it('refuses adds that are duplicates only after folding, and a name that is only format characters', () => {
    const add = (names: string[]) => ({ expectedRevision: 1, tags: { add: names } });
    for (const pair of [
      ['STRASSE', 'Stra\u00dfe'],
      ['\u0130stanbul', 'istanbul'],
      ['grace', 'gr\u200bace'],
      ['grace', '\uff47\uff52\uff41\uff43\uff45'],
    ]) {
      expect(issuesOf(add(pair))).toStrictEqual([
        { path: ['tags', 'add'], message: TAG_DUPLICATE },
      ]);
    }
    expect(issuesOf(add(['\u200b\u200d']))).toStrictEqual([
      { path: ['tags', 'add', 0], message: TAG_EMPTY },
    ]);
  });

  it('refuses an empty tag change, a repeated or malformed removal id, and unknown members', () => {
    expect(issuesOf({ expectedRevision: 1, tags: {} })).toStrictEqual([
      { path: ['tags'], message: TAG_CHANGE_EMPTY },
    ]);
    expect(issuesOf({ expectedRevision: 1, tags: { add: [], remove: [] } })).toStrictEqual([
      { path: ['tags'], message: TAG_CHANGE_EMPTY },
    ]);
    expect(
      issuesOf({ expectedRevision: 1, tags: { remove: [nodeId, nodeId.toLowerCase()] } }),
    ).toStrictEqual([{ path: ['tags', 'remove'], message: TAG_DUPLICATE }]);
    expect(issuesOf({ expectedRevision: 1, tags: { remove: ['Grace'] } })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, tags: ['Grace'] })).toHaveLength(1);
    expect(issuesOf({ expectedRevision: 1, tags: { set: ['Grace'] } })).toContainEqual({
      path: ['tags'],
      message: 'Unrecognized key: "set"',
    });
  });
});
