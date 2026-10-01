/**
 * Locale-independent input to `to_tsvector` (BIB-16). PostgreSQL's default text-search parser
 * classifies non-ASCII characters through the database's LC_CTYPE: under `C` (common in
 * containers and managed databases) every non-ASCII character counts as a letter, so `lord’s` or
 * `“behold—you` would each stay one lexeme and the prefilter would silently drop every verse
 * where a word touches a curly quote or an em dash. Under `en_US.UTF-8` they split. ASCII is
 * classified the same in every locale, so blanking the corpus's non-ASCII punctuation and spaces
 * to ASCII spaces before parsing gives the same vector everywhere.
 *
 * `SEARCH_VECTOR_BLANKED_CHARS` is every non-ASCII code point in the pinned WEB corpus text
 * (`bible_verse.text`): none is a letter, mark or digit. It was derived from the corpus, and
 * `test/search-vector-locale.int-spec.ts` re-derives it from the imported corpus and fails if the
 * set changes, so a new character (or a non-ASCII letter, which `C` would also lower-case
 * differently) needs a deliberate decision and a migration.
 *
 * The migration `add_bible_verse_search_vector` spells the same expression as a frozen literal (a
 * migration never imports code that may change later); a test asserts the live column's
 * expression equals `searchVectorSql('text')`, so the two cannot drift.
 */

/** No-break space, em dash, left/right single quotation marks, left/right double quotation marks. */
export const SEARCH_VECTOR_BLANKED_CHARS = '\u00A0\u2014\u2018\u2019\u201C\u201D';

/** A PostgreSQL Unicode-escaped literal (`U&'\00A0...'`) for BMP characters. */
function unicodeLiteral(chars: string): string {
  const escaped = Array.from(chars, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xffff) throw new Error('searchVectorSql: only BMP characters are supported');
    return `\\${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }).join('');
  return `U&'${escaped}'`;
}

/** `translate(<expr>, <blanked chars>, <as many spaces>)`: the text the parser actually reads. */
export function searchVectorInputSql(expr: string): string {
  const spaces = ' '.repeat(Array.from(SEARCH_VECTOR_BLANKED_CHARS).length);
  return `translate(${expr}, ${unicodeLiteral(SEARCH_VECTOR_BLANKED_CHARS)}, '${spaces}')`;
}

/** The `search_vector` expression over a text expression. */
export function searchVectorSql(expr: string): string {
  return `to_tsvector('simple'::regconfig, ${searchVectorInputSql(expr)})`;
}
