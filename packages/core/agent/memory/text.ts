/**
 * Text folding and FTS5 query building for memories and people.
 *
 * The FTS table uses `unicode61 remove_diacritics 2`, so the index already
 * ignores case and accents; folding the same way in JS keeps dedup keys,
 * alias lookups and the LIKE fallback consistent with what MATCH sees.
 */

/** Lowercase, accents stripped, whitespace collapsed: "  Café  de OLLA" → "cafe de olla". */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Key two memories share when they say the same thing: folded, without
 * surrounding punctuation ("Likes coffee." and "likes coffee" collide).
 */
export function dedupKey(s: string): string {
  return foldText(s).replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
}

/** Word tokens the way unicode61 splits them (letters and digits; everything else separates). */
export function wordTokens(s: string): string[] {
  return foldText(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Function words dropped from search queries so "qué le gusta a mi esposa"
 * searches for "gusta" and "esposa" instead of OR-matching every memory that
 * contains "a". Kept only when the query has nothing else.
 */
const STOPWORDS = new Set([
  // Spanish (folded)
  'a', 'al', 'algo', 'como', 'con', 'cual', 'cuando', 'de', 'del', 'donde', 'el', 'ella', 'ellos', 'en', 'es', 'esa', 'ese', 'eso',
  'esta', 'este', 'esto', 'fue', 'ha', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'me', 'mi', 'mis', 'muy', 'no', 'nos', 'o',
  'para', 'pero', 'por', 'que', 'quien', 'se', 'si', 'sin', 'sobre', 'son', 'su', 'sus', 'te', 'tu', 'tus', 'u', 'un', 'una',
  'unos', 'unas', 'y', 'ya', 'yo',
  // English
  'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his', 'how', 'i',
  'in', 'is', 'it', 'its', 'my', 'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was',
  'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

const MAX_QUERY_TERMS = 12;
/** Shorter terms match exactly: a 1–2 letter prefix would match half the index. */
const MIN_PREFIX_LENGTH = 3;

/** Distinct search terms for `raw`, without stopwords unless that would leave none. */
export function searchTerms(raw: string): string[] {
  const all = [...new Set(wordTokens(raw))];
  const meaningful = all.filter(t => !STOPWORDS.has(t));
  return (meaningful.length ? meaningful : all).slice(0, MAX_QUERY_TERMS);
}

/**
 * A MATCH expression that can't be used for FTS syntax injection: every term
 * is a double-quoted string made only of letters and digits, so operators
 * (`NEAR`, `AND`, `NOT`), column filters (`content:`), `*`, `^` and quotes in
 * the user's text are either dropped as separators or searched as plain words.
 * Terms are OR-ed (bm25 ranks rows that match more of them first) and prefix
 * matched. Null when the query has no usable tokens (emoji, punctuation).
 */
export function buildFtsQuery(raw: string): string | null {
  const terms = searchTerms(raw);
  if (!terms.length) return null;
  return terms.map(t => (t.length >= MIN_PREFIX_LENGTH ? `"${t}"*` : `"${t}"`)).join(' OR ');
}

/** All of `terms` as exact tokens — candidate lookup for dedup. */
export function buildFtsAllTerms(terms: string[]): string | null {
  const clean = terms.filter(t => /^[\p{L}\p{N}]+$/u.test(t));
  return clean.length ? clean.map(t => `"${t}"`).join(' AND ') : null;
}

/** Escape `%`, `_` and the escape char itself for `LIKE ? ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Single line, trimmed, capped at `max` characters with an ellipsis. */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}
