# Index and Background Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove work Simple Journal does while nothing relevant happened — the startup event storm, linear path lookups, index work for non-journal edits, mentions/calendar repaints for unrelated saves, and idle editor polling — with no user-visible behaviour change.

**Architecture:** A path-keyed `EntryIndex` class wraps the existing sorted array. `JournalService` registers its listeners at layout-ready, runs a one-time reconcile there, and drops events for files outside the journal. `MentionsPanel` and `CalendarView` each decide whether a change batch concerns them before repainting. `ObsidianEmbedEditor` polls at 250 ms only while in use, 2 s otherwise.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest (+ `vitest bench`), jsdom.

**Spec:** `docs/superpowers/specs/2026-10-20-index-and-background-perf-design.md`

**Ground rules for the implementer**

- Read `CLAUDE.md` first. Do not touch `JournalView.ts`'s composer, reload or focus code; nothing in this plan needs to.
- Match the surrounding style: long explanatory doc comments that say *why*. New code gets the same.
- Every command runs from the repo root: `/Users/utkuaytac/Documents/dev/obsidian-simple-journal`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015vj5ANdwDBaoR8Phx9go7P
  ```

## File map

| File | Change |
| --- | --- |
| `tests/obsidian-mock.ts` | `FakeWorkspace` gains an opt-in "layout not ready" mode; new `ExtraButtonComponent` stand-in |
| `tests/perf/indexScale.bench.ts` | New benchmark, run with `npm run bench` |
| `package.json` | `bench` script |
| `src/services/entryIndex.ts` | `insertionIndex` extracted; new `EntryIndex` class |
| `src/services/journalService.ts` | Uses `EntryIndex`; listeners at layout-ready; reconcile; event gate; rekey at rename time |
| `src/main.ts` | One comment on ordering (no logic change) |
| `src/mentions/MentionsPanel.ts` | Batch/resolve relevance filter |
| `src/views/calendarGrid.ts` | New pure `calendarSignature` |
| `src/views/CalendarView.ts` | Skips identical repaints from `onChange` |
| `src/views/ObsidianEmbedEditor.ts` | Two-speed polling |
| `tests/entryIndex.test.ts`, `tests/journalService.test.ts`, `tests/mentionsPanel.test.ts`, `tests/calendarGrid.test.ts`, `tests/calendarView.test.ts` (new), `tests/obsidianEmbedEditor.test.ts` | Tests |
| `docs/manual-testing.md` | Four manual checks |

---

### Task 1: Let the mock workspace defer `onLayoutReady`

**Files:**
- Modify: `tests/obsidian-mock.ts` (the `FakeWorkspace.onLayoutReady` method, around line 783)

No test of its own: Tasks 2 and 5 exercise it. Default behaviour stays "run immediately", so no existing test changes.

- [ ] **Step 1: Replace `onLayoutReady` in `FakeWorkspace`**

Replace the existing doc comment and method:

```ts
  /**
   * Runs immediately. Real Obsidian defers until the layout is ready and runs
   * it straight away afterwards; this mock is always "afterwards", and a test
   * that needs to observe the deferral would have to model a layout this has
   * no notion of.
   */
  onLayoutReady(callback: () => unknown): void {
    callback();
  }
```

with:

```ts
  /**
   * Whether the layout counts as ready. True by default, so every test that
   * does not care keeps the "always afterwards" behaviour it was written
   * against. A test that needs to see what happens BEFORE the layout is ready
   * — the window in which real Obsidian fires `create` for every file in the
   * vault — sets this false before loading, then calls `fireLayoutReady()`.
   */
  layoutReady = true;
  private layoutReadyQueue: Array<() => unknown> = [];

  /** Same contract as the real method: run now if ready, else queue in order. */
  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) callback();
    else this.layoutReadyQueue.push(callback);
  }

  /** Test-only: marks the layout ready and runs the queued callbacks in order. */
  fireLayoutReady(): void {
    this.layoutReady = true;
    for (const callback of this.layoutReadyQueue.splice(0)) callback();
  }
```

- [ ] **Step 2: Run the whole suite to prove nothing moved**

Run: `npm test`
Expected: all tests pass (same count as before).

- [ ] **Step 3: Commit**

```bash
git add tests/obsidian-mock.ts
git commit -m "test: let the mock workspace defer onLayoutReady"
```

---

### Task 2: Benchmark and baseline

**Files:**
- Create: `tests/perf/indexScale.bench.ts`
- Modify: `package.json` (`scripts`)

- [ ] **Step 1: Add the script to `package.json`**

In `"scripts"`, after `"test:tz"`, add:

```json
    "bench": "vitest bench --run",
```

- [ ] **Step 2: Create `tests/perf/indexScale.bench.ts`**

```ts
// @vitest-environment jsdom
/**
 * Scale benchmark for `JournalService`. Not part of `npm test`: run with
 * `npm run bench`. Each case runs once — the "before" numbers for the startup
 * storm are measured in seconds, and repeating them buys nothing.
 *
 * The storm is modelled the way Obsidian produces it: the plugin loads, then
 * the vault fires `create` for every file, then the layout becomes ready.
 */
import { bench, describe } from "vitest";
import type { App, TFile } from "obsidian";
import { createFakeApp } from "../obsidian-mock";
import { EntryRepository } from "../../src/journal/entryRepository";
import { JournalService } from "../../src/services/journalService";

