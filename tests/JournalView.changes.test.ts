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
   * FAILS against the current implementation — a genuine bug found while
   * writing this suite, not a pre-existing known one.
   *
   * `applyChangesNow`'s "removed" handling for a rename (`change.kind ===
   * "removed"` with `fileStillExists === true`) removes the stale rendering
   * at the old path and relies on this same batch's paired upsert for the
   * new path to reinsert it (see the "removed" branch's own doc: "a rename
   * always pairs this 'removed' with a same-batch upsert ... If this
   * rendering is left keyed at the old path, that paired upsert finds
   * nothing at the new path and inserts a SECOND, independent rendering").
   * That reasoning is right for a DIRTY entry (which re-keys instead of
   * removing), but for a CLEAN one — the common case — the row is removed
   * outright and nothing re-keys it; the paired upsert is expected to
   * reinsert it fresh instead.
   *
   * For a rename that leaves `created` unchanged (the case this test
   * exercises — same effective timestamp, just a different filename),
   * `JournalService.applyUpsert` takes its "content" branch, which returns
   * `{ kind: "content", entry }` WITHOUT ever splicing that `entry` object
   * into `this.index` (only the "added"/"moved" branches call
   * `insertSorted`). `decideChangeAction` correctly routes a "content"
   * change with nothing currently rendered to `{ type: "insert" }` (its own
   * doc says this is "reachable after a same-timestamp rename"), which
   * calls `insertEntryInPlace(change.entry)` — but `insertEntryInPlace`
   * locates the entry via `this.index.indexOf(entry)`, a reference-identity
   * lookup. Since `entry` here is a freshly-constructed object that is
   * never the same object as whatever the index already holds at that path,
   * `indexOf` returns -1 and `insertEntryInPlace` silently returns without
   * inserting anything.
   *
   * Net effect: renaming a rendered, unedited entry from outside the view
   * (Explorer, another tool, a sync client) — without also changing its
   * effective timestamp — makes its row vanish from the timeline entirely
   * until the next full `reload()`. The file itself is untouched and still
   * correctly present in `this.index`; only the DOM/`this.rendered` lose
   * track of it. This is the "re-keyed rather than duplicated" invariant
   * this test pins — it should end up re-rendered (or, better, re-keyed)
   * at the new path, not dropped.
   */
  it.fails("a renamed entry is re-keyed in place, never duplicated", async () => {
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
