# Journal Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read tags from every journal entry through a single source-blind resolver, render chips for the frontmatter tags the timeline otherwise hides, and let a command scope the timeline to one tag — without the plugin ever writing a tag.

**Architecture:** `journal/entryTags.ts` becomes the one place tags are resolved (`getAllTags`), exactly as `entryDate.ts` is the one place chronology is resolved. `JournalEntry` grows a `tags` array, filled in `EntryRepository.entryFor`. `JournalView` owns a `tagScope: string | null`; while it is set, `this.index` is re-derived as `live.filter(matches)` at every reload and at the start of every change batch, so paging, anchoring and insertion all keep working unchanged. The pure `decideChangeAction` gains an `inScope` argument so a row that leaves the scope is removed and one that enters is inserted.

**Tech Stack:** TypeScript, Obsidian plugin API (`getAllTags`, `parseFrontMatterTags`, `SuggestModal`), vitest + jsdom, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-23-journal-tags-design.md`

**One decision the spec left open, settled here:** tag matching is **exact**, case-insensitive. Scoping to `#work` does NOT include `#work/project`. Nested tags are listed separately in the suggester, so every tag stays reachable, and "tag hierarchy browsing" is out of scope per the spec.

---

### Task 1: Test-mock groundwork

The vitest config aliases `obsidian` to `tests/obsidian-mock.ts`, so `getAllTags`,
`parseFrontMatterTags` and `SuggestModal` do not exist for any test until they are
added there. `FakeMetadataCache` also has no way to express an inline tag today.

**Files:**
- Modify: `tests/obsidian-mock.ts:296-305` (`FakeMetadataCache`), and append new exports
- Modify: `tests/journalViewHarness.ts` (add `tagEntry`)

- [ ] **Step 1: Replace `FakeMetadataCache` so a test can express inline tags**

Replace the whole existing class (`/** In-memory metadata cache. Frontmatter is supplied per path by the test. */` through its closing brace) with:

```ts
/**
 * In-memory metadata cache. Frontmatter is supplied per path by the test;
 * inline `#tag` occurrences are supplied separately via `inlineTags` (bare
 * tag text, no `#`), because a real cache reports the two through different
 * fields and `resolveTags` must be provable against both.
 */
export class FakeMetadataCache extends FakeEvents {
  frontmatter = new Map<string, Record<string, unknown>>();
  /** Inline tags per path, WITHOUT the leading `#`. */
  inlineTags = new Map<string, string[]>();

  getFileCache(
    file: TFile,
  ): { frontmatter?: Record<string, unknown>; tags?: Array<{ tag: string }> } | null {
    const fm = this.frontmatter.get(file.path);
    const inline = this.inlineTags.get(file.path);
    // Null for a file the test said nothing about, matching a real cache that
    // has not indexed (or found anything in) the file — `entryFor` relies on
    // that to fall back to the filename convention.
    if (!fm && !inline) return null;

    const cache: { frontmatter?: Record<string, unknown>; tags?: Array<{ tag: string }> } = {};
    if (fm) cache.frontmatter = fm;
    // Real Obsidian reports inline tags WITH the `#`, and with a `position`
    // nothing under test reads — only `.tag` is modeled.
    if (inline) cache.tags = inline.map((tag) => ({ tag: `#${tag}` }));
    return cache;
  }
}
```

- [ ] **Step 2: Add `parseFrontMatterTags` and `getAllTags` to the mock**

Append after the `FakeMetadataCache` class:

```ts
/**
 * Stand-in for Obsidian's `parseFrontMatterTags`. Returns tags WITH a leading
 * `#`, like the real function, and accepts both of the shapes a user's
 * frontmatter can legitimately hold — a YAML list, or one comma/space
 * separated string.
 */
export function parseFrontMatterTags(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!frontmatter) return null;

  const raw = frontmatter.tags ?? frontmatter.tag;
  if (raw === undefined || raw === null) return null;

  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const tags = list
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.startsWith("#") ? value : `#${value}`));

  return tags.length > 0 ? tags : null;
}

/**
 * Stand-in for Obsidian's `getAllTags`: inline tags and frontmatter tags
 * merged into one array, each with its `#`. Deliberately does NOT dedupe —
 * `resolveTags` dedupes for itself, and leaving duplicates in makes a test
 * that relies on that dedupe prove something real.
 */
export function getAllTags(
  cache: { frontmatter?: Record<string, unknown>; tags?: Array<{ tag: string }> } | null,
): string[] | null {
  if (!cache) return null;

  const tags = [
    ...(cache.tags ?? []).map((entry) => entry.tag),
    ...(parseFrontMatterTags(cache.frontmatter) ?? []),
  ];

  return tags.length > 0 ? tags : null;
}
```

- [ ] **Step 3: Add a `SuggestModal` stand-in to the mock**

Append after the existing `Modal` class:

```ts
/**
 * Minimal stand-in for Obsidian's `SuggestModal`. Real Obsidian renders a
 * floating prompt with a filtered list; jsdom has no layout for that, so this
 * exposes the three abstract members a subclass implements and a test-only
 * `choose` to pick a suggestion by hand — which is the whole surface
 * `TagScopeModal` has.
 */
export abstract class SuggestModal<T> extends Modal {
  limit = 50;
  emptyStateText = "";
  inputEl: HTMLInputElement;

  constructor(app?: unknown) {
    super(app);
    this.inputEl = document.createElement("input");
  }

  setPlaceholder(text: string): void {
    this.inputEl.placeholder = text;
  }

  abstract getSuggestions(query: string): T[];
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

  /** Test-only: chooses `item` exactly as a click in the real prompt would. */
  choose(item: T): void {
    this.onChooseSuggestion(item, new MouseEvent("click"));
  }
}
```

- [ ] **Step 4: Add a `tagEntry` helper to the harness**

Append to `tests/journalViewHarness.ts`, after `addEntry`:

```ts
/**
 * Registers `tags` (bare, no `#`) as the INLINE tags of an already-added
 * entry file. Must be called before `harness.service.load()` for the tags to
 * be in the initial index — `entryFor` reads the cache once, when the index
 * is built.
 */
export function tagEntry(harness: Harness, file: TFile, tags: string[]): void {
  harness.app.metadataCache.inlineTags.set(file.path, tags);
}

/** Same, for FRONTMATTER tags — the ones the timeline renders chips for. */
export function tagEntryInFrontmatter(harness: Harness, file: TFile, tags: string[]): void {
  harness.app.metadataCache.frontmatter.set(file.path, { tags });
}
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npx vitest run`
Expected: PASS — every existing test file, unchanged behaviour (the mock only gained members).

- [ ] **Step 6: Commit**

```bash
git add tests/obsidian-mock.ts tests/journalViewHarness.ts
git commit -m "test: mock getAllTags, parseFrontMatterTags and SuggestModal"
```

---

### Task 2: `entryTags.ts` — the single tag resolver

**Files:**
- Create: `src/journal/entryTags.ts`
- Test: `tests/entryTags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/entryTags.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import { collectTags, entryHasTag, frontmatterTags, resolveTags } from "../src/journal/entryTags";

/** A cache shaped like Obsidian's, as `getFileCache` returns it. */
function cache(inline: string[] = [], frontmatter?: Record<string, unknown>) {
  return {
    tags: inline.map((tag) => ({ tag: `#${tag}` })),
    ...(frontmatter ? { frontmatter } : {}),
  } as never;
}

function entry(tags: string[]): JournalEntry {
  return {
    file: { path: "Journal/2026/08/2026-08-12-22-41-52.md" } as JournalEntry["file"],
    created: new Date(2026, 7, 12, 22, 41, 52),
    tags,
  };
}

describe("resolveTags", () => {
  it("reads inline tags, stripping the #", () => {
    expect(resolveTags(cache(["work"]))).toEqual(["work"]);
  });

  it("reads frontmatter tags, which carry no #", () => {
    expect(resolveTags(cache([], { tags: ["work"] }))).toEqual(["work"]);
  });

  it("merges both without caring which side a tag came from", () => {
    expect(resolveTags(cache(["therapy"], { tags: ["work"] }))).toEqual(["therapy", "work"]);
  });

  it("keeps nested tags whole", () => {
    expect(resolveTags(cache(["work/project"]))).toEqual(["work/project"]);
  });

  it("dedupes case-insensitively, keeping the casing seen first", () => {
    expect(resolveTags(cache(["Work"], { tags: ["work", "WORK"] }))).toEqual(["Work"]);
  });

  it("accepts a comma-separated frontmatter string", () => {
    expect(resolveTags(cache([], { tags: "work, therapy" }))).toEqual(["work", "therapy"]);
  });

  it("is empty for an absent cache rather than throwing", () => {
    expect(resolveTags(null)).toEqual([]);
    expect(resolveTags(undefined)).toEqual([]);
  });

  it("is empty for a cache with no tags at all", () => {
    expect(resolveTags(cache([], { created: "2026-08-12T22:41:52+03:00" }))).toEqual([]);
  });

  it("ignores frontmatter tag entries that are not usable text", () => {
    expect(resolveTags(cache([], { tags: ["work", "", null, 7] }))).toEqual(["work", "7"]);
  });
});