const ENTRIES = 50_000;
const OTHER_NOTES = 50_000;
const RENAMES = 10_000;
const ONCE = { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Unique, convention-following entry paths spread over a few years. */
function entryPath(i: number): string {
  const d = new Date(2020, 0, 1, 0, 0, 0);
  d.setMinutes(d.getMinutes() + i * 37);
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const name = `${y}-${m}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(i % 60)}`;
  return `Journal/${y}/${m}/${name}.md`;
}

function seed() {
  const fake = createFakeApp();
  const entries: TFile[] = [];
  const others: TFile[] = [];
  for (let i = 0; i < ENTRIES; i++) entries.push(fake.vault.addFile(entryPath(i), "") as unknown as TFile);
  for (let i = 0; i < OTHER_NOTES; i++) {
    others.push(fake.vault.addFile(`Notes/${Math.floor(i / 1000)}/note-${i}.md`, "") as unknown as TFile);
  }
  const repository = new EntryRepository(fake as unknown as App, () => "Journal");
  return { fake, entries, others, repository };
}

/** Runs the debounced flush now, the way `journalViewHarness.ts` reaches past `private`. */
function flushNow(service: JournalService): void {
  (service as unknown as { flush(): void }).flush();
}

describe("JournalService at 50k entries + 50k other notes", () => {
  bench(
    "startup: load, create storm for every file, layout ready, flush",
    () => {
      const { fake, entries, others, repository } = seed();
      fake.workspace.layoutReady = false;
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      for (const file of entries) fake.vault.trigger("create", file);
      for (const file of others) fake.vault.trigger("create", file);
      fake.workspace.fireLayoutReady();
      flushNow(service);
      service.unload();
    },
    ONCE,
  );

  bench(
    `bulk rename: ${RENAMES} entries moved to the journal root, then flush`,
    async () => {
      const { fake, entries, repository } = seed();
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      for (const file of entries.slice(0, RENAMES)) {
        await fake.fileManager.renameFile(file as never, `Journal/${file.basename}.md`);
      }
      flushNow(service);
      service.unload();
    },
    ONCE,
  );

  bench(
    "typing elsewhere: 100 modify+changed pairs on a non-journal note, flushed each time",
    () => {
      const { fake, others, repository } = seed();
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      const note = others[0];
      for (let i = 0; i < 100; i++) {
        fake.vault.trigger("modify", note);
        fake.metadataCache.trigger("changed", note);
        flushNow(service);
      }
      service.unload();
    },
    ONCE,
  );
});
```

Note: seeding is inside each bench body, so it is included in the time. That is deliberate and identical before and after; compare the numbers *between* runs, not against zero.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: no errors. If `fake.vault.addFile`'s return type is already `TFile` from the mock, the `as unknown as TFile` casts are harmless; leave them.

- [ ] **Step 4: Record the baseline**

Run: `npm run bench 2>&1 | tee /tmp/claude-501/bench-before.txt`
Expected: three results. The startup case is expected to be very slow (seconds or more). Copy the three `mean` values into a scratch note — they go into the final commit message in Task 10.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/perf/indexScale.bench.ts
git commit -m "test: benchmark JournalService at 50k entries"
```

---

### Task 3: `EntryIndex` — a path map beside the sorted array

**Files:**
- Modify: `src/services/entryIndex.ts`
- Test: `tests/entryIndex.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/entryIndex.test.ts`, add `EntryIndex` to the import list from `../src/services/entryIndex`, then append:

```ts
describe("EntryIndex", () => {
  function fresh(basename: string, created: Date): JournalEntry {
    return entry(basename, created);
  }

  it("keeps the array sorted newest first and finds records by path", () => {
    const index = new EntryIndex();
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    const b = fresh("2026-08-12-22-41-52", new Date(2026, 7, 12, 22, 41, 52));
    index.insert(a);
    index.insert(b);

    expect(index.entries.map((e) => e.file.basename)).toEqual(["2026-08-12-22-41-52", "2026-08-12-09-34-21"]);
    expect(index.get(a.file.path)).toBe(a);
    expect(index.has(b.file.path)).toBe(true);
    expect(index.get("Journal/missing.md")).toBeNull();
  });

  it("insert replaces an existing record for the same path instead of duplicating it", () => {
    const index = new EntryIndex();
    const before = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.insert(before);
    const after = { ...before, created: new Date(2026, 6, 1) };
    index.insert(after);

    expect(index.entries).toEqual([after]);
    expect(index.get(before.file.path)).toBe(after);
  });

  it("remove drops the record from both the array and the map", () => {
    const index = new EntryIndex();
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.insert(a);

    expect(index.remove(a.file.path)).toBe(0);
    expect(index.entries).toEqual([]);
    expect(index.has(a.file.path)).toBe(false);
    expect(index.remove(a.file.path)).toBe(-1);
  });

  it("rekey refiles a record whose TFile was renamed in place, through a chain of renames", () => {
    const index = new EntryIndex();
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.insert(a);
    const array = index.entries;

    // Obsidian mutates the TFile itself; the record's path follows.
    (a.file as { path: string }).path = "Journal/B.md";
    index.rekey("Journal/2026-08-12-09-34-21.md");
    (a.file as { path: string }).path = "Journal/C.md";
    index.rekey("Journal/B.md");

    expect(index.get("Journal/C.md")).toBe(a);
    expect(index.has("Journal/B.md")).toBe(false);
    expect(index.has("Journal/2026-08-12-09-34-21.md")).toBe(false);
    expect(index.entries).toBe(array);
    expect(index.entries).toEqual([a]);
  });

  it("rekey drops a different, stale record already filed under the new path", () => {
    const index = new EntryIndex();
    const stale = fresh("2026-08-11-21-10-00", new Date(2026, 7, 11, 21, 10, 0));
    const moving = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.insert(stale);
    index.insert(moving);

    (moving.file as { path: string }).path = stale.file.path;
    index.rekey("Journal/2026-08-12-09-34-21.md");

    expect(index.entries).toEqual([moving]);
    expect(index.get(stale.file.path)).toBe(moving);
  });

  it("a path removed and re-added is found again", () => {
    const index = new EntryIndex();
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.insert(a);
    index.remove(a.file.path);
    index.insert(a);

    expect(index.get(a.file.path)).toBe(a);
    expect(index.entries).toEqual([a]);
  });

  it("staleKeys lists only keys whose record now reports another path", () => {
    const index = new EntryIndex();
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    const b = fresh("2026-08-11-21-10-00", new Date(2026, 7, 11, 21, 10, 0));
    index.insert(a);
    index.insert(b);
    (a.file as { path: string }).path = "Journal/renamed.md";

    expect(index.staleKeys()).toEqual(["Journal/2026-08-12-09-34-21.md"]);
  });

  it("replaceAll swaps in a new array object and rebuilds the map", () => {
    const index = new EntryIndex();
    const before = index.entries;
    const a = fresh("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
    index.replaceAll([a]);

    // A new array, not the old one mutated: `JournalView` treats a rebuild as
    // "re-fetch getEntries()", and code holding the old array must not see
    // its contents change underneath it.
    expect(index.entries).not.toBe(before);
    expect(index.entries).toEqual([a]);
    expect(index.get(a.file.path)).toBe(a);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/entryIndex.test.ts`
Expected: FAIL — `EntryIndex` is not exported.

- [ ] **Step 3: Implement**

In `src/services/entryIndex.ts`, replace `insertSorted` (keep its doc comment) with an extracted search plus the original function:

```ts
/**
 * Where `entry` belongs in `list` (sorted by `compareEntries`): the first
 * position whose entry does not sort before it. Binary search.
 */
export function insertionIndex(list: readonly JournalEntry[], entry: JournalEntry): number {
  let low = 0;
  let high = list.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareEntries(list[mid], entry) < 0) low = mid + 1;
    else high = mid;
  }

  return low;
}

/**
 * Inserts into an already sorted list and returns the insertion index. If an
 * entry with the same path is already present (e.g. its timestamp was
 * edited), that stale copy is removed first so the list never accumulates
 * duplicate paths.
 */
export function insertSorted(list: JournalEntry[], entry: JournalEntry): number {
  removeByPath(list, entry.file.path);
  const low = insertionIndex(list, entry);
  list.splice(low, 0, entry);
  return low;
}
```

Append the class at the end of the file:

```ts
/**
 * The sorted entry list plus a path → record map, kept in step by being the
 * only thing that mutates either.
 *
 * The map exists because `JournalService` asks "is this path an entry?" for
 * every vault event, and a linear scan per event made a startup or a bulk
 * rename quadratic in the size of the journal.
 *
 * `entries` is the live array, exactly as `JournalService.getEntries()` has
 * always returned it: `JournalView` aliases it as its paging cursor list.
 * `replaceAll` therefore swaps in a NEW array rather than refilling the old
 * one — a rebuild has always meant "re-fetch", and code still holding the old
 * array must not see it change underneath it.
 *
 * Keys can go stale in exactly one way: Obsidian renames a `TFile` in place,
 * so the record filed under the old path starts reporting the new one.
 * `rekey` repairs that for one path; `staleKeys` finds every such key.
 */
export class EntryIndex {
  private list: JournalEntry[] = [];
  private byPath = new Map<string, JournalEntry>();

  get entries(): JournalEntry[] {
    return this.list;
  }

  get(path: string): JournalEntry | null {
    return this.byPath.get(path) ?? null;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  /** Files `entry` under its path, replacing any record already there. Returns its position. */
  insert(entry: JournalEntry): number {
    this.remove(entry.file.path);
    const index = insertionIndex(this.list, entry);
    this.list.splice(index, 0, entry);
    this.byPath.set(entry.file.path, entry);
    return index;
  }

  /**
   * Removes the record filed under `path`. Returns its former position, or -1.
   * `indexOf` by reference rather than a search by path string: still linear,
   * but a pointer comparison per element, and immune to a stale key.
   */
  remove(path: string): number {
    const record = this.byPath.get(path);
    if (!record) return -1;
    this.byPath.delete(path);
    const index = this.list.indexOf(record);
    if (index >= 0) this.list.splice(index, 1);
    return index;
  }

  /**
   * Refiles the record found under `oldPath` under the path its `TFile` now
   * reports. A different record already under that path can only be a stale
   * duplicate, and is removed, so one path never names two rows.
   */
  rekey(oldPath: string): void {
    const record = this.byPath.get(oldPath);
    if (!record) return;
    const newPath = record.file.path;
    if (newPath === oldPath) return;

    const occupant = this.byPath.get(newPath);
    if (occupant && occupant !== record) this.remove(newPath);
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, record);
  }

  /** Every key whose record now reports a different path. */
  staleKeys(): string[] {
    const stale: string[] = [];
    for (const [key, record] of this.byPath) {
      if (record.file.path !== key) stale.push(key);
    }
    return stale;
  }

  /** Takes `list` (already sorted) as the new live array. */
  replaceAll(list: JournalEntry[]): void {
    this.list = list;
    this.byPath = new Map(list.map((entry) => [entry.file.path, entry]));
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/entryIndex.test.ts`
Expected: PASS, including the pre-existing `insertSorted` tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/entryIndex.ts tests/entryIndex.test.ts
git commit -m "feat: EntryIndex keeps a path map beside the sorted entries"
```

---

### Task 4: `JournalService` uses `EntryIndex`, and rekeys at rename time

**Files:**
- Modify: `src/services/journalService.ts`
- Test: `tests/journalService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/journalService.test.ts`:

```ts
describe("JournalService: rename bookkeeping", () => {
  it("finds an entry renamed moments ago under its new path, before the flush", async () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();

    await fake.fileManager.renameFile(file, "Journal/2026/08/2026-08-12-22-41-52-2.md");
    // No timer advance: the rename event has fired, the flush has not.
    // `JournalView.changeEntryTime` can call this in exactly that window.
    service.applyKnownEntry({ file, created: new Date(2026, 6, 1, 8, 0, 0), tags: [] });

    expect(service.getEntries()).toHaveLength(1);
    expect(service.getEntries()[0].file).toBe(file);
  });
});
```

- [ ] **Step 2: Run it — it passes today, and that is the point**

Run: `npx vitest run tests/journalService.test.ts -t "renamed moments ago"`
Expected: PASS. Today's linear `findByPath` compares each record's *live* `file.path`, so it finds the renamed file. This is a regression guard: a path map keyed at insert time would miss it and insert a duplicate, which is exactly what the event-time `rekey` in Step 3 prevents. Re-run it after Step 3.

- [ ] **Step 3: Switch the service to `EntryIndex`**

In `src/services/journalService.ts`:

1. Change the import:

```ts
import { EntryIndex } from "./entryIndex";
```

2. Change the field:

```ts
  private index = new EntryIndex();
