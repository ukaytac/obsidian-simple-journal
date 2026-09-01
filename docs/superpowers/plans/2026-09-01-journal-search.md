# Journal Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Search journal` command that finds an entry by the words in it, and either takes you to that one entry or scopes the timeline to every entry matching.

**Architecture:** Three layers with hard boundaries. `journal/entrySearch.ts` is pure text — folding, terms, matching, snippets — and knows nothing about journals or Obsidian. `services/journalSearch.ts` reads entry bodies through `EntryRepository.readBodyCached` and joins them to the index. `JournalView`'s existing `tagScope: string | null` becomes a `JournalScope` union so a text scope reuses every mechanism the tag scope already has: `matchesScope` stays synchronous because the modal resolves the matching paths before the scope is ever set.

**Tech Stack:** TypeScript, Obsidian plugin API (`SuggestModal`, `Vault.cachedRead`), vitest + jsdom, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-01-journal-search-design.md`

---

## Spec corrections adopted by this plan

**Spec §8, the folder-change paragraph, is wrong and is not built as written.** It says a change to the journal folder setting *clears* a text scope. That contradicts a decision the codebase already made, argued at length, and pinned with a test.

`JournalView.applyChangesNow` carries this comment, and `tests/JournalView.tagScope.test.ts`'s "survives a folder-level rebuild" enforces it:

> A "reload" change deliberately does NOT clear the scope. It fires for any mutation of the journal folder or its DESCENDANTS […] so renaming `Journal/2026`, which changes not one entry and not one tag, would silently drop the user's filter […] The semantically identical settings-path rebuild (`refreshJournal` in `main.ts`) does not clear it either.

The spec's own §5 ("a scope must never change on its own") agrees with the codebase, not with its §8 paragraph. So:

**A `reload` change RE-RESOLVES a text scope over the rebuilt index rather than clearing it.** That keeps the user's filter, keeps the resolved path set correct after a rename, and needs no new rule — it is the same "re-derive, don't sync incrementally" move `applyChangesNow` already makes for tags. A re-resolve is a full read of the journal, but `reload` fires only on a folder rename or a settings change, not on ordinary editing.

Everything else in the spec is built as written.

---

## File structure

**Create**

| File | Responsibility |
| --- | --- |
| `src/journal/entrySearch.ts` | Pure text matching: case folding, term splitting, match tests, snippet extraction. No Obsidian, no journal, no I/O. |
| `src/views/journalScope.ts` | The `JournalScope` union and the two pure functions that read it (`scopeMatches`, `scopeEmptyText`). Keeps the union out of `JournalView.ts`, which is already 3121 lines, and gives `timelineDom.ts` something to take that is not a bare string. |
| `src/services/journalSearch.ts` | The I/O layer: reads every entry body once into a snapshot, and searches that snapshot. The only file that knows search needs to read files. |
| `src/views/SearchModal.ts` | The suggester. Sibling to `TagScopeModal.ts`. |
| `tests/entrySearch.test.ts` | Pure unit tests for Task 1 and Task 2. |
| `tests/journalSearch.test.ts` | Snapshot reading, unreadable files, searching the snapshot. |
| `tests/searchModal.test.ts` | Suggestion list shape. Sibling to `tagScopeModal.test.ts`. |
| `tests/JournalView.textScope.test.ts` | Text-scope behaviour in the view. Sibling to `JournalView.tagScope.test.ts`. |

**Modify**

| File | Change |
| --- | --- |
| `src/views/JournalView.ts` | `tagScope: string \| null` → `scope: JournalScope \| null`; `setScope`/`requestScope` added, `setTagScope`/`requestTagScope`/`activeTagScope` kept as tag-shaped wrappers; text-scope re-resolution in `applyChangesNow`. |
| `src/views/timelineDom.ts` | `renderEmptyState(anchored, scopeTag: string \| null)` → `renderEmptyState(anchored, scope: JournalScope \| null)`. |
| `src/main.ts` | `searchJournal()` and the `search-journal` command. |
| `styles.css` | Scope bar for a text scope; suggester row layout. |
| `CLAUDE.md` | `# Navigation`, a new `# Search` section, and the `# Non-Goals` amendment. |
| `docs/manual-testing-open.md` | Live-vault checks. |
| `CHANGELOG.md` | A `1.3.0` section. |

---

## Task 1: Pure matching — folding, terms, match

**Files:**
- Create: `src/journal/entrySearch.ts`
- Test: `tests/entrySearch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/entrySearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MIN_QUERY_LENGTH,
  bodyMatchesTerms,
  foldForSearch,
  parseSearchQuery,
} from "../src/journal/entrySearch";

describe("foldForSearch", () => {
  it("folds Turkish casing pairs, keeping i and ı apart", () => {
    expect(foldForSearch("İstanbul")).toBe("istanbul");
    expect(foldForSearch("İSTANBUL")).toBe("istanbul");
    expect(foldForSearch("Işık")).toBe("ışık");
    expect(foldForSearch("IŞIK")).toBe("ışık");
    expect(foldForSearch("ilik")).not.toBe(foldForSearch("ılık"));
  });

  it("leaves every other diacritic distinct", () => {
    expect(foldForSearch("açık")).not.toBe(foldForSearch("acik"));
    expect(foldForSearch("şişman")).not.toBe(foldForSearch("sisman"));
    expect(foldForSearch("Kâr")).not.toBe(foldForSearch("kar"));
    expect(foldForSearch("gün")).not.toBe(foldForSearch("gun"));
  });

  /**
   * Not a bug: the price of `I` being the capital of `ı`. Turkish casing
   * cannot be correct and leave English's capital `I` alone at the same
   * time, and this journal is Turkish. Pinned so it stays a decision.
   */
  it("costs English its capital I, deliberately", () => {
    expect(foldForSearch("I am happy")).toBe("ı am happy");
    expect(foldForSearch("I am happy").includes(foldForSearch("i am"))).toBe(false);
  });
});

describe("parseSearchQuery", () => {
  it("splits on whitespace and folds each term", () => {
    expect(parseSearchQuery("İki  Kelime")).toEqual(["iki", "kelime"]);
  });

  it("returns no terms for a query below the minimum length", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(parseSearchQuery("a")).toEqual([]);
    expect(parseSearchQuery("   ")).toEqual([]);
    expect(parseSearchQuery("")).toEqual([]);
  });

  it("measures the minimum against the trimmed query, not each term", () => {
    expect(parseSearchQuery("ab")).toEqual(["ab"]);
    expect(parseSearchQuery("a b")).toEqual(["a", "b"]);
  });
});

describe("bodyMatchesTerms", () => {
  it("requires every term, in any order", () => {
    const body = "Kutuları taşıdık, sonra kahve içtik.";
    expect(bodyMatchesTerms(body, ["kahve", "kutu"])).toBe(true);
    expect(bodyMatchesTerms(body, ["kahve", "çay"])).toBe(false);
  });

  it("matches inside a word, not only at a boundary", () => {
    expect(bodyMatchesTerms("taşınma günü", ["şınm"])).toBe(true);
  });

  it("matches nothing when there are no terms", () => {
    expect(bodyMatchesTerms("anything at all", [])).toBe(false);
  });

  it("folds the body the same way as the query", () => {
    expect(bodyMatchesTerms("İstanbul'a gittik", parseSearchQuery("istanbul"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/entrySearch.test.ts`
Expected: FAIL — `Failed to resolve import "../src/journal/entrySearch"`.

