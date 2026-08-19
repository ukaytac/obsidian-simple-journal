// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey, formatMonthHeader } from "../src/utils/dates";
import { addEntry, createHarness, internals, settle, timelineEl } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/**
 * Pins `timelineDom.ts`'s two invariants that mutation testing found
 * unprotected: `insertEntryInPlace`'s reverse-chronological sibling
 * placement (CLAUDE.md's "Timeline Direction" / North Star #3, which
 * applies WITHIN a day, not only across days), and `rebuildMonthHeaders`'s
 * per-month dedup once it runs on a path other than the initial-load
 * "append" branch (a delete or a vault-event-driven insert).
 *
 * Every insertion here goes through the real vault "create" event ->
 * `JournalService`'s debounced batching -> `applyUpsert`'s "added" branch ->
 * `decideChangeAction`'s "insert" -> `JournalView.insertEntryInPlace` ->
 * `timelineDom.ts`'s `insertEntryInPlace` — the same path a file dropped
 * into the journal folder from outside the view takes. Nothing here calls
 * `insertEntryInPlace` directly.
 *
 * Expected order is hardcoded per test (not re-derived from
 * `compareEntries`): re-deriving it from the very function whose result
 * `insertEntryInPlace` consumes would let a bug shared by both sides still
 * pass. The dates chosen make the intended order obvious by inspection.
 */