```

3. `rebuild()` and `getEntries()`:

```ts
  rebuild(): void {
    this.index.replaceAll(this.repository.listEntries());
  }

  /** The live, sorted index. See this class's doc for why this is not a copy. */
  getEntries(): JournalEntry[] {
    return this.index.entries;
  }
```

4. In the `vault.on("rename", …)` handler, replace the two lines after the folder branch:

```ts
        // Queued as "renameSource", not a plain "remove": see
        // `applyRenameSource`'s doc for why a plain removal would silently
        // never fire here.
        this.queuePath(oldPath, "renameSource");
        this.queue(file, "upsert");
```

with:

```ts
        // Refiled now, at event time, not at flush: Obsidian has already
        // renamed this TFile in place, so until this runs the index would
        // answer a lookup by the new path with nothing, and a caller between
        // here and the flush (`applyKnownEntry` from a time correction) would
        // insert a second row for the same file.
        this.index.rekey(oldPath);
        // Queued as "renameSource", not a plain "remove": see
        // `applyRenameSource`'s doc for why a plain removal would silently
        // never fire here.
        this.queuePath(oldPath, "renameSource");
        this.queue(file, "upsert");
```

5. `applyRemoval`, `applyRenameSource`, `applyUpsert`:

```ts
  private applyRemoval(path: string): JournalChange | null {
    if (this.index.remove(path) < 0) return null;
    return { kind: "removed", path };
  }
```

In `applyRenameSource`, replace `removeByPath(this.index, path);` with `this.index.remove(path);` and add one sentence to the end of its doc comment: "The rename listener has already refiled the record under its new path (`EntryIndex.rekey`), so the removal here is the defensive no-op it was always described as."

In `applyUpsert`, replace:

```ts
    const existing = findByPath(this.index, entry.file.path);

    if (!existing) {
      insertSorted(this.index, entry);
      return { kind: "added", entry };
    }

    if (existing.created.getTime() !== entry.created.getTime()) {
      removeByPath(this.index, entry.file.path);
      insertSorted(this.index, entry);
      return { kind: "moved", entry };
    }
```

with:

```ts
    const existing = this.index.get(entry.file.path);

    if (!existing) {
      this.index.insert(entry);
      return { kind: "added", entry };
    }

    if (existing.created.getTime() !== entry.created.getTime()) {
      // `insert` drops the record already filed under this path first.
      this.index.insert(entry);
      return { kind: "moved", entry };
    }