- [ ] **Step 3: Write the implementation**

Create `src/journal/entrySearch.ts`:

```ts
/**
 * Every decision about what matches what, in one place.
 *
 * The same shape `entryDate.ts` holds for chronology, `entryTags.ts` for
 * tags, and `mentions/mentionQuery.ts` for links: nothing downstream
 * re-derives folding, term splitting, or matching. Pure — no Obsidian, no
 * files, no journal — so the whole of it is testable without a DOM.
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
 * `compareEntries` in `entryIndex.ts` gave up `localeCompare` to guarantee
 * for a synced vault.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/entrySearch.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/journal/entrySearch.ts tests/entrySearch.test.ts
git commit -m "feat: fold, split and match search terms"
```

---

## Task 2: Pure matching — the snippet

**Files:**
- Modify: `src/journal/entrySearch.ts`
- Test: `tests/entrySearch.test.ts`

The suggester row has to be identifiable, and a bare timestamp is the exact problem `CLAUDE.md` § Mentions exists to solve. So each row carries an excerpt around the first match, split into three parts so the caller can emphasise the middle without ever building HTML from user text.

- [ ] **Step 1: Write the failing tests**

Append to `tests/entrySearch.test.ts`:

```ts
import { SNIPPET_CONTEXT, buildSnippet } from "../src/journal/entrySearch";

describe("buildSnippet", () => {
  it("splits the body around the first matching term", () => {
    const snippet = buildSnippet("Bugün kahve içtik.", ["kahve"]);
    expect(snippet).toEqual({ before: "Bugün ", match: "kahve", after: " içtik." });
  });

  it("uses whichever term appears first, not the first term given", () => {
    const snippet = buildSnippet("kahve, sonra kutu", ["kutu", "kahve"]);
    expect(snippet.match).toBe("kahve");
  });

  it("returns the matched text as the body spells it, not as the query does", () => {
    expect(buildSnippet("İstanbul'a gittik", ["istanbul"]).match).toBe("İstanbul");
  });

  it("trims context on both sides and marks the trim", () => {
    const body = `${"a".repeat(200)} kahve ${"b".repeat(200)}`;
    const snippet = buildSnippet(body, ["kahve"]);
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.before.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 2);
    expect(snippet.after.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 2);
  });

  it("does not mark a trim that did not happen", () => {
    const snippet = buildSnippet("kısa kahve notu", ["kahve"]);
    expect(snippet.before).toBe("kısa ");
    expect(snippet.after).toBe(" notu");
  });

  it("collapses newlines so a row stays one line", () => {
    expect(buildSnippet("ilk satır\n\nkahve\nson", ["kahve"])).toEqual({
      before: "ilk satır kahve".slice(0, 10),
      match: "kahve",
      after: " son",
    });
  });

  it("returns the head of the body when nothing matched", () => {
    const snippet = buildSnippet("hiçbir şey", ["kahve"]);
    expect(snippet.match).toBe("");
    expect(snippet.before).toBe("hiçbir şey");
    expect(snippet.after).toBe("");
  });
});
```

Note on the newline test: `"ilk satır\n\nkahve\nson"` collapses to `"ilk satır kahve son"`, so `before` is `"ilk satır "` — which is what `"ilk satır kahve".slice(0, 10)` spells. Written that way so the expectation states the rule (whitespace collapses to one space) rather than a magic literal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/entrySearch.test.ts`
Expected: FAIL — `buildSnippet is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/journal/entrySearch.ts`:

```ts
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
 * is to look like the entry, not like the search box.
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

  // Folding is one code unit in, one code unit out for every substitution
  // this module makes, so an index into the folded string is an index into
  // the flattened one. Anything that changed length — NFD expansion, for
  // instance — would break this, which is why `foldForSearch` does not do it.
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + length + SNIPPET_CONTEXT);

  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, at),
    match: flat.slice(at, at + length),
    after: flat.slice(at + length, end) + (end < flat.length ? "…" : ""),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/entrySearch.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/journal/entrySearch.ts tests/entrySearch.test.ts
git commit -m "feat: excerpt an entry around its first search match"
```

---

## Task 3: The scope union, with no behaviour change

This task changes types and names only. Every existing test must stay green without being edited — that is the whole check.

**Files:**
- Create: `src/views/journalScope.ts`
- Modify: `src/views/JournalView.ts`, `src/views/timelineDom.ts`

- [ ] **Step 1: Write `journalScope.ts`**

```ts
import type { JournalEntry } from "../journal/entry";
import { entryHasTag } from "../journal/entryTags";

/**
 * What the timeline is currently filtered to, if anything.
 *
 * A SCOPE, never an anchor: neither kind is a point on the chronological
 * axis, so both compose with `anchorDate` rather than competing with it.
 * Exactly one can be active — setting either replaces the other. That is
 * the line that keeps this on the right side of CLAUDE.md's `advanced
 * filters` non-goal: the intersection of two filters is a query builder.
 *
 * NEVER persisted. See `JournalView.scope`.
 */
export type JournalScope =
  | { kind: "tag"; tag: string }
  | {
      kind: "text";
      /** As the user typed it. Shown in the scope bar; re-parsed for matching. */
      query: string;
      /**
       * The paths that matched, resolved BEFORE the scope was ever set.
       *
       * This is what keeps `scopeMatches` synchronous. A text scope's
       * predicate is "did this entry's body contain the terms", which
       * cannot be answered without reading a file — so it is answered once,
       * by whoever built the scope, and the view only ever asks a set.
       */
      paths: ReadonlySet<string>;
    };

/** Whether `entry` belongs in the timeline under `scope`. Synchronous, always. */
export function scopeMatches(scope: JournalScope | null, entry: JournalEntry): boolean {
  if (scope === null) return true;
  return scope.kind === "tag"
    ? entryHasTag(entry, scope.tag)
    : scope.paths.has(entry.file.path);
}

/**
 * What an empty timeline says under this scope. Naming the scope matters:
 * saying "nothing on or before this date" while a scope is silently
 * excluding everything else sends the user looking in the wrong place.
 */
export function scopeEmptyText(scope: JournalScope): string {
  return scope.kind === "tag"
    ? `No entries tagged #${scope.tag}.`
    : `No entries matching “${scope.query}”.`;
}
```

- [ ] **Step 2: Change `timelineDom.ts` to take the union**

In `src/views/timelineDom.ts`, change the interface member (line 88) and the function (line 354):

```ts
  renderEmptyState(anchored?: boolean, scope?: JournalScope | null): void;
```

```ts
  function renderEmptyState(anchored = false, scope: JournalScope | null = null): void {
    deps.getTimelineEl().createDiv({
      cls: "journal-empty",
      text: scope
        ? scopeEmptyText(scope)
        : anchored
          ? "Nothing on or before this date."
          : "No journal entries yet. Use the + button above to write the first one.",
    });
  }
```

Add at the top of the file:

```ts
import { scopeEmptyText, type JournalScope } from "./journalScope";
```

- [ ] **Step 3: Change `JournalView.ts`'s field and every reader**

Replace the `tagScope` field (line ~268) with:

```ts
  /**
   * What the timeline is filtered to, or null. See `journalScope.ts` for
   * the two kinds and why only one can be active.
   *
   * NEVER persisted — not to view state, not to settings. A saved workspace
   * layout that restored a filter would hide most of a user's journal at
   * startup with no visible cause, the same "permanently locked out"
   * failure the calendar's placement policy exists to avoid.
   */
  private scope: JournalScope | null = null;
