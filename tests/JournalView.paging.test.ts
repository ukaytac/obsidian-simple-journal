// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle, timelineEl } from "./journalViewHarness";
import type { FakeIntersectionObserver } from "./obsidian-mock";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Entries an hour apart, newest at `newest`, oldest `count - 1` hours before it. */
function seedHourly(h: ReturnType<typeof createHarness>, newest: Date, count: number): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(newest.getTime() - i * 60 * 60 * 1000);
    dates.push(at);
    addEntry(h, at, `entry ${i}`);
  }
  return dates;
}

function entryTimes(view: ReturnType<typeof createHarness>["view"]): string[] {
  return Array.from(
    internals(view).timelineEl.querySelectorAll(".journal-entry-time"),
  ).map((el) => (el as HTMLElement).textContent ?? "");
}

describe("JournalView paging", () => {
  it("renders exactly the first page (40 entries) on open, oldest of the page as the cursor", async () => {
    const h = createHarness();
    const dates = seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 45);
    h.service.load();

    await h.view.onOpen();

    expect(internals(h.view).rendered.size).toBe(40);
    expect(entryTimes(h.view)).toHaveLength(40);
    // The 40th-newest entry (index 39) is the oldest one loaded, and becomes
    // the paging cursor `nextPage` resumes from.
    expect(internals(h.view).lastLoadedPath).toBe(
      internals(h.view).index[39].file.path,
    );
  });

  it("the sentinel appends the next page below, and the cursor advances", async () => {
    const h = createHarness();
    seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 45);
    h.service.load();

    await h.view.onOpen();
    expect(internals(h.view).rendered.size).toBe(40);
    const firstPageOldestPath = internals(h.view).lastLoadedPath;

    const sentinel = internals(h.view).observer as FakeIntersectionObserver;
    const sentinelEl = internals(h.view).sentinelEl as HTMLElement;
    expect(sentinel).toBeTruthy();

    sentinel.trigger([{ target: sentinelEl, isIntersecting: true }]);
    await settle();

    // All 45 are now loaded — the remaining 5 were appended BELOW the first
    // 40, not re-rendering (or reordering) anything already on screen.
    expect(internals(h.view).rendered.size).toBe(45);
    expect(entryTimes(h.view)).toHaveLength(45);
    expect(internals(h.view).lastLoadedPath).not.toBe(firstPageOldestPath);

    // Every path in the DOM appears in the same order as `this.index`
    // (newest -> oldest); the appended page must not have landed above the
    // first page or out of order.
    const domPaths = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry"),
    ).map((el) => el.dataset.path);
    const indexPaths = (internals(h.view).index as Array<{ file: { path: string } }>).map(
      (e) => e.file.path,
    );
    expect(domPaths).toEqual(indexPaths);
  });

  it("a lost paging cursor re-anchors on the furthest still-rendered entry instead of restarting", async () => {
    const h = createHarness();
    seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 45);
    h.service.load();

    await h.view.onOpen();
    expect(internals(h.view).rendered.size).toBe(40);

    const cursorPath = internals(h.view).lastLoadedPath as string;
    const cursorFile = h.app.vault.files.get(cursorPath);
    expect(cursorFile).toBeTruthy();

    // The cursor entry is deleted externally while scrolled down — exactly
    // the scenario `nextPage`'s doc describes: `pageAfter` can no longer
    // find it in the index.
    h.app.vault.trigger("delete", cursorFile);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).rendered.has(cursorPath)).toBe(false);
    expect(internals(h.view).rendered.size).toBe(39);

    const sentinel = internals(h.view).observer;
    const sentinelEl = internals(h.view).sentinelEl as HTMLElement;
    sentinel.trigger([{ target: sentinelEl, isIntersecting: true }]);
    await settle();

    // All remaining entries (44 = 45 - 1 deleted) are now rendered exactly
    // once each — a restart from page one would have re-appended the first
    // 39 a second time; a correct re-anchor does not.
    expect(internals(h.view).rendered.size).toBe(44);
    const domPaths = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry"),
    ).map((el) => el.dataset.path);
    expect(new Set(domPaths).size).toBe(44);
    expect(domPaths).not.toContain(cursorPath);
  });
});