describe("JournalView insertEntryInPlace: intra-day order", () => {
  async function createFile(h: ReturnType<typeof createHarness>, at: Date, body: string, suffix = "") {
    const file = addEntry(h, at, body, suffix);
    h.app.vault.trigger("create", file);
    vi.advanceTimersByTime(300);
    await settle();
    return file;
  }

  function pathsInDay(h: ReturnType<typeof createHarness>, day: Date): (string | undefined)[] {
    const group = internals(h.view).dayGroups.get(dayKey(day)) as HTMLElement;
    return Array.from(group.querySelectorAll<HTMLElement>(".journal-entry")).map(
      (el) => el.dataset.path,
    );
  }

  it("an entry newer than every rendered sibling lands first", async () => {
    const h = createHarness();
    const day = new Date(2026, 7, 12);
    const older = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "older");
    const newer = addEntry(h, new Date(2026, 7, 12, 14, 0, 0), "newer");
    h.service.load();
    await h.view.onOpen();
    expect(pathsInDay(h, day)).toEqual([newer.path, older.path]);

    const newest = await createFile(h, new Date(2026, 7, 12, 20, 0, 0), "newest");

    expect(pathsInDay(h, day)).toEqual([newest.path, newer.path, older.path]);
  });

  it("an entry older than every rendered sibling lands last", async () => {
    const h = createHarness();
    const day = new Date(2026, 7, 12);
    const first = addEntry(h, new Date(2026, 7, 12, 20, 0, 0), "first");
    const second = addEntry(h, new Date(2026, 7, 12, 14, 0, 0), "second");
    // An older anchor entry on a separate day, loaded alongside the two
    // above. Without it, the new "oldest" entry inserted below would land
    // exactly on the loaded window's boundary
    // (`position - offset >= loadedCount`) and `insertEntryInPlace` would
    // correctly defer it to paging instead of rendering it — a real but
    // different code path than the one this test means to exercise.
    const anchor = addEntry(h, new Date(2026, 7, 5, 9, 0, 0), "older anchor, different day");
    h.service.load();
    await h.view.onOpen();
    expect(pathsInDay(h, day)).toEqual([first.path, second.path]);

    const oldest = await createFile(h, new Date(2026, 7, 12, 9, 0, 0), "oldest");

    expect(pathsInDay(h, day)).toEqual([first.path, second.path, oldest.path]);
    expect(internals(h.view).rendered.has(anchor.path)).toBe(true);
  });

  it("an entry between two rendered siblings lands between them", async () => {
    const h = createHarness();
    const day = new Date(2026, 7, 12);
    const top = addEntry(h, new Date(2026, 7, 12, 20, 0, 0), "top");
    const bottom = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "bottom");
    h.service.load();
    await h.view.onOpen();
    expect(pathsInDay(h, day)).toEqual([top.path, bottom.path]);

    const middle = await createFile(h, new Date(2026, 7, 12, 14, 0, 0), "middle");

    expect(pathsInDay(h, day)).toEqual([top.path, middle.path, bottom.path]);
  });

  it("a same-second collision sits above the entry it collided with", async () => {
    const h = createHarness();
    const at = new Date(2026, 7, 12, 22, 14, 0);
    const day = new Date(2026, 7, 12);
    const first = addEntry(h, at, "first", "");
    h.service.load();
    await h.view.onOpen();
    expect(pathsInDay(h, day)).toEqual([first.path]);

    // Same second, "-2" collision suffix: compareEntries's collision
    // fallback says this one is the later of the two, so it must render
    // above `first`, not below it.
    const second = await createFile(h, at, "second", "-2");

    expect(pathsInDay(h, day)).toEqual([second.path, first.path]);
  });

  /**
   * `ensureDayGroup`'s "prepend" branch (used whenever `insertEntryInPlace`
   * needs a day group that does not exist yet) searches the already-loaded
   * day groups for the correct neighbour instead of assuming the new day is
   * always the newest. This test covers the common case: capturing "today"
   * when today's group does not exist yet and nothing newer is loaded.
   */
  it("a new day group that genuinely is the newest lands above every already-loaded day", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "aug12");
    addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "aug10");
    h.service.load();
    await h.view.onOpen();

    const created = await createFile(h, new Date(2026, 7, 14, 9, 0, 0), "aug14, newest overall");

    const days = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-day"),
    ).map((el) => el.dataset.day);
    expect(days).toEqual(["2026-08-14", "2026-08-12", "2026-08-10"]);
    expect(internals(h.view).rendered.has(created.path)).toBe(true);
  });

  /**
   * The bug this suite was built to catch: a new day sandwiched between two
   * already-loaded days (an external drop of an old file into the journal
   * folder, or any "added" change for a day strictly between two loaded
   * ones) must land between its correct neighbours, not at the absolute top
   * of the timeline — violating CLAUDE.md's "Timeline Direction"/North Star
   * #3 ("the newest journal entry is always at the top"), which implies the
   * days between it and the true newest stay in order too.
   */
  it("a new day sandwiched between two already-loaded days lands between them, not at the top", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 14, 9, 0, 0), "aug14");
    addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "aug10");
    h.service.load();
    await h.view.onOpen();

    const created = await createFile(
      h,
      new Date(2026, 7, 12, 9, 0, 0),
      "aug12, between the two loaded days",
    );

    const days = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-day"),
    ).map((el) => el.dataset.day);
    expect(days).toEqual(["2026-08-14", "2026-08-12", "2026-08-10"]);
    expect(internals(h.view).rendered.has(created.path)).toBe(true);
  });

  it("a new day older than every already-loaded day lands at the bottom, not at the top", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 14, 9, 0, 0), "aug14");
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "aug12");
    // An older anchor day, loaded alongside the two above, purely to keep
    // the new entry inside the loaded window's boundary check
    // (`position - offset >= loadedCount`) — the same technique the
    // intra-day "lands last" test above uses. Without it, an insert that is
    // the true oldest entry in the whole journal sits exactly on that
    // boundary and `insertEntryInPlace` correctly defers it to paging
    // instead of rendering it at all: a different code path than the one
    // this test means to exercise.
    const anchor = addEntry(h, new Date(2026, 6, 1, 9, 0, 0), "jul1, older anchor day");
    h.service.load();
    await h.view.onOpen();

    const created = await createFile(
      h,
      new Date(2026, 7, 5, 9, 0, 0),
      "aug5, older than every loaded day but the anchor",
    );

    const days = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-day"),
    ).map((el) => el.dataset.day);
    expect(days).toEqual(["2026-08-14", "2026-08-12", "2026-08-05", "2026-07-01"]);
    expect(internals(h.view).rendered.has(created.path)).toBe(true);
    expect(internals(h.view).rendered.has(anchor.path)).toBe(true);
  });
});

