// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile as FakeTFile, type FakeIntersectionObserver } from "./obsidian-mock";
import { dayKey, formatCreatedProperty, formatMonthHeader, formatTime } from "../src/utils/dates";
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

/**
 * Gaps surfaced by a deliberate mutation scan of `applyChangesNow`/
 * `reKeyRenderedEntry`/`removeRenderedEntry`/`repositionIsNoOp`/
 * `renderedStateFor` before this seam was extracted into its own module.
 * Each test below was verified to go red against the specific mutation named
 * in its comment (and, in each case, at least one further mutation of the
 * same invariant) before being written; the suite above, plus
 * `tests/applyChange.test.ts`'s coverage of the pure decision table, already
 * passed against every one of them.
 */
describe("JournalView change-application: pinned edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /**
   * Mutation: delete the `if (this.rendered.has(newPath)) return false;`
   * guard in `reKeyRenderedEntry`. The suite stayed fully green with that
   * line gone — this test is what makes it red again.
   *
   * Scenario (see `reKeyRenderedEntry`'s own doc): a dirty entry (A) gets
   * renamed onto a path a DIFFERENT, currently-rendered entry (B) occupies —
   * reachable when B was deleted at the vault level within the same
   * debounce window, freeing the path, before A's rename lands. Modeled
   * directly (removing B from the fake vault's own file map, then renaming A
   * into the freed path, then calling `applyChangesNow` with only A's
   * "removed" half) so the exact narrow window is exercised deterministically
   * rather than left to the service's real batching order.
   */
  it("declines to re-key a dirty rename onto an already-rendered path, rather than silently overwriting the occupant", async () => {
    const h = createHarness();
    const fileA = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "A original");
    const fileB = addEntry(h, new Date(2026, 7, 12, 10, 0, 0), "B original");
    h.service.load();
    await h.view.onOpen();

    const view = internals(h.view);
    const renderedA = view.rendered.get(fileA.path);
    const renderedB = view.rendered.get(fileB.path);
    const oldPathA = fileA.path;

    // Mount and dirty A's editor.
    const mountObserver = view.mountObserver as FakeIntersectionObserver;
    mountObserver.trigger([{ target: renderedA.el, isIntersecting: true }]);
    await settle();
    const textarea = renderedA.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "A edited, not yet saved";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
    expect(renderedA.editor.getValue()).toBe("A edited, not yet saved");

    // B is deleted at the vault level (the view has not processed that
    // removal yet — its row is still in `view.rendered`), freeing its path...
    h.app.vault.files.delete(fileB.path);
    h.app.vault.contents.delete(fileB.path);
    // ...and A is renamed into it.
    await h.app.fileManager.renameFile(fileA, fileB.path);

    // A's flush must fail, or a successful flush would clear `isDirty` before
    // the re-key branch is ever reached (see `applyChangesNow`'s own "removed"
    // handling) — this models the write still failing at the moment the
    // rename's "removed" change for A's stale old path is processed.
    h.app.vault.process = async () => {
      throw new Error("disk write failing");
    };

    await view.applyChangesNow([{ kind: "removed", path: oldPathA }]);

    // B's rendering must be exactly what it always was — never silently
    // replaced by A's.
    expect(view.rendered.get(fileB.path)).toBe(renderedB);
    expect(view.rendered.has(oldPathA)).toBe(false);
  });

  /**
   * Mutation: drop either sibling check in `repositionIsNoOp` (both the
   * `prevEntry`/`nextEntry` comparisons, and — as a second, self-devised
   * mutation — just the `nextEntry` one alone). Both left the suite green:
   * every existing "same-day correction" test only ever has ONE entry on the
   * day in question, so the sibling comparisons never actually run.
   *
   * `repositionIsNoOp` reporting a false no-op is the worst outcome CLAUDE.md
   * calls out for this seam: the row gets a corrected label but stays in the
   * wrong place — silent mis-ordering, not a visible failure.
   */
  it("a same-day correction that crosses a rendered sibling actually reorders the row, not merely relabels it", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "earliest");
    const target = addEntry(h, new Date(2026, 7, 12, 10, 0, 0), "moving later");
    const laterSibling = addEntry(h, new Date(2026, 7, 12, 11, 0, 0), "already later");
    h.service.load();
    await h.view.onOpen();

    // Corrected past `laterSibling`, but still on the same calendar day —
    // exactly the case `repositionIsNoOp`'s day-key check alone cannot catch.
    const correctedAt = new Date(2026, 7, 12, 11, 30, 0);
    h.app.metadataCache.frontmatter.set(target.path, { created: formatCreatedProperty(correctedAt) });
    h.app.vault.trigger("modify", target);
    vi.advanceTimersByTime(300);
    await settle();

    const domPaths = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry"),
    ).map((el) => el.dataset.path);

    // Reverse-chronological: the corrected entry is now the newest of the
    // three and must lead; `laterSibling` — now older than the correction —
    // must have moved to second. A wrongly-declared no-op would leave
    // `target` sitting in its OLD slot (between `laterSibling` and the
    // earliest entry) with only its label corrected.
    expect(domPaths).toEqual([target.path, laterSibling.path, expect.stringContaining("09-00-00")]);
    expect(
      timelineEl(h.view).querySelector<HTMLElement>(`[data-path="${target.path}"] .journal-entry-time`)
        ?.textContent,
    ).toBe(formatTime(correctedAt));
  });

  /**
   * The mirror image of the test above, needed because `repositionIsNoOp`
   * has two independent sibling checks (`prevEntry`/`nextEntry`) and the test
   * above only happens to exercise the `prevEntry` one — removing only the
   * `nextEntry` check on its own left that test (and the rest of the suite)
   * green. This one crosses the OLDER neighbour instead of the newer one, so
   * only the `nextEntry` check can catch it.
   */
  it("a same-day correction moving earlier that crosses its older rendered sibling also reorders the row", async () => {
    const h = createHarness();
    // An older, untouched entry on a separate day pads the loaded window so
    // the correction below — which briefly drops the rendered count to 3
    // while `applyChangesNow` removes-then-reinserts it — doesn't land
    // exactly on `insertEntryInPlace`'s "not yet loaded" boundary, a real but
    // unrelated edge case (see `insertEntryInPlace`'s own doc) this test does
    // not intend to exercise.
    addEntry(h, new Date(2026, 7, 11, 9, 0, 0), "unrelated, stays put");
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "oldest");
    const target = addEntry(h, new Date(2026, 7, 12, 10, 0, 0), "moving earlier");
    addEntry(h, new Date(2026, 7, 12, 11, 0, 0), "newest");
    h.service.load();
    await h.view.onOpen();

    // Corrected past the 09:00 entry, but still the same calendar day —
    // the `prevEntry` check (against the 11:00 entry) stays satisfied
    // throughout; only `nextEntry` (against the 09:00 entry) can detect this.
    const correctedAt = new Date(2026, 7, 12, 8, 30, 0);
    h.app.metadataCache.frontmatter.set(target.path, { created: formatCreatedProperty(correctedAt) });
    h.app.vault.trigger("modify", target);
    vi.advanceTimersByTime(300);
    await settle();

    const domPaths = Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry"),
    ).map((el) => el.dataset.path);

    // Reverse-chronological: the corrected entry is now older than the
    // 09:00 entry on the same day, so it must trail that entry (and still
    // lead the unrelated, older day) — not stay sandwiched between 11:00 and
    // 09:00.
    expect(domPaths).toEqual([
      expect.stringContaining("2026-08-12-11-00-00"),
      expect.stringContaining("2026-08-12-09-00-00"),
      target.path,
      expect.stringContaining("2026-08-11-09-00-00"),
    ]);
  });

  /**
   * Mutation: in `applyChangesNow`'s "reposition" branch, remove the entry
   * without recording `dayGroupsDirty` (e.g. `this.removeRenderedEntry(path)`
   * without the `if (...) dayGroupsDirty = true`). The suite stayed green —
   * every existing reposition test either stays within one day/month, or
   * (the "moves to its new correct position" test) crosses a day boundary
   * but never actually empties a day/month it leaves behind.
   *
   * Without `removeEmptyDayGroups`/`rebuildMonthHeaders` running at the end of
   * the batch, an emptied month's header and now-empty day group are left
   * behind in the DOM indefinitely.
   */
  it("a correction crossing a month boundary removes the emptied month's day group and header", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 5, 15, 9, 0, 0), "june stays put");
    const moving = addEntry(h, new Date(2026, 6, 31, 9, 0, 0), "the only entry in july");
    h.service.load();
    await h.view.onOpen();

    expect(
      Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-month-header")).map(
        (el) => el.textContent,
      ),
    ).toEqual([formatMonthHeader(new Date(2026, 6, 1)), formatMonthHeader(new Date(2026, 5, 1))]);

    const correctedAt = new Date(2026, 7, 1, 9, 0, 0); // August 1st — a new month, and empties July entirely.
    h.app.metadataCache.frontmatter.set(moving.path, { created: formatCreatedProperty(correctedAt) });
    h.app.vault.trigger("modify", moving);
    vi.advanceTimersByTime(300);
    await settle();

    expect(internals(h.view).dayGroups.has(dayKey(new Date(2026, 6, 31)))).toBe(false);
    expect(internals(h.view).dayGroups.has(dayKey(correctedAt))).toBe(true);
    expect(
      Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-month-header")).map(
        (el) => el.textContent,
      ),
    ).toEqual([formatMonthHeader(correctedAt), formatMonthHeader(new Date(2026, 5, 1))]);
  });

  /**
   * Mutation: in `renderedStateFor`, compare `fileStillExists` by mere path
   * resolution (`!== null`) instead of by object identity (`===
   * rendered.entry.file`). The suite stayed green — no existing test ever
   * installs a genuinely different `TFile` object at a rendering's own path.
   *
   * Without the identity check, a delete-then-recreate at the same path
   * within one debounce window reads as "the file still exists," which would
   * flush a stale editor's held text through `writeBody` — landing on
   * whatever now-unrelated file the vault's `process` resolves by path,
   * clobbering it with content it never had.
   */
  it("a delete-then-recreate at the same path is not mistaken for the same file, so a stale dirty edit is dropped rather than written into the replacement", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original");
    h.service.load();
    await h.view.onOpen();

    const view = internals(h.view);
    const rendered = view.rendered.get(file.path);

    expect(view.renderedStateFor(rendered).fileStillExists).toBe(true);

    // Mount and dirty its editor.
    const mountObserver = view.mountObserver as FakeIntersectionObserver;
    mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    const textarea = rendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "stale, unsaved edit";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));

    // A genuinely different TFile object now resolves at the exact same
    // path — the delete-then-recreate this test's name describes.
    h.app.vault.files.set(file.path, new FakeTFile(file.path, 0));
    expect(view.renderedStateFor(rendered).fileStillExists).toBe(false);

    const writeSpy = vi.spyOn(h.app.vault, "process");
    await view.applyChangesNow([{ kind: "removed", path: file.path }]);

    // The stale edit must never reach the replacement file...
    expect(writeSpy).not.toHaveBeenCalled();
    // ...and the stale rendering is simply gone, not left dangling.
    expect(view.rendered.has(file.path)).toBe(false);
  });

  /**
   * Mutation: in `renderedStateFor`, hardcode `focused: false, dirty: false`
   * instead of reading the live editor. The suite stayed green —
   * `tests/applyChange.test.ts` only pins `decideChangeAction`'s pure
   * decision given a `focused`/`dirty` input; nothing exercises whether
   * `renderedStateFor` actually computes those from a real, live, focused,
   * unsaved editor before an external "content" change arrives.
   *
   * This is CLAUDE.md's loop/clobber-suppression invariant, exercised at the
   * wiring level rather than the pure-function level `applyChange.test.ts`
   * already covers.
   */
  it("an external content change never overwrites a focused, unsaved editor", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const view = internals(h.view);
    const rendered = view.rendered.get(file.path);

    const mountObserver = view.mountObserver as FakeIntersectionObserver;
    mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();

    const textarea = rendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    textarea.value = "the user's own in-progress sentence";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
    expect(rendered.editor.hasFocus()).toBe(true);

    // A genuine external edit to the same file's body — via the fake vault
    // directly, mirroring another Obsidian pane saving over the same file —
    // with `created` left untouched, so `JournalService.applyUpsert` takes
    // its "content" branch rather than "moved".
    h.app.vault.contents.set(
      file.path,
      `---\ncreated: "${formatCreatedProperty(new Date(2026, 7, 12, 9, 0, 0))}"\n---\n\nexternal change from another pane`,
    );
    h.app.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);
    await settle();

    // The user's own unsaved text must survive untouched.
    expect(rendered.editor.getValue()).toBe("the user's own in-progress sentence");
  });

  /**
   * Mutation: in `handleDeleteFallback`, drop the "does the file still
   * resolve" check and unconditionally call `removeRenderedEntry`. The suite
   * stayed green — no existing test exercises `confirmDelete`/
   * `handleDeleteFallback` at all.
   *
   * `promptForDeletion` resolving `true` means the user confirmed, not that
   * the trash itself actually succeeded (disabled system trash, permissions,
   * ...). If the file is still there, removing the row would make the
   * timeline silently misrepresent the vault.
   */
  it("restores a row instead of removing it when a confirmed deletion's file actually survived", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "hello");
    h.service.load();
    await h.view.onOpen();

    const view = internals(h.view);
    const rendered = view.rendered.get(file.path);

    // Fake vault has no `promptForDeletion` of its own; the user confirming
    // the (unthemed, native) dialog is exactly this call resolving `true`.
    (h.app.fileManager as unknown as { promptForDeletion: () => Promise<boolean> }).promptForDeletion =
      async () => true;

    await view.confirmDelete(rendered);
    expect(rendered.el.classList.contains("is-deleting")).toBe(true);

    // The trash itself did not actually happen — the file is still there —
    // simulated simply by never having removed it from the fake vault.
    // `DELETE_FALLBACK_MS` (2000ms; see `JournalView.ts`) is how long
    // `confirmDelete` waits for the vault's own "delete" event before this
    // fallback runs.
    vi.advanceTimersByTime(2000);
    await settle();

    expect(rendered.el.classList.contains("is-deleting")).toBe(false);
    expect(view.rendered.has(file.path)).toBe(true);
    expect(view.rendered.get(file.path)).toBe(rendered);
  });
});

