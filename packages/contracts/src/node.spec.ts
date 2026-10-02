import { describe, expect, it } from 'vitest';
import {
  createNodeRequestSchema,
  NODE_EDIT_EMPTY,
  NODE_ORIGIN_NAMES,
  NODE_ORIGINS,
  nodePreview,
  SOURCE_EXCERPT_KIND_REQUIRED,
  SOURCE_EXCERPT_REQUIRED,
  SOURCE_LOCATION_REQUIRED,
  sourceSchema,
  updateNodeRequestSchema,
} from './node';

const REFERENCE_ID = '1b0f7d9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const SOURCE = { title: 'Romans', kind: 'commentary', locator: 'p. 12' } as const;

const VALID = [
  { type: 'scripture', expectedRevision: 1, referenceId: REFERENCE_ID },
  { type: 'question', expectedRevision: 1, text: 'What is conscience?' },
  {
    type: 'observation',
    expectedRevision: 1,
    text: 'Paul appeals to his conscience.',
    observationKind: 'textual_observation',
  },
  { type: 'thought', expectedRevision: 1, text: 'Maybe it is a witness.' },
  { type: 'conclusion', expectedRevision: 1, text: 'Conscience bears witness.' },
  { type: 'source', expectedRevision: 1, source: SOURCE },
] as const;

