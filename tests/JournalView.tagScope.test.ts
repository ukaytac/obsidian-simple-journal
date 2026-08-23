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
});