/**
 * Regression suite for `commitEntryTimeChange`'s "Change entry time"
 * fallback. Every test here drives the exact same private method the
 * timestamp button's modal calls after the user confirms a new value —
 * `internals(view).commitEntryTimeChange(rendered, file, newDate)` — so the
 * full real sequence (`EntryRepository.setEntryCreated`'s write,
 * `JournalService.applyKnownEntry`'s immediate reposition,
 * `JournalView.applyChangesNow`'s real DOM reconciliation, and the rename)
 * runs exactly as it would from the modal, never touching `timelineDom.ts`
 * directly.
 *
 * The bug this suite pins: `insertEntryInPlace`'s loaded-window bounds check
 * (`position - offset >= loadedCount && hasSentinel()`) declines whenever a
 * correction pushes the entry to (or past) the edge of what happens to be
 * rendered at that instant — and the paging sentinel stays mounted after
 * every ordinary load until the user has scrolled to genuine exhaustion
 * (`reloadNow` always calls `installSentinel()`, regardless of whether
 * anything is actually left to page). So the decline fires far more often
 * than "this really is deep, unloaded history" — including for a journal
 * that holds only a handful of entries, never scrolled at all. Before the
 * fix, `commitEntryTimeChange` treated every such decline as deep history
 * and jumped straight to an ANCHORED `goToDate(value)`, which hides every
 * entry newer than the corrected date (see `goToDate`'s own doc) — so
 * moving an entry back a month didn't just reorder the timeline, it made
 * every newer entry vanish from the view entirely, with the moved entry
 * left looking like the only (and therefore topmost) thing in the journal.
 * `setEntryCreated` requires a metadata-cache entry with a "created" key
 * already present for `file.path` (see its own doc's frontmatter
 * cross-check) — seeded with a placeholder value here, since only its
 * presence, not its content, is what that check requires.
 */
