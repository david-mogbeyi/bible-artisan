import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { SearchBibleResponse, SearchResult } from '@bible-artisan/contracts';
import request from 'supertest';
import { Op, QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { ScriptureReference } from '../src/database/models/scripture-reference.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import {
  CANDIDATES_SQL,
  MAX_SCANNED_CANDIDATES,
} from '../src/modules/bible-content/search/search.service';
import { tokenize } from '../src/modules/bible-content/search/search-text';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

/**
 * GET /v1/bible/search (BIB-16) against the real imported WEB corpus. No Scripture is typed:
 * every term and phrase is extracted from stored verses at run time, and expectations come from
 * oracles written independently of the service (regular expressions over the stored text), run
 * over all 31,103 verses. Sampling uses a fixed seed so failures reproduce.
 */

interface Verse {
  bookCode: string;
  chapter: number;
  verse: number;
  text: string;
  sequence: number;
  name: string;
}

const keyOf = (v: { bookCode: string; chapter: number; verse: number }): string =>
  `${v.bookCode} ${v.chapter}:${v.verse}`;
const resultKey = (r: SearchResult): string => keyOf(r.reference);

/** Deterministic PRNG (mulberry32) so a sampled failure can be reproduced. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}]`;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Oracle: whole-word, case-insensitive occurrences of `term` (a regex, not the tokenizer). */
function wordOccurrences(text: string, term: string): number {
  const re = new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(term)}(?!${WORD_CHAR})`, 'giu');
  return text.match(re)?.length ?? 0;
}

/**
 * Oracle form of a text for phrase checks: lower-case; quotation marks, apostrophes and hyphens
 * become spaces; dashes become one dash; whitespace collapses; spaces around punctuation go.
 * A phrase matches where its form occurs in the verse's form on word boundaries.
 */
function oracleForm(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`\u00AB\u00B4\u00BB\u2018-\u201F\u2032\u2033\u2039\u203A\-\u2010\u2011]/g, ' ')
    .replace(/[\u2012-\u2015\u2212]/g, '\u2014')
    .replace(/\s+/gu, ' ')
    .replace(/ ?([^\p{L}\p{M}\p{N} ]) ?/gu, '$1')
    .trim();
}

function phraseOracle(verseForm: string, phraseForm: string): boolean {
  const word = new RegExp(WORD_CHAR, 'u');
  for (
    let at = verseForm.indexOf(phraseForm);
    at >= 0;
    at = verseForm.indexOf(phraseForm, at + 1)
  ) {
    const before = verseForm[at - 1];
    const after = verseForm[at + phraseForm.length];
    if (
      (before === undefined || !word.test(before)) &&
      (after === undefined || !word.test(after))
    ) {
      return true;
    }
  }
  return false;
}

const phraseFormOf = (input: string): string =>
  oracleForm(input).replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');

/** A highlight's code points from the stored text. */
const slice = (text: string, h: { start: number; end: number }): string =>
  Array.from(text).slice(h.start, h.end).join('');

/**
 * Server latency per search request, as NFR-PERF-002 states it: each request's `durationMs` from
 * its own access line (first middleware to response finish). Collected only while `recording`.
 */
const serverMs: number[] = [];
let recording = false;
const ignore = (): void => undefined;
const accessRecorder = {
  log: (message: unknown, ...params: unknown[]): void => {
    if (!recording || message !== 'http_request') return;
    for (const p of params) {
      if (typeof p === 'object' && p !== null && 'durationMs' in p && 'route' in p) {
        if (p.route === '/v1/bible/search' && typeof p.durationMs === 'number') {
          serverMs.push(p.durationMs);
        }
      }
    }
  },
  error: ignore,
  warn: ignore,
};

