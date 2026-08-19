// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey, formatCreatedProperty, formatTime } from "../src/utils/dates";
import { addEntry, createHarness, internals, settle, timelineEl } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/**
 * These tests all drive the SAME machinery a real external edit (Properties
 * pane, another Obsidian window, a sync conflict resolution) goes through:
 * a real vault/metadata-cache event, `JournalService`'s real 300ms-debounced
 * batching, and `JournalView.applyChangesNow`'s real reconciliation — none
 * of it re-implemented or bypassed here.
 */
describe("JournalView external-change reconciliation", () => {
  /**
   * `applyChangesNow`'s "removed" handling for a rename (`change.kind ===
   * "removed"` with `fileStillExists === true`) removes the stale rendering
   * at the old path and relies on this same batch's paired upsert for the
   * new path to reinsert it, for a CLEAN entry (a dirty one re-keys instead;
   * see that branch's own doc).
   *
   * For a rename that leaves `created` unchanged (the case this test
   * exercises — same effective timestamp, just a different filename),
   * `JournalService.applyUpsert` takes its "content" branch. `decideChangeAction`
   * correctly routes a "content" change with nothing currently rendered to
   * `{ type: "insert" }`, which calls `insertEntryInPlace(change.entry)` —
   * and `insertEntryInPlace` locates the entry via `this.index.indexOf(entry)`,
   * a reference-identity lookup. This only works if `applyUpsert`'s "content"
   * branch hands back the exact object already living in `this.index` —
   * fixed in `JournalService.applyUpsert` to return `existing` rather than a
   * freshly re-parsed `entry`, restoring the same "returned entry IS the
   * index's object" invariant the "added"/"moved" branches already keep by
   * construction.
   *
   * Net effect pinned here: renaming a rendered, unedited entry from outside
   * the view (Explorer, another tool, a sync client) — without also changing
   * its effective timestamp — must not drop its row from the timeline; it
   * ends up re-rendered fresh at the new path (not re-keyed in the DOM
   * sense, but never dropped, and never duplicated).
   */
  it("a renamed entry is re-keyed in place, never duplicated", async () => {
    const h = createHarness();
    const at = new Date(2026, 7, 12, 9, 0, 0);
    const file = addEntry(h, at, "hello");
    // A second, unrelated entry keeps the loaded window non-empty across
    // the rename's remove+reinsert — with only one entry total, removing it
    // (even for one instant, mid-batch) would make `insertEntryInPlace`'s
    // own "is this inside the loaded window" check see an empty window and
    // correctly defer to paging instead, which is a real but unrelated
    // edge case this test does not intend to exercise.
    addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "unrelated, stays put");
    h.service.load();
    await h.view.onOpen();

    const oldPath = file.path;
    expect(internals(h.view).rendered.has(oldPath)).toBe(true);
    expect(internals(h.view).rendered.size).toBe(2);

    // Same timestamp, same folder, just a different (still convention-
    // shaped, so `created` still resolves identically) filename — isolates
    // "this is a rename" from "this is also a timestamp change".
    const newPath = oldPath.replace(/\.md$/, "-2.md");
    await h.app.fileManager.renameFile(file, newPath);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).rendered.has(oldPath)).toBe(false);
    expect(internals(h.view).rendered.has(newPath)).toBe(true);
    expect(internals(h.view).rendered.size).toBe(2);

    const rows = timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry");
    expect(rows).toHaveLength(2);
    expect(Array.from(rows).map((el) => el.dataset.path)).toContain(newPath);
    expect(Array.from(rows).map((el) => el.dataset.path)).not.toContain(oldPath);
  });

  it("a deleted entry's row is removed, and its day group along with it if it was the only entry", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "hello");
    h.service.load();
    await h.view.onOpen();

    expect(internals(h.view).dayGroups.size).toBe(1);

    h.app.vault.trigger("delete", file);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).rendered.size).toBe(0);
    expect(internals(h.view).dayGroups.size).toBe(0);
    expect(internals(h.view).timelineEl.querySelectorAll(".journal-entry")).toHaveLength(0);
    expect(internals(h.view).timelineEl.querySelectorAll(".journal-day")).toHaveLength(0);
  });

  it("deleting one entry out of several on a day leaves the day's other entries untouched", async () => {
    const h = createHarness();
    const doomed = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "gone soon");
    const survivor = addEntry(h, new Date(2026, 7, 12, 14, 0, 0), "stays");
    h.service.load();
    await h.view.onOpen();

    h.app.vault.trigger("delete", doomed);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).rendered.has(doomed.path)).toBe(false);
    expect(internals(h.view).rendered.has(survivor.path)).toBe(true);
    expect(internals(h.view).dayGroups.size).toBe(1);
    expect(internals(h.view).timelineEl.querySelectorAll(".journal-entry")).toHaveLength(1);
  });

  it("an entry whose created timestamp changed externally moves to its new correct position", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "oldest");
    const middle = addEntry(h, new Date(2026, 7, 11, 9, 0, 0), "middle");
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "newest");
    h.service.load();
    await h.view.onOpen();

    expect(internals(h.view).rendered.size).toBe(3);

    // Corrected from another pane to a time after everything currently
    // loaded — must move from the middle to the top, not stay sandwiched.
    const correctedAt = new Date(2026, 7, 13, 9, 0, 0);
    h.app.metadataCache.frontmatter.set(middle.path, { created: formatCreatedProperty(correctedAt) });
    h.app.vault.trigger("modify", middle);
    vi.advanceTimersByTime(300);
    await settle();

    const domPaths = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry"),
    ).map((el) => el.dataset.path);

    expect(domPaths).toHaveLength(3);
    expect(domPaths[0]).toBe(middle.path);
    expect(internals(h.view).dayGroups.has(dayKey(correctedAt))).toBe(true);
  });

  it("a rename that also changes the resolved created time moves the row, without duplicating it", async () => {
    // Composes the rename fix above with the pre-existing "moved" handling:
    // renaming AND changing `created` in the same external edit takes
    // `JournalService.applyUpsert`'s "moved" branch (not "content"), which
    // already spliced the fresh entry into the index itself — this pins
    // that the "content" branch's identity fix didn't regress this
    // sibling branch's own (already-correct) behaviour.
    const h = createHarness();
    const at = new Date(2026, 7, 12, 9, 0, 0);
    const file = addEntry(h, at, "hello");
    addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "unrelated, stays put");
    h.service.load();
    await h.view.onOpen();

    const oldPath = file.path;
    expect(internals(h.view).rendered.size).toBe(2);

    // Same folder, different filename, AND (via an explicit `created`
    // registered at the new path before the rename flushes) a different
    // resolved timestamp — newer than everything currently loaded, so the
    // renamed entry sorts to the top rather than past the edge of the
    // (deliberately tiny) loaded window, which would exercise paging
    // instead of the rename/identity path this test targets.
    const dir = oldPath.slice(0, oldPath.lastIndexOf("/"));
    const newPath = `${dir}/renamed-entry.md`;
    const correctedAt = new Date(2026, 7, 13, 9, 0, 0);
    h.app.metadataCache.frontmatter.set(newPath, { created: formatCreatedProperty(correctedAt) });
    await h.app.fileManager.renameFile(file, newPath);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).rendered.has(oldPath)).toBe(false);
    expect(internals(h.view).rendered.has(newPath)).toBe(true);
    expect(internals(h.view).rendered.size).toBe(2);

    const rows = timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry");
    expect(rows).toHaveLength(2);
    const domPaths = Array.from(rows).map((el) => el.dataset.path);
    expect(domPaths).toContain(newPath);
    expect(domPaths).not.toContain(oldPath);
  });

  it("a same-day timestamp correction updates the row in place instead of tearing it down and re-inserting it", async () => {
    const h = createHarness();
    const at = new Date(2026, 7, 12, 9, 0, 0);
    const file = addEntry(h, at, "hello");
    h.service.load();
    await h.view.onOpen();

    const before = internals(h.view).rendered.get(file.path);
    const elBefore = before.el as HTMLElement;

    const correctedAt = new Date(2026, 7, 12, 9, 5, 0);
    h.app.metadataCache.frontmatter.set(file.path, { created: formatCreatedProperty(correctedAt) });
    h.app.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);
    await settle();

    const after = internals(h.view).rendered.get(file.path);
    // Same DOM node, same RenderedEntry — this is `repositionIsNoOp`'s fast
    // path, which exists precisely to preserve focus/caret/undo-history
    // across a correction that does not actually reorder anything on screen.
    expect(after.el).toBe(elBefore);
    expect(after.el.querySelector(".journal-entry-time")?.textContent).toBe(formatTime(correctedAt));
  });
});