```

Import it:

```ts
import { scopeMatches, type JournalScope } from "./journalScope";
```

Then, mechanically:

| Was | Becomes |
| --- | --- |
| `this.tagScope !== null` | `this.scope !== null` |
| `this.tagScope === null` | `this.scope === null` |
| `this.tagScope = null` | `this.scope = null` |
| `this.renderEmptyState(…, this.tagScope)` | `this.renderEmptyState(…, this.scope)` |
| `… ? this.tagScope : null` (lines 669, 695) | `… ? this.scope : null` |

Change `renderEmptyState`'s wrapper (line 1208):

```ts
  private renderEmptyState(anchored = false, scope: JournalScope | null = null): void {
    this.timelineDom.renderEmptyState(anchored, scope);
  }
```

Change `scopedIndex` and `matchesScope`:

```ts
  private scopedIndex(): JournalEntry[] {
    const all = this.plugin.journal.getEntries();
    const scope = this.scope;
    if (scope === null) return all;
    if (scope.kind === "tag") return entriesWithTag(all, scope.tag);
    return all.filter((entry) => scope.paths.has(entry.file.path));
  }

  /** Whether `entry` belongs in the timeline as currently filtered. */
  private matchesScope(entry: JournalEntry): boolean {
    return scopeMatches(this.scope, entry);
  }
```

Change `renderScopeBar`'s guard and label:

```ts
    el.empty();
    const scope = this.scope;
    el.toggleClass("journal-scope-bar-active", scope !== null);
    if (scope === null) return;
```

and, in place of the `journal-scope-tag` span:

```ts
    if (scope.kind === "tag") {
      inner.createSpan({ cls: "journal-scope-tag", text: `#${scope.tag}` });
    } else {
      inner.createSpan({ cls: "journal-scope-query", text: `“${scope.query}”` });
    }
```

The clear button keeps calling `this.requestTagScope(null)` — clearing is kind-blind, and the wrapper below still routes it.

Add the general scope API, and keep the tag-shaped one as wrappers so no existing call site or test changes:

```ts
  /** The active scope, or null. Read by `main.ts` to build the suggesters. */
  activeScope(): JournalScope | null {
    return this.scope;
  }

  /** The active TAG scope's tag, or null — null also when a text scope is active. */
  activeTagScope(): string | null {
    return this.scope?.kind === "tag" ? this.scope.tag : null;
  }

  /**
   * Sets the scope, or clears it when null. One scope at a time: this
   * replaces whatever was active, whatever kind it was.
   *
   * Keeps any active anchor: the two compose. Goes through the same
   * serialized `reload()` chain as every other timeline rebuild, and
   * scrolls to the top afterwards so the newest matching entry is actually
   * visible rather than leaving the viewport where the previous,
   * differently-populated timeline had it.
   */
  async setScope(scope: JournalScope | null): Promise<void> {
    this.scope = scope;
    this.renderScopeBar();
    await this.reload();
    this.scrollToTop();
  }

  /** Tag-shaped entry point. `normalizeTag` here and nowhere else. */
  async setTagScope(tag: string | null): Promise<void> {
    if (tag === null) return this.setScope(null);
    const next = normalizeTag(tag);
    return this.setScope(next === "" ? null : { kind: "tag", tag: next });
  }
```

`requestTagScope` keeps its body and its doc; only the message it logs stays accurate for both kinds:

```ts
  requestScope(scope: JournalScope | null): void {
    this.setScope(scope).catch((error: unknown) => {
      console.error("Simple Journal: could not change the journal filter", error);
      new Notice("Could not change the journal filter. See the developer console.");
    });
  }

  requestTagScope(tag: string | null): void {
    this.setTagScope(tag).catch((error: unknown) => {
      console.error("Simple Journal: could not change the tag filter", error);
      new Notice("Could not change the tag filter. See the developer console.");
    });
  }
```

- [ ] **Step 4: Run the whole suite — nothing may have changed**

Run: `npm test`
Expected: PASS, 667 tests (650 before, +17 from Tasks 1–2). `tests/JournalView.tagScope.test.ts` must be green **without being edited**. If any assertion there needed changing, the refactor changed behaviour and is wrong.

- [ ] **Step 5: Type-check and lint**

Run: `npm run build && npm run lint`
Expected: both silent.

- [ ] **Step 6: Commit**

```bash
git add src/views/journalScope.ts src/views/JournalView.ts src/views/timelineDom.ts
git commit -m "refactor: make the timeline's scope a union, not a tag"
```

---

## Task 4: A text scope the view can be put into

**Files:**
- Modify: `src/views/JournalView.ts`
- Test: `tests/JournalView.textScope.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/JournalView.textScope.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, tagEntry, timelineEl } from "./journalViewHarness";
import type { Harness } from "./journalViewHarness";

function renderedPaths(h: Harness): string[] {
  return Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry")).map(
    (el) => el.dataset.path ?? "",
  );
}

function textScope(h: Harness, query: string, paths: string[]) {
  return h.view.setScope({ kind: "text", query, paths: new Set(paths) });
}