describe('GET /v1/bible/search', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let editionId: string;
  let alice: string;
  let bob: string;
  const userIds: string[] = [];
  let corpus: Verse[];
  let byKey: Map<string, Verse>;
  let forms: Map<string, string>;
  /** Corpus words (lower-cased) by the number of verses containing them, most frequent first. */
  let byFrequency: [string, number][];
  const searchPath = '/v1/bible/search';

  const searchAs = (cookie: string | undefined, query: Record<string, string>) => {
    const req = request(app.getHttpServer()).get(searchPath).query(query);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const search = (query: Record<string, string>) => searchAs(alice, { editionId, ...query });

  /** Follows nextCursor to the end; returns every result and the number of requests. */
  async function allPages(
    query: Record<string, string>,
  ): Promise<{ results: SearchResult[]; requests: number }> {
    const results: SearchResult[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const res = await search({ limit: '100', ...query, ...(cursor ? { cursor } : {}) }).expect(
        200,
      );
      const body = res.body as SearchBibleResponse;
      expect(body.results.length).toBeLessThanOrEqual(100);
      results.push(...body.results);
      cursor = body.nextCursor;
      requests += 1;
      if (requests > 400) throw new Error('search did not terminate');
    } while (cursor);
    return { results, requests };
  }

  /** Stored text and label are the corpus's; no result repeats. */
  function expectVerbatim(results: SearchResult[]): void {
    expect(new Set(results.map(resultKey)).size).toBe(results.length);
    for (const r of results) {
      const stored = byKey.get(resultKey(r));
      expect(stored).toBeDefined();
      expect(r.text).toBe(stored?.text);
      expect(r.reference.label).toBe(`${stored?.name} ${r.reference.chapter}:${r.reference.verse}`);
    }
  }

  async function signedIn(): Promise<string> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return `ba_session=${token}`;
  }

  /** Random corpus tokens of at least `min` letters from one verse (lower-cased, distinct). */
  function wordsOf(v: Verse, min: number): string[] {
    return [
      ...new Set(
        Array.from(v.text.matchAll(/[\p{L}\p{M}\p{N}]+/gu), (m) => m[0].toLowerCase()).filter(
          (w) => w.length >= min,
        ),
      ),
    ];
  }

  beforeAll(async () => {
    app = await createTestApp(AppModule, { logger: accessRecorder });
    db = app.get<Database>(DATABASE);
    const edition = await BibleEdition.findOne({
      where: {
        code: ENGWEBP_RELEASE.code,
        sourceRelease: ENGWEBP_RELEASE.sourceRelease,
        activatedAt: { [Op.ne]: null },
      },
      rejectOnEmpty: true,
    });
    editionId = edition.id;
    corpus = await db.query<Verse>(
      `SELECT v.book_code AS "bookCode", v.chapter, v.verse, v.text, b.sequence, b.name
         FROM bible_verse v
         JOIN bible_book b ON b.edition_id = v.edition_id AND b.code = v.book_code
        WHERE v.edition_id = $1
        ORDER BY b.sequence, v.chapter, v.verse`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(corpus).toHaveLength(31103);
    byKey = new Map(corpus.map((v) => [keyOf(v), v]));
    forms = new Map(corpus.map((v) => [keyOf(v), oracleForm(v.text)]));
    const counts = new Map<string, number>();
    for (const v of corpus) {
      for (const w of new Set(wordsOf(v, 1))) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    alice = await signedIn();
    bob = await signedIn();
  });

  afterAll(async () => {
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  describe('terms mode', () => {
    it('returns exactly the verses containing every term as a whole word, across all pages', async () => {
      const pick = prng(16);
      const sets: string[][] = [];
      while (sets.length < 8) {
        const v = corpus[pick(corpus.length)];
        const words = v ? wordsOf(v, 6) : [];
        if (words.length < 2) continue;
        const a = words[pick(words.length)] ?? '';
        const b = words.filter((w) => w !== a)[pick(words.length - 1)] ?? '';
        const set = sets.length % 3 === 0 ? [a] : [a, b];
        // Mixed case and duplicates in the typed query must not matter.
        sets.push(set);
      }
      for (const terms of sets) {
        const q = [...terms.map((t) => t.toUpperCase()), terms[0] ?? ''].join(' ');
        const { results } = await allPages({ q });
        const expected = corpus
          .filter((v) => terms.every((t) => wordOccurrences(v.text, t) > 0))
          .map(keyOf);
        expect(expected.length).toBeGreaterThan(0);
        expect(results.map(resultKey).sort()).toStrictEqual([...expected].sort());
        expectVerbatim(results);
        for (const r of results) {
          const marked = r.highlights.map((h) => slice(r.text, h).toLowerCase());
          const occurrences = terms.reduce((n, t) => n + wordOccurrences(r.text, t), 0);
          expect(marked).toHaveLength(occurrences);
          for (const word of marked) expect(terms).toContain(word);
        }
      }
    });

    it('does not stem: a typed word never matches a longer inflection', async () => {
      // A corpus word whose plural with "s" also occurs, both found by the regex oracle.
      const base = corpus
        .flatMap((v) => wordsOf(v, 5))
        .find(
          (w) =>
            corpus.some((v) => wordOccurrences(v.text, `${w}s`) > 0) &&
            corpus.filter((v) => wordOccurrences(v.text, w) > 0).length < 300,
        );
      if (!base) throw new Error('no inflected word found');
      const { results } = await allPages({ q: base });
      for (const r of results) expect(wordOccurrences(r.text, base)).toBeGreaterThan(0);
      const pluralOnly = corpus.filter(
        (v) => wordOccurrences(v.text, `${base}s`) > 0 && wordOccurrences(v.text, base) === 0,
      );
      expect(pluralOnly.length).toBeGreaterThan(0);
      const returned = new Set(results.map(resultKey));
      for (const v of pluralOnly) expect(returned.has(keyOf(v))).toBe(false);
    });

    it('treats query operators and SQL as plain separators, never syntax', async () => {
      const v = corpus.find((x) => wordsOf(x, 6).length >= 2);
      const [a, b] = v ? wordsOf(v, 6) : [];
      if (!a || !b) throw new Error('no sample verse');
      const plain = await search({ q: `${a} ${b}` }).expect(200);
      for (const hostile of [
        `${a} & !${b}`,
        `(${a} | ${b}:*)`,
        `'${a}' <-> "${b}" \\`,
        `${a}:* & ${b}:*`,
        `${a}\u0000${b}`,
      ]) {
        const res = await search({ q: hostile }).expect(200);
        expect(res.body).toStrictEqual(plain.body);
      }
      const injection = await search({ q: `${a}'); DROP TABLE bible_verse; --` }).expect(200);
      expect((injection.body as SearchBibleResponse).results).toStrictEqual([]);
      expect(await db.query(`SELECT 1 FROM bible_verse LIMIT 1`)).toBeDefined();
      for (const q of ['&|!:*()<>', "' \\ “” — …"]) {
        const res = await search({ q }).expect(400);
        expect(res.body).toStrictEqual(
          envelope({
            code: 'VALIDATION',
            message: 'Invalid request',
            fieldErrors: { q: ['Enter at least one word'] },
          }),
        );
      }
    });

    it('filters by book and still returns every match in it', async () => {
      const v = corpus.find((x) => x.bookCode === 'ROM' && wordsOf(x, 5).length > 0);
      const term = v ? wordsOf(v, 5)[0] : undefined;
      if (!term) throw new Error('no sample verse');
      const { results } = await allPages({ q: term, book: 'ROM' });
      const expected = corpus
        .filter((x) => x.bookCode === 'ROM' && wordOccurrences(x.text, term) > 0)
        .map(keyOf);
      expect(results.map(resultKey).sort()).toStrictEqual(expected.sort());
    });
  });

  describe('phrase mode', () => {
    it('finds sampled real phrases, and returns exactly the verses containing them', async () => {
      const pick = prng(1600);
      let checked = 0;
      for (let attempt = 0; checked < 12 && attempt < 1000; attempt++) {
        const v = corpus[pick(corpus.length)];
        if (!v) continue;
        const { tokens } = tokenize(v.text);
        const k = 2 + pick(3);
        if (tokens.length < k) continue;
        const i = pick(tokens.length - k + 1);
        const window = tokens.slice(i, i + k);
        // Only plain-space windows here (punctuation is covered below), with one rarer word so a
        // full traversal stays small.
        const raw = v.text.slice(window[0]?.start, window[k - 1]?.end);
        if (!/^[\p{L}\p{M}\p{N}\s]+$/u.test(raw) || !window.some((t) => t.norm.length >= 6)) {
          continue;
        }
        const { results } = await allPages({ q: raw, mode: 'phrase' });
        const form = phraseFormOf(raw);
        const expected = corpus
          .filter((x) => phraseOracle(forms.get(keyOf(x)) ?? '', form))
          .map(keyOf);
        expect(expected).toContain(keyOf(v));
        expect(results.map(resultKey).sort()).toStrictEqual([...expected].sort());
        expectVerbatim(results);
        for (const r of results) {
          expect(r.highlights.length).toBeGreaterThan(0);
          for (const h of r.highlights) expect(phraseFormOf(slice(r.text, h))).toBe(form);
        }
        checked += 1;
      }
      expect(checked).toBe(12);
    });

    it('never invents adjacency across punctuation the phrase does not contain', async () => {
      const cases = corpus
        .flatMap((v) =>
          Array.from(v.text.matchAll(/([\p{L}]{4,})([.,;:!?]) ([\p{L}]{4,})/gu), (m) => ({
            v,
            joined: `${m[1]} ${m[3]}`,
            punctuated: m[0],
          })),
        )
        .filter((_, i) => i % 997 === 0)
        .slice(0, 8);
      expect(cases.length).toBe(8);
      for (const { v, joined, punctuated } of cases) {
        const without = await allPages({ q: joined, mode: 'phrase' });
        const form = phraseFormOf(joined);
        expect(without.results.map(resultKey)).not.toContain(keyOf(v));
        for (const r of without.results) {
          expect(phraseOracle(forms.get(resultKey(r)) ?? '', form)).toBe(true);
        }
        const withIt = await allPages({ q: punctuated, mode: 'phrase' });
        expect(withIt.results.map(resultKey)).toContain(keyOf(v));
      }
    });

    it('matches curly apostrophes, hyphenated words and no-break spaces from plain typing', async () => {
      const find = (re: RegExp): { v: Verse; m: RegExpMatchArray } => {
        for (const v of corpus) {
          const m = v.text.match(re);
          if (m) return { v, m };
        }
        throw new Error(`no verse matches ${re.source}`);
      };
      const curly = find(/(\p{L}+)’(\p{L}+) (\p{L}+)/u);
      const hyphen = find(/(\p{L}+)-(\p{L}+) (\p{L}+)/u);
      // The publisher's no-break spaces sit between closing quotation marks after a verse's last
      // word: type the last two words and everything after them, with a plain space instead.
      const nbspVerse = corpus.find((v) => v.text.includes('\u00a0'));
      if (!nbspVerse) throw new Error('no verse with a no-break space');
      const at = nbspVerse.text.indexOf('\u00a0');
      const { tokens } = tokenize(nbspVerse.text);
      const lastTwo = tokens.filter((t) => t.end <= at).slice(-2);
      if (lastTwo.length !== 2) throw new Error('no words before the no-break space');
      const nbspTyped = nbspVerse.text.slice(lastTwo[0]?.start).replace(/\u00a0/g, ' ');
      expect(nbspTyped).not.toContain('\u00a0');
      for (const [{ v }, typed] of [
        [curly, `${curly.m[1]}'${curly.m[2]} ${curly.m[3]}`],
        [hyphen, `${hyphen.m[1]} ${hyphen.m[2]} ${hyphen.m[3]}`],
        [{ v: nbspVerse }, nbspTyped],
      ] as const) {
        const { results } = await allPages({ q: `"${typed}"`, mode: 'phrase' });
        const hit = results.find((r) => resultKey(r) === keyOf(v));
        expect(hit?.text).toBe(v.text);
      }
    });

    it('scans a bounded number of candidates per request and still finds every match', async () => {
      // The commonest word twice: nearly every verse is a candidate, almost none match.
      const [common, candidates] = byFrequency[0] ?? [];
      if (!common || !candidates) throw new Error('no common word');
      expect(candidates).toBeGreaterThan(MAX_SCANNED_CANDIDATES * 5);
      const first = await search({ q: `${common} ${common}`, mode: 'phrase' }).expect(200);
      expect((first.body as SearchBibleResponse).nextCursor).toEqual(expect.any(String));

      const { results, requests } = await allPages({ q: `${common} ${common}`, mode: 'phrase' });
      expect(requests).toBeLessThanOrEqual(Math.ceil(candidates / MAX_SCANNED_CANDIDATES) + 1);
      const form = phraseFormOf(`${common} ${common}`);
      const expected = corpus.filter((v) => phraseOracle(forms.get(keyOf(v)) ?? '', form));
      expect(results.map(resultKey).sort()).toStrictEqual(expected.map(keyOf).sort());
    });

    it('searches reference-shaped text literally instead of resolving it', async () => {
      const before = await ScriptureReference.count();
      const res = await search({ q: 'Rom 9:1', mode: 'phrase' }).expect(200);
      expect(res.body).toStrictEqual({ results: [], nextCursor: null });
      expect(await ScriptureReference.count()).toBe(before);
    });
  });

  describe('order and pages', () => {
    it('orders by rank, then canonical order, and pages without gaps or repeats', async () => {
      // A word in a few hundred verses: several pages, and ties in rank.
      const term = byFrequency.find(([w, n]) => w.length >= 4 && n >= 300 && n <= 600)?.[0];
      if (!term) throw new Error('no sample word');
      const big = await search({ q: term, limit: '100' }).expect(200);
      const one = big.body as SearchBibleResponse;
      expect(one.results.length).toBe(100);

      const pages: SearchResult[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const res = await search({ q: term, ...(cursor ? { cursor } : {}) }).expect(200);
        const body = res.body as SearchBibleResponse;
        expect(body.results).toHaveLength(25);
        pages.push(...body.results);
        cursor = body.nextCursor ?? undefined;
      }
      expect(pages).toStrictEqual(one.results);

      const ranks = await db.query<{ k: string; rank: number; sequence: number }>(
        `SELECT v.book_code || ' ' || v.chapter || ':' || v.verse AS k, b.sequence,
                ts_rank(v.search_vector, plainto_tsquery('simple', $2)) AS rank
           FROM bible_verse v JOIN bible_book b ON b.edition_id = v.edition_id AND b.code = v.book_code
          WHERE v.edition_id = $1 AND v.search_vector @@ plainto_tsquery('simple', $2)`,
        { bind: [editionId, term], type: QueryTypes.SELECT },
      );
      const rankOf = new Map(ranks.map((r) => [r.k, r]));
      const ordered = one.results.map((r) => {
        const row = rankOf.get(resultKey(r));
        return { rank: row?.rank ?? -1, sequence: row?.sequence ?? 0, ...r.reference };
      });
      for (let i = 1; i < ordered.length; i++) {
        const [a, b] = [ordered[i - 1], ordered[i]];
        if (!a || !b) continue;
        expect(a.rank).toBeGreaterThanOrEqual(b.rank);
        if (a.rank === b.rank) {
          expect(
            a.sequence < b.sequence ||
              (a.sequence === b.sequence &&
                (a.chapter < b.chapter || (a.chapter === b.chapter && a.verse < b.verse))),
          ).toBe(true);
        }
      }
    });

    it('defaults to 25 results and reports the last page with a null cursor', async () => {
      const rare = byFrequency.find(([w, n]) => w.length >= 6 && n >= 5 && n < 25)?.[0];
      if (!rare) throw new Error('no sample word');
      const expected = corpus.filter((x) => wordOccurrences(x.text, rare) > 0);
      expect(expected.length).toBeLessThan(25);
      const res = await search({ q: rare }).expect(200);
      expect((res.body as SearchBibleResponse).results).toHaveLength(expected.length);
      expect((res.body as SearchBibleResponse).nextCursor).toBeNull();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects a cursor from another query or one it never issued', async () => {
      const first = await search({ q: 'the', limit: '1' }).expect(200);
      const cursor = (first.body as SearchBibleResponse).nextCursor ?? '';
      const invalid = envelope({
        code: 'VALIDATION',
        message: 'Invalid request',
        fieldErrors: { cursor: ['Invalid cursor'] },
      });
      const foreign: Record<string, string>[] = [
        { q: 'and', cursor },
        { q: 'the', cursor, mode: 'phrase' },
        { q: 'the', cursor, book: 'GEN' },
        { q: 'the', cursor: 'bm90LWEtY3Vyc29y' },
      ];
      for (const query of foreign) {
        const res = await search(query).expect(400);
        expect(res.body).toStrictEqual(invalid);
      }
    });
  });

  describe('validation, references, access', () => {
    it('answers 422 for terms that are a Bible reference, without persisting anything', async () => {
      const before = await ScriptureReference.count();
      for (const q of ['Rom 9:1', 'John', 'Phil 4:1', 'Gen 99:1', 'Rom 9:1-2:3', 'Rom 9:1, 3']) {
        const res = await search({ q }).expect(422);
        expect(res.body).toStrictEqual(
          envelope({
            code: 'SEARCH_QUERY_IS_REFERENCE',
            message: 'This is a Bible reference. Look it up as a reference instead',
          }),
        );
      }
      expect(await ScriptureReference.count()).toBe(before);
    });

    it('rejects malformed parameters with fixed messages that never echo the input', async () => {
      const cases: [Record<string, string>, Record<string, string[]>][] = [
        [{ q: '' }, { q: ['Too small: expected string to have >=1 characters'] }],
        [{ q: 'a'.repeat(201) }, { q: ['Too big: expected string to have <=200 characters'] }],
        [
          { q: Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ') },
          { q: ['Enter at most 20 words'] },
        ],
        [{ q: 'faith', limit: '101' }, { limit: ['Enter a whole number from 1 to 100'] }],
        [{ q: 'faith', limit: '0' }, { limit: ['Enter a whole number from 1 to 100'] }],
        [{ q: 'faith', book: 'XYZ' }, { book: ['No book in this translation has that code'] }],
        [{ q: 'faith', book: 'romans' }, { book: ['Enter a book code such as ROM'] }],
      ];
      for (const [query, fieldErrors] of cases) {
        const res = await search(query).expect(400);
        expect(res.body).toStrictEqual(
          envelope({ code: 'VALIDATION', message: 'Invalid request', fieldErrors }),
        );
      }
      const missing = await searchAs(alice, { q: 'faith' }).expect(400);
      expect(missing.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { editionId: ['Invalid input: expected string, received undefined'] },
        }),
      );
      const repeated = await request(app.getHttpServer())
        .get(`${searchPath}?editionId=${editionId}&q=faith&q=hope`)
        .set('Cookie', alice)
        .expect(400);
      expect(repeated.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { q: ['Invalid input: expected string, received array'] },
        }),
      );
    });

    it('answers 404 for an unknown edition and 401 without a session', async () => {
      const unknown = await searchAs(alice, { q: 'faith', editionId: randomUUID() }).expect(404);
      expect(unknown.body).toStrictEqual(NOT_FOUND);
      const anonymous = await searchAs(undefined, { q: 'faith', editionId }).expect(401);
      expect(anonymous.body).toStrictEqual(UNAUTHENTICATED);
    });

    it('gives another user the same shared results for the same query', async () => {
      const v = corpus.find((x) => wordsOf(x, 7).length > 0);
      const term = v ? wordsOf(v, 7)[0] : undefined;
      if (!term) throw new Error('no sample verse');
      const mine = await searchAs(alice, { q: term, editionId }).expect(200);
      const theirs = await request(app.getHttpServer())
        .get('/v1/bible/search')
        .query({ q: term, editionId })
        .set('Cookie', bob)
        .expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
      expect((mine.body as SearchBibleResponse).results.length).toBeGreaterThan(0);
    });
  });

  describe('index and corpus integrity', () => {
    it('keeps search_vector a generated column of the text, GIN-indexed, with the corpus intact', async () => {
      const [column] = await db.query<{ generated: string; expression: string }>(
        `SELECT a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS expression
           FROM pg_attribute a
           JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'bible_verse'::regclass AND a.attname = 'search_vector'`,
        { type: QueryTypes.SELECT },
      );
      expect(column).toStrictEqual({
        generated: 's',
        expression: "to_tsvector('simple'::regconfig, text)",
      });
      const indexes = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'bible_verse' AND indexname = 'bible_verse_search_vector_idx'`,
        { type: QueryTypes.SELECT },
      );
      expect(indexes.map((i) => i.indexdef.replace(/^.* USING /, ''))).toStrictEqual([
        'gin (search_vector)',
      ]);

      const [state] = await db.query<{ drift: number; checksum: boolean; triggers: number }>(
        `SELECT
           (SELECT count(*)::int FROM bible_verse
             WHERE search_vector IS DISTINCT FROM to_tsvector('simple'::regconfig, text)) AS drift,
           (SELECT bible_edition_content_sha256(id) = $2 FROM bible_edition WHERE id = $1)
             AS checksum,
           (SELECT count(*)::int FROM pg_trigger
             WHERE tgrelid = 'bible_verse'::regclass AND NOT tgisinternal AND tgenabled = 'O')
             AS triggers`,
        { bind: [editionId, ENGWEBP_RELEASE.contentSha256], type: QueryTypes.SELECT },
      );
      expect(state).toStrictEqual({ drift: 0, checksum: true, triggers: 3 });

      for (const sql of [
        `UPDATE bible_verse SET search_vector = to_tsvector('simple', 'x') WHERE book_code = 'GEN'`,
        `UPDATE bible_verse SET search_vector = DEFAULT WHERE book_code = 'GEN'`,
      ]) {
        const error = await db.query(sql).catch((e: unknown) => e);
        expect((error as { parent?: { code?: string } }).parent?.code).toMatch(/^(428C9|23000)$/);
      }
    });

    it('serves the candidate query from the GIN index', async () => {
      const rare = byFrequency.find(([w, n]) => w.length >= 6 && n >= 5 && n < 25)?.[0];
      if (!rare) throw new Error('no sample word');
      // Planner statistics only (no row changes): the reversibility suite may have just re-imported
      // the corpus, and autovacuum's analyze after a bulk load is not deterministic in a test run.
      await db.query('ANALYZE bible_verse');
      const plan = await db.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${CANDIDATES_SQL}`,
        {
          bind: [editionId, rare, null, null, null, null, null, 26],
          type: QueryTypes.SELECT,
        },
      );
      expect(JSON.stringify(plan)).toContain('bible_verse_search_vector_idx');
    });

    it('never loses a true match in the prefilter: every token’s lexemes are in its verse’s vector', async () => {
      const vectors = await db.query<{ k: string; lexemes: string[] }>(
        `SELECT book_code || ' ' || chapter || ':' || verse AS k,
                tsvector_to_array(search_vector) AS lexemes
           FROM bible_verse WHERE edition_id = $1`,
        { bind: [editionId], type: QueryTypes.SELECT },
      );
      const lexemesOf = new Map(vectors.map((r) => [r.k, new Set(r.lexemes)]));
      const tokens = [
        ...new Set(corpus.flatMap((v) => tokenize(v.text).tokens.map((t) => t.norm))),
      ];
      const parsed = await db.query<{ token: string; lexemes: string[] }>(
        `SELECT t AS token, tsvector_to_array(to_tsvector('simple'::regconfig, t)) AS lexemes
           FROM unnest($1::text[]) AS t`,
        { bind: [tokens], type: QueryTypes.SELECT },
      );
      const tokenLexemes = new Map(parsed.map((r) => [r.token, r.lexemes]));
      let missing = 0;
      for (const v of corpus) {
        const have = lexemesOf.get(keyOf(v));
        for (const t of tokenize(v.text).tokens) {
          const need = tokenLexemes.get(t.norm) ?? [];
          if (need.length === 0 || !need.every((l) => have?.has(l))) missing += 1;
        }
      }
      expect(tokens.length).toBeGreaterThan(10000);
      expect(missing).toBe(0);
    });
  });

  describe('performance (NFR-PERF-002)', () => {
    it('keeps p95 server latency within 750 ms for 100 concurrent searches', async () => {
      const words = byFrequency.map(([w]) => w);
      const [w0 = '', w1 = '', w2 = ''] = words;
      const mid = words[200] ?? '';
      // Worst cases: the commonest words (every match is ranked) and a phrase of the commonest
      // word twice (the full candidate bound is scanned and almost nothing verifies).
      const mix: Record<string, string>[] = [
        { q: w0 },
        { q: `${w0} ${w1}`, limit: '100' },
        { q: `${w0} ${w0}`, mode: 'phrase' },
        { q: `${w1} ${w2}`, mode: 'phrase' },
        { q: mid },
      ];
      await Promise.all(mix.map((query) => search(query).expect(200))); // warm caches
      serverMs.length = 0;
      recording = true;
      try {
        await Promise.all(
          Array.from({ length: 100 }, (_, i) => search(mix[i % mix.length] ?? {}).expect(200)),
        );
      } finally {
        recording = false;
      }
      expect(serverMs).toHaveLength(100);
      serverMs.sort((a, b) => a - b);
      expect(serverMs[94]).toBeLessThanOrEqual(750);
    });
  });
});