describe("JournalView commitEntryTimeChange: cross-month reordering, not an anchor jump", () => {
  function dayEls(h: ReturnType<typeof createHarness>): (string | undefined)[] {
    return Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-day")).map(
      (el) => el.dataset.day,
    );
  }

  function headerTexts(h: ReturnType<typeof createHarness>): string[] {
    return Array.from(
      timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-month-header"),
    ).map((el) => el.textContent ?? "");
  }

  async function changeTime(
    h: ReturnType<typeof createHarness>,
    file: ReturnType<typeof addEntry>,
    to: Date,
  ): Promise<void> {
    h.app.metadataCache.frontmatter.set(file.path, { created: "placeholder" });
    const rendered = internals(h.view).rendered.get(file.path);
    await internals(h.view).commitEntryTimeChange(rendered, file, to);
    await settle();
  }

  it("moving the only other-day entry to an earlier month sinks it below the newer day, not above it", async () => {
    const h = createHarness();
    const aug10 = addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "aug10");
    const aug5 = addEntry(h, new Date(2026, 7, 5, 9, 0, 0), "aug5, will move to july");
    h.service.load();
    await h.view.onOpen();

    await changeTime(h, aug5, new Date(2026, 6, 15, 9, 0, 0));

    expect(dayEls(h)).toEqual(["2026-08-10", "2026-07-15"]);
    expect(headerTexts(h)).toEqual([
      formatMonthHeader(new Date(2026, 7, 10)),
      formatMonthHeader(new Date(2026, 6, 15)),
    ]);
    // Not hidden by an anchor jump: still reachable exactly as before.
    expect(internals(h.view).rendered.has(aug10.path)).toBe(true);
  });

  it("moving one of two same-day entries to an earlier month sinks it below every remaining day", async () => {
    const h = createHarness();
    const aug12a = addEntry(h, new Date(2026, 7, 12, 20, 0, 0), "aug12 first");
    const aug12b = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "aug12 second, will move to july");
    const aug10 = addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "aug10");
    h.service.load();
    await h.view.onOpen();

    await changeTime(h, aug12b, new Date(2026, 6, 20, 9, 0, 0));

    expect(dayEls(h)).toEqual(["2026-08-12", "2026-08-10", "2026-07-20"]);
    expect(headerTexts(h)).toEqual([
      formatMonthHeader(new Date(2026, 7, 12)),
      formatMonthHeader(new Date(2026, 6, 20)),
    ]);
  });

  it("mirror case: moving an entry to a LATER month lands above every older day", async () => {
    const h = createHarness();
    const aug10 = addEntry(h, new Date(2026, 7, 10, 9, 0, 0), "aug10");
    const aug5 = addEntry(h, new Date(2026, 7, 5, 9, 0, 0), "aug5, will move to september");
    h.service.load();
    await h.view.onOpen();

    await changeTime(h, aug5, new Date(2026, 8, 3, 9, 0, 0));

    expect(dayEls(h)).toEqual(["2026-09-03", "2026-08-10"]);
    expect(headerTexts(h)).toEqual([
      formatMonthHeader(new Date(2026, 8, 3)),
      formatMonthHeader(new Date(2026, 7, 10)),
    ]);
  });

  it("crosses a year boundary: a december entry moved into next january still sorts above december", async () => {
    const h = createHarness();
    const dec20 = addEntry(h, new Date(2026, 11, 20, 9, 0, 0), "dec20");
    const dec15 = addEntry(h, new Date(2026, 11, 15, 9, 0, 0), "dec15, will move to next january");
    h.service.load();
    await h.view.onOpen();

    await changeTime(h, dec15, new Date(2027, 0, 5, 9, 0, 0));

    expect(dayEls(h)).toEqual(["2027-01-05", "2026-12-20"]);
    expect(headerTexts(h)).toEqual([
      formatMonthHeader(new Date(2027, 0, 5)),
      formatMonthHeader(new Date(2026, 11, 20)),
    ]);
    // Exactly one header per month, nothing duplicated by the reload.
    expect(timelineEl(h.view).querySelectorAll(".journal-month-header")).toHaveLength(2);
  });
});