```

The comment block inside `applyUpsert` that mentions `this.index.indexOf(...)` still holds — `getEntries()` returns the same array objects — leave it.

- [ ] **Step 4: Run the service and view suites**

Run: `npx vitest run tests/journalService.test.ts tests/JournalView.changes.test.ts tests/JournalView.rekeyRace.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 5: Run everything**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/journalService.ts tests/journalService.test.ts
git commit -m "perf: JournalService looks entries up by path in O(1)"
```

---

### Task 5: Listeners at layout-ready, with a one-time reconcile

**Files:**
- Modify: `src/services/journalService.ts`
- Modify: `src/main.ts` (comment only, around line 39)
- Test: `tests/journalService.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/journalService.test.ts`:

```ts
describe("JournalService: before and at layout-ready", () => {
  it("ignores the create storm Obsidian fires before the layout is ready", () => {
    const { fake, service } = setup();
    fake.workspace.layoutReady = false;
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([]);
  });

  it("emits nothing at layout-ready when the index already matches the vault", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG12, "");
    fake.vault.addFile(AUG11, "");
    fake.workspace.layoutReady = false;
    service.load();
    const batches = collectBatches(service);

    fake.workspace.fireLayoutReady();

    expect(batches).toEqual([]);
  });

  it("reports a date the metadata cache learned before layout-ready as one moved entry", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    fake.vault.addFile(AUG11, "");
    fake.workspace.layoutReady = false;
    service.load();
    const changes = collectChanges(service);

    fake.metadataCache.frontmatter.set(file.path, {
      created: formatCreatedProperty(new Date(2026, 6, 1, 8, 0, 0)),
    });
    fake.workspace.fireLayoutReady();

    expect(changes).toEqual([{ kind: "moved", entry: expect.objectContaining({ file }) }]);
    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG11, AUG12]);
  });

  it("reports files created and deleted before layout-ready as added and removed", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG11, "");
    fake.workspace.layoutReady = false;
    service.load();
    const changes = collectChanges(service);

    const added = fake.vault.addFile(AUG12, "");
    fake.vault.files.delete(AUG11);
    fake.vault.contents.delete(AUG11);
    fake.workspace.fireLayoutReady();

    expect(changes).toEqual([
      { kind: "removed", path: AUG11 },
      { kind: "added", entry: expect.objectContaining({ file: added }) },
    ]);
  });

  it("repairs an entry renamed before layout-ready: removed at the old path, added at the new", async () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    fake.workspace.layoutReady = false;
    service.load();
    const changes = collectChanges(service);

    const renamed = "Journal/2026/08/2026-08-12-22-41-52-2.md";
    await fake.fileManager.renameFile(file, renamed);
    fake.workspace.fireLayoutReady();

    expect(changes[0]).toEqual({ kind: "removed", path: AUG12 });
    expect(service.getEntries()).toHaveLength(1);
    expect(service.getEntries()[0].file.path).toBe(renamed);
  });

  it("starts listening once the layout is ready", () => {
    const { fake, service } = setup();
    fake.workspace.layoutReady = false;
    service.load();
    fake.workspace.fireLayoutReady();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "added", entry: expect.objectContaining({ file }) }]);
  });

  it("registers nothing if unloaded before the layout became ready", () => {
    const { fake, service } = setup();
    fake.workspace.layoutReady = false;
    service.load();
    service.unload();
    fake.workspace.fireLayoutReady();

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(service.getEntries().map((e) => e.file.path)).not.toContain(AUG12);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/journalService.test.ts -t "layout-ready|layout is ready|before the layout"`
Expected: FAIL — listeners are registered in `onload`, so the storm is processed and nothing is reconciled.

- [ ] **Step 3: Implement**

In `src/services/journalService.ts`:

1. Add a field next to `flushHandle`:

```ts
  /** Set by `onunload`, so a layout-ready callback queued before it registers nothing. */
  private unloaded = false;
```

2. Replace the start of `onload()` — keep every listener body exactly as it is now, moved into `registerListeners()`:

```ts
  /**
   * The index is built now, synchronously, and the listeners wait for the
   * layout.
   *
   * Built now because a timeline restored from the saved workspace can open
   * before the layout is ready; with an empty index it would show the empty
   * state, and repainting it later means `reload()`, which runs through the
   * composer path.
   *
   * Listeners wait because Obsidian's vault initialisation fires `create` for
   * EVERY file in the vault (Obsidian's "Optimize plugin load time" guide says
   * to register vault events in `onLayoutReady` for exactly this reason), and
   * each queued path used to cost a linear scan of the index.
   *
   * What the storm did that was useful — correcting entries indexed while the
   * metadata cache was still filling in — `reconcile()` does instead, once.
   * Both run in the same synchronous callback, so no event can fall between
   * them.
   *
   * Ordering that `main.ts` relies on: this callback is queued during
   * `addChild(journal)`, before `main.ts` queues its own capture-URI callback,
   * and Obsidian runs them in order — so the index is reconciled before an
   * `obsidian://simple-journal-new` composer opens.
   */
  onload(): void {
    this.rebuild();
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.reconcile();
      this.registerListeners();
    });
  }

  private registerListeners(): void {
    // The five registrations below are moved here verbatim from the old
    // onload(), comments included.
  }
```

Into `registerListeners()`, move — verbatim, with their comments — all five `this.registerEvent(...)` calls that were in `onload()`: `vault` `create`, `modify`, `delete`, `rename` (with Task 4's `rekey` line), and `metadataCache` `changed`. `onload()` must then contain only what is shown above.

3. In `onunload()`, set the flag first:

```ts
  onunload(): void {
    this.unloaded = true;
    if (this.flushHandle !== null) window.clearTimeout(this.flushHandle);
    this.listeners.clear();
    this.selfWrites.clear();
  }
```

4. Add `reconcile()` and a helper, below `rebuild()`:

```ts
  /**
   * One pass at layout-ready that brings the index built in `onload` into
   * line with the vault as it is now, and reports only what differs — an
   * ordinary batch of changes, never `reload`, so no view goes through its
   * composer path. On a normal launch nothing differs and nothing is emitted.
   *
   * Removals are collected first, the same order `flush()` guarantees and
   * for the same reason (see its doc).
   */
  private reconcile(): void {
    const changes: JournalChange[] = [];

    // A TFile renamed before the listeners existed still sits under its old
    // key. Refile it and report the old path gone, which is the half of a
    // rename `JournalView` needs to tear down a row rendered at that path.
    for (const oldPath of this.index.staleKeys()) {
      this.index.rekey(oldPath);
      changes.push({ kind: "removed", path: oldPath });
    }

    const fresh = this.repository.listEntries();
    const freshPaths = new Set(fresh.map((entry) => entry.file.path));

    for (const entry of [...this.index.entries]) {
      if (freshPaths.has(entry.file.path)) continue;
      const change = this.applyRemoval(entry.file.path);
      if (change) changes.push(change);
    }

    for (const entry of fresh) {
      const existing = this.index.get(entry.file.path);
      if (
        existing &&
        existing.file === entry.file &&
        existing.created.getTime() === entry.created.getTime() &&
        sameTags(existing.tags, entry.tags)
      ) {
        continue;
      }
      changes.push(this.applyUpsert(entry));
    }

    if (changes.length > 0) this.emitBatch(changes);
  }
```

At module level, below the constants:

```ts
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}
```

Note on the rename test: after `rekey` the renamed record is filed under its new path, and `listEntries()` resolves it there with a `created` that may differ (the `-2` suffix still parses to the same second, so it is usually the same). If it matches, the test sees only `removed`; if it differs, `moved` follows. The test asserts only the first change and the final index, so either is correct.

- [ ] **Step 4: Add the ordering comment in `src/main.ts`**

Replace:

```ts
    this.journal = new JournalService(this.app, this.repository);
    // Ties the service's lifecycle to the plugin: its vault/metadata-cache
    // event registrations are released automatically on unload.
    this.addChild(this.journal);
```

with:

```ts
    this.journal = new JournalService(this.app, this.repository);
    // Ties the service's lifecycle to the plugin: its vault/metadata-cache
    // event registrations are released automatically on unload.
    //
    // Must stay ABOVE the capture-URI handler's `onLayoutReady` below: the
    // service queues its own layout-ready reconcile here, and Obsidian runs
    // those callbacks in the order they were queued, so the index is current
    // before a URI-opened composer looks at it.
    this.addChild(this.journal);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/journalService.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS. Every other suite uses the mock's default (layout already ready), where `onLayoutReady` runs immediately inside `load()`, so their behaviour is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/services/journalService.ts src/main.ts tests/journalService.test.ts