describe("JournalView month headers after mutation, not only after load", () => {
  async function createFile(h: ReturnType<typeof createHarness>, at: Date, body: string) {
    const file = addEntry(h, at, body);
    h.app.vault.trigger("create", file);
    vi.advanceTimersByTime(300);
    await settle();
    return file;
  }

  function headerTexts(h: ReturnType<typeof createHarness>): string[] {
    return Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-month-header"),
    ).map((el) => el.textContent ?? "");
  }

  it("an insert that opens a new month above existing ones adds exactly one header for it, and keeps the rest deduped and in order", async () => {
    const h = createHarness();
    const aug12 = new Date(2026, 7, 12, 9, 0, 0);
    const aug10 = new Date(2026, 7, 10, 9, 0, 0);
    const jul30 = new Date(2026, 6, 30, 9, 0, 0);
    addEntry(h, aug12, "aug12");
    addEntry(h, aug10, "aug10");
    addEntry(h, jul30, "jul30");
    h.service.load();
    await h.view.onOpen();

    expect(headerTexts(h)).toEqual([formatMonthHeader(aug12), formatMonthHeader(jul30)]);

    // Newest overall AND a new month: this insert goes through
    // `ensureDayGroup`'s "prepend" branch (a brand-new day, correctly the
    // newest loaded), which calls `rebuildMonthHeaders` — the path this
    // gap is about, as opposed to the initial load's "append" branch.
    const sep1 = new Date(2026, 8, 1, 9, 0, 0);
    await createFile(h, sep1, "sep1, newest and a new month");

    expect(headerTexts(h)).toEqual([
      formatMonthHeader(sep1),
      formatMonthHeader(aug12),
      formatMonthHeader(jul30),
    ]);
  });

  it("deleting the last entry of a month removes that month's header", async () => {
    const h = createHarness();
    const aug12 = new Date(2026, 7, 12, 9, 0, 0);
    const jul30 = new Date(2026, 6, 30, 9, 0, 0);
    const onlyJulyEntry = addEntry(h, jul30, "jul30");
    addEntry(h, aug12, "aug12");
    h.service.load();
    await h.view.onOpen();

    expect(headerTexts(h)).toEqual([formatMonthHeader(aug12), formatMonthHeader(jul30)]);

    h.app.vault.trigger("delete", onlyJulyEntry);
    vi.advanceTimersByTime(300);
    await settle();

    expect(headerTexts(h)).toEqual([formatMonthHeader(aug12)]);
    expect(internals(h.view).dayGroups.has(dayKey(jul30))).toBe(false);
  });

  it("a month holding several days still has exactly one header after a delete elsewhere in the timeline", async () => {
    const h = createHarness();
    const aug12 = new Date(2026, 7, 12, 9, 0, 0);
    const aug10 = new Date(2026, 7, 10, 9, 0, 0);
    const aug5 = new Date(2026, 7, 5, 9, 0, 0);
    const doomed = addEntry(h, aug5, "gone soon");
    addEntry(h, aug12, "aug12");
    addEntry(h, aug10, "aug10");
    h.service.load();
    await h.view.onOpen();

    expect(headerTexts(h)).toEqual([formatMonthHeader(aug12)]);

    // Deleting one day out of three, all in the same month, must not turn
    // the single shared header into one-per-remaining-day.
    h.app.vault.trigger("delete", doomed);
    vi.advanceTimersByTime(300);
    await settle();

    expect(headerTexts(h)).toEqual([formatMonthHeader(aug12)]);
    const days = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-day"),
    ).map((el) => el.dataset.day);
    expect(days).toEqual(["2026-08-12", "2026-08-10"]);
  });
});