/** The field paths of a failed parse (messages never echo the input). */
function failures(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('typed node requests (BIB-25)', () => {
  it.each(VALID)('accepts a valid $type body', (body) => {
    expect(createNodeRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each(VALID)('refuses an unknown key, an origin or a status on a $type body', (body) => {
    for (const extra of [
      { note: 'x' },
      { origin: 'ai' },
      { status: 'answered' },
      { ownerId: 'x' },
    ]) {
      expect(createNodeRequestSchema.safeParse({ ...body, ...extra }).success).toBe(false);
    }
  });

  it("refuses another type's fields, a missing field and an unknown type", () => {
    for (const body of [
      { type: 'thought', expectedRevision: 1, text: 'x', observationKind: 'interpretation' },
      { type: 'question', expectedRevision: 1, referenceId: REFERENCE_ID },
      { type: 'observation', expectedRevision: 1, text: 'x' },
      { type: 'scripture', expectedRevision: 1, text: 'Romans 9:1' },
      { type: 'source', expectedRevision: 1, text: 'x' },
      { type: 'edge', expectedRevision: 1, text: 'x' },
    ]) {
      expect(createNodeRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('bounds text: statements to 4,000 and observation/thought text to 10,000 characters', () => {
    const parse = (type: string, text: string) =>
      createNodeRequestSchema.safeParse({
        type,
        expectedRevision: 1,
        text,
        ...(type === 'observation' ? { observationKind: 'interpretation' } : {}),
      }).success;
    expect([
      parse('question', 'x'.repeat(4000)),
      parse('question', 'x'.repeat(4001)),
      parse('conclusion', 'x'.repeat(4001)),
      parse('thought', 'x'.repeat(10_000)),
      parse('thought', 'x'.repeat(10_001)),
      parse('observation', 'x'.repeat(10_001)),
      parse('thought', '   '),
    ]).toStrictEqual([true, false, false, true, false, false, false]);
  });

  it('refuses control characters and unpaired surrogates in node text and citations', () => {
    expect(
      [
        { type: 'thought', expectedRevision: 1, text: 'a\u0000b' },
        { type: 'thought', expectedRevision: 1, text: 'a\uD800b' },
        { type: 'source', expectedRevision: 1, source: { ...SOURCE, author: 'a\u0007b' } },
      ].map((body) => createNodeRequestSchema.safeParse(body).success),
    ).toStrictEqual([false, false, false]);
  });

  it('trims text and keeps line breaks and tabs', () => {
    expect(
      createNodeRequestSchema.parse({ type: 'thought', expectedRevision: 1, text: '  a\n\tb  ' }),
    ).toStrictEqual({ type: 'thought', expectedRevision: 1, text: 'a\n\tb' });
  });

  it('refuses type, origin and status on an edit, and an edit with nothing to change', () => {
    expect(
      [
        { expectedRevision: 1, type: 'thought', text: 'x' },
        { expectedRevision: 1, origin: 'user', text: 'x' },
        { expectedRevision: 1, status: 'answered', text: 'x' },
      ].map((body) => updateNodeRequestSchema.safeParse(body).success),
    ).toStrictEqual([false, false, false]);
    const empty = updateNodeRequestSchema.safeParse({ expectedRevision: 1 });
    expect(empty.success ? null : empty.error.issues.map((issue) => issue.message)).toStrictEqual([
      NODE_EDIT_EMPTY,
    ]);
    expect(
      updateNodeRequestSchema.safeParse({ expectedRevision: 2, observationKind: 'interpretation' })
        .success,
    ).toBe(true);
  });
});

describe('source citations (BIB-25)', () => {
  it('stores only the fields given, trimmed; an empty optional field is absent', () => {
    expect(
      sourceSchema.parse({
        title: '  Romans  ',
        kind: 'web',
        author: '  ',
        workTitle: '',
        url: ' https://example.org/romans ',
        locator: '',
        excerpt: ' The law written on their hearts ',
        excerptKind: 'quotation',
      }),
    ).toStrictEqual({
      title: 'Romans',
      kind: 'web',
      url: 'https://example.org/romans',
      excerpt: 'The law written on their hearts',
      excerptKind: 'quotation',
    });
  });

  it('needs a URL or a locator', () => {
    expect(failures(sourceSchema.safeParse({ title: 'Romans', kind: 'book' }))).toStrictEqual([
      'locator',
    ]);
    const missing = sourceSchema.safeParse({ title: 'Romans', kind: 'book', url: ' ' });
    expect(missing.success ? null : missing.error.issues[0]?.message).toBe(
      SOURCE_LOCATION_REQUIRED,
    );
  });

  it('takes an excerpt and its kind together or not at all', () => {
    const noKind = sourceSchema.safeParse({ ...SOURCE, excerpt: 'Quoted words' });
    const noExcerpt = sourceSchema.safeParse({ ...SOURCE, excerptKind: 'paraphrase' });
    expect([
      noKind.success ? null : noKind.error.issues.map((i) => [i.path.join('.'), i.message]),
      noExcerpt.success ? null : noExcerpt.error.issues.map((i) => [i.path.join('.'), i.message]),
    ]).toStrictEqual([
      [['excerptKind', SOURCE_EXCERPT_KIND_REQUIRED]],
      [['excerpt', SOURCE_EXCERPT_REQUIRED]],
    ]);
  });

  it('accepts only http and https URLs without credentials', () => {
    const parse = (url: string) => sourceSchema.safeParse({ ...SOURCE, url }).success;
    expect([
      parse('https://example.org/a'),
      parse('http://example.org/a'),
      parse('javascript:alert(1)'),
      parse('data:text/html,hi'),
      parse('//example.org'),
      parse('https://user:pass@example.org'),
      parse(`https://example.org/${'a'.repeat(2048)}`),
    ]).toStrictEqual([true, true, false, false, false, false, false]);
  });

  it('bounds each field and refuses unknown keys and kinds', () => {
    const parse = (extra: object) => sourceSchema.safeParse({ ...SOURCE, ...extra }).success;
    expect([
      parse({ title: 'x'.repeat(200) }),
      parse({ title: 'x'.repeat(201) }),
      parse({ author: 'x'.repeat(201) }),
      parse({ workTitle: 'x'.repeat(201) }),
      parse({ publicationDetails: 'x'.repeat(500) }),
      parse({ publicationDetails: 'x'.repeat(501) }),
      parse({ locator: 'x'.repeat(201) }),
      parse({ excerpt: 'x'.repeat(10_001), excerptKind: 'quotation' }),
      parse({ kind: 'blog' }),
      parse({ rightsNote: 'x' }),
    ]).toStrictEqual([true, false, false, false, true, false, false, false, false, false]);
  });
});

describe('nodePreview', () => {
  it('collapses whitespace, trims and keeps the first 160 code points', () => {
    expect(nodePreview('  Paul\n\n  appeals\tto   conscience  ')).toBe(
      'Paul appeals to conscience',
    );
    expect(nodePreview('x'.repeat(200))).toBe('x'.repeat(160));
  });

  it('counts an astral character once and never splits it', () => {
    const preview = nodePreview('🙂'.repeat(170));
    expect([Array.from(preview).length, preview]).toStrictEqual([160, '🙂'.repeat(160)]);
  });

  it('names every origin as text', () => {
    expect(NODE_ORIGINS.map((origin) => NODE_ORIGIN_NAMES[origin])).toStrictEqual([
      'You',
      'AI Suggested',
      'External Source',
      'Scripture Text',
    ]);
  });
});
