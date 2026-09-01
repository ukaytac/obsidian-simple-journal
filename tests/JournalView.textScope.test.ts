// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, tagEntry, timelineEl } from "./journalViewHarness";
import type { Harness } from "./journalViewHarness";

function renderedPaths(h: Harness): string[] {
  return Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry")).map(
    (el) => el.dataset.path ?? "",
  );
}

function scopeBar(h: Harness): HTMLElement {
  return internals(h.view).scopeBarEl as HTMLElement;
}

/**
 * A text scope as `main.ts` builds one: the paths are already resolved, which
 * is the whole point — the view never reads a file to decide what to render.
 */
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
   * The same crossing shape `JournalView.tagScope.test.ts` uses, for the same
   * reason: the match axis and the date axis have to cross, or the
   * composition test below passes just as well with the scope removed.
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

    expect(scopeBar(h).querySelector(".journal-scope-query")?.textContent).toBe("“kahve”");
    expect(scopeBar(h).querySelector(".journal-scope-tag")).toBeNull();
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
    h.service.rebuild();
    await h.view.setTagScope("therapy");
    expect(renderedPaths(h)).toEqual([oldMiss.path]);

    await textScope(h, "kahve", [match.path, older.path]);

    expect(renderedPaths(h)).toEqual([match.path, older.path]);
    expect(h.view.activeTagScope()).toBeNull();
  });

  it("is replaced by a tag scope in the other direction too", async () => {
    const { match, older, oldMiss } = await openWithBodies();
    tagEntry(h, oldMiss, ["therapy"]);
    h.service.rebuild();
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

  it("clears on Escape outside an entry, exactly as a tag scope does", async () => {
    const { match, older } = await openWithBodies();
    await textScope(h, "kahve", [match.path, older.path]);

    scopeBar(h).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await vi.waitFor(() => expect(h.view.activeScope()).toBeNull());
  });
});