describe("JournalView text scope", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = createHarness();
  });

  afterEach(async () => {
    await h.view.onClose();
    h.service.unload();
    vi.useRealTimers();
  });

  /**
   * The same crossing shape `JournalView.tagScope.test.ts` uses, for the
   * same reason: the match axis and the date axis have to cross, or the
   * composition test below passes with the scope removed entirely.
   *
   *   match    Aug 12 22:41  "kahve"   newer than the anchor
   *   miss     Aug 12 17:23  --        newer than the anchor
   *   older    Aug 10 09:34  "kahve"   older than the anchor
   *   oldMiss  Aug  9 09:00  --        older than the anchor
   */
  async function openWithBodies() {
    const match = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "kahve içtik");
    const miss = addEntry(h, new Date(2026, 7, 12, 17, 23, 41), "hiçbir şey");
    const older = addEntry(h, new Date(2026, 7, 10, 9, 34, 21), "yine kahve");
    const oldMiss = addEntry(h, new Date(2026, 7, 9, 9, 0, 0), "başka bir şey");
    h.service.load();
    await h.view.onOpen();
    return { match, miss, older, oldMiss };
  }

  it("renders only the entries whose paths the scope resolved", async () => {
    const { match, miss, older } = await openWithBodies();

    await textScope(h, "kahve", [match.path, older.path]);

    expect(renderedPaths(h)).toEqual([match.path, older.path]);
    expect(renderedPaths(h)).not.toContain(miss.path);
  });

  it("restores the whole timeline when the scope is cleared", async () => {
    const { match, miss, older, oldMiss } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    await h.view.setScope(null);

    expect(renderedPaths(h)).toEqual([match.path, miss.path, older.path, oldMiss.path]);
  });

  it("names the query in the scope bar, in quotes rather than as a tag", async () => {
    await openWithBodies();
    await textScope(h, "kahve", []);

    const bar = internals(h.view).scopeBarEl as HTMLElement;
    expect(bar.querySelector(".journal-scope-query")?.textContent).toBe("“kahve”");
    expect(bar.querySelector(".journal-scope-tag")).toBeNull();
  });

  it("blames the query, not the date, in an empty timeline", async () => {
    await openWithBodies();

    await textScope(h, "zeplin", []);

    expect(timelineEl(h.view).querySelector(".journal-empty")?.textContent).toBe(
      "No entries matching “zeplin”.",
    );
  });

  it("composes with an anchor: matching entries, from that day backwards", async () => {
    const { match, older } = await openWithBodies();

    await textScope(h, "kahve", [match.path, older.path]);
    await h.view.goToDate(new Date(2026, 7, 11, 23, 59, 59));

    expect(renderedPaths(h)).toEqual([older.path]);
  });

  it("replaces a tag scope rather than combining with it", async () => {
    const { match, older, oldMiss } = await openWithBodies();
    tagEntry(h, oldMiss, ["therapy"]);
    await h.view.setTagScope("therapy");
    expect(renderedPaths(h)).toEqual([oldMiss.path]);

    await textScope(h, "kahve", [match.path, older.path]);

    expect(renderedPaths(h)).toEqual([match.path, older.path]);
    expect(h.view.activeTagScope()).toBeNull();
  });

  it("is replaced by a tag scope in the other direction too", async () => {
    const { match, older, oldMiss } = await openWithBodies();
    tagEntry(h, oldMiss, ["therapy"]);
    await textScope(h, "kahve", [match.path, older.path]);

    await h.view.setTagScope("therapy");

    expect(renderedPaths(h)).toEqual([oldMiss.path]);
    expect(h.view.activeScope()).toEqual({ kind: "tag", tag: "therapy" });
  });

  it("clears when a new entry is started", async () => {
    const { match, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    await h.view.startNewEntry();

    expect(h.view.activeScope()).toBeNull();
    expect(internals(h.view).composer).not.toBeNull();
  });

  it("clears on Escape outside an entry", async () => {
    const { match, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    internals(h.view).contentEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await vi.waitFor(() => expect(h.view.activeScope()).toBeNull());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/JournalView.textScope.test.ts`
Expected: FAIL. After Task 3 most of these already pass — `setScope` exists and `scopedIndex` handles the union. The ones that must be red are "names the query in the scope bar" and "blames the query", if Task 3's `renderScopeBar`/`scopeEmptyText` edits were skipped. If every test is green here, that is the correct outcome: Task 3 built the behaviour and this task is proving it. **Do not weaken a test to make it fail.**

- [ ] **Step 3: Fix whatever was red**

The only production change this task can need is in `renderScopeBar` and `journalScope.ts`'s `scopeEmptyText`, both specified in Task 3 Steps 1 and 3. Apply them if they were missed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/JournalView.textScope.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-verify the two that matter**

The scope-bar and empty-state tests are the only ones asserting text this task introduces. Prove they bite: temporarily change `scopeEmptyText`'s text branch to return the tag branch's string, run the suite, confirm "blames the query" fails, then revert.

Run: `npx vitest run tests/JournalView.textScope.test.ts`
Expected while mutated: 1 failed. Expected after revert: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add tests/JournalView.textScope.test.ts src/views/JournalView.ts src/views/journalScope.ts
git commit -m "test: pin the text scope's behaviour in the view"
```

---

## Task 5: Reading bodies — the snapshot and the search

**Files:**
- Create: `src/services/journalSearch.ts`
- Test: `tests/journalSearch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/journalSearch.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { JournalEntry } from "../src/journal/entry";
import { parseSearchQuery } from "../src/journal/entrySearch";
import {
  readJournalSnapshot,
  searchSnapshot,
  type JournalSnapshotReader,
} from "../src/services/journalSearch";

function entry(path: string, created: Date): JournalEntry {
  return { file: { path, basename: path } as unknown as TFile, created, tags: [] };
}

/** A reader whose bodies are a plain map, and whose failures are explicit. */
function reader(bodies: Record<string, string | Error>): JournalSnapshotReader {
  return {
    readBodyCached: (file: TFile) => {
      const body = bodies[file.path];
      if (body instanceof Error) return Promise.reject(body);
      return Promise.resolve(body ?? "");
    },
  };
}

const A = entry("Journal/a.md", new Date(2026, 7, 12, 22, 0, 0));
const B = entry("Journal/b.md", new Date(2026, 7, 10, 9, 0, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readJournalSnapshot", () => {
  it("reads every entry once and keeps the index's order", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "kahve", "Journal/b.md": "çay" }),
      [A, B],
    );

    expect(snapshot.entries.map((e) => e.entry.file.path)).toEqual([A.file.path, B.file.path]);
    expect(snapshot.entries.map((e) => e.body)).toEqual(["kahve", "çay"]);
    expect(snapshot.unreadable).toBe(0);
  });

  it("counts and logs an unreadable entry instead of failing the whole search", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": new Error("EACCES"), "Journal/b.md": "çay" }),
      [A, B],
    );

    expect(snapshot.entries.map((e) => e.entry.file.path)).toEqual([B.file.path]);
    expect(snapshot.unreadable).toBe(1);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("searchSnapshot", () => {
  it("returns a hit per matching entry, in the index's order, with a snippet", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "bugün kahve içtik", "Journal/b.md": "çay içtik" }),
      [A, B],
    );

    const hits = searchSnapshot(snapshot, parseSearchQuery("kahve"));

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.file.path).toBe(A.file.path);
    expect(hits[0].snippet.match).toBe("kahve");
  });

  it("returns nothing for a query below the minimum length", async () => {
    const snapshot = await readJournalSnapshot(reader({ "Journal/a.md": "kahve" }), [A]);
    expect(searchSnapshot(snapshot, parseSearchQuery("k"))).toEqual([]);
  });

  it("requires every term across the whole body, not one line", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "kahve içtik\n\nsonra kutu taşıdık" }),
      [A],
    );
    expect(searchSnapshot(snapshot, parseSearchQuery("kahve kutu"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/journalSearch.test.ts`
Expected: FAIL — `Failed to resolve import "../src/services/journalSearch"`.

- [ ] **Step 3: Write the implementation**

Create `src/services/journalSearch.ts`:

```ts
import type { TFile } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import { bodyMatchesTerms, buildSnippet, type SearchSnippet } from "../journal/entrySearch";

/**
 * The one thing search needs from `EntryRepository`, named as an interface
 * so the tests can supply a map instead of a vault. `readBodyCached` and not
 * `readBody`: search never writes what it read, which is exactly the case
 * Obsidian's guidance reserves `cachedRead` for — and the same reason the
 * mentions panel uses it.
 */
export interface JournalSnapshotReader {
  readBodyCached(file: TFile): Promise<string>;
}

export interface SnapshotEntry {
  entry: JournalEntry;
  /** Body only — `readBodyCached` has already stripped the frontmatter. */
  body: string;
}

export interface JournalSnapshot {
  entries: SnapshotEntry[];
  /** How many entries could not be read. Surfaced by the modal; see below. */
  unreadable: number;
}

export interface SearchHit {
  entry: JournalEntry;
  snippet: SearchSnippet;
}

/**
 * Reads every entry's body once.
 *
 * Once per search session, not once per keystroke: the modal filters the
 * snapshot in memory as the user types. A per-keystroke scan is the
 * "obviously unscalable decision" CLAUDE.md § Performance warns against; a
 * single pass over a journal is not, and `cachedRead` means a second search
 * in the same session pays almost nothing.
 *
 * If this is ever felt on a large journal, the answer is an incrementally
 * maintained index fed by `JournalService`'s existing change batching — and
 * the reason that stays a one-file change is that nothing outside this
 * module knows search reads anything.
 *
 * An unreadable entry is logged and dropped rather than throwing: one bad
 * file must not take the whole search with it. It is also COUNTED, because
 * the worst thing a search can do is quietly answer with less than it has —
 * `SearchModal` shows the count, which is CLAUDE.md § Error Handling's
 * "fail visibly" for a path that writes nothing and so risks no data.
 */
export async function readJournalSnapshot(
  reader: JournalSnapshotReader,
  entries: readonly JournalEntry[],
): Promise<JournalSnapshot> {
  const results = await Promise.all(
    entries.map(async (entry): Promise<SnapshotEntry | null> => {
      try {
        return { entry, body: await reader.readBodyCached(entry.file) };
      } catch (error) {
        console.error(`Simple Journal: could not read ${entry.file.path} to search it`, error);
        return null;
      }
    }),
  );

  return {
    entries: results.filter((result): result is SnapshotEntry => result !== null),
    unreadable: results.filter((result) => result === null).length,
  };
}

/**
 * Pure: the snapshot is already in memory, so this is string work only and
 * safe to run on every keystroke. Order is the snapshot's order, which is
 * the index's order, which is the journal's order — newest first, as it is
 * everywhere else.
 */
export function searchSnapshot(
  snapshot: JournalSnapshot,
  terms: readonly string[],
): SearchHit[] {
  if (terms.length === 0) return [];
  return snapshot.entries
    .filter(({ body }) => bodyMatchesTerms(body, terms))
    .map(({ entry, body }) => ({ entry, snippet: buildSnippet(body, terms) }));
}

/** The paths a set of hits covers — what a text scope is built from. */
export function hitPaths(hits: readonly SearchHit[]): Set<string> {
  return new Set(hits.map((hit) => hit.entry.file.path));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/journalSearch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/journalSearch.ts tests/journalSearch.test.ts
git commit -m "feat: read the journal once per search and match it in memory"
```

---

## Task 6: Keeping a text scope live

A tag scope re-derives itself from the index on every change batch. A text scope cannot — its predicate needs a file read. This task gives it the equivalent.

**Files:**
- Modify: `src/views/JournalView.ts`
- Test: `tests/JournalView.textScope.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/JournalView.textScope.test.ts`, inside the same `describe`:

```ts
  it("drops a row whose text stopped matching, edited elsewhere in Obsidian", async () => {
    const { match, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    h.app.vault.setContent(match.path, "---\ncreated: \"x\"\n---\n\nartık çay");
    h.app.vault.trigger("modify", match);
    vi.advanceTimersByTime(300);

    await vi.waitFor(() => expect(renderedPaths(h)).toEqual([older.path]));
  });

  it("admits a row whose text started matching", async () => {
    const { match, miss, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    h.app.vault.setContent(miss.path, "---\ncreated: \"x\"\n---\n\nbugün de kahve");
    h.app.vault.trigger("modify", miss);
    vi.advanceTimersByTime(300);

    await vi.waitFor(() =>
      expect(renderedPaths(h)).toEqual([match.path, miss.path, older.path]),
    );
  });

  /**
   * A `reload` change fires for any mutation of the journal folder or its
   * descendants, including a rename that changes every entry's path and not
   * one word of anyone's text. Clearing the scope there is what the tag
   * scope refuses to do, on the grounds that a filter must never vanish
   * with no cause the user can connect to what they did — so this
   * re-resolves instead, which keeps the filter AND keeps the path set
   * correct. The spec asked for clearing; see this plan's spec corrections.
   */
  it("re-resolves rather than clearing when the folder is rebuilt under it", async () => {
    const { match, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    h.service.rebuild();
    await h.view.reload();
    await vi.waitFor(() => {
      expect(h.view.activeScope()?.kind).toBe("text");
      expect(renderedPaths(h)).toEqual([match.path, older.path]);
    });
  });
```

`h.app.vault.setContent` must exist on the fake vault. If it does not, add it to `tests/obsidian-mock.ts` beside `addFile`:

```ts
  setContent(path: string, content: string): void {
    this.contents.set(path, content);
  }
```

using whatever the mock already names its content store — read `addFile` first and match it exactly rather than inventing a field.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/JournalView.textScope.test.ts`
Expected: FAIL on all three — the scope's `paths` set is never updated, so the first two show an unchanged timeline and the third shows a timeline that empties out or a scope that survives only by luck.

- [ ] **Step 3: Write the implementation**

In `src/views/JournalView.ts`, add the imports:

```ts
import { parseSearchQuery } from "../journal/entrySearch";
import { hitPaths, readJournalSnapshot, searchSnapshot } from "../services/journalSearch";
```

Add the re-resolution, and call it from `applyChangesNow`:

```ts
  /**
   * Brings a text scope's resolved path set back into line after a change.
   *
   * A tag scope needs nothing here: `scopedIndex()` re-derives it from an
   * index `JournalService` has already updated. A text scope's predicate
   * lives on disk, so the equivalent is a read — kept as small as the batch
   * allows.
   *
   * A `reload` change means the index was replaced wholesale (a folder
   * rename, or the journal-folder setting changing), so every path in the
   * set may be stale and the whole journal is re-read. Every other batch
   * touches named entries only, so only those are re-read. Either way the
   * scope is REPLACED, never cleared: see this file's `applyChangesNow`
   * comment on why a scope must not vanish on its own.
   */
  private async reresolveTextScope(changes: JournalChange[]): Promise<void> {
    const scope = this.scope;
    if (scope === null || scope.kind !== "text") return;

    const terms = parseSearchQuery(scope.query);
    const entries = this.plugin.journal.getEntries();

    if (changes.some((change) => change.kind === "reload")) {
      const snapshot = await readJournalSnapshot(this.plugin.repository, entries);
      this.scope = { ...scope, paths: hitPaths(searchSnapshot(snapshot, terms)) };
      return;
    }

    const touched = new Set(
      changes.map((change) => ("entry" in change ? change.entry.file.path : change.path)),
    );
    const affected = entries.filter((entry) => touched.has(entry.file.path));
    const snapshot = await readJournalSnapshot(this.plugin.repository, affected);
    const matched = hitPaths(searchSnapshot(snapshot, terms));

    const paths = new Set(scope.paths);
    // A path that was touched and no longer matches leaves the set; one that
    // now matches joins it. A removed entry is in `touched` but not in
    // `entries`, so it is deleted here and never re-added — which is the
    // correct outcome without a case of its own.
    for (const path of touched) paths.delete(path);
    for (const path of matched) paths.add(path);

    this.scope = { ...scope, paths };
  }
```

In `applyChangesNow`, replace the single re-derivation line:

```ts
    if (this.scope !== null) {
      await this.reresolveTextScope(changes);
      this.index = this.scopedIndex();
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/JournalView.textScope.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. `JournalView.tagScope.test.ts` must still be green and unedited — `reresolveTextScope` returns immediately for a tag scope.

- [ ] **Step 6: Commit**

```bash
git add src/views/JournalView.ts tests/JournalView.textScope.test.ts tests/obsidian-mock.ts
git commit -m "feat: keep a text scope live as entries change"
```

---

## Task 7: The suggester

**Files:**
- Create: `src/views/SearchModal.ts`
- Test: `tests/searchModal.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/searchModal.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { TFile } from "obsidian";
import type { JournalEntry } from "../src/journal/entry";
import type { JournalSnapshot } from "../src/services/journalSearch";
import { SearchModal, type SearchChoice } from "../src/views/SearchModal";
import { installDomHelpers } from "./obsidian-mock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

function entry(path: string, created: Date): JournalEntry {
  return { file: { path, basename: path } as unknown as TFile, created, tags: [] };
}

const A = entry("Journal/a.md", new Date(2026, 7, 12, 22, 41, 0));
const B = entry("Journal/b.md", new Date(2026, 7, 10, 9, 34, 0));

function modal(snapshot: JournalSnapshot, hasScope = false) {
  const chosen: SearchChoice[] = [];
  const instance = new SearchModal({} as App, snapshot, hasScope, (choice) => chosen.push(choice));
  return { instance, chosen };
}

const SNAPSHOT: JournalSnapshot = {
  entries: [
    { entry: A, body: "bugün kahve içtik" },
    { entry: B, body: "çay içtik" },
  ],
  unreadable: 0,
};

describe("SearchModal", () => {
  it("suggests nothing at all for a query below the minimum length", () => {
    expect(modal(SNAPSHOT).instance.getSuggestions("k")).toEqual([]);
  });

  it("offers Show all first, then one row per match, newest first", () => {
    const suggestions = modal(SNAPSHOT).instance.getSuggestions("içtik");

    expect(suggestions[0]).toMatchObject({ kind: "all", count: 2, query: "içtik" });
    expect(suggestions.slice(1).map((s) => (s.kind === "hit" ? s.hit.entry.file.path : ""))).toEqual(
      [A.file.path, B.file.path],
    );
  });

  it("omits Show all when nothing matched", () => {
    expect(modal(SNAPSHOT).instance.getSuggestions("zeplin")).toEqual([]);
  });

  it("keeps Clear filter reachable, first, while a scope is active", () => {
    const { instance } = modal(SNAPSHOT, true);
    expect(instance.getSuggestions("zeplin")).toEqual([{ kind: "clear" }]);
    expect(instance.getSuggestions("içtik")[0]).toEqual({ kind: "clear" });
    expect(instance.getSuggestions("içtik")[1]).toMatchObject({ kind: "all", count: 2 });
  });

  it("renders a hit as its time plus an excerpt, with the match marked", () => {
    const { instance } = modal(SNAPSHOT);
    const suggestion = instance.getSuggestions("kahve")[1];
    const el = createDiv();

    instance.renderSuggestion(suggestion, el);

    expect(el.querySelector(".journal-search-time")?.textContent).toBe("22:41");
    expect(el.querySelector(".journal-search-match")?.textContent).toBe("kahve");
    expect(el.textContent).toContain("bugün ");
  });

  it("says so when entries could not be read", () => {
    const { instance } = modal({ ...SNAPSHOT, unreadable: 3 });
    expect(instance.getSuggestions("içtik").at(-1)).toEqual({ kind: "unreadable", count: 3 });
  });

  it("says nothing about unreadable entries when there were none", () => {
    const { instance } = modal(SNAPSHOT);
    expect(instance.getSuggestions("içtik").some((s) => s.kind === "unreadable")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/searchModal.test.ts`
Expected: FAIL — `Failed to resolve import "../src/views/SearchModal"`.

- [ ] **Step 3: Write the implementation**

Create `src/views/SearchModal.ts`:

```ts
import { type App, SuggestModal } from "obsidian";
import { parseSearchQuery } from "../journal/entrySearch";
import { searchSnapshot, type JournalSnapshot, type SearchHit } from "../services/journalSearch";
import { formatTime } from "../utils/dates";

/**
 * One row. Four kinds, and the three synthetic ones exist for reasons the
 * list itself cannot express:
 *
 * - `clear` gets the user back to the whole journal, so a query matching
 *   nothing must not be able to hide it. Same role, same position, same
 *   argument as `TagScopeModal`'s.
 * - `all` is the second exit: it scopes the timeline instead of going to
 *   one entry. First (after `clear`) so the list cannot scroll it away.
 * - `unreadable` is not choosable. It is the only place a user can learn
 *   that this answer is incomplete, which CLAUDE.md § Error Handling asks
 *   for and a search owes more than most surfaces do.
 */
export type SearchChoice =
  | { kind: "clear" }
  | { kind: "all"; count: number; query: string; hits: SearchHit[] }
  | { kind: "hit"; hit: SearchHit }
  | { kind: "unreadable"; count: number };

/**
 * The way into a search. A suggester rather than a plain prompt because the
 * command answers two questions at once — "take me to that entry" and "show
 * me all of them" — and only a list can offer both without asking the user
 * to decide before they have seen anything.
 *
 * Matches over a snapshot read once, before this opened: `getSuggestions`
 * runs on every keystroke and must never touch the disk. See
 * `services/journalSearch.ts`.
 */
export class SearchModal extends SuggestModal<SearchChoice> {
  constructor(
    app: App,
    private readonly snapshot: JournalSnapshot,
    private readonly hasScope: boolean,
    private readonly onChoose: (choice: SearchChoice) => void,
  ) {
    super(app);
    this.setPlaceholder("Search the journal");
    this.emptyStateText = "No entries match.";
  }

  getSuggestions(query: string): SearchChoice[] {
    const terms = parseSearchQuery(query);
    const hits = searchSnapshot(this.snapshot, terms);

    const rows: SearchChoice[] = [];
    if (this.hasScope) rows.push({ kind: "clear" });
    // The query and the hits travel ON the choice, not in a field on the
    // plugin: the caller needs both to build a scope, and a modal that
    // parked its state somewhere else would make two objects responsible
    // for one answer.
    if (hits.length > 0) {
      rows.push({ kind: "all", count: hits.length, query: query.trim(), hits });
    }
    for (const hit of hits) rows.push({ kind: "hit", hit });
    // Last, not first: it is a caveat about the answer, and putting a
    // caveat above the answer would push the answer off the first screen.
    if (this.snapshot.unreadable > 0 && rows.length > 0) {
      rows.push({ kind: "unreadable", count: this.snapshot.unreadable });
    }
    return rows;
  }

  renderSuggestion(choice: SearchChoice, el: HTMLElement): void {
    if (choice.kind === "clear") {
      el.setText("Clear filter");
      return;
    }
    if (choice.kind === "all") {
      el.setText(`Show all ${choice.count} matches`);
      return;
    }
    if (choice.kind === "unreadable") {
      el.addClass("journal-search-unreadable");
      el.setText(`${choice.count} entries could not be read.`);
      return;
    }

    el.addClass("journal-search-suggestion");
    el.createSpan({ cls: "journal-search-time", text: formatTime(choice.hit.entry.created) });
    // Three spans, not one string with markup: the excerpt is the user's own
    // text, and it reaches the DOM as text nodes only.
    const excerpt = el.createSpan({ cls: "journal-search-excerpt" });
    excerpt.createSpan({ text: choice.hit.snippet.before });
    excerpt.createSpan({ cls: "journal-search-match", text: choice.hit.snippet.match });
    excerpt.createSpan({ text: choice.hit.snippet.after });
  }

  // Same two parameters as the real abstract member, for the reason
  // `TagScopeModal.onChooseSuggestion` documents: narrowing the arity would
  // make TypeScript check calls against the narrower one.
  onChooseSuggestion(choice: SearchChoice, _evt: MouseEvent | KeyboardEvent): void {
    // Not choosable — it is a caveat, and selecting it must do nothing
    // rather than close the modal having done nothing visible.
    if (choice.kind === "unreadable") return;
    this.onChoose(choice);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/searchModal.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/SearchModal.ts tests/searchModal.test.ts
git commit -m "feat: a suggester with both of search's exits"
```

---

## Task 8: The command, and the wiring

**Files:**
- Modify: `src/main.ts`
- Test: `tests/mainSearch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/mainSearch.test.ts`. Model the harness on `tests/mainMentionSurfaces.test.ts` — read it first and follow how it builds a plugin over `createFakeApp`; do not invent a different one.

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { hitPaths, readJournalSnapshot, searchSnapshot } from "../src/services/journalSearch";
import { parseSearchQuery } from "../src/journal/entrySearch";
import type { JournalEntry } from "../src/journal/entry";
import type { TFile } from "obsidian";

function entry(path: string): JournalEntry {
  return { file: { path, basename: path } as unknown as TFile, created: new Date(), tags: [] };
}

/**
 * `searchJournal` is three lines of glue over pieces with their own tests,
 * and the glue is the part worth pinning: that the scope it builds carries
 * the paths the search actually found. Getting this wrong scopes the
 * timeline to nothing while the modal showed matches.
 */
describe("the scope a search builds", () => {
  it("carries exactly the matched paths", async () => {
    const a = entry("Journal/a.md");
    const b = entry("Journal/b.md");
    const reader = {
      readBodyCached: (file: TFile) =>
        Promise.resolve(file.path === a.file.path ? "kahve içtik" : "çay"),
    };

    const snapshot = await readJournalSnapshot(reader, [a, b]);
    const paths = hitPaths(searchSnapshot(snapshot, parseSearchQuery("kahve")));

    expect([...paths]).toEqual([a.file.path]);
  });
});
```

- [ ] **Step 2: Run it to verify it passes already**

Run: `npx vitest run tests/mainSearch.test.ts`
Expected: PASS. This one is a characterisation test over Task 5's exports, written before the glue so the glue has something to be checked against. The behaviour it pins is what Step 3 must produce.

- [ ] **Step 3: Write the command and the method**

In `src/main.ts`, add the imports:

```ts
import { hitPaths, readJournalSnapshot } from "./services/journalSearch";
import { SearchModal } from "./views/SearchModal";
```

Register the command beside `filter-journal-by-tag`:

```ts
    this.addCommand({
      id: "search-journal",
      name: "Search journal",
      callback: () => {
        void this.searchJournal();
      },
    });
```

Add the method beside `filterByTag`:

```ts
  /**
   * Opens the journal and asks what the user is looking for.
   *
   * Wrapped for the same reason `filterByTag` is: it is invoked as
   * `void this.searchJournal()`, and it opens with the same `openJournal()`
   * call, which can throw. Left unwrapped that throw is an unhandled
   * rejection that never reaches the console — the command would appear to
   * do nothing.
   *
   * The snapshot is read HERE, before the modal opens, and not inside
   * `getSuggestions`: that runs on every keystroke, and a search that
   * touches the disk per keystroke is the unscalable shape CLAUDE.md
   * § Performance warns against. One read, then pure string work.
   *
   * Both callbacks are guarded rather than fired bare. `requestScope` is
   * the guarded wrapper for the scope path; `goToDateInJournal` has no
   * such wrapper, so its rejection is caught at this call site.
   */
  async searchJournal(): Promise<void> {
    try {
      const view = await this.openJournal();

      if (!view) {
        console.error("Simple Journal: the journal view was not available after opening it");
        new Notice("Could not open the journal.");
        return;
      }

      const entries = this.journal.getEntries();
      const active = view.activeScope();

      // Nothing to search and nothing to clear — a prompt would be a dead end.
      if (entries.length === 0 && active === null) {
        new Notice("No journal entries yet.");
        return;
      }

      const snapshot = await readJournalSnapshot(this.repository, entries);

      new SearchModal(this.app, snapshot, active !== null, (choice) => {
        if (choice.kind === "clear") {
          view.requestScope(null);
          return;
        }
        if (choice.kind === "hit") {
          this.goToDateInJournal(choice.hit.entry.created).catch((error: unknown) => {
            console.error("Simple Journal: could not go to that entry", error);
            new Notice("Could not go to that entry. See the developer console.");
          });
          return;
        }
        if (choice.kind === "all") {
          view.requestScope({ kind: "text", query: choice.query, paths: hitPaths(choice.hits) });
        }
      }).open();
    } catch (error) {
      console.error("Simple Journal: could not open journal search", error);
      new Notice("Could not open journal search. See the developer console.");
    }
  }
```

Nothing here holds the query on the plugin. `SearchModal` puts the query and the hits on the
`all` choice itself (Task 7), so this callback reads both off the thing the user picked — one
object responsible for one answer, and no state to keep in sync between a modal and its opener.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, 685 tests.

- [ ] **Step 5: Type-check and lint**

Run: `npm run build && npm run lint`
Expected: both silent.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/views/SearchModal.ts tests/searchModal.test.ts tests/mainSearch.test.ts
git commit -m "feat: add the Search journal command"
```

---

## Task 9: Styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add the rules**

Append beside the existing `.journal-scope-tag` rule (find it first; put these immediately after so the scope bar's styling stays in one place):

```css
/* A text scope's label. Same role as `.journal-scope-tag`, different shape:
   a tag is a token and reads as one, while a query is the user's own words
   and reads as a quotation. Italic rather than monospaced — this is prose
   they typed, not a code fragment. */
.journal-scope-query {
  font-style: italic;
  color: var(--text-muted);
}

/* One suggester row: the timestamp, then the excerpt. The timestamp is
   fixed-width so the excerpts start on one column and can be scanned down. */
.journal-search-suggestion {
  display: flex;
  gap: var(--size-4-3);
  align-items: baseline;
}

.journal-search-time {
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

/* One line, always. An excerpt that wrapped would make rows different
   heights and turn a scannable list into a wall. */
.journal-search-excerpt {
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The matched text. Colour and weight rather than a background highlight:
   the row is already selectable and a second highlight competes with the
   suggester's own selection state. */
.journal-search-match {
  color: var(--text-normal);
  font-weight: var(--font-semibold);
}

/* Not a result — a caveat about the results. Reads as an aside so it is not
   mistaken for an entry that failed to render. */
.journal-search-unreadable {
  color: var(--text-error);
  font-size: var(--font-ui-smaller);
}
```

- [ ] **Step 2: Verify nothing else broke**

Run: `npm run lint && npm test`
Expected: both green. CSS is not unit-tested; this step only proves the file is still valid enough for the build and that no selector name collided.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: style the search suggester and the query scope bar"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/manual-testing-open.md`, `CHANGELOG.md`

- [ ] **Step 1: Move the command in `CLAUDE.md` § Navigation**

Delete `Search journal` from the "Still later" block, and add it to the "Also implemented" block:

```text
Open calendar
Filter journal by tag
Open journal mentions
Insert journal mentions block
Search journal
```

The "Still later" block is then empty. Replace it and its heading with:

```text
Nothing is queued behind these. A new command needs a section of its own
here first, the way each of the four above has one.
```

- [ ] **Step 2: Add `# Search` to `CLAUDE.md`, immediately after `# Tags`**

```markdown
# Search

One command, `Search journal`, answering two questions with one list: *take me
to that entry*, and *show me everything I wrote about this*.

## Rule 1 — One reader

`journal/entrySearch.ts` owns folding, term splitting, matching and snippets,
and nothing downstream re-derives any of them. Same shape as `entryDate.ts`
for chronology and `entryTags.ts` for tags. It is pure; the reading lives in
`services/journalSearch.ts`, which is the only file that knows search touches
the disk at all.

## Rule 2 — The body, and only the body

Search reads what the timeline shows. Not frontmatter, not filenames.

The timeline hides `.metadata-container`, so a result that matched on a
property would appear with no visible cause — the same reasoning that decides
which tags get chips (§ Tags Rule 3). Tags are already reachable exactly and
case-insensitively through `Filter journal by tag`; search does not duplicate
that with a looser guarantee.

## Rule 3 — Two exits, one door

Choosing a result **anchors** the timeline to that entry, unfiltered — the
calendar's mechanism. Choosing "Show all N matches" **scopes** the timeline to
the query — the tag scope's mechanism. Neither is a new concept.

## Rule 4 — One scope at a time

A text scope and a tag scope are never both active; setting either replaces
the other. This is the line that keeps search on the right side of § Non-Goals:
the intersection of two filters is a query builder.

## Rule 5 — Matching is substring, and there is no syntax

Terms split on whitespace and are ANDed in any order. No quotes, no `OR`, no
exclusion, no field prefixes, no fuzzy matching. A query under two characters
matches nothing.

## Case folding: Turkish casing pairs, no locale

`İ`→`i`, `I`→`ı`, then `toLowerCase()`. Two fixed substitutions, no ICU, no
locale — identical on every platform, which is what `compareEntries` gave up
`localeCompare` to guarantee for a synced vault.

`İ` and `i` are one letter; `I` and `ı` are one letter; `i` and `ı` are not.
`ö/o`, `ç/c`, `ş/s`, `ğ/g`, `ü/u`, `â/a` all stay distinct: this folds case,
not accents.

Plain `toLowerCase()` was rejected because it turns `İ` into `i` plus a
combining dot, so `istanbul` would not find `İstanbul` — a daily failure in a
Turkish journal, not a preference.

**The accepted cost:** English loses its capital `I`. `"I am happy"` folds to
`"ı am happy"` and is not found by `"i am"`. Turkish casing cannot be correct
and leave that alone at the same time. Pinned by a test so it stays a decision.

## Reading

One read of the whole journal per search session, not per keystroke, through
`readBodyCached`. A per-keystroke scan is the unscalable shape § Performance
warns against; a single pass is not. If it is ever felt, the answer is an
incrementally maintained index fed by `JournalService`'s change batching —
which Rule 1 keeps a one-file change.

An unreadable entry is logged, dropped, and **counted**, and the modal shows
the count. Quietly answering with less than you have is the worst thing a
search can do, and § Error Handling asks to fail visibly. Search writes
nothing, so no data is at risk either way.

## A text scope stays live, and never clears itself

A changed entry is re-read and re-evaluated; a folder-level rebuild re-resolves
the whole scope. It is never cleared by anything but the user and
`New journal entry`, for the reason § Tags already gives: a filter that
vanishes with no cause the user can connect to what they did is the failure
this codebase keeps designing away from.
```

- [ ] **Step 3: Amend `CLAUDE.md` § Non-Goals**

Replace the `advanced filters` bullet with:

```markdown
* advanced filters, except the two scopes described under `# Tags` and
  `# Search` — one tag or one text query, chosen from one command, never
  persisted, never both at once. Specifically still out: query syntax of any
  kind (quotes, `OR`, exclusion, field prefixes), regular expressions,
  combining a text scope with a tag scope, saved or recent searches,
  searching frontmatter or filenames, searching the vault rather than the
  journal, a sort order for results, and highlighting matches inside the
  timeline itself. `semantic search` above is unaffected: `# Search` is
  substring matching and nothing else, and Obsidian's own search keeps
  answering the wider question exactly as it did.
```

- [ ] **Step 4: Add the open checks**

Append to the Session G block in `docs/manual-testing-open.md`:

```markdown
- [ ] **Search finds what you remember, in your own language.** Write an entry
      containing `İstanbul` and another containing `Işık`. `Search journal`,
      type `istanbul` — the first must appear; type `ışık` — the second must.
      Then type `acik` with an entry containing `açık` open: it must NOT
      appear. That is the folding decision working in both directions, and no
      unit test can prove the keyboard produces the characters you think it
      does.

- [ ] **Both exits do different things.** Search for a word in several
      entries. Choose one result: the timeline lands on that entry with older
      entries below it and NO filter — scroll up and the newer ones are still
      there. Search again and choose "Show all": now the timeline shows only
      matches and the bar names the query in quotes.

- [ ] **The excerpt is legible in both themes.** In light and dark, the
      matched word must read as emphasised without the row looking striped,
      and a long entry's excerpt must stay on one line rather than wrapping.

- [ ] **A search over the real journal feels immediate.** Not "is fast in a
      test" — open the command on the actual vault and type. If the first
      keystroke stutters, the snapshot read is the suspect and the fix
      direction is the incremental index named in `CLAUDE.md` § Search.

- [ ] **Search on a phone.** The suggester is Obsidian's own, so the keyboard
      and the list are its problem, not ours — but the row layout is ours.
      Confirm the timestamp and excerpt share a line at phone width instead of
      the excerpt collapsing to nothing.
```

- [ ] **Step 5: Add the changelog section**

At the top of `CHANGELOG.md`, under `# Changelog`'s preamble:

```markdown
## 1.3.0

### Search

`Search journal` finds an entry by the words in it.

Type, and matching entries appear with their time and the line the match is
on. Two ways out: pick one and the journal goes to that entry, with the rest
of the timeline still there around it; pick "Show all" and the timeline
narrows to every entry that matched.

- **It searches what you wrote**, not properties or filenames.
- **Turkish casing works.** `istanbul` finds `İstanbul`, `ışık` finds `IŞIK`.
  Accents are not folded: `acik` does not find `açık`. One consequence worth
  knowing — English's capital `I` folds to `ı`, so `i am` does not find
  `I am happy`.
- **Every term must appear**, in any order. There is no query syntax.
- **A search filter is never remembered.** Restarting Obsidian, or writing a
  new entry, puts the whole journal back.
```

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build && npm run lint`
Expected: all green.

```bash
git add CLAUDE.md docs/manual-testing-open.md CHANGELOG.md
git commit -m "docs: record Search journal as a product decision"
```

---

## Self-review notes

Checked against the spec, section by section:

| Spec | Task |
| --- | --- |
| §3 Rule 1 (one reader) | 1, 2 — `entrySearch.ts` pure; 5 — reading isolated in `journalSearch.ts` |
| §3 Rule 2 (body only) | 5 — `readBodyCached` strips frontmatter; 10 — written into CLAUDE.md |
| §3 Rule 3 (two exits) | 7, 8 |
| §3 Rule 4 (one scope) | 3, 4 — the union makes it structural, not a rule to remember |
| §3 Rule 5 (never persisted) | 3 — inherited unchanged; 4 — pinned by the new-entry and Escape tests |
| §4.1–4.2 (substring, AND, no syntax, min length) | 1 |
| §4.3 (folding) | 1, incl. the English cost |
| §5 (the modal) | 7 |
| §6 (one read per session, unreadable count) | 5, 7, 8 |
| §7 (the union, synchronous `matchesScope`) | 3 |
| §8 (live updates) | 6 — **with the correction at the top of this plan** |
| §9 (CLAUDE.md changes) | 10 |
| §10 (tests) | every task |
| §11 (non-goals) | 10 Step 3 |

Two things the spec asks for that this plan deliberately does not build:

1. **Spec §8's folder-change clearing.** Corrected at the top; re-resolution instead.
2. **Spec §10's "the modal is usable on a phone" as a unit test.** It is not one; it is in Task 10's open checks, where the rest of this plugin's mobile claims already live.