describe("frontmatterTags", () => {
  it("returns only the frontmatter side — the part the timeline hides", () => {
    expect(frontmatterTags(cache(["therapy"], { tags: ["work"] }))).toEqual(["work"]);
  });

  it("is empty when there is no frontmatter", () => {
    expect(frontmatterTags(cache(["therapy"]))).toEqual([]);
  });
});

describe("entryHasTag", () => {
  it("matches case-insensitively", () => {
    expect(entryHasTag(entry(["Work"]), "work")).toBe(true);
  });

  it("accepts a needle written with a #", () => {
    expect(entryHasTag(entry(["work"]), "#work")).toBe(true);
  });

  it("does not match a child tag — scoping is exact", () => {
    expect(entryHasTag(entry(["work/project"]), "work")).toBe(false);
  });

  it("is false for an entry with no tags", () => {
    expect(entryHasTag(entry([]), "work")).toBe(false);
  });
});

describe("collectTags", () => {
  it("returns every tag across entries, deduped and alphabetical", () => {
    const tags = collectTags([entry(["work", "therapy"]), entry(["Work", "books"])]);
    expect(tags).toEqual(["books", "therapy", "work"]);
  });

  it("is empty for an empty journal", () => {
    expect(collectTags([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entryTags.test.ts`
Expected: FAIL — `Failed to resolve import "../src/journal/entryTags"`.

- [ ] **Step 3: Write the implementation**

Create `src/journal/entryTags.ts`:

```ts
import { getAllTags, parseFrontMatterTags, type CachedMetadata } from "obsidian";
import type { JournalEntry } from "./entry";

/**
 * The ONE place tags are resolved, exactly as `entryDate.ts` is the one place
 * an entry's chronology is resolved.
 *
 * Obsidian draws no semantic distinction between an inline `#tag` and a
 * frontmatter `tags:` entry — `getAllTags` merges both, and search, the tag
 * pane and the graph all treat them identically. Neither does this plugin,
 * with exactly one exception: `frontmatterTags` below, which exists because
 * the timeline hides the properties panel (`styles.css`'s
 * `.journal-entry-embed .metadata-container`) and so has to surface the one
 * kind of tag it would otherwise make invisible.
 *
 * Nothing here ever WRITES a tag. Frontmatter belongs to the user (only
 * `created` is ours, via `setCreatedProperty`), and the body needs no help:
 * the embedded editor is a real Obsidian editor, so typing `#` brings up
 * Obsidian's own tag autocomplete.
 */

/** Bare tag text: no leading `#`, no surrounding whitespace. */
function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim();
}

/**
 * Normalizes, drops anything empty, and dedupes case-insensitively —
 * Obsidian treats `#Work` and `#work` as the same tag — while keeping the
 * casing that appeared first, which is what gets displayed.
 */
function normalizeAll(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const value of raw) {
    const tag = normalizeTag(value);
    if (!tag) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

/**
 * Every tag on the entry, inline and frontmatter alike, `#` stripped.
 *
 * An absent cache yields `[]` rather than throwing: the timeline must not
 * break because one entry has not been indexed yet, the same principle
 * `resolveEntryDate`'s fallback chain follows. `metadataCache.on("changed")`
 * already queues an upsert, so the entry picks its tags up moments later.
 */
export function resolveTags(cache: CachedMetadata | null | undefined): string[] {
  if (!cache) return [];
  return normalizeAll(getAllTags(cache) ?? []);
}

/**
 * Only the frontmatter side. Used for the chips in an entry's header, and
 * for nothing else — see this module's doc for why that one asymmetry exists.
 */
export function frontmatterTags(cache: CachedMetadata | null | undefined): string[] {
  if (!cache?.frontmatter) return [];
  return normalizeAll(parseFrontMatterTags(cache.frontmatter) ?? []);
}

/**
 * Whether `entry` carries `tag`, compared case-insensitively. `tag` may be
 * written with or without a leading `#`.
 *
 * EXACT match, deliberately: `work` does not match `work/project`. A scope is
 * a filter over a continuous timeline, not a hierarchy browser (a non-goal),
 * and the suggester lists every nested tag separately, so nothing becomes
 * unreachable.
 */
export function entryHasTag(entry: JournalEntry, tag: string): boolean {
  const needle = normalizeTag(tag).toLowerCase();
  if (!needle) return false;
  return entry.tags.some((value) => value.toLowerCase() === needle);
}

/** Every tag across `entries`, deduped and alphabetical — the suggester's list. */
export function collectTags(entries: readonly JournalEntry[]): string[] {
  return normalizeAll(entries.flatMap((entry) => entry.tags)).sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/entryTags.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/journal/entryTags.ts tests/entryTags.test.ts
git commit -m "feat: resolve entry tags in one source-blind place"
```

---

### Task 3: `JournalEntry.tags`, filled by the repository

**Files:**
- Modify: `src/journal/entry.ts`
- Modify: `src/journal/entryRepository.ts:161-172` (`entryFor`)
- Modify: `src/views/JournalView.ts:1601`, `:2207`, `:2502` (the three other construction sites)
- Modify: `tests/entryIndex.test.ts:15-19`, `:120-123`, `:138`, `:139-142`
- Modify: `tests/journalService.test.ts:101`, `:404`
- Test: `tests/entryRepository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/entryRepository.test.ts`, inside its top-level `describe` (match the file's existing `setup()`/fake-app helpers — if its helper is named differently, use that name; the assertions are what matter):

```ts
describe("entryFor tags", () => {
  it("carries the entry's tags, inline and frontmatter merged", () => {
    const { fake, repository } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.metadataCache.inlineTags.set(file.path, ["therapy"]);
    fake.metadataCache.frontmatter.set(file.path, { tags: ["work"] });

    expect(repository.entryFor(file)?.tags).toEqual(["therapy", "work"]);
  });

  it("is an empty array, not undefined, for an unindexed entry", () => {
    const { fake, repository } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");

    expect(repository.entryFor(file)?.tags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entryRepository.test.ts`
Expected: FAIL — `expected undefined to deeply equal [ 'therapy', 'work' ]`.

- [ ] **Step 3: Add the field**

Replace `src/journal/entry.ts` entirely:

```ts
import type { TFile } from "obsidian";

export interface JournalEntry {
  file: TFile;
  created: Date;
  /**
   * Every tag on the entry, `#` stripped — inline and frontmatter alike, in
   * no particular order. Resolved by `entryTags.ts`; see its doc for why the
   * two kinds are not distinguished here. `[]` when the entry has none, or
   * has not been indexed yet.
   */
  tags: string[];
}
```

- [ ] **Step 4: Fill it in the repository**

In `src/journal/entryRepository.ts`, add to the import block from `./entryDate`'s neighbours:

```ts
import { resolveTags } from "./entryTags";
```

Then replace the body of `entryFor` (currently lines 161-172):

```ts
  /** Builds the entry record for a file, or null if the file is not an entry. */
  entryFor(file: TFile): JournalEntry | null {
    if (!this.isEntryFile(file)) return null;

    // Read once: `resolveTags` needs the whole cache (inline tags live
    // outside `frontmatter`), and `resolveEntryDate` needs only `created`.
    const cache = this.app.metadataCache.getFileCache(file);
    const created = resolveEntryDate({
      basename: file.basename,
      ctime: file.stat.ctime,
      created: cache?.frontmatter?.created,
    });

    return { file, created, tags: resolveTags(cache) };
  }
```

- [ ] **Step 5: Fix the three other construction sites**

`src/views/JournalView.ts:1601`, inside `commitEntryTimeChange` — a time correction changes neither tag:

```ts
    const change = this.plugin.journal.applyKnownEntry({
      file,
      created: value,
      tags: rendered.entry.tags,
    });
```

`src/views/JournalView.ts:2207`, the uncommitted composer's placeholder entry — add `tags` alongside the existing `file`/`created` members of that object literal:

```ts
      file: null as unknown as JournalEntry["file"],
      // No file, so nothing has been indexed: an uncommitted composer has no
      // tags even if its draft text already contains a `#tag`.
      tags: [],
```

`src/views/JournalView.ts:2502`, in `commitComposer`, where the entry finally gets a file:

```ts
    // `[]`, not a fresh resolve: the file was created a moment ago and the
    // metadata cache has not indexed it yet. The `changed` event it will fire
    // arrives as a "content" change, and `applyUpsert` fills the real tags in
    // then (see `journalService.ts`).
    rendered.entry = { file, created, tags: [] };
```

- [ ] **Step 6: Fix the affected test literals**

`tests/entryIndex.test.ts`, the `entry` helper at the top:

```ts
function entry(basename: string, created: Date): JournalEntry {
  return {
    file: { path: `Journal/${basename}.md`, basename } as JournalEntry["file"],
    created,
    tags: [],
  };
}
```

Same file, the `edited` literal (~line 120):

```ts
    const edited: JournalEntry = {
      file: aug12_1723.file,
      created: new Date(2026, 7, 12, 23, 0, 0), // now newer than aug12_2241
      tags: [],
    };
```

Same file, the `first`/`second` literals (~line 138):

```ts
    const first: JournalEntry = { file: aug12_1723.file, created: aug12_1723.created, tags: [] };
    const second: JournalEntry = {
      file: aug12_1723.file,
      created: new Date(2026, 7, 12, 18, 0, 0),
      tags: [],
    };
```

`tests/journalService.test.ts:101`:

```ts
    service.applyKnownEntry({ file, created: new Date(2026, 6, 1, 8, 0, 0), tags: [] });
```

`tests/journalService.test.ts:404`:

```ts
    const change = service.applyKnownEntry({
      file: replacement,
      created: existing.created,
      tags: existing.tags,
    });
```

- [ ] **Step 7: Run the type check and the full suite**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run`
Expected: no type errors; all tests PASS. If `tsc` names another `JournalEntry` literal not listed above, add `tags: []` to it (or the entry's real tags when the site has them at hand).

- [ ] **Step 8: Commit**

```bash
git add src/journal/entry.ts src/journal/entryRepository.ts src/views/JournalView.ts tests/entryIndex.test.ts tests/journalService.test.ts tests/entryRepository.test.ts
git commit -m "feat: carry tags on JournalEntry"
```

**Correction applied during execution.** Step 5 specified `tags: rendered.entry.tags` at `commitEntryTimeChange`; code review found that array can be stale for a freshly committed composer entry (the "added" change never replaces it, since `insertEntryInPlace` early-returns on an already-rendered path), so the shipped code re-resolves the tags from the metadata cache instead. The `commitComposer` comment at `:2502` was also corrected to name the "added" branch rather than "content", which was never the branch that event takes.

---

### Task 4: A tag changed externally reaches the index

`JournalService.applyUpsert` compares only `created`. When just the tags changed
it takes the "content" branch and returns the EXISTING index object — which
still holds the old tags unless they are written back, exactly as `.file`
already is.

**Files:**
- Modify: `src/services/journalService.ts` (`applyUpsert`, the "content" branch)
- Test: `tests/journalService.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `tests/journalService.test.ts`'s top-level `describe`:

```ts
  it("updates tags on the existing index entry when only the tags changed", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    fake.metadataCache.inlineTags.set(file.path, ["work"]);
    service.load();

    const [existing] = service.getEntries();
    expect(existing.tags).toEqual(["work"]);

    fake.metadataCache.inlineTags.set(file.path, ["work", "therapy"]);
    const change = service.applyKnownEntry({
      file,
      created: existing.created,
      tags: ["work", "therapy"],
    });

    // Same object — the identity `indexOf`-by-reference callers depend on is
    // preserved — but its tags are current.
    expect(change).toEqual({ kind: "content", entry: existing });
    expect(service.getEntries()[0]).toBe(existing);
    expect(existing.tags).toEqual(["work", "therapy"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/journalService.test.ts`
Expected: FAIL — `expected [ 'work' ] to deeply equal [ 'work', 'therapy' ]`.

- [ ] **Step 3: Write the tags back**

In `src/services/journalService.ts`, in `applyUpsert`'s final branch, immediately
after the existing `existing.file = entry.file;` line and before the `return`:

```ts
    // Written back for the same reason `.file` is, and for one more: this
    // branch is the ONLY one a tag-only change ever reaches, since
    // `applyUpsert` compares `created` and nothing else. Without this, an
    // entry that gained or lost a tag elsewhere in Obsidian would keep its
    // stale tags in the index forever, and `JournalView`'s tag scope would
    // filter on them.
    existing.tags = entry.tags;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/journalService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/journalService.ts tests/journalService.test.ts
git commit -m "fix: refresh tags on an existing index entry"
```

---

### Task 5: `decideChangeAction` learns about a scope

**Files:**
- Modify: `src/views/applyChange.ts`
- Test: `tests/applyChange.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/applyChange.test.ts` (reuse the file's existing `entry` const and
its `state()`-style helper; if the helper has another name, use that one — it
builds a `RenderedState`):

```ts
describe("decideChangeAction with a tag scope", () => {
  const rendered = { exists: true, focused: false, dirty: false, fileStillExists: true };
  const absent = { exists: false, focused: false, dirty: false, fileStillExists: true };

  it("does not insert an added entry the scope excludes", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent, false)).toEqual({ type: "noop" });
  });

  it("still inserts an added entry the scope admits", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent, true)).toEqual({ type: "insert" });
  });

  it("removes a rendered entry that has left the scope", () => {
    expect(decideChangeAction({ kind: "content", entry }, rendered, false)).toEqual({
      type: "remove",
      flush: true,
    });
  });

  it("inserts an entry that has entered the scope", () => {
    expect(decideChangeAction({ kind: "content", entry }, absent, true)).toEqual({
      type: "insert",
    });
  });

  it("never yanks a row the user is focused in, even out of scope", () => {
    expect(
      decideChangeAction({ kind: "content", entry }, { ...rendered, focused: true }, false),
    ).toEqual({ type: "noop" });
  });

  it("never yanks a row with unsaved text, even out of scope", () => {
    expect(
      decideChangeAction({ kind: "content", entry }, { ...rendered, dirty: true }, false),
    ).toEqual({ type: "noop" });
  });

  it("removes rather than repositions a moved entry the scope excludes", () => {
    expect(decideChangeAction({ kind: "moved", entry }, rendered, false)).toEqual({
      type: "remove",
      flush: true,
    });
  });

  it("defaults to in-scope, so an unscoped timeline behaves exactly as before", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent)).toEqual({ type: "insert" });
    expect(decideChangeAction({ kind: "content", entry }, rendered)).toEqual({ type: "refresh" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/applyChange.test.ts`
Expected: FAIL — `expected { type: 'insert' } to deeply equal { type: 'noop' }` (the third argument is ignored today).

- [ ] **Step 3: Add the parameter**

In `src/views/applyChange.ts`, replace the signature and the `moved`/`content`
cases of `decideChangeAction`:

```ts
/**
 * Pure decision logic behind `JournalView.applyChangesNow`. Exercised
 * directly with fabricated `RenderedState`, rather than only through a live
 * `JournalView` (which needs a DOM, `IntersectionObserver`s, and Obsidian
 * internals this test environment doesn't provide).
 *
 * `inScope` is whether the changed entry belongs in the timeline as
 * currently filtered — always `true` for an unscoped timeline, which is why
 * it defaults that way: an unscoped journal must behave exactly as it did
 * before tag scoping existed. Only consulted for the three kinds that carry
 * an entry; "removed" and "reload" are scope-independent.
 */
export function decideChangeAction(
  change: JournalChange,
  state: RenderedState,
  inScope = true,
): ChangeAction {
  switch (change.kind) {
    case "reload":
      return { type: "reloadView" };

    case "added":
      // An entry the scope excludes is not merely rendered elsewhere — it is
      // not part of this timeline at all, so there is nothing to insert.
      return inScope ? { type: "insert" } : { type: "noop" };

    case "removed":
      // Nothing rendered at this path (e.g. a delete of a path that was
      // never an entry, or the renameSource half of a rename that never
      // had a rendering to begin with): nothing to do.
      if (!state.exists) return { type: "noop" };
      // `fileStillExists` distinguishes a genuine deletion (flushing would
      // just fail and surface a confusing "failed to save" notice for an
      // intentional deletion) from the stale old-path half of a rename or a
      // move out of the journal folder (the file is still there, just
      // elsewhere — flush first so a mid-debounce edit isn't lost).
      return { type: "remove", flush: state.fileStillExists };

    case "moved":
      if (!inScope) return leaveScope(state);
      // Nothing rendered under this path yet: still insert it fresh, same
      // as "added" — reachable when a rename also changes the resolved
      // `created` (the old rendering, if any, was already torn down by this
      // same batch's "removed" for the old path).
      if (!state.exists) return { type: "insert" };
      return { type: "reposition", flush: state.fileStillExists };

    case "content":
      if (!inScope) return leaveScope(state);
      // Same reasoning as "moved": nothing rendered yet, insert fresh
      // rather than silently dropping the change (reachable after a
      // same-timestamp rename).
      if (!state.exists) return { type: "insert" };
      // Loop/clobber suppression: never touch an editor the user is
      // actively focused in, AND never touch one whose text is "dirty" —
      // differs from what's known to be on disk. The second case matters
      // even though the editor isn't focused: without it, `setValue`-ing the
      // external body over an in-flight edit would both discard that edit
      // AND get silently overwritten again moments later when the stale,
      // already-scheduled save fires with its stale captured value — losing
      // both the local edit and the external change, and leaving the
      // editor's on-screen text diverged from what actually lands on disk.
      if (state.focused || state.dirty) return { type: "noop" };
      return { type: "refresh" };
  }
}

/**
 * What to do with a rendered row whose entry no longer belongs in the
 * current scope — the user removed the scoped tag from it, or changed it to
 * a different one, from anywhere in Obsidian.
 *
 * The focused/dirty decline is the same one `"content"` makes above, and
 * matters MORE here: removing a scoped tag from an entry is something a user
 * plausibly does while typing in that very entry, and destroying the editor
 * mid-keystroke would take unsaved text with it. The row then stays visible
 * although out of scope until the next reload — a briefly over-inclusive
 * timeline, which is the safe direction to be wrong in.
 */
function leaveScope(state: RenderedState): ChangeAction {
  if (!state.exists) return { type: "noop" };
  if (state.focused || state.dirty) return { type: "noop" };
  return { type: "remove", flush: state.fileStillExists };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/applyChange.test.ts`
Expected: PASS — the new block plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/views/applyChange.ts tests/applyChange.test.ts
git commit -m "feat: scope-aware change decisions"
```

---

### Task 6: `changeApplication` carries the scope and refreshes chips

`decideChangeAction` can now return `remove` for `content`/`moved`, which the
switch in `applyChangesNow` currently treats as unreachable.

**Files:**
- Modify: `src/views/changeApplication.ts` (`ChangeApplicationDeps`, `applyChangesNow`)

- [ ] **Step 1: Add the two new deps**

In `src/views/changeApplication.ts`, append to `ChangeApplicationDeps` (before
the final `save: SaveDeps;` member):

```ts
  /**
   * Whether `entry` belongs in the timeline as currently filtered —
   * `JournalView.matchesScope`. Always true when no tag scope is active.
   */
  matchesScope(entry: JournalEntry): boolean;
  /**
   * Re-renders one row's frontmatter tag chips from the current metadata
   * cache — `JournalView.refreshEntryTags`. Called for every "content"/
   * "moved" change, INCLUDING the ones whose action is `noop`: that decline
   * protects the editor's text, and the header's chips are not the editor.
   * Without this a chip would keep advertising a frontmatter tag the user
   * had already removed, until the next full reload.
   */
  refreshEntryTags(rendered: ChangeEntry): void;
```

- [ ] **Step 2: Pass the scope into the decision and refresh the chips**

In `applyChangesNow`, replace the three lines beginning
`// Remaining kinds ("added" | "content" | "moved") all carry \`entry\`.`:

```ts
      // Remaining kinds ("added" | "content" | "moved") all carry `entry`.
      const path = change.entry.file.path;
      const rendered = deps.getRendered(path);
      // Before the switch, so it also runs for the `noop` a focused/dirty
      // editor produces — see `refreshEntryTags`'s doc in the deps.
      if (rendered && change.kind !== "added") deps.refreshEntryTags(rendered);
      const action = decideChangeAction(
        change,
        renderedStateFor(rendered),
        deps.matchesScope(change.entry),
      );
```

- [ ] **Step 3: Implement the `remove` case**

In the same switch, replace the final two cases:

```ts
        case "remove":
          // Reachable only for an entry that has LEFT the active tag scope
          // (see `leaveScope` in `applyChange.ts`); a genuine deletion is a
          // "removed" change, handled above.
          if (action.flush && rendered) {
            await flushSave(rendered, deps.save);
            if (deps.isClosed() || generation !== deps.getGeneration()) return;

            // The write is still failing. Same reasoning as the "removed"
            // and "reposition" branches: tearing this rendering down would
            // replace the on-screen text with the stale `savedBody` and
            // discard exactly what the "not saved" marker promises is still
            // safe. Leaving an out-of-scope row on screen is the smaller
            // harm by a wide margin.
            if (isDirty(rendered)) break;
          }
          if (removeRenderedEntry(path)) dayGroupsDirty = true;
          break;

        case "reloadView":
          // Unreachable for "added"/"content"/"moved" — decideChangeAction
          // only returns this for "reload", handled above.
          break;
```

- [ ] **Step 4: Verify the type check fails for the missing deps**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: FAIL — `Property 'matchesScope' is missing` at `JournalView.ts`'s `createChangeApplication(...)` call. Task 7 supplies both deps; this is the expected intermediate state.

- [ ] **Step 5: Commit**

```bash
git add src/views/changeApplication.ts
git commit -m "feat: apply scope decisions and refresh chips per change"
```

---

### Task 7: `JournalView` owns the scope

**Files:**
- Modify: `src/views/JournalView.ts` (imports, fields, `changeApplication` deps, `reloadNow`, `applyChangesNow`, new methods)
- Test: `tests/JournalView.tagScope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/JournalView.tagScope.test.ts`:

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

describe("JournalView tag scope", () => {
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

  async function openWithTaggedEntries() {
    const tagged = addEntry(h, new Date(2026, 7, 12, 22, 41, 52));
    const untagged = addEntry(h, new Date(2026, 7, 12, 17, 23, 41));
    const older = addEntry(h, new Date(2026, 7, 10, 9, 34, 21));
    tagEntry(h, tagged, ["therapy"]);
    tagEntry(h, older, ["therapy"]);
    h.service.load();
    await h.view.onOpen();
    return { tagged, untagged, older };
  }

  it("renders only the entries carrying the scoped tag", async () => {
    const { tagged, untagged, older } = await openWithTaggedEntries();

    await h.view.setTagScope("therapy");

    expect(renderedPaths(h)).toEqual([tagged.path, older.path]);
    expect(renderedPaths(h)).not.toContain(untagged.path);
  });

  it("restores the whole timeline when the scope is cleared", async () => {
    const { tagged, untagged, older } = await openWithTaggedEntries();

    await h.view.setTagScope("therapy");
    await h.view.setTagScope(null);

    expect(renderedPaths(h)).toEqual([tagged.path, untagged.path, older.path]);
  });

  it("reports the active scope", async () => {
    await openWithTaggedEntries();
    expect(h.view.activeTagScope()).toBeNull();

    await h.view.setTagScope("#Therapy");
    // Stored bare and as typed; matching is case-insensitive.
    expect(h.view.activeTagScope()).toBe("Therapy");
  });

  it("shows a scoped empty state rather than a blank timeline", async () => {
    await openWithTaggedEntries();

    await h.view.setTagScope("nothing-has-this");

    expect(renderedPaths(h)).toEqual([]);
    expect(timelineEl(h.view).querySelector(".journal-empty")?.textContent).toBe(
      "No entries tagged #nothing-has-this.",
    );
  });

  it("drops a row whose scoped tag was removed elsewhere in Obsidian", async () => {
    const { tagged, older } = await openWithTaggedEntries();
    await h.view.setTagScope("therapy");
    expect(renderedPaths(h)).toEqual([tagged.path, older.path]);

    h.app.metadataCache.inlineTags.set(tagged.path, []);
    h.app.metadataCache.trigger("changed", tagged);
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(renderedPaths(h)).toEqual([older.path]));
  });

  it("does not insert a newly created entry the scope excludes", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");
    const before = renderedPaths(h);

    const fresh = addEntry(h, new Date(2026, 7, 13, 8, 0, 0));
    h.app.vault.trigger("create", fresh);
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(renderedPaths(h)).toEqual(before));
  });

  it("inserts a newly created entry the scope admits", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");

    const fresh = addEntry(h, new Date(2026, 7, 13, 8, 0, 0));
    tagEntry(h, fresh, ["therapy"]);
    h.app.vault.trigger("create", fresh);
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(renderedPaths(h)[0]).toBe(fresh.path));
  });

  it("composes with an anchor: the scoped tag, from that day backwards", async () => {
    const { tagged, older } = await openWithTaggedEntries();

    await h.view.setTagScope("therapy");
    await h.view.goToDate(new Date(2026, 7, 11, 23, 59, 59));

    // `tagged` is newer than the anchor, so the anchor excludes it; `older`
    // carries the tag and is older, so both filters admit it.
    expect(renderedPaths(h)).toEqual([older.path]);
    expect(h.view.activeTagScope()).toBe("therapy");
    void tagged;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: FAIL — `h.view.setTagScope is not a function`.

- [ ] **Step 3: Add the imports**

In `src/views/JournalView.ts`, add after the `UnsafeFrontmatterError` import:

```ts
import { entryHasTag, frontmatterTags } from "../journal/entryTags";
```

- [ ] **Step 4: Add the field**

Immediately after the `anchorDate` field (line ~237):

```ts
  /**
   * When set, the timeline shows only entries carrying this tag (`#`
   * stripped, cased as the user chose it; matching is case-insensitive).
   *
   * A SCOPE, not an anchor: a tag is not a point on the chronological axis,
   * so "this tag and older" has no meaning — see the spec at
   * `docs/superpowers/specs/2026-08-23-journal-tags-design.md`. Composes with
   * `anchorDate`: the two are orthogonal, one deciding WHICH entries and the
   * other WHERE to start.
   *
   * NEVER persisted — not to view state, not to settings. A saved workspace
   * layout that restored a filter would hide most of a user's journal at
   * startup with no visible cause, the same "permanently locked out" failure
   * the calendar's placement policy exists to avoid.
   */
  private tagScope: string | null = null;
```

- [ ] **Step 5: Supply the two new `changeApplication` deps**

In the `createChangeApplication({...})` object literal (line ~429), add:

```ts
    matchesScope: (entry) => this.matchesScope(entry),
    refreshEntryTags: (rendered) => this.refreshEntryTags(rendered as RenderedEntry),
```

- [ ] **Step 6: Add the scope methods**

Insert immediately before `scrollToTop()` (line ~2625):

```ts
  /**
   * The entries the current scope admits.
   *
   * Unscoped this returns the service's LIVE array, exactly as before —
   * `JournalService`'s class doc explains why that alias matters. Scoped it
   * returns a fresh filtered array, re-derived rather than incrementally
   * maintained (see `reloadNow`/`applyChangesNow`): `filter` preserves the
   * same entry objects, so `pageAfter`'s path cursor and
   * `insertEntryInPlace`'s `indexOf`-by-reference both keep working against
   * it unchanged, and two lists can never drift apart.
   */
  private scopedIndex(): JournalEntry[] {
    const all = this.plugin.journal.getEntries();
    const scope = this.tagScope;
    if (scope === null) return all;
    return all.filter((entry) => entryHasTag(entry, scope));
  }

  /** Whether `entry` belongs in the timeline as currently filtered. */
  private matchesScope(entry: JournalEntry): boolean {
    return this.tagScope === null || entryHasTag(entry, this.tagScope);
  }

  /** The active tag scope, or null. Read by `main.ts` to build the suggester. */
  activeTagScope(): string | null {
    return this.tagScope;
  }

  /**
   * Scopes the timeline to `tag`, or clears the scope when `tag` is null.
   *
   * Keeps any active anchor: the two compose (see `tagScope`'s doc). Goes
   * through the same serialized `reload()` chain as every other timeline
   * rebuild, and scrolls to the top afterwards so the newest matching entry
   * is actually visible rather than leaving the viewport where the previous,
   * differently-populated timeline had it.
   */
  async setTagScope(tag: string | null): Promise<void> {
    const next = tag === null ? null : tag.trim().replace(/^#+/, "").trim();
    this.tagScope = next === "" ? null : next;
    this.renderScopeBar();
    await this.reload();
    this.scrollToTop();
  }

  /**
   * Clears BOTH the scope and the anchor and reloads — what `startNewEntry`
   * needs. Clearing only one would leave the other still able to exclude the
   * entry about to be written: it would be safe on disk but invisible in the
   * timeline, with no explanation.
   */
  private async resetToNewest(): Promise<void> {
    this.tagScope = null;
    this.anchorDate = null;
    this.renderScopeBar();
    await this.reload();
    this.scrollToTop();
  }
```

- [ ] **Step 7: Derive the index through the scope**

In `reloadNow`, replace the single line `this.index = this.plugin.journal.getEntries();`:

```ts
    this.index = this.scopedIndex();
```

And replace both `renderEmptyState` calls in the same method:

```ts
      this.renderEmptyState(false, this.tagScope);
```

```ts
    if (this.rendered.size === 0) this.renderEmptyState(this.anchorDate !== null, this.tagScope);
```

- [ ] **Step 8: Re-derive at the start of every change batch**

Replace `JournalView.applyChangesNow` (line ~2023) with:

```ts
  private async applyChangesNow(changes: JournalChange[]): Promise<void> {
    // Re-derived here, once per batch, rather than kept in sync change by
    // change: `JournalService` has already applied this batch to its live
    // index by the time listeners run (see its class doc), so one O(n) pass
    // over a metadata-only array — per debounce flush, not per keystroke —
    // buys exact correctness with no incremental-sync state to get wrong.
    // Skipped entirely when unscoped, so `this.index` stays the live alias.
    if (this.tagScope !== null) this.index = this.scopedIndex();

    // A folder-level rebuild ("reload") means the journal root itself moved,
    // so the tag set the scope was chosen from no longer describes what is
    // being shown. Cleared before `changeApplication` fires the reload, so
    // the rebuild it triggers already sees no scope.
    if (changes.some((change) => change.kind === "reload") && this.tagScope !== null) {
      this.tagScope = null;
      this.renderScopeBar();
    }

    await this.changeApplication.applyChangesNow(changes);
  }
```

- [ ] **Step 9: Add the placeholder chip/bar methods so this task compiles**

Tasks 9 and 10 fill these in. Insert them next to `scopedIndex`:

```ts
  /** Task 9 renders the scope bar here. */
  private renderScopeBar(): void {}

  /** Task 10 re-renders one row's frontmatter chips here. */
  private refreshEntryTags(_rendered: RenderedEntry): void {}
```

- [ ] **Step 10: Widen the two wrappers these calls need**

Replace `JournalView.renderEmptyState` (line ~1105):

```ts
  private renderEmptyState(anchored = false, scopeTag: string | null = null): void {
    this.timelineDom.renderEmptyState(anchored, scopeTag);
  }
```

Task 8 makes `timelineDom` accept the second argument; until then `tsc` reports
one error here, which is expected.

- [ ] **Step 11: Run the type check and the new test**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: FAIL with exactly one error — `Expected 0-1 arguments, but got 2` at the `timelineDom.renderEmptyState` call. Do Task 9 next; do not "fix" this by dropping the argument.

- [ ] **Step 12: Commit**

```bash
git add src/views/JournalView.ts tests/JournalView.tagScope.test.ts
git commit -m "feat: tag scope state and scoped index derivation"
```

**Correction applied during execution.** Step 8 specified that a `"reload"`
change in the batch clears the tag scope; that block was **removed** and the
scope now survives a folder rebuild. `JournalService.isJournalFolderPath`
matches DESCENDANTS of the journal root, and every install has them
(`Journal/2026/08`), so renaming `Journal/2026` — which changes not one entry
and not one tag — would have silently dropped the user's active filter and
blinked the scope bar off with no cause they could connect to what they did.
The semantically identical rebuild on the settings path (`refreshJournal` in
`src/main.ts`) does not clear the scope either, so the planned behaviour made
the design contradict itself. There is also no correctness need:
`scopedIndex()` reads `getEntries()` fresh, so a rebuilt index filters fine,
and a scope that now matches nothing renders "No entries tagged #x." — which
explains itself, unlike state that changes on its own. Silently changing state
is exactly the failure `CLAUDE.md`'s calendar section exists to warn about.

Removing it also resolved a code-review finding by construction: the derive ran
BEFORE the clear, so `this.index` was left filtered while `matchesScope()`
began returning `true` for everything. Had a `"reload"` ever arrived alongside
other changes (the case `some()` exists for) and landed after them, every
earlier change would have computed `inScope === true`, called
`insertEntryInPlace`, hit `indexOf === -1`, and been silently dropped.

**Task 14 must not claim the scope is cleared on a folder reload** — neither
§6 of the design spec nor the `CLAUDE.md` Tags section.

Also folded in from review: the scoped filter predicate moved out of
`JournalView` into `entriesWithTag` in `src/journal/entryTags.ts`, which
normalizes the needle once instead of once per entry (the planned
`all.filter((entry) => entryHasTag(entry, scope))` ran a regex replace, two
trims and a `toLowerCase()` per entry over the whole journal). `entryHasTag`
stays for `matchesScope`'s single-entry question. Task 8's widening of
`timelineDom.renderEmptyState` was also done here, since Task 7 cannot compile
without it.

---

### Task 8: Empty state names the scope

**Files:**
- Modify: `src/views/timelineDom.ts` (`TimelineDom.renderEmptyState`, its implementation)

- [ ] **Step 1: Widen the interface member**

In `src/views/timelineDom.ts`, replace the `renderEmptyState` member of the
`TimelineDom` interface:

```ts
  /**
   * Renders the "nothing here" line. `scopeTag` takes precedence over
   * `anchored`: when a tag filter is on, that is overwhelmingly the reason
   * the timeline is empty, and naming it is the only thing that explains an
   * empty journal that clearly is not empty.
   */
  renderEmptyState(anchored?: boolean, scopeTag?: string | null): void;
```

- [ ] **Step 2: Widen the implementation**

Replace the `renderEmptyState` function (line ~339):

```ts
  function renderEmptyState(anchored = false, scopeTag: string | null = null): void {
    deps.getTimelineEl().createDiv({
      cls: "journal-empty",
      text: scopeTag
        ? `No entries tagged #${scopeTag}.`
        : anchored
          ? "Nothing on or before this date."
          : "No journal entries yet. Use the + button above to write the first one.",
    });
  }
```

- [ ] **Step 3: Run the type check and the suite**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run tests/JournalView.tagScope.test.ts`
Expected: no type errors. The tag-scope tests from Task 7 PASS — including the
scoped empty state. The scope-bar and chip tests do not exist yet (Tasks 9-10).

- [ ] **Step 4: Commit**

```bash
git add src/views/timelineDom.ts
git commit -m "feat: name the active tag in the empty state"
```

---

### Task 9: The scope bar

The only thing that explains why entries are missing, so it is not optional.
Lives in `contentEl` (not `timelineEl`, which `clearTimeline` empties on every
reload) and sticks to the top of the scroll container.

**Files:**
- Modify: `src/views/JournalView.ts` (`onOpen`, `renderScopeBar`, new field, Esc handler)
- Modify: `styles.css`
- Test: `tests/JournalView.tagScope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/JournalView.tagScope.test.ts`'s `describe`:

```ts
  function scopeBar(h: Harness): HTMLElement {
    return internals(h.view).scopeBarEl as HTMLElement;
  }

  it("names the scope in a bar, and clears it from there", async () => {
    await openWithTaggedEntries();
    expect(scopeBar(h).textContent).toBe("");

    await h.view.setTagScope("therapy");
    expect(scopeBar(h).querySelector(".journal-scope-tag")?.textContent).toBe("#therapy");

    scopeBar(h).querySelector<HTMLButtonElement>(".journal-scope-clear")?.click();
    await vi.waitFor(() => expect(h.view.activeTagScope()).toBeNull());
    expect(scopeBar(h).textContent).toBe("");
  });

  it("lives outside the timeline, so a reload cannot wipe it", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");

    await h.view.reload();

    expect(scopeBar(h).querySelector(".journal-scope-tag")?.textContent).toBe("#therapy");
  });

  it("clears the scope on Escape outside an entry", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");

    scopeBar(h).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(h.view.activeTagScope()).toBeNull());
  });

  it("leaves Escape alone inside an entry, where the editor owns it", async () => {
    const { tagged } = await openWithTaggedEntries();
    await h.view.setTagScope("therapy");

    const row = timelineEl(h.view).querySelector<HTMLElement>(
      `.journal-entry[data-path="${tagged.path}"]`,
    );
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(h.view.activeTagScope()).toBe("therapy");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'textContent')` (`scopeBarEl` does not exist).

- [ ] **Step 3: Add the field**

In `src/views/JournalView.ts`, immediately after `private timelineEl!: HTMLElement;`:

```ts
  /**
   * The tag-scope bar. Deliberately a sibling of `timelineEl` rather than a
   * child: `clearTimeline` empties `timelineEl` on every reload, and the one
   * element that explains why the timeline looks empty must not be part of
   * what gets emptied. Present but blank when no scope is active.
   */
  private scopeBarEl: HTMLElement | null = null;
```

- [ ] **Step 4: Create it, and wire Escape, in `onOpen`**

Replace the first three lines of `onOpen`'s body:

```ts
    this.contentEl.empty();
    this.contentEl.addClass("journal-view");
    this.scopeBarEl = this.contentEl.createDiv({ cls: "journal-scope-bar" });
    this.timelineEl = this.contentEl.createDiv({ cls: "journal-timeline" });
    this.renderScopeBar();

    // `addEventListener` + `register` rather than a bare listener, so the
    // view's own teardown removes it — nothing else would.
    const onKeyDown = (event: KeyboardEvent): void => this.onContentKeyDown(event);
    this.contentEl.addEventListener("keydown", onKeyDown);
    this.register(() => this.contentEl.removeEventListener("keydown", onKeyDown));
```

- [ ] **Step 5: Implement the bar and the key handler**

Replace the `renderScopeBar` placeholder from Task 7:

```ts
  /**
   * Renders (or blanks) the scope bar. Idempotent, and safe before `onOpen`
   * has created the element.
   */
  private renderScopeBar(): void {
    const el = this.scopeBarEl;
    if (!el) return;

    el.empty();
    el.toggleClass("journal-scope-bar-active", this.tagScope !== null);
    if (this.tagScope === null) return;

    el.createSpan({ cls: "journal-scope-tag", text: `#${this.tagScope}` });

    const clear = new ButtonComponent(el)
      .setIcon("x")
      .setTooltip("Clear tag filter")
      .setClass("clickable-icon");
    clear.buttonEl.addClass("journal-scope-clear");
    clear.onClick(() => {
      void this.setTagScope(null);
    });
  }

  /**
   * Escape clears an active scope — but only when it was not pressed inside
   * an entry, where the editor (vim mode, an open autocomplete, a selection)
   * owns that key and would be silently overridden.
   */
  private onContentKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || this.tagScope === null) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".journal-entry")) return;

    event.preventDefault();
    void this.setTagScope(null);
  }
```

- [ ] **Step 6: Style it**

Append to `styles.css`:

```css
/* Tag scope bar. A sibling of .journal-timeline (see JournalView.onOpen),
   sticky against the scroll container so the one explanation for a
   filtered-looking journal cannot scroll away. Blank and inert — no padding,
   no background — when no scope is active, so an unscoped timeline looks
   exactly as it did before tag scoping existed. */
.journal-scope-bar:empty {
  display: none;
}

.journal-scope-bar-active {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-2) var(--size-4-8);
  max-width: var(--file-line-width);
  margin: 0 auto;
  background-color: var(--background-primary);
}

.journal-scope-tag {
  font-size: var(--font-ui-small);
  font-weight: var(--font-semibold);
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: PASS — every test in the file except the chip tests added in Task 10.

- [ ] **Step 8: Commit**

```bash
git add src/views/JournalView.ts styles.css tests/JournalView.tagScope.test.ts
git commit -m "feat: scope bar with clear button and Escape"
```

---

### Task 10: Frontmatter tag chips

The timeline hides `.metadata-container`, so a frontmatter tag is invisible and
unremovable there. Inline tags already render as clickable pills in live preview
and get no chip — nothing appears twice, nothing appears zero times.

**Files:**
- Modify: `src/views/JournalView.ts` (`createEntryEl`, `refreshEntryTags`)
- Modify: `styles.css`
- Test: `tests/JournalView.tagScope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/JournalView.tagScope.test.ts`'s `describe` (add
`tagEntryInFrontmatter` to the file's import from `./journalViewHarness`):

```ts
  function chips(h: Harness, path: string): string[] {
    const row = timelineEl(h.view).querySelector<HTMLElement>(
      `.journal-entry[data-path="${path}"]`,
    );
    return Array.from(row?.querySelectorAll<HTMLElement>(".journal-entry-tag") ?? []).map(
      (el) => el.textContent ?? "",
    );
  }

  it("chips a frontmatter tag, which the timeline otherwise hides", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52));
    tagEntryInFrontmatter(h, file, ["work"]);
    h.service.load();
    await h.view.onOpen();

    expect(chips(h, file.path)).toEqual(["#work"]);
  });

  it("does not chip an inline tag, which live preview already shows", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52));
    tagEntry(h, file, ["therapy"]);
    h.service.load();
    await h.view.onOpen();

    expect(chips(h, file.path)).toEqual([]);
  });

  it("scopes the timeline when a chip is clicked", async () => {
    const chipped = addEntry(h, new Date(2026, 7, 12, 22, 41, 52));
    const plain = addEntry(h, new Date(2026, 7, 12, 17, 23, 41));
    tagEntryInFrontmatter(h, chipped, ["work"]);
    h.service.load();
    await h.view.onOpen();

    timelineEl(h.view)
      .querySelector<HTMLButtonElement>(`.journal-entry[data-path="${chipped.path}"] .journal-entry-tag`)
      ?.click();

    await vi.waitFor(() => expect(h.view.activeTagScope()).toBe("work"));
    expect(renderedPaths(h)).toEqual([chipped.path]);
    expect(renderedPaths(h)).not.toContain(plain.path);
  });

  it("re-renders chips when frontmatter changes elsewhere in Obsidian", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52));
    tagEntryInFrontmatter(h, file, ["work"]);
    h.service.load();
    await h.view.onOpen();
    expect(chips(h, file.path)).toEqual(["#work"]);

    h.app.metadataCache.frontmatter.set(file.path, { tags: ["work", "books"] });
    h.app.metadataCache.trigger("changed", file);
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(chips(h, file.path)).toEqual(["#work", "#books"]));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: FAIL — `expected [] to deeply equal [ '#work' ]`.

- [ ] **Step 3: Render the chips in `createEntryEl`**

In `src/views/JournalView.ts`, inside `createEntryEl`, immediately after the
`if (!entry.file) timeButton.disabled = true;` line:

```ts
    // Chips for the FRONTMATTER tags only — the ones the timeline hides by
    // suppressing `.metadata-container` (see styles.css). An inline `#tag`
    // already renders as a clickable pill in live preview, so chipping it too
    // would show the same tag twice. See `entryTags.ts`'s module doc.
    const tagsEl = headerEl.createDiv({ cls: "journal-entry-tags" });
    this.renderEntryTagsInto(tagsEl, entry);
```

- [ ] **Step 4: Implement the two chip methods**

Replace the `refreshEntryTags` placeholder from Task 7:

```ts
  /**
   * Fills `tagsEl` with one chip per frontmatter tag. Buttons, not spans, so
   * they are keyboard-reachable and activate on Enter/Space with no extra
   * wiring — same reasoning as the time button above.
   */
  private renderEntryTagsInto(tagsEl: HTMLElement, entry: JournalEntry): void {
    tagsEl.empty();
    // No file yet (an uncommitted composer) means nothing is indexed, so
    // there is nothing to chip.
    if (!entry.file) return;

    for (const tag of frontmatterTags(this.app.metadataCache.getFileCache(entry.file))) {
      const chip = tagsEl.createEl("button", {
        cls: "journal-entry-tag",
        text: `#${tag}`,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        void this.setTagScope(tag);
      });
    }
  }

  /**
   * Re-reads one rendered row's frontmatter chips from the metadata cache.
   * Called for every "content"/"moved" change, including those whose action
   * is a `noop` to protect a focused or dirty editor — the chips are in the
   * header, not the editor, so refreshing them is always safe, and a chip
   * advertising a tag the user already deleted is a lie the timeline has no
   * other way to correct before the next reload.
   */
  private refreshEntryTags(rendered: RenderedEntry): void {
    const tagsEl = rendered.el.querySelector<HTMLElement>(".journal-entry-tags");
    if (tagsEl) this.renderEntryTagsInto(tagsEl, rendered.entry);
  }
```

- [ ] **Step 5: Style the chips**

Append to `styles.css`:

```css
/* Frontmatter tag chips (JournalView.createEntryEl). Real <button>s, so —
   exactly like .journal-entry-time — a lone class selector would lose to
   Obsidian's own `button:not(.clickable-icon)` and bare `button` rules and
   leave a filled, rounded, shadowed chip where a quiet tag belongs. The
   two-class selector clears both, and the explicit :hover entry keeps a
   theme's own `button:hover` from flipping the tie back. */
.journal-entry-tags {
  display: flex;
  align-items: center;
  gap: var(--size-4-1);
}

.journal-entry-header .journal-entry-tag,
.journal-entry-header .journal-entry-tag:hover {
  padding: 0;
  height: auto;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background-color: transparent;
  font-family: inherit;
  font-size: var(--font-ui-smaller);
  font-weight: var(--font-normal);
  color: var(--text-faint);
  cursor: pointer;
}

.journal-entry-header .journal-entry-tag:hover {
  color: var(--text-accent);
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 7: Run the whole suite — the header gained a child element**

Run: `npx vitest run`
Expected: PASS. If a render test asserts on `.journal-entry-header`'s exact
children, update that assertion to allow the (empty) `.journal-entry-tags` div —
do not remove the div.

- [ ] **Step 8: Commit**

```bash
git add src/views/JournalView.ts styles.css tests/JournalView.tagScope.test.ts
git commit -m "feat: chip the frontmatter tags the timeline hides"
```

---

### Task 11: `TagScopeModal`

**Files:**
- Create: `src/views/TagScopeModal.ts`
- Test: `tests/tagScopeModal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tagScopeModal.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { TagScopeModal, type TagChoice } from "../src/views/TagScopeModal";
import { installDomHelpers } from "./obsidian-mock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

function modal(tags: string[], hasScope: boolean) {
  const chosen: TagChoice[] = [];
  const instance = new TagScopeModal({} as App, tags, hasScope, (choice) => chosen.push(choice));
  return { instance, chosen };
}

describe("TagScopeModal", () => {
  it("lists every tag when the query is empty", () => {
    const { instance } = modal(["books", "work"], false);
    expect(instance.getSuggestions("")).toEqual([
      { kind: "tag", tag: "books" },
      { kind: "tag", tag: "work" },
    ]);
  });

  it("filters case-insensitively and ignores a typed #", () => {
    const { instance } = modal(["books", "Work"], false);
    expect(instance.getSuggestions("#wor")).toEqual([{ kind: "tag", tag: "Work" }]);
  });

  it("offers Clear filter first, but only when a scope is active", () => {
    expect(modal(["work"], true).instance.getSuggestions("")[0]).toEqual({ kind: "clear" });
    expect(modal(["work"], false).instance.getSuggestions("")[0]).toEqual({
      kind: "tag",
      tag: "work",
    });
  });

  it("keeps Clear filter reachable while a query is being typed", () => {
    const { instance } = modal(["work"], true);
    expect(instance.getSuggestions("zzz")).toEqual([{ kind: "clear" }]);
  });

  it("hands the chosen tag to its callback", () => {
    const { instance, chosen } = modal(["work"], false);
    instance.choose({ kind: "tag", tag: "work" });
    expect(chosen).toEqual([{ kind: "tag", tag: "work" }]);
  });

  it("renders a tag with its # and the clear item as plain words", () => {
    const { instance } = modal(["work"], true);

    const tagEl = document.createElement("div");
    instance.renderSuggestion({ kind: "tag", tag: "work" }, tagEl);
    expect(tagEl.textContent).toBe("#work");

    const clearEl = document.createElement("div");
    instance.renderSuggestion({ kind: "clear" }, clearEl);
    expect(clearEl.textContent).toBe("Clear filter");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tagScopeModal.test.ts`
Expected: FAIL — `Failed to resolve import "../src/views/TagScopeModal"`.

- [ ] **Step 3: Write the modal**

Create `src/views/TagScopeModal.ts`:

```ts
import { type App, SuggestModal } from "obsidian";

/** Either a tag to scope to, or the request to clear the current scope. */
export type TagChoice = { kind: "tag"; tag: string } | { kind: "clear" };

/**
 * The primary way into a tag scope. A suggester rather than clickable tags
 * everywhere: it covers inline and frontmatter tags alike with one control,
 * and hijacks no native interaction — Obsidian's own inline tag pill keeps
 * opening Obsidian's own search, so the same pill never means two different
 * things in two different places.
 */
export class TagScopeModal extends SuggestModal<TagChoice> {
  constructor(
    app: App,
    private readonly tags: readonly string[],
    private readonly hasScope: boolean,
    private readonly onChoose: (choice: TagChoice) => void,
  ) {
    super(app);
    this.setPlaceholder("Filter the journal by tag");
    this.emptyStateText = "No tags in the journal yet.";
  }

  getSuggestions(query: string): TagChoice[] {
    // A user who types `#work` means `work` — the `#` is how tags are written
    // inline, and refusing it would just look broken.
    const needle = query.trim().replace(/^#+/, "").toLowerCase();
    const matches = this.tags
      .filter((tag) => tag.toLowerCase().includes(needle))
      .map((tag): TagChoice => ({ kind: "tag", tag }));

    // Unfiltered and always first while a scope is active: it is how the user
    // gets back to the whole journal, so a query that happens to match
    // nothing must not be able to hide it.
    return this.hasScope ? [{ kind: "clear" }, ...matches] : matches;
  }

  renderSuggestion(choice: TagChoice, el: HTMLElement): void {
    el.setText(choice.kind === "clear" ? "Clear filter" : `#${choice.tag}`);
  }

  onChooseSuggestion(choice: TagChoice): void {
    this.onChoose(choice);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tagScopeModal.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/TagScopeModal.ts tests/tagScopeModal.test.ts
git commit -m "feat: tag suggester for the journal filter"
```

---

### Task 12: The `Filter journal by tag` command

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the imports**

In `src/main.ts`, add:

```ts
import { collectTags } from "./journal/entryTags";
import { TagScopeModal } from "./views/TagScopeModal";
```

- [ ] **Step 2: Register the command**

After the `go-to-today` command block, and before the calendar block's comment:

```ts
    this.addCommand({
      id: "filter-journal-by-tag",
      name: "Filter journal by tag",
      callback: () => {
        void this.filterByTag();
      },
    });
```

- [ ] **Step 3: Add the handler**

After `goToToday()` in the same file:

```ts
  /**
   * Opens (or reveals) the journal and prompts for a tag to scope it to —
   * same shape as `newEntry`/`goToToday`/`goToDateInJournal`, so nothing
   * about opening the view is duplicated here.
   *
   * The tag list comes from the index, so it contains exactly the tags that
   * are actually reachable in the timeline — never a vault-wide tag list
   * offering choices that would scope the journal to nothing.
   */
  async filterByTag(): Promise<void> {
    const view = await this.openJournal();

    if (!view) {
      console.error("Simple Journal: the journal view was not available after opening it");
      new Notice("Could not open the journal.");
      return;
    }

    const tags = collectTags(this.journal.getEntries());
    const active = view.activeTagScope();

    // Nothing to choose and nothing to clear — a prompt would be a dead end.
    if (tags.length === 0 && active === null) {
      new Notice("No tags in the journal yet.");
      return;
    }

    new TagScopeModal(this.app, tags, active !== null, (choice) => {
      void view.setTagScope(choice.kind === "clear" ? null : choice.tag);
    }).open();
  }
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run && npx eslint .`
Expected: no type errors, all tests PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: Filter journal by tag command"
```

---

### Task 13: A new entry always lands somewhere visible

An entry written while a scope is active carries no tags, so it would not match —
the file would be safe on disk and invisible in the timeline. `startNewEntry`
already clears a stale anchor for exactly this reason; it must clear both.

**Files:**
- Modify: `src/views/JournalView.ts` (`startNewEntry`)
- Test: `tests/JournalView.tagScope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/JournalView.tagScope.test.ts`'s `describe`:

```ts
  it("clears the scope when a new entry is started", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");

    await h.view.startNewEntry();

    expect(h.view.activeTagScope()).toBeNull();
    expect(internals(h.view).composer).not.toBeNull();
  });

  it("clears a scope AND an anchor together", async () => {
    await openWithTaggedEntries();
    await h.view.setTagScope("therapy");
    await h.view.goToDate(new Date(2026, 7, 11, 23, 59, 59));

    await h.view.startNewEntry();

    expect(h.view.activeTagScope()).toBeNull();
    expect(internals(h.view).anchorDate).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/JournalView.tagScope.test.ts`
Expected: FAIL — `expected 'therapy' to be null`.

- [ ] **Step 3: Reset both in `startNewEntry`**

In `src/views/JournalView.ts`, replace the anchor-clearing block in
`startNewEntry`:

```ts
    // REQUIRED, per CLAUDE.md's "Creating a New Entry": a stale anchor OR an
    // active tag scope would exclude the entry about to be written — a new
    // entry has no tags, and is newer than any past anchor — leaving the file
    // safe on disk but absent from the timeline with no explanation. Both are
    // cleared in one reload rather than two.
    if (this.tagScope !== null || this.anchorDate !== null) {
      await this.resetToNewest();
    }
```

Also extend the doc comment above `startNewEntry`, replacing the sentence that
begins "REQUIRED, per CLAUDE.md's "Creating a New Entry": if the timeline is
anchored…" with:

```ts
   * REQUIRED, per CLAUDE.md's "Creating a New Entry": if the timeline is
   * anchored to a past date (`goToDate`) or scoped to a tag (`setTagScope`),
   * this must clear both before opening the composer — otherwise the
   * exclusion stays in force, and the entry just written is either newer than
   * the anchor or missing the scoped tag, so it silently vanishes from the
   * timeline. The file itself would still be safe on disk, but it would
   * disappear with no explanation — worse than the navigation state merely
   * being inconvenient.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/JournalView.tagScope.test.ts tests/JournalView.composer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/JournalView.ts tests/JournalView.tagScope.test.ts
git commit -m "fix: a new entry clears both the scope and the anchor"
```

---

### Task 14: Documentation

The spec's §8: tag scoping contradicts `CLAUDE.md`'s "advanced filters" non-goal,
and that must be a recorded product decision, not a silent contradiction.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/manual-testing.md`

- [ ] **Step 1: Add the `# Tags` section to `CLAUDE.md`**

Insert immediately before `# Navigation`:

```markdown
---

# Tags

Obsidian draws no semantic distinction between an inline `#tag` and a
frontmatter `tags:` entry — `getAllTags` merges them, and search, the tag pane
and the graph treat them identically. Neither does this plugin. For it, exactly
one difference matters: **visibility.** The timeline hides
`.metadata-container` by design, so a frontmatter tag is invisible there and
cannot be removed there, while an inline tag renders as a clickable pill like
anywhere else in Obsidian.

Four rules follow, and none of them may be quietly reversed:

1. **One reader, source-blind.** `journal/entryTags.ts` resolves every tag
   through `getAllTags`, exactly as `entryDate.ts` is the one place chronology
   is resolved. Nothing else asks where a tag came from.
2. **The plugin never writes a tag.** Frontmatter belongs to the user (only
   `created` is ours). The body needs no help: the embedded editor is a real
   Obsidian editor, so typing `#` brings up Obsidian's own tag autocomplete.
   There is no tag-entry UI, and "automatic tagging" remains a non-goal.
3. **The timeline shows only what it hides.** Chips are rendered for
   frontmatter tags only. Inline tags already show as pills, so chipping them
   too would display the same tag twice.
4. **Clicking a tag scopes the timeline, and a scope is never persisted.**

A **scope** is a filter: the timeline shows only entries carrying that tag,
still newest → oldest, still continuous within the filtered set. A tag is not
a point on the chronological axis, so anchoring — what a calendar day click
does — has no meaning for it; the honest options were filter or nothing.
Scope composes with an anchor ("this tag, from that day backwards"), and
calendar dots stay scope-independent: they describe the journal, not the
current filter.

Matching is exact and case-insensitive: `#work` does not include
`#work/project`. Nested tags are listed separately in the suggester, so nothing
becomes unreachable, and tag-hierarchy browsing stays out of scope.

The scope lives only as long as the user keeps it — never in view state,
settings, or the saved workspace layout. A restored filter would hide most of
someone's journal at startup with no visible cause, the same "permanently
locked out" failure the calendar's placement policy exists to avoid. For the
same reason `New journal entry` clears the scope (and any anchor) before
opening the composer: a new entry has no tags, so it would otherwise be
written safely to disk and be invisible in the timeline.

Reaching a scope is one command, `Filter journal by tag`, plus the plugin's own
frontmatter chips. Obsidian's inline tag pill is deliberately left alone — it
opens Obsidian's own search, and intercepting it would make the same pill mean
two different things in two different places.
```

- [ ] **Step 2: Record the exception in the non-goals list**

In `CLAUDE.md`'s `# Non-Goals`, replace the `* advanced filters` line and the
`* single-day filtering` line with:

```markdown
* advanced filters — with one deliberate exception, the tag scope described
  under `# Tags`: a single tag, chosen from one command, never persisted
* single-day filtering — clicking a calendar day anchors the timeline rather
  than filtering it; see the calendar section for why
```

- [ ] **Step 3: Add the manual checks**

Append to the relevant checklist in `docs/manual-testing.md`:

```markdown
- [ ] **`#` autocomplete works in the timeline.** Type `#` in an entry and
      confirm Obsidian's own tag suggester appears. UNVERIFIED assumption
      behind the "plugin never writes a tag" rule — the embedded editor is a
      real editor, but nothing proves its suggester is wired without running
      it. Expected NOT to work in the `<textarea>` fallback.
- [ ] **Frontmatter chips appear, inline tags do not.** Add `tags: [work]` to
      an entry's frontmatter and `#therapy` to its body. The header shows
      `#work` only; `#therapy` shows as a pill in the body.
- [ ] **A chip scopes the timeline.** Click `#work`. Only entries tagged
      `work` remain, the scope bar names it, and `✕` restores the timeline.
- [ ] **Scope survives a reload and composes with the calendar.** With a scope
      active, click a calendar day: the timeline shows that tag from that day
      backwards, and the scope bar is still there.
- [ ] **Removing the scoped tag externally drops the row.** Edit the entry in
      another pane to delete the tag. The row disappears; the file does not.
- [ ] **Typing is never interrupted by the scope.** With the caret in a scoped
      entry, delete its tag from the frontmatter in another pane. The row stays
      (focus/dirty decline) rather than vanishing under the caret.
- [ ] **`New journal entry` while scoped.** The scope clears, the timeline
      returns to today, and the composer takes focus.
- [ ] **Nothing is persisted.** Scope the timeline, restart Obsidian: the
      journal comes back unscoped.
```

- [ ] **Step 4: Full verification**

Run: `npm run build && npx vitest run && npm run test:tz && npx eslint .`
Expected: build succeeds (`tsc --noEmit` clean, esbuild writes `main.js`), all
tests PASS in both the local and `America/New_York` timezone runs, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/manual-testing.md
git commit -m "docs: record the tag rules and the scope exception"
```

---

## Self-review

**Spec coverage:** §3 Rule 1 → Task 2. Rule 2 → Task 2 (no write path exists) and
Task 14's manual check. Rule 3 → Task 10. Rule 4 → Tasks 5-7, 11, 12. Rule 5 →
Task 7 (no `getState`/`setState` touched) and Task 14's restart check. §4 module
table → Tasks 1-7, 10-12. §5 re-derivation → Task 7 steps 7-8. §6 interactions:
entry points → 11-12; scope bar and Esc → 9; `New journal entry` → 13; calendar
untouched → nothing modifies `CalendarView` in any task; `Go to today` keeps the
scope → unchanged code, since `goToToday` scrolls within the already-scoped
index; folder change / `reload` → Task 7 step 8; empty result → Task 8. §7
failure modes → covered by Task 5's focused/dirty tests, Task 6's dirty decline,
Task 8's empty state, and Task 14's manual checks. §8 docs → Task 14. §10 test
priorities 1-5 → Tasks 2, 5, 4, 7, 13 respectively.

**One deliberate gap:** `Go to today` gets no automated test — it is unchanged
code, and its scoped behaviour follows from `this.index` already being scoped.

**Type consistency:** `resolveTags`/`frontmatterTags`/`entryHasTag`/`collectTags`
are named identically in every task that calls them. `setTagScope`/
`activeTagScope`/`matchesScope`/`scopedIndex`/`resetToNewest`/`renderScopeBar`/
`refreshEntryTags`/`renderEntryTagsInto` likewise. `decideChangeAction`'s third
parameter is `inScope` everywhere. `TagChoice` is `{kind:"tag",tag}` /
`{kind:"clear"}` in both Task 11 and Task 12.

**Intermediate red states are intentional and flagged:** Task 6 step 4 and Task 7
step 11 both expect a specific `tsc` failure that the next task resolves. Do not
work around them.
