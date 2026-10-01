import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  type AnchorSelection,
  type CaptureAnchorResponse,
  type ResolveReferenceResponse,
  type ScriptureAnchor,
  type ScriptureReference,
} from '@bible-artisan/contracts';
import request from 'supertest';
import { Op, QueryTypes } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import type { Database } from '../src/database/database';
import { AuthSession } from '../src/database/models/auth-session.model';
import { BibleEdition } from '../src/database/models/bible-edition.model';
import { User } from '../src/database/models/user.model';
import { ENGWEBP_RELEASE } from '../src/modules/bible-content/corpus/engwebp-release';
import { SessionService } from '../src/modules/identity/session.service';
import { createTestApp } from './app';
import { envelope, NOT_FOUND, UNAUTHENTICATED } from './support/envelopes';

/**
 * POST /v1/bible/anchors and POST /v1/bible/anchors/resolve (BIB-18, FR-BIBLE-006) against the
 * real imported WEB corpus. No Scripture is typed: every quote and checksum is read from the stored
 * rows at run time, and offsets are counted in code points over that stored text.
 */

const CAPTURE = '/v1/bible/anchors';
const RESOLVE = '/v1/bible/anchors/resolve';

interface VerseRow {
  bookCode: string;
  chapter: number;
  verse: number;
  text: string;
  textSha256: string;
}