git commit -m "perf: register vault listeners at layout-ready, and reconcile once there"
```

---

### Task 6: Drop vault events for files outside the journal

**Files:**
- Modify: `src/services/journalService.ts`
- Test: `tests/journalService.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/journalService.test.ts`:

```ts
describe("JournalService: events outside the journal", () => {
  it("does no index work for an edit to a note outside the journal", () => {
    const { fake, repository, service } = setup();
    fake.vault.addFile(AUG12, "");
    service.load();
    const entryFor = vi.spyOn(repository, "entryFor");
    const note = fake.vault.addFile("Notes/idea.md", "");

    fake.vault.trigger("modify", note);
    fake.metadataCache.trigger("changed", note);
    vi.advanceTimersByTime(300);

    expect(entryFor).not.toHaveBeenCalled();
  });

  it("does not push back a pending journal change", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);
    const file = fake.vault.addFile(AUG12, "");
    const note = fake.vault.addFile("Notes/idea.md", "");

    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(200);
    fake.vault.trigger("modify", note);
    vi.advanceTimersByTime(100);

    expect(changes).toEqual([{ kind: "added", entry: expect.objectContaining({ file }) }]);
  });

  it("still removes an entry moved out of the journal folder", async () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    await fake.fileManager.renameFile(file, "Archive/2026-08-12-22-41-52.md");
    vi.advanceTimersByTime(300);

    expect(service.getEntries()).toEqual([]);
    expect(changes).toContainEqual({ kind: "removed", path: AUG12 });
  });

  it("adds a note moved into the journal folder", async () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile("Inbox/2026-08-12-22-41-52.md", "");
    service.load();
    const changes = collectChanges(service);

    await fake.fileManager.renameFile(file, AUG12);
    vi.advanceTimersByTime(300);

    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12]);
    expect(changes).toContainEqual({ kind: "added", entry: expect.objectContaining({ file }) });
  });

  it("ignores a rename that starts and ends outside the journal", async () => {
    const { fake, service } = setup();
    const note = fake.vault.addFile("Notes/a.md", "");
    service.load();
    const batches = collectBatches(service);

    await fake.fileManager.renameFile(note, "Notes/b.md");
    vi.advanceTimersByTime(300);

    expect(batches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/journalService.test.ts -t "outside the journal"`
Expected: FAIL on the first test (`entryFor` is called), the second (the note's event restarts the timer, so nothing is emitted by 300 ms), and the last (a `removed` for `Notes/a.md` is emitted today).

- [ ] **Step 3: Implement**

In `src/services/journalService.ts`:

Replace `queue`:

```ts
  /**
   * Drops events for files that are not, and were not, journal entries.
   *
   * Every note in the vault produces `modify` and `changed` while someone
   * types in it, and each one used to cost a flush, an `entryFor`, and a
   * linear scan of the index that found nothing — and restarted the shared
   * debounce, delaying real journal changes queued just before it.
   *
   * "Were not" is the half that matters: a file moved OUT of the journal is
   * no longer an entry file, but is still indexed until the flush removes it,
   * and that removal is how the timeline learns it is gone.
   */
  private queue(file: TAbstractFile, action: "upsert" | "remove"): void {
    if (!(file instanceof TFile)) return;
    if (!this.concernsJournal(file, file.path)) return;
    this.queuePath(file.path, action);
  }

  /** True when `file` is an entry file now, or `indexedPath` is in the index. */
  private concernsJournal(file: TFile, indexedPath: string): boolean {
    return this.index.has(indexedPath) || this.repository.isEntryFile(file);
  }
```

In the rename handler, after the folder branch and before `this.index.rekey(oldPath)`:

```ts
        if (!(file instanceof TFile)) return;
        // Tested against the OLD path, before `rekey` below moves the key:
        // an entry leaving the journal is indexed there, and a note arriving
        // is an entry file at its new path.
        if (!this.concernsJournal(file, oldPath)) return;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/journalService.test.ts`
Expected: PASS.

If a pre-existing test fails because it asserted a `removed` change for a rename of a path that was never a journal entry, that test pinned the old, ungated behaviour (its comment will say "harmless no-op"). Change its expectation to no change for that path, and say so in the commit message. Do not loosen any assertion about a real entry.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/journalService.ts tests/journalService.test.ts
git commit -m "perf: ignore vault events for files outside the journal"
```

---

### Task 7: Mentions panels repaint only for changes that concern them

**Files:**
- Modify: `src/mentions/MentionsPanel.ts`
- Test: `tests/mentionsPanel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("createMentionsPanel", …)` in `tests/mentionsPanel.test.ts`:

```ts
  describe("staying current without repainting for nothing", () => {
    const UNRELATED = "Journal/2026/08/2026-08-01-10-00-00.md";

    it("does not re-render for a change to an entry that does not mention the target", async () => {
      const { app, plugin, target, container } = setup(1);
      const panel = createMentionsPanel({ plugin, container, target });
      await panel.render();
      const reads = vi.spyOn(plugin.repository, "readBodyCached");

      const unrelated = app.vault.addFile(UNRELATED, "about something else");
      app.vault.trigger("create", unrelated);
      await vi.advanceTimersByTimeAsync(500);
      app.vault.trigger("modify", unrelated);
      await vi.advanceTimersByTimeAsync(500);

      expect(reads).not.toHaveBeenCalled();
      panel.destroy();
    });

    it("re-renders for a change to an entry it lists", async () => {
      const { app, plugin, target, container, entries } = setup(1);
      const panel = createMentionsPanel({ plugin, container, target });
      await panel.render();
      const reads = vi.spyOn(plugin.repository, "readBodyCached");

      app.vault.trigger("modify", entries[0]);
      await vi.advanceTimersByTimeAsync(500);

      expect(reads).toHaveBeenCalled();
      panel.destroy();
    });

    it("re-renders for an entry it lists but has not shown yet", async () => {
      const { app, plugin, target, container, entries } = setup(7);
      const panel = createMentionsPanel({ plugin, container, target });
      await panel.render();
      const reads = vi.spyOn(plugin.repository, "readBodyCached");

      // Only five are shown; the sixth still counts towards the header.
      app.vault.trigger("delete", entries[6]);
      await vi.advanceTimersByTimeAsync(500);

      expect(reads).toHaveBeenCalled();
      expect(container.querySelector(".journal-mentions-count")?.textContent).toBe("6");
      panel.destroy();
    });

    it("re-renders when an entry starts linking to the target", async () => {
      const { app, plugin, target, container } = setup(1);
      const unrelated = app.vault.addFile(UNRELATED, "now about [[Ekin Arslan Aytaç]]");
      plugin.journal.rebuild();
      const panel = createMentionsPanel({ plugin, container, target });
      await panel.render();
      expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);

      app.metadataCache.resolvedLinks[unrelated.path] = { [TARGET_PATH]: 1 };
      app.metadataCache.trigger("resolve", unrelated);
      await vi.advanceTimersByTimeAsync(200);

      expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
      panel.destroy();
    });

    it("ignores a resolve for an entry that neither is listed nor links to the target", async () => {
      const { app, plugin, target, container } = setup(1);
      const unrelated = app.vault.addFile(UNRELATED, "about something else");
      plugin.journal.rebuild();
      const panel = createMentionsPanel({ plugin, container, target });
      await panel.render();
      const reads = vi.spyOn(plugin.repository, "readBodyCached");

      app.metadataCache.trigger("resolve", unrelated);
      await vi.advanceTimersByTimeAsync(200);

      expect(reads).not.toHaveBeenCalled();
      panel.destroy();
    });
  });
```

`plugin.journal.rebuild()` is reachable because `setup` puts the real `JournalService` on `plugin.journal`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/mentionsPanel.test.ts -t "repainting for nothing"`
Expected: FAIL on the first and last tests (the panel re-reads on every batch and every entry `resolve`). The middle three already pass and guard the change.

- [ ] **Step 3: Implement**

In `src/mentions/MentionsPanel.ts`:

1. Add the type import:

```ts
import type { JournalChange } from "../services/journalService";
```

2. Next to `let contentOwner …`, add:

```ts
  /**
   * Paths of EVERY entry the last render found mentioning the target — not
   * only the shown slice, because the header counts them all. A change to
   * anything else cannot alter what this panel shows unless it now links to
   * the target, which `concerns` asks `resolvedLinks` directly.
   */
  let mentionPaths = new Set<string>();
```

3. Replace the two subscriptions:

```ts
  const unsubscribeJournal = plugin.journal.onChange(() => scheduleRefresh());
```

with:

```ts
  /**
   * Every timeline autosave reaches here as a batch, and so does every other
   * entry change in the journal. Repainting for each one meant a read and a
   * `MarkdownRenderer` pass per shown entry, in every live footer, sidebar
   * and code block, for saves that had nothing to do with the target.
   */
  const unsubscribeJournal = plugin.journal.onChange((changes) => {
    if (changes.some(batchChangeConcerns)) scheduleRefresh();
  });
```

and in the `resolve` handler:

```ts
  const resolveRef = plugin.app.metadataCache.on("resolve", (file) => {
    if (!plugin.repository.isEntryFile(file)) return;
    if (!concerns(file.path)) return;
    scheduleRefresh();
  });
```

Extend that handler's doc comment with one sentence: "Of those, only an entry this panel lists, or one that now links to the target, can change what it shows: a link removed drops a listed entry, a link added shows up in `resolvedLinks`."

4. Below the subscriptions, add:

```ts
  function concerns(path: string): boolean {
    return mentionPaths.has(path) || Boolean(plugin.app.metadataCache.resolvedLinks[path]?.[target.path]);
  }

  function batchChangeConcerns(change: JournalChange): boolean {
    if (change.kind === "reload") return true;
    if (change.kind === "removed") return mentionPaths.has(change.path);
    return concerns(change.entry.file.path);
  }
```

`function` declarations are hoisted, so the subscriptions above can reference them.

5. In `render()`, right after `const mentions = findMentions(…);`:

```ts
    mentionPaths = new Set(mentions.map((entry) => entry.file.path));
```

The registry repaint (`refreshMentionPanels`) and every explicit `render()` call are untouched and stay unconditional.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mentionsPanel.test.ts tests/mentionsView.test.ts tests/mentionsFooter.test.ts tests/mentionsCodeBlock.test.ts tests/mainMentionSurfaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mentions/MentionsPanel.ts tests/mentionsPanel.test.ts
git commit -m "perf: mentions panels repaint only for changes that concern them"
```

---

### Task 8: The calendar skips an identical grid

**Files:**
- Modify: `src/views/calendarGrid.ts`, `src/views/CalendarView.ts`, `tests/obsidian-mock.ts`
- Test: `tests/calendarGrid.test.ts`, `tests/calendarView.test.ts` (new)

- [ ] **Step 1: Write the failing pure test**

In `tests/calendarGrid.test.ts`, add `calendarSignature` to the import from `../src/views/calendarGrid` and append:

```ts
describe("calendarSignature", () => {
  it("is equal for the same month, today and dotted days, whatever their order", () => {
    expect(calendarSignature(2026, 7, new Set(["2026-08-12", "2026-08-01"]), "2026-08-20")).toBe(
      calendarSignature(2026, 7, new Set(["2026-08-01", "2026-08-12"]), "2026-08-20"),
    );
  });

  it("differs when the month, today, or the dotted days differ", () => {
    const base = calendarSignature(2026, 7, new Set(["2026-08-12"]), "2026-08-20");
    expect(calendarSignature(2026, 6, new Set(["2026-08-12"]), "2026-08-20")).not.toBe(base);
    expect(calendarSignature(2026, 7, new Set(["2026-08-12"]), "2026-08-21")).not.toBe(base);
    expect(calendarSignature(2026, 7, new Set(["2026-08-13"]), "2026-08-20")).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/calendarGrid.test.ts`
Expected: FAIL — `calendarSignature` is not exported.

- [ ] **Step 3: Implement `calendarSignature`**

Append to `src/views/calendarGrid.ts`:

```ts
/**
 * Everything a rendered month grid depends on, as one comparable string: the
 * month, which day is today, and which days carry a dot. Two equal signatures
 * render identical grids, which is what lets `CalendarView` skip a rebuild
 * for a change batch that touched none of them.
 */
export function calendarSignature(
  year: number,
  month: number,
  entryDays: ReadonlySet<string>,
  todayKey: string,
): string {
  return `${year}-${month}|${todayKey}|${[...entryDays].sort().join(",")}`;
}
```

Run: `npx vitest run tests/calendarGrid.test.ts`
Expected: PASS.

- [ ] **Step 4: Add `ExtraButtonComponent` to the mock**

`CalendarView` renders its month navigation with it; the mock has none yet. Add to `tests/obsidian-mock.ts`, near `ItemView`:

```ts
/**
 * Minimal stand-in for Obsidian's `ExtraButtonComponent`: a clickable element
 * in the container, with the chainable setters `CalendarView` calls. Icons
 * and tooltips are accepted and not modelled.
 */
export class ExtraButtonComponent {
  extraSettingsEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.extraSettingsEl = containerEl.createEl("button", { cls: "clickable-icon extra-setting-button" });
  }

  setIcon(_icon: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  onClick(callback: () => unknown): this {
    this.extraSettingsEl.addEventListener("click", () => void callback());
    return this;
  }
}
```

- [ ] **Step 5: Write the failing view test**

Create `tests/calendarView.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf as ObsidianWorkspaceLeaf } from "obsidian";
import { createFakeApp, installDomHelpers, WorkspaceLeaf as FakeWorkspaceLeaf } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { CalendarView } from "../src/views/CalendarView";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 20, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const AUG12 = "Journal/2026/08/2026-08-12-22-41-52.md";
const JUL03 = "Journal/2026/07/2026-07-03-09-00-00.md";

async function setup() {
  const app = createFakeApp();
  const aug = app.vault.addFile(AUG12, "");
  const jul = app.vault.addFile(JUL03, "");
  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();
  const plugin = { app, journal: service, goToDateInJournal: vi.fn() } as unknown as JournalEntriesPlugin;
  const view = new CalendarView(new FakeWorkspaceLeaf(app) as unknown as ObsidianWorkspaceLeaf, plugin);
  await view.onOpen();
  return { app, view, aug, jul };
}

function firstDayCell(view: CalendarView): Element | null {
  return view.contentEl.querySelector(".journal-calendar-day:not(.journal-calendar-day-blank)");
}

describe("CalendarView repaints", () => {
  it("keeps the same grid for a change that moves no dot", async () => {
    const { app, view, jul } = await setup();
    const before = firstDayCell(view);

    app.vault.trigger("modify", jul);
    vi.advanceTimersByTime(300);

    expect(firstDayCell(view)).toBe(before);
  });

  it("rebuilds the grid when a day in the shown month gains a dot", async () => {
    const { app, view } = await setup();
    const before = firstDayCell(view);

    const added = app.vault.addFile("Journal/2026/08/2026-08-15-08-00-00.md", "");
    app.vault.trigger("create", added);
    vi.advanceTimersByTime(300);

    expect(firstDayCell(view)).not.toBe(before);
    const dotted = view.contentEl.querySelectorAll(
      ".journal-calendar-day:not(.is-empty):not(.journal-calendar-day-blank)",
    );
    expect(dotted).toHaveLength(2);
  });

  it("refresh() always rebuilds", async () => {
    const { view } = await setup();
    const before = firstDayCell(view);

    view.refresh();

    expect(firstDayCell(view)).not.toBe(before);
  });
});
```

Run: `npx vitest run tests/calendarView.test.ts`
Expected: FAIL on the first test only (every batch rebuilds today). If the file fails to load instead, the mock is missing something `CalendarView` uses: add the smallest stand-in to `tests/obsidian-mock.ts`, following Step 4's pattern, and re-run.

- [ ] **Step 6: Implement in `CalendarView`**

In `src/views/CalendarView.ts`:

1. Import it: `import { buildMonthGrid, calendarSignature, entryDaysInMonth, WEEKDAY_HEADER } from "./calendarGrid";`
2. Add a field after `displayedMonth`:

```ts
  /** What the grid on screen was rendered from. See `renderIfChanged`. */
  private renderedSignature: string | null = null;
```

3. In `onOpen`, change the subscription to `this.register(this.plugin.journal.onChange(() => this.renderIfChanged()));`, and replace its comment's first sentence ("Re-render on every vault change batch.") with: "Re-render for a vault change batch only when it changed something this grid shows; see `renderIfChanged`."
4. Replace `render()` and add two methods:

```ts
  /**
   * The `onChange` path. Every timeline autosave arrives as a batch, almost
   * always for an entry whose day already had a dot, so rebuilding the header
   * and ~45 cells for it changed nothing on screen. Today's date is part of
   * the signature, so the midnight move of the "today" emphasis still lands
   * on the next batch, as it always has.
   */
  private renderIfChanged(): void {
    if (this.currentSignature() === this.renderedSignature) return;
    this.render();
  }

  private currentSignature(): string {
    const year = this.displayedMonth.getFullYear();
    const month = this.displayedMonth.getMonth();
    const entryDays = entryDaysInMonth(this.plugin.journal.getEntries(), year, month);
    return calendarSignature(year, month, entryDays, dayKey(new Date()));
  }

  /** Rebuilds the header and grid for `this.displayedMonth`. */
  private render(): void {
    this.renderedSignature = this.currentSignature();
    this.renderHeader();
    this.renderGrid();
  }
```

`refresh()` and `stepMonth()` keep calling `render()` directly, so they always rebuild.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/calendarView.test.ts tests/calendarGrid.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views/calendarGrid.ts src/views/CalendarView.ts tests/obsidian-mock.ts tests/calendarGrid.test.ts tests/calendarView.test.ts
git commit -m "perf: the calendar skips rebuilding an unchanged grid"
```

---

### Task 9: Editors poll fast only while in use

**Files:**
- Modify: `src/views/ObsidianEmbedEditor.ts`
- Test: `tests/obsidianEmbedEditor.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/obsidianEmbedEditor.test.ts`, change the import to:

```ts
import { COLD_POLL_MS, HOT_LINGER_MS, HOT_POLL_MS, ObsidianEmbedEditor } from "../src/views/ObsidianEmbedEditor";
```

Append:

```ts
describe("ObsidianEmbedEditor: polling speed", () => {
  function embedEl(container: HTMLElement): HTMLElement {
    return container.querySelector(".journal-entry-embed") as HTMLElement;
  }

  function mounted() {
    vi.useFakeTimers();
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);
    return { editor, setDoc, changes, container };
  }

  it("an editor nobody is using picks a change up on the slow poll", () => {
    const { setDoc, changes } = mounted();

    setDoc(replaceBody(SEEDED_DOC, "DROPPED IN.\n"));
    vi.advanceTimersByTime(HOT_POLL_MS);
    expect(changes).toEqual([]);

    vi.advanceTimersByTime(COLD_POLL_MS - HOT_POLL_MS);
    expect(changes).toEqual(["DROPPED IN.\n"]);
  });

  it("focusing it switches to the fast poll at once", () => {
    const { setDoc, changes, container } = mounted();
    vi.advanceTimersByTime(100);

    embedEl(container).dispatchEvent(new FocusEvent("focusin"));
    setDoc(replaceBody(SEEDED_DOC, "TYPED.\n"));
    vi.advanceTimersByTime(HOT_POLL_MS);

    expect(changes).toEqual(["TYPED.\n"]);
  });

  it("stays fast for a while after losing focus, then slows down", () => {
    const { setDoc, changes, container } = mounted();
    const el = embedEl(container);

    el.dispatchEvent(new FocusEvent("focusin"));
    el.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
    setDoc(replaceBody(SEEDED_DOC, "A.\n"));
    vi.advanceTimersByTime(HOT_POLL_MS);
    expect(changes).toEqual(["A.\n"]);

    vi.advanceTimersByTime(HOT_LINGER_MS);
    setDoc(replaceBody(SEEDED_DOC, "B.\n"));
    vi.advanceTimersByTime(HOT_POLL_MS);
    expect(changes).toEqual(["A.\n"]);

    vi.advanceTimersByTime(COLD_POLL_MS);
    expect(changes).toEqual(["A.\n", "B.\n"]);
  });

  it("a focus move inside the editor does not slow it down", () => {
    const { setDoc, changes, container } = mounted();
    const el = embedEl(container);
    const inner = document.createElement("div");
    el.appendChild(inner);

    el.dispatchEvent(new FocusEvent("focusin"));
    el.dispatchEvent(new FocusEvent("focusout", { relatedTarget: inner }));
    vi.advanceTimersByTime(HOT_LINGER_MS + HOT_POLL_MS);
    setDoc(replaceBody(SEEDED_DOC, "STILL HOT.\n"));
    vi.advanceTimersByTime(HOT_POLL_MS);

    expect(changes).toEqual(["STILL HOT.\n"]);
  });

  it("flush() reports text the slow poll has not seen yet", () => {
    // What makes eviction safe at any polling speed: `flushSave` calls
    // `flush()` first, and `isDirty` reads `getValue()`, neither of which
    // waits for a poll.
    const { editor, setDoc, changes } = mounted();

    setDoc(replaceBody(SEEDED_DOC, "NOT POLLED YET.\n"));
    editor.flush();

    expect(changes).toEqual(["NOT POLLED YET.\n"]);
    expect(editor.getValue()).toBe("NOT POLLED YET.\n");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/obsidianEmbedEditor.test.ts -t "polling speed"`
Expected: FAIL — the constants are not exported.

- [ ] **Step 3: Implement**

In `src/views/ObsidianEmbedEditor.ts`:

1. Above the class, add:

```ts
/** Poll interval while the editor is in use: focused, or left under `HOT_LINGER_MS` ago. */
export const HOT_POLL_MS = 250;
/** Poll interval for every other mounted editor — a safety net, not the typing path. */
export const COLD_POLL_MS = 2000;
/** How long an editor keeps the fast poll after focus leaves it. */
export const HOT_LINGER_MS = 2000;
```

2. Fields, next to `pollHandle`:

```ts
  /** The raw document as of the last poll. */
  private lastRaw = "";
  /**
   * Until when this editor counts as in use. `Infinity` while it holds focus;
   * a timestamp once focus leaves; 0 for one never focused.
   */
  private hotUntil = 0;
```

3. In `mount()`, register a `focusin` listener beside the existing `focusout` one, and stamp the blur inside `focusout` after its "still inside" early return:

```ts
      this.containerEl.addEventListener("focusin", () => {
        this.hotUntil = Infinity;
        // A cold editor may be up to COLD_POLL_MS from its next look; the
        // first keystroke after focusing must not wait for that.
        if (this.pollHandle !== null) {
          window.clearTimeout(this.pollHandle);
          this.schedulePoll(HOT_POLL_MS);
        }
      });
      this.containerEl.addEventListener("focusout", (event) => {
        // ... existing comment
        const related = event.relatedTarget as Node | null;
        if (related && this.containerEl?.contains(related)) return;
        this.hotUntil = Date.now() + HOT_LINGER_MS;
        this.blurCallback?.();
      });
```

Both listeners stay covered by the existing "No removeEventListener on destroy" comment; extend it to say "these listeners".

4. Replace `startPolling` and `stopPolling`, and add two methods:

```ts
  /**
   * The spike found no change callback on the embed (docs/editor-embed-api.md).
   * `editMode` has an `onUpdate` on its prototype, but hooking it would mean
   * monkey-patching a method CM6 itself wires into the editor at
   * construction time — there's no way to verify, without a live Obsidian
   * window, whether replacing it post-construction is ever actually invoked,
   * or whether it silently breaks live preview's own use of the same hook.
   * Given that risk, this polls instead: a string read on a timer, with an
   * early-out once the raw document is unchanged.
   *
   * At two speeds. Every mounted editor used to poll every 250 ms, so 25 idle
   * editors on a phone woke the CPU 100 times a second for nothing. An editor
   * in use — focused, or left within `HOT_LINGER_MS` — still polls at
   * `HOT_POLL_MS`; the rest at `COLD_POLL_MS`, which only has to catch a change
   * made without focus (a drop, a command) and never loses one: `getValue()`
   * and `flush()` read the editor directly, so no save path waits on a poll.
   */
  private startPolling(): void {
    this.lastRaw = this.readRaw() ?? "";
    // The initial read above may itself have found the embed already
    // broken and called markUnusable() — without this check, the timer
    // below would still be installed regardless, leaving a loop running
    // against an editor already flagged unusable, clearable only by
    // destroy() rather than the markUnusable() path that's supposed to own
    // stopping it.
    if (!this.usable) return;
    this.schedulePoll(this.nextPollDelay());
  }

  private nextPollDelay(): number {
    return Date.now() < this.hotUntil ? HOT_POLL_MS : COLD_POLL_MS;
  }

  private schedulePoll(delay: number): void {
    this.pollHandle = window.setTimeout(() => this.poll(), delay);
  }

  private poll(): void {
    this.pollHandle = null;

    const raw = this.readRaw();
    // A null read either means nothing changed relevantly or that readRaw()
    // just flipped this editor unusable — in which case it must not be
    // rescheduled.
    if (raw !== null && raw !== this.lastRaw) {
      this.lastRaw = raw;
      const body = this.readBody();
      if (body !== this.lastBody) {
        this.lastBody = body;
        this.changeCallback?.(body);
      }
    }

    // The callback above can destroy or remount this editor; only a still
    // usable editor with no timer of its own carries on.
    if (this.usable && this.pollHandle === null) this.schedulePoll(this.nextPollDelay());
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      window.clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
  }
```

Leave `readBody()` and its own `lastRawBody` bookkeeping exactly as they are; only the timer around them changes.

- [ ] **Step 4: Move the existing tests onto the slow poll**

The existing tests mount without focusing, then advance 300 ms (or 1000 ms) expecting the old 250 ms poll. They test what a poll *does*, not how often, so they move to the cold interval:

```bash
sed -i '' 's/vi\.advanceTimersByTime(300)/vi.advanceTimersByTime(COLD_POLL_MS)/; s/vi\.advanceTimersByTime(1000)/vi.advanceTimersByTime(2 * COLD_POLL_MS)/' tests/obsidianEmbedEditor.test.ts
```

Then `git diff tests/obsidianEmbedEditor.test.ts` and confirm every replaced line sits in a test about polling (the "embed polling", "destroy", "get() failure", and frontmatter-guard tests). The `advanceTimersByTime(0)` call is a separate deferral and must be unchanged.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/obsidianEmbedEditor.test.ts tests/JournalView.composerFocusRetake.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/ObsidianEmbedEditor.ts tests/obsidianEmbedEditor.test.ts
git commit -m "perf: idle editors poll every 2 s instead of every 250 ms"
```

---

### Task 10: Measure, verify, document

**Files:**
- Modify: `docs/manual-testing.md`, `docs/superpowers/specs/2026-10-20-index-and-background-perf-design.md`

- [ ] **Step 1: Run the benchmark again**

Run: `npm run bench 2>&1 | tee /tmp/claude-501/bench-after.txt`
Expected: the startup case drops from seconds to milliseconds; the bulk-rename case drops substantially; the typing case is near zero. If any case did not improve, stop and investigate before continuing — do not ship an unexplained result.

- [ ] **Step 2: Full verification**

Run each, and read the output:

```bash
npm run build
npm test
npm run test:tz
npm run lint
```

Expected: all four succeed with no errors. Fix anything that fails before moving on.

- [ ] **Step 3: Add the manual checks**

Read `docs/manual-testing.md` to find its checklist format, then add a section in that same format with these four checks:

1. **Startup, large vault (desktop).** Open a vault with thousands of entries and an open timeline in the saved workspace. Obsidian starts with no visible hitch, and the restored timeline opens full, not empty.
2. **Capture at startup.** With Obsidian closed, open `obsidian://simple-journal-new`. The composer opens and the entry saves where expected.
3. **Idle editors (iPhone).** Leave the timeline open with entries on screen for five minutes. Settings → Battery shows no unusual Obsidian usage compared with 1.5.1.
4. **Surfaces still follow edits.** Edit an entry that links to a note with the mentions footer on: the footer updates. Create an entry for a day without one: the calendar shows its dot.

- [ ] **Step 4: Mark the spec implemented**

In the spec's header, change `**Status:** approved design, not yet implemented` to `**Status:** approved, implemented`.

- [ ] **Step 5: Commit, with the numbers**

```bash
git add docs/manual-testing.md docs/superpowers/specs/2026-10-20-index-and-background-perf-design.md
git commit -m "docs: manual checks for the index and background performance work

Benchmark, 50k entries + 50k other notes (npm run bench):
  startup storm:  <before mean> -> <after mean>
  bulk rename:    <before mean> -> <after mean>
  typing outside: <before mean> -> <after mean>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015vj5ANdwDBaoR8Phx9go7P"
```

Replace each `<… mean>` with the measured values from Task 2 Step 4 and Task 10 Step 1 before committing.
