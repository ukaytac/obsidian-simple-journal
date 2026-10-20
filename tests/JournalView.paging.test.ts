// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle, timelineEl } from "./journalViewHarness";
import type { FakeIntersectionObserver } from "./obsidian-mock";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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

  it("does not re-ask the sentinel until the new page's bodies have rendered", async () => {
    const h = createHarness();
    seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 100);
    h.service.load();
    await h.view.onOpen();
    await settle();

    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });
    const observer = internals(h.view).observer as FakeIntersectionObserver;
    const reobserve = vi.spyOn(observer, "observe");

    observer.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();
    expect(internals(h.view).rendered.size).toBe(80);
    expect(reobserve).not.toHaveBeenCalled();

    gate.release();
    await settle();
    expect(reobserve).toHaveBeenCalledTimes(1);
  });

  describe("a new burst needs a real scroll", () => {
    /** Gives the scroll container a size, so it overflows like a real one. */
    function overflowing(view: ReturnType<typeof createHarness>["view"], scrollTop = 0): HTMLElement {
      const el = internals(view).contentEl as HTMLElement;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
      Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: scrollTop });
      return el;
    }

    async function openWithTwoPages() {
      const h = createHarness();
      seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 200);
      h.service.load();
      await h.view.onOpen();
      await settle();
      const contentEl = overflowing(h.view);
      const observer = internals(h.view).observer as FakeIntersectionObserver;
      const sentinelEl = internals(h.view).sentinelEl as HTMLElement;
      // The first callback after a reload is always allowed.
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();
      // The forced re-observe found it out of range: the burst ends.
      observer.trigger([{ target: sentinelEl, isIntersecting: false }]);
      await settle();
      expect(internals(h.view).rendered.size).toBe(80);
      return { h, contentEl, observer, sentinelEl };
    }

    it("ignores a re-entry nobody scrolled for", async () => {
      const { h, observer, sentinelEl } = await openWithTwoPages();

      // Heights changed and carried the sentinel back into range.
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });

    it("loads on the next scroll once one happens", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      contentEl.scrollTop = 400;
      contentEl.dispatchEvent(new Event("scroll"));
      await settle();

      expect(internals(h.view).rendered.size).toBe(120);
    });

    it("a scroll after the sentinel left again loads nothing", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();
      observer.trigger([{ target: sentinelEl, isIntersecting: false }]);
      await settle();

      contentEl.scrollTop = 400;
      contentEl.dispatchEvent(new Event("scroll"));
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });

    it("loads without a scroll when the content does not fill the pane", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      Object.defineProperty(contentEl, "scrollHeight", { configurable: true, value: 600 });

      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(120);
    });

    it("a reload allows the first callback again", async () => {
      const { h } = await openWithTwoPages();
      await h.view.reload();
      await settle();
      overflowing(h.view);
      const observer = internals(h.view).observer as FakeIntersectionObserver;

      observer.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });
  });
});