describe('Bible anchor routes', () => {
  let app: INestApplication<Server>;
  let db: Database;
  let editionId: string;
  let alice: string;
  let bob: string;
  const userIds: string[] = [];
  /** `BOOK c:v` -> stored row. */
  const rows = new Map<string, VerseRow>();

  const row = (book: string, chapter: number, verse: number): VerseRow => {
    const found = rows.get(`${book} ${chapter}:${verse}`);
    if (!found) throw new Error(`no stored verse ${book} ${chapter}:${verse}`);
    return found;
  };
  const cps = (text: string) => Array.from(text);
  const slice = (r: VerseRow, start: number, end: number) => cps(r.text).slice(start, end).join('');
  const len = (r: VerseRow) => cps(r.text).length;

  async function signedIn(): Promise<string> {
    const user = await User.create({ normalizedEmail: `${randomUUID()}@example.test` });
    userIds.push(user.id);
    const { token } = await db.transaction((transaction) =>
      app.get(SessionService).create(user.id, transaction),
    );
    return `ba_session=${token}`;
  }

  /** `null` sends no session cookie. */
  const post = (path: string, body: unknown, cookie: string | null = alice) => {
    const req = request(app.getHttpServer())
      .post(path)
      .send(body as object);
    return cookie === null ? req : req.set('Cookie', cookie);
  };

  /** The shared reference POST /bible/resolve gives for typed input (a reference, not Scripture). */
  async function referenceFor(input: string): Promise<ScriptureReference> {
    const res = await post('/v1/bible/resolve', { input, editionId }).expect(200);
    const body = res.body as ResolveReferenceResponse;
    if (body.outcome !== 'resolved') throw new Error('expected a resolved reference');
    return body.reference;
  }

  /** The anchor the server must build: the selection plus each stored verse's checksum. */
  function expectedAnchor(selection: AnchorSelection): ScriptureAnchor {
    return {
      version: 1,
      ...selection,
      segments: selection.segments.map((s) => ({
        ...s,
        textSha256: row(selection.bookCode, s.chapter, s.verse).textSha256,
      })),
    };
  }

  const referenceCount = async (): Promise<number> => {
    const [r] = await db.query<{ n: string }>('SELECT count(*) AS n FROM scripture_reference', {
      type: QueryTypes.SELECT,
    });
    return Number(r?.n);
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
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
    const verses = await db.query<VerseRow>(
      `SELECT book_code AS "bookCode", chapter, verse, text, text_sha256 AS "textSha256"
         FROM bible_verse WHERE edition_id = $1`,
      { bind: [editionId], type: QueryTypes.SELECT },
    );
    expect(verses).toHaveLength(31103);
    for (const v of verses) rows.set(`${v.bookCode} ${v.chapter}:${v.verse}`, v);
    alice = await signedIn();
    bob = await signedIn();
  });

  afterAll(async () => {
    await AuthSession.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await app.close();
  });

  /** The first stored verse (canon order is irrelevant here) whose text contains `ch`. */
  function verseWith(ch: string): VerseRow {
    const found = [...rows.values()]
      .filter((r) => r.text.includes(ch))
      .sort((a, b) =>
        `${a.bookCode} ${a.chapter} ${a.verse}`.localeCompare(
          `${b.bookCode} ${b.chapter} ${b.verse}`,
        ),
      )[0];
    if (!found) throw new Error('fixture character not in the corpus');
    return found;
  }

  describe('POST /v1/bible/anchors (capture)', () => {
    it('captures a phrase inside one verse with code-point offsets, quote and checksum', async () => {
      const v = row('ROM', 9, 1);
      const selection: AnchorSelection = {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 4, end: 20 }],
        quote: slice(v, 4, 20),
      };
      const res = await post(CAPTURE, selection).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toStrictEqual({
        anchor: expectedAnchor(selection),
        reference: await referenceFor('Rom 9:1'),
      });
    });

    it('captures a phrase across verses and across a chapter boundary in one book', async () => {
      const last = row('ROM', 8, 39);
      expect(rows.has('ROM 8:40')).toBe(false);
      const first = row('ROM', 9, 1);
      const selection: AnchorSelection = {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [
          { chapter: 8, verse: 39, start: 10, end: len(last) },
          { chapter: 9, verse: 1, start: 0, end: 12 },
        ],
        quote: `${slice(last, 10, len(last))} ${slice(first, 0, 12)}`,
      };
      const res = await post(CAPTURE, selection).expect(200);
      expect(res.body).toStrictEqual({
        anchor: expectedAnchor(selection),
        reference: await referenceFor('Rom 8:39-9:1'),
      });
    });

    it('captures whole verses, including a verse the edition gives no text for', async () => {
      const [a, empty, b] = [row('LUK', 17, 35), row('LUK', 17, 36), row('LUK', 17, 37)];
      expect(empty.text).toBe('');
      const whole: AnchorSelection = {
        editionId,
        bookCode: 'LUK',
        kind: 'verses',
        segments: [a, empty, b].map((r) => ({
          chapter: 17,
          verse: r.verse,
          start: 0,
          end: len(r),
        })),
        quote: `${a.text} ${b.text}`,
      };
      const res = await post(CAPTURE, whole).expect(200);
      expect(res.body).toStrictEqual({
        anchor: expectedAnchor(whole),
        reference: await referenceFor('Luke 17:35-37'),
      });

      // A phrase may pass through the empty verse, but may not start or end on it.
      const through: AnchorSelection = {
        ...whole,
        kind: 'phrase',
        segments: [
          { chapter: 17, verse: 35, start: len(a) - 5, end: len(a) },
          { chapter: 17, verse: 36, start: 0, end: 0 },
          { chapter: 17, verse: 37, start: 0, end: 3 },
        ],
        quote: `${slice(a, len(a) - 5, len(a))} ${slice(b, 0, 3)}`,
      };
      await post(CAPTURE, through).expect(200);
      const endsOnEmpty = { ...through, segments: through.segments.slice(0, 2) };
      endsOnEmpty.quote = slice(a, len(a) - 5, len(a));
      const res2 = await post(CAPTURE, endsOnEmpty).expect(422);
      expect(res2.body).toStrictEqual(
        envelope({
          code: 'ANCHOR_EMPTY',
          message: 'The selection must start and end on selected text',
        }),
      );
    });

    it('keeps no-break spaces and curly quotes exactly; a folded quote is refused', async () => {
      for (const ch of [' ', '“']) {
        const v = verseWith(ch);
        const at = cps(v.text).indexOf(ch);
        const start = Math.max(0, at - 3);
        const end = Math.min(len(v), at + 4);
        const selection: AnchorSelection = {
          editionId,
          bookCode: v.bookCode,
          kind: 'phrase',
          segments: [{ chapter: v.chapter, verse: v.verse, start, end }],
          quote: slice(v, start, end),
        };
        const ok = await post(CAPTURE, selection).expect(200);
        expect((ok.body as CaptureAnchorResponse).anchor).toStrictEqual(expectedAnchor(selection));
        const folded = selection.quote.replace(' ', ' ').replace('“', '"');
        expect(folded).not.toBe(selection.quote);
        const bad = await post(CAPTURE, { ...selection, quote: folded }).expect(422);
        expect(bad.body).toStrictEqual(
          envelope({
            code: 'ANCHOR_QUOTE_MISMATCH',
            message: 'The selected text does not match this translation',
          }),
        );
      }
    });

    it('refuses every mismatch with a fixed code, writes nothing, and never repairs', async () => {
      const v1 = row('ROM', 9, 1);
      const v2 = row('ROM', 9, 2);
      const base: AnchorSelection = {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 0, end: 5 }],
        quote: slice(v1, 0, 5),
      };
      const cases: [Partial<AnchorSelection>, string, string][] = [
        [
          { segments: [{ chapter: 9, verse: 99, start: 0, end: 1 }] },
          'ANCHOR_VERSE_NOT_FOUND',
          'The selection names a verse this translation does not have',
        ],
        [
          { segments: [{ chapter: 17, verse: 1, start: 0, end: 1 }] },
          'ANCHOR_VERSE_NOT_FOUND',
          'The selection names a verse this translation does not have',
        ],
        [
          { bookCode: 'ZZZ' },
          'ANCHOR_VERSE_NOT_FOUND',
          'The selection names a verse this translation does not have',
        ],
        [
          {
            segments: [
              { chapter: 9, verse: 1, start: 0, end: len(v1) },
              { chapter: 9, verse: 3, start: 0, end: 2 },
            ],
          },
          'ANCHOR_NOT_CONTIGUOUS',
          'The selection must be one continuous passage',
        ],
        [
          // A gap: the first verse's selection stops before its end.
          {
            segments: [
              { chapter: 9, verse: 1, start: 0, end: 3 },
              { chapter: 9, verse: 2, start: 0, end: 3 },
            ],
            quote: `${slice(v1, 0, 3)} ${slice(v2, 0, 3)}`,
          },
          'ANCHOR_NOT_CONTIGUOUS',
          'The selection must be one continuous passage',
        ],
        [
          { segments: [{ chapter: 9, verse: 1, start: 0, end: len(v1) + 1 }] },
          'ANCHOR_OFFSET_OUT_OF_RANGE',
          'The selection runs past the end of a verse',
        ],
        [{ kind: 'verses' }, 'ANCHOR_KIND_MISMATCH', 'A verse selection must cover whole verses'],
        [
          { segments: [{ chapter: 9, verse: 1, start: 3, end: 3 }], quote: '' },
          'ANCHOR_EMPTY',
          'The selection must start and end on selected text',
        ],
        [
          // The text of the next verse at the same offsets: never moved to where it matches.
          { quote: slice(v2, 0, 5) },
          'ANCHOR_QUOTE_MISMATCH',
          'The selected text does not match this translation',
        ],
        [
          { quote: slice(v1, 0, 4) },
          'ANCHOR_QUOTE_MISMATCH',
          'The selected text does not match this translation',
        ],
      ];
      const before = await referenceCount();
      for (const [change, code, message] of cases) {
        const res = await post(CAPTURE, { ...base, ...change }).expect(422);
        expect(res.body).toStrictEqual(envelope({ code, message }));
      }
      expect(await referenceCount()).toBe(before);
    });

    it('answers 404 for an unknown edition and 400 for a malformed selection', async () => {
      const selection = {
        editionId: randomUUID(),
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 0, end: 1 }],
        quote: 'x',
      };
      expect((await post(CAPTURE, selection).expect(404)).body).toStrictEqual(NOT_FOUND);
      const reversed = await post(CAPTURE, {
        ...selection,
        editionId,
        segments: [{ chapter: 9, verse: 1, start: 5, end: 1 }],
      }).expect(400);
      expect(reversed.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { 'segments.0.end': ['A segment cannot end before it starts'] },
        }),
      );
    });

    it('answers 413 for an oversized body', async () => {
      const res = await post(CAPTURE, {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 0, end: 1 }],
        quote: 'x'.repeat(120_000),
      }).expect(413);
      expect(res.body).toStrictEqual(
        envelope({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload Too Large' }),
      );
    });

    it('answers 401 without a session and gives another user the same shared anchor', async () => {
      const v = row('ROM', 9, 1);
      const selection = {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [{ chapter: 9, verse: 1, start: 0, end: 7 }],
        quote: slice(v, 0, 7),
      };
      expect((await post(CAPTURE, selection, null).expect(401)).body).toStrictEqual(
        UNAUTHENTICATED,
      );
      const mine = await post(CAPTURE, selection, alice).expect(200);
      const theirs = await post(CAPTURE, selection, bob).expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
    });
  });

  describe('POST /v1/bible/anchors/resolve', () => {
    async function captured(): Promise<CaptureAnchorResponse> {
      const [a, b] = [row('ROM', 9, 1), row('ROM', 9, 2)];
      const res = await post(CAPTURE, {
        editionId,
        bookCode: 'ROM',
        kind: 'phrase',
        segments: [
          { chapter: 9, verse: 1, start: 6, end: len(a) },
          { chapter: 9, verse: 2, start: 0, end: 9 },
        ],
        quote: `${slice(a, 6, len(a))} ${slice(b, 0, 9)}`,
      }).expect(200);
      return res.body as CaptureAnchorResponse;
    }

    it('re-resolves a captured anchor, kept as JSON, to the identical anchor (survives reload)', async () => {
      const { anchor, reference } = await captured();
      const stored = JSON.parse(JSON.stringify(anchor)) as unknown;
      const res = await post(RESOLVE, { anchor: stored }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toStrictEqual({ outcome: 'resolved', anchor, reference });
    });

    it('reports a changed checksum, quote or offset as unresolved with the original quote', async () => {
      const { anchor, reference } = await captured();
      const [s0, s1] = anchor.segments;
      if (!s0 || !s1) throw new Error('two segments expected');
      const otherSha = row('ROM', 9, 3).textSha256;
      const cases: [ScriptureAnchor, string, ScriptureReference | null][] = [
        [
          { ...anchor, segments: [s0, { ...s1, textSha256: otherSha }] },
          'ANCHOR_CHECKSUM_MISMATCH',
          reference,
        ],
        [{ ...anchor, quote: `${anchor.quote}.` }, 'ANCHOR_QUOTE_MISMATCH', reference],
        [
          { ...anchor, segments: [s0, { ...s1, end: 999 }] },
          'ANCHOR_OFFSET_OUT_OF_RANGE',
          reference,
        ],
        [
          { ...anchor, segments: [{ ...s0, end: s0.end - 1 }, s1] },
          'ANCHOR_NOT_CONTIGUOUS',
          reference,
        ],
        [
          { ...anchor, segments: [s0, { ...s1, chapter: 9, verse: 4 }] },
          'ANCHOR_NOT_CONTIGUOUS',
          null,
        ],
        [{ ...anchor, segments: [{ ...s0, chapter: 99 }] }, 'ANCHOR_VERSE_NOT_FOUND', null],
        [{ ...anchor, editionId: randomUUID() }, 'ANCHOR_EDITION_UNAVAILABLE', null],
      ];
      for (const [tampered, reason, ref] of cases) {
        const res = await post(RESOLVE, { anchor: tampered }).expect(200);
        expect(res.body).toStrictEqual({
          outcome: 'unresolved',
          reason,
          anchor: tampered,
          reference: ref,
        });
      }
    });

    it('answers 400 for a malformed anchor and 401 without a session', async () => {
      const { anchor } = await captured();
      const res = await post(RESOLVE, { anchor: { ...anchor, version: 2 } }).expect(400);
      expect(res.body).toStrictEqual(
        envelope({
          code: 'VALIDATION',
          message: 'Invalid request',
          fieldErrors: { 'anchor.version': ['Invalid input: expected 1'] },
        }),
      );
      expect((await post(RESOLVE, { anchor }, null).expect(401)).body).toStrictEqual(
        UNAUTHENTICATED,
      );
    });

    it('gives another user the same shared resolution', async () => {
      const { anchor } = await captured();
      const mine = await post(RESOLVE, { anchor }, alice).expect(200);
      const theirs = await post(RESOLVE, { anchor }, bob).expect(200);
      expect(theirs.body).toStrictEqual(mine.body);
    });
  });
});
