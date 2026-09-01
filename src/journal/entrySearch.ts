/**
 * Every decision about what matches what, in one place.
 *
 * The same shape `entryDate.ts` holds for chronology, `entryTags.ts` for
 * tags, and `mentions/mentionQuery.ts` for links: nothing downstream
 * re-derives folding, term splitting, or matching. Pure — no Obsidian, no
 * files, no journal — so the whole of it is testable without a DOM. The
 * reading lives in `services/journalSearch.ts`, which is the only file that
 * knows search touches the disk at all.
 */

/**
 * Below this, a query matches nothing. Scoping the timeline to a query that
 * every entry contains is the same thing as having no scope, and a one-
 * character query is close enough to that to be useless.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * Case folding for search: Turkish casing pairs, no locale.
 *
 * `İ` and `i` are the same letter; `I` and `ı` are the same letter; `i` and
 * `ı` are NOT. Everything else — `ö/o`, `ç/c`, `ş/s`, `ğ/g`, `ü/u`, `â/a` —
 * stays distinct, which is the user's choice: this folds case, not accents.
 *
 * Two fixed substitutions before an ordinary `toLowerCase()`, rather than
 * `toLocaleLowerCase("tr")`. Same result for these letters, but no ICU and
 * no locale, so it cannot vary by platform — which is exactly what
 * `compareEntries` in `services/entryIndex.ts` gave up `localeCompare` to
 * guarantee for a synced vault.
 *
 * Plain `toLowerCase()` alone was rejected: it turns `İ` into `i` plus a
 * combining dot (U+0307), so `istanbul` would not find `İstanbul`. In a
 * Turkish journal that is a daily failure, not a preference.
 *
 * The accepted cost is English's capital `I`, which folds to `ı` — so
 * `"I am happy"` is not found by `"i am"`. Turkish casing cannot be correct
 * and leave that alone at the same time. Pinned by a test in
 * `tests/entrySearch.test.ts` so it stays a decision rather than becoming a
 * bug report.
 *
 * Every substitution here is one code unit in, one code unit out. That is
 * load bearing beyond neatness: `buildSnippet` indexes the original string
 * with offsets found in the folded one, which only holds while folding
 * preserves length. Anything that changed it — NFD expansion, say — would
 * silently misalign every excerpt.
 */
export function foldForSearch(text: string): string {
  return text.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
}

/**
 * Splits a query into folded terms.
 *
 * Whitespace only. No quotes, no `OR`, no `-exclusion`, no field prefixes:
 * query syntax is the first step onto the road CLAUDE.md's `advanced
 * filters` non-goal fences off, and entries are short enough that an AND of
 * terms behaves close to a phrase search anyway.
 *
 * The length floor is measured against the whole trimmed query, not against
 * each term — `a b` is a deliberate two-word search, while `a` is a
 * keystroke on the way to one.
 */
export function parseSearchQuery(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  return trimmed.split(/\s+/).map(foldForSearch);
}

/**
 * Whether every term appears somewhere in `body`. Substring, not fuzzy and
 * not word-bounded: the user is recalling a phrase they wrote themselves,
 * where fuzzy recall adds noise to what is supposed to be an answer, and a
 * word boundary would refuse the half-word people actually remember.
 *
 * No terms means no match, not "everything matches" — see `MIN_QUERY_LENGTH`.
 */
export function bodyMatchesTerms(body: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const folded = foldForSearch(body);
  return terms.every((term) => folded.includes(term));
}
