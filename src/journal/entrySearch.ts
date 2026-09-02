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
 * Case folding for search: the four i's are one letter, no locale.
 *
 * `İ`, `I`, `ı` and `i` all fold to `i`. Everything else — `ö/o`, `ç/c`,
 * `ş/s`, `ğ/g`, `ü/u`, `â/a` — stays distinct, which is the user's choice:
 * this folds case, not accents.
 *
 * One fixed substitution before an ordinary `toLowerCase()`, rather than
 * `toLocaleLowerCase("tr")`. No ICU and no locale, so it cannot vary by
 * platform — which is exactly what `compareEntries` in
 * `services/entryIndex.ts` gave up `localeCompare` to guarantee for a synced
 * vault. It also leaves no `I`/`İ` behind for `toLowerCase()` to turn into
 * `i` plus a combining dot (U+0307), which is what made `istanbul` miss
 * `İstanbul` before any of this existed.
 *
 * Turkish casing alone — `İ`→`i`, `I`→`ı` — was the first answer and was
 * wrong in the other direction: English's capital `I` folded to `ı`, so
 * `i am` did not find `I am happy`. Two languages, the same daily failure,
 * and no case mapping can be right for both while `i` and `ı` stay apart.
 *
 * So they do not stay apart, and the cost is over-matching: `ısı` also finds
 * `isi`, `sık` also finds `sik`. That is the right direction for the error to
 * run. An extra row in a list is something the user reads past; a missing row
 * is a search that lost what they wrote. Both halves are pinned by tests in
 * `tests/entrySearch.test.ts` so this stays a decision rather than becoming a
 * bug report either way.
 *
 * Every substitution here is one code unit in, one code unit out. That is
 * load bearing beyond neatness: `buildSnippet` indexes the original string
 * with offsets found in the folded one, which only holds while folding
 * preserves length. Anything that changed it — NFD expansion, say — would
 * silently misalign every excerpt.
 */
export function foldForSearch(text: string): string {
  return text.replace(/[İIı]/g, "i").toLowerCase();
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

/** Characters of context kept on each side of a match in a suggester row. */
export const SNIPPET_CONTEXT = 60;

/**
 * One row's worth of an entry, split so the caller can emphasise the match
 * with `createSpan` rather than by building markup out of the user's own
 * text. `match` is empty when nothing matched, in which case `before` holds
 * the head of the body — a row is still better than a blank.
 */
export interface SearchSnippet {
  before: string;
  match: string;
  after: string;
}

/** Collapses every run of whitespace to one space, so a row stays one line. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * The excerpt around the FIRST match in the body — first by position, not by
 * the order the terms were typed. Whichever term the user's eye would hit
 * first is the one worth showing.
 *
 * `match` is sliced out of the body rather than taken from the term, so the
 * row shows `İstanbul` for a query of `istanbul`: the point of the excerpt
 * is to look like the entry, not like the search box. That slice is only
 * correct because `foldForSearch` preserves length — see its doc.
 */
export function buildSnippet(body: string, terms: readonly string[]): SearchSnippet {
  const flat = flatten(body);
  const folded = foldForSearch(flat);

  let at = -1;
  let length = 0;
  for (const term of terms) {
    const index = folded.indexOf(term);
    if (index >= 0 && (at === -1 || index < at)) {
      at = index;
      length = term.length;
    }
  }

  if (at === -1) {
    const head = flat.slice(0, SNIPPET_CONTEXT * 2);
    return { before: head + (flat.length > head.length ? "…" : ""), match: "", after: "" };
  }

  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + length + SNIPPET_CONTEXT);

  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, at),
    match: flat.slice(at, at + length),
    after: flat.slice(at + length, end) + (end < flat.length ? "…" : ""),
  };
}
