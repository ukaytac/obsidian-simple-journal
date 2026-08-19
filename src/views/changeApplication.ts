/**
 * Applies one batch of `JournalChange`s from `JournalService` to the
 * rendered timeline: the orchestration behind `JournalView.applyChanges` —
 * looking up each change's current rendering, resolving its `RenderedState`
 * for `applyChange.ts`'s pure `decideChangeAction`, and carrying out
 * whichever DOM/editor mutation that decides on — plus the two pieces of
 * rendering bookkeeping (`reKeyRenderedEntry`/`removeRenderedEntry`) that
 * decision reaches for, both also called from outside this batch loop
 * (`commitEntryTimeChange`'s own rename, `handleDeleteFallback`'s confirmed
 * deletion). Factored out of `JournalView` so it can be exercised with a
 * fabricated `ChangeEntry`/`ChangeApplicationDeps`, the same
 * dependency-injection shape `entrySave.ts`/`mountLifecycle.ts`/
 * `timelineDom.ts` use.
 *
 * `applyChange.ts`'s `decideChangeAction` stays a SEPARATE file rather than
 * being absorbed here or grown in place: it is already fully exercised with
 * fabricated `RenderedState`, needing no DOM/Obsidian internals at all
 * (`tests/applyChange.test.ts`), and this module's whole reason to exist is
 * to be the thing that resolves real state into that pure function's input
 * and carries out its answer — mirroring `mountWindow.ts` (pure selection)
 * staying separate from `mountLifecycle.ts` (the orchestration that resolves
 * state for it and acts on its answer). Growing `decideChangeAction` in
 * place, or merging it into this file, would either force it to take on a
 * DOM dependency it doesn't need, or bury its now-larger, still-pure decision
 * table inside a file that also does async I/O and DOM surgery — losing the
 * exact property that makes it cheap to test exhaustively today.
 *
 * This is NOT as clean a cut as `entrySave.ts`, for the same reason
 * `mountLifecycle.ts` isn't either: the `generation`/`closed` guards are only
 * meaningful relative to `JournalView`'s own teardown counters (owned by the
 * reload/composer seam, not this one), and `insertEntryInPlace`/
 * `removeEmptyDayGroups`/static rendering are `timelineDom.ts`'s/
 * `JournalView.renderStatic`'s jobs, not this module's. Each crosses back
 * into the view via a narrow `ChangeApplicationDeps` accessor rather than
 * this module owning it outright — the same shape as `MountDeps`'s
 * `getGeneration`/`renderStatic`/`lookup`.
 *
 * `mountOrder` IS state this module needs to keep synchronized (a rename
 * re-keys it; a removal splices out of it) but does not own — it must stay
 * the SAME array `mountLifecycle.ts` closes over (`JournalView.mountOrder`,
 * `readonly` for exactly this reason). `createChangeApplication(mountOrder,
 * deps)` closes over it once, the same way `createMountLifecycle(order, max,
 * deps)` does, rather than threading it through every call.
 *
 * The save pipeline (`entrySave.ts`'s `flushSave`) is called directly, via an
 * injected `SaveDeps`, rather than through a `JournalView` method — same
 * reasoning as `mountLifecycle.ts`.
 *
 * `JournalView` keeps `applyChangesNow`/`reKeyRenderedEntry`/
 * `removeRenderedEntry`/`renderedStateFor` as thin wrappers over the
 * `ChangeApplication` below — all four still called from outside this
 * module's own batch loop (`applyChanges`, `commitEntryTimeChange`,
 * `handleDeleteFallback`, and `tests/JournalView.*.test.ts`'s
 * `internals(view).applyChangesNow(...)`/`.renderedStateFor(...)`/
 * `.reKeyRenderedEntry(...)` reflection). `repositionIsNoOp` and
 * `refreshEntryContent` have no caller left outside this module's own batch
 * loop, so `JournalView` does not re-expose either.
 */
import type { Component } from "obsidian";
import { setTooltip } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import { compareEntries } from "../services/entryIndex";
import type { JournalChange } from "../services/journalService";
import { dayKey, formatTime } from "../utils/dates";
import { decideChangeAction, type RenderedState } from "./applyChange";
import { flushSave, type SaveDeps } from "./entrySave";

/**
 * Minimal shape this module needs from an entry's live editor — narrower
 * than the full `EntryEditor` interface, same reasoning as `entrySave.ts`'s
 * `SaveEditor`.
 */
export interface ChangeEditor {
  hasFocus(): boolean;
  getValue(): string;
  setValue(value: string): void;
  destroy(): void;
  /** Needed only to satisfy `entrySave.ts`'s `flushSave`, called directly below. */
  flush(): void;
}

/**
 * The state this module reads and mutates for one rendered entry — a
 * narrow, structural slice of `JournalView`'s private `RenderedEntry`, which
 * satisfies this without any changes, so this module stays exercisable with
 * fabricated state (same shape as `mountLifecycle.ts`'s `MountEntry` and
 * `entrySave.ts`'s `SaveEntry`).
 */
export interface ChangeEntry {
  entry: JournalEntry;
  el: HTMLElement;
  /** Component that owns any MarkdownRenderer output, so it can be unloaded. */
  renderComponent: Component | null;
  editor: ChangeEditor | null;
  saveHandle: number | null;
  savedBody: string;
  /** Needed only to satisfy `entrySave.ts`'s `flushSave`, called directly below. */
  saveToken: number;
}

/**
 * What this module needs injected to reach the rest of `JournalView` — the
 * generation/closed guards and `reload()` owned by the reload/composer seam,
 * the `rendered` map's narrow read/write surface, the `timelineDom.ts`
 * operations this batch loop drives, the repository read and static-render
 * fallback `refreshEntryContent` needs, the file-identity check
 * `renderedStateFor` needs, and the two small helpers (`logUnsavedTextIfLost`,
 * `clearMobileTimers`) shared with teardown paths this module doesn't own
 * (`clearTimeline`, `confirmDelete`).
 */
export interface ChangeApplicationDeps {
  /** `JournalView.closed`, owned by the reload/composer seam. */
  isClosed(): boolean;
  /** `JournalView.generation`, owned by the reload/composer seam. */
  getGeneration(): number;
  /** Fire-and-forget `void this.reload()` — owned by the reload/composer seam. */
  reload(): void;
  /** `this.rendered.get(path)` — storage for `RenderedEntry` is not part of this seam. */
  getRendered(path: string): ChangeEntry | undefined;
  /** `this.rendered.set(path, rendered)`. */
  setRendered(path: string, rendered: ChangeEntry): void;
  /** `this.rendered.delete(path)`. */
  deleteRendered(path: string): void;
  /** `this.insertEntryInPlace` — `timelineDom.ts`'s job, not part of this seam. */
  insertEntryInPlace(entry: JournalEntry): void;
  /** `this.removeEmptyDayGroups` — `timelineDom.ts`'s job, not part of this seam. */
  removeEmptyDayGroups(): void;
  /** `EntryRepository.readBody`. */
  readBody(file: ChangeEntry["entry"]["file"]): Promise<string>;
  /** `this.renderStatic` — the static-rendering fallback, not part of this seam. */
  renderStatic(rendered: ChangeEntry): Promise<void>;
  /**
   * Whether `file` still resolves, BY IDENTITY, somewhere in the current
   * vault state — `this.app.vault.getAbstractFileByPath(file.path) ===
   * file`. See `renderedStateFor`'s doc on why identity, not merely path.
   */
  fileIdentityStillValid(file: ChangeEntry["entry"]["file"]): boolean;
  /** `this.logUnsavedTextIfLost` — shared with `clearTimeline`/`confirmDelete`. */
  logUnsavedTextIfLost(rendered: ChangeEntry): void;
  /** `this.clearMobileTimers` — shared with `clearTimeline`/`confirmDelete`. */
  clearMobileTimers(rendered: ChangeEntry): void;
  /** Passed straight through to `entrySave.ts`'s `flushSave`. */
  save: SaveDeps;
}

/** The bound change-application pipeline `createChangeApplication` returns. */
export interface ChangeApplication {
  applyChangesNow(changes: JournalChange[]): Promise<void>;
  reKeyRenderedEntry(oldPath: string, newPath: string): boolean;
  removeRenderedEntry(path: string): boolean;
  renderedStateFor(rendered: ChangeEntry | undefined): RenderedState;
}

/**
 * Whether `target`'s live editor currently holds text that hasn't reached
 * disk — its value differs from `savedBody`, the body last confirmed
 * written. Mirrors `JournalView.isDirty` exactly, kept as its own copy here
 * rather than an injected callback — same reasoning as `mountLifecycle.ts`'s
 * own copy: nothing about this needs a live reference back into `JournalView`
 * at all.
 */
function isDirty(target: ChangeEntry): boolean {
  return target.editor ? target.editor.getValue() !== target.savedBody : false;
}

/**
 * Builds the change-application pipeline bound to one `mountOrder` array —
 * genuinely shared state this module must keep synchronized but does not
 * own (see this file's doc) — so every function below reads as "act on this
 * entry" rather than repeating "...and here is the mount order, again" at
 * every call site.
 */
export function createChangeApplication(mountOrder: string[], deps: ChangeApplicationDeps): ChangeApplication {
  /**
   * Re-keys the rendered-entry map (and `mountOrder`/`el.dataset.path`) from
   * `oldPath` to `newPath` in place, without touching the editor, DOM node,
   * or day-group placement at all — the whole point being to make a rename
   * a pure bookkeeping update, preserving whatever is currently mounted
   * (focus, caret, CM6 undo history) exactly as `repositionIsNoOp`'s fast
   * path already does for a same-position `created` correction.
   *
   * Shared by two callers: `applyChangesNow`'s "removed" handling (an
   * external rename, re-keying a still-dirty entry so the batch's paired
   * upsert doesn't insert a duplicate), and `commitEntryTimeChange` (this
   * view's OWN `renameEntryToMatch` call, re-keyed immediately rather than
   * waiting for that same external-rename machinery to rediscover it ~300ms
   * later — see that method's doc for why waiting would cost the very
   * focus/undo-history preservation this exists to protect).
   *
   * Guarded on the destination being free: setting the rendered entry at
   * `newPath` would otherwise silently overwrite whatever is ALREADY
   * rendered there — reachable within one debounce window if a different
   * entry at that exact path is deleted while this rename lands first. That
   * victim's DOM node and (if mounted) its still-polling editor would then
   * be orphaned — unreachable from the rendered map, so nothing could ever
   * tear it down; it would keep running for the rest of the session.
   * Returns `false` in that case so the caller falls through to its own
   * (safe) fallback instead.
   */
  function reKeyRenderedEntry(oldPath: string, newPath: string): boolean {
    const rendered = deps.getRendered(oldPath);
    if (!rendered) return false;
    if (deps.getRendered(newPath)) return false;

    deps.deleteRendered(oldPath);
    deps.setRendered(newPath, rendered);
    const mountIndex = mountOrder.indexOf(oldPath);
    if (mountIndex >= 0) mountOrder[mountIndex] = newPath;
    rendered.el.dataset.path = newPath;
    return true;
  }

  /**
   * Tears down one rendered entry's editor/DOM and forgets it. Used for a
   * genuine deletion, the stale old-path half of a rename, and — after an
   * explicit flush that confirmed the entry is no longer dirty — as half of
   * repositioning a "moved" entry (see `applyChangesNow`'s "removed"/
   * "reposition" handling, both of which bail before reaching this call if
   * the flush left the entry still dirty). This method itself never flushes,
   * so it stays safe to call unconditionally even when the underlying file
   * is genuinely gone.
   *
   * A genuine deletion is the one path here that can still reach a dirty
   * entry: `applyChangesNow` never flushes before deleting (`action.flush`
   * is only true when the file still exists elsewhere), so any edit still
   * inside the debounce window, or already failed, is discarded for real —
   * there is no file left to write it to. `logUnsavedTextIfLost` gives the
   * user a last chance to recover that text from the developer console
   * before it goes.
   *
   * Returns whether anything was actually removed. Deliberately does NOT
   * call `removeEmptyDayGroups` itself — see `applyChangesNow`'s doc — the
   * caller batches that once per flush using this return value.
   */
  function removeRenderedEntry(path: string): boolean {
    const rendered = deps.getRendered(path);
    if (!rendered) return false;

    if (rendered.saveHandle !== null) window.clearTimeout(rendered.saveHandle);
    deps.logUnsavedTextIfLost(rendered);
    deps.clearMobileTimers(rendered);
    rendered.editor?.destroy();
    rendered.renderComponent?.unload();
    rendered.el.remove();

    deps.deleteRendered(path);
    const mountIndex = mountOrder.indexOf(path);
    if (mountIndex >= 0) mountOrder.splice(mountIndex, 1);

    return true;
  }

  /**
   * True when `change.kind === "reposition"` for `entry` would not actually
   * move `rendered.el` anywhere in the DOM: still the same day group, and
   * still sorted on the same side of whichever rendered entries currently
   * sit immediately before/after it. Only rendered (mounted or static)
   * neighbours are consulted — an unrendered one imposes no visible
   * ordering constraint here.
   *
   * Deliberately narrower than "the entry's index position is unchanged":
   * that would also have to account for the anchor offset and the loaded
   * window, both irrelevant to whether anything on screen actually needs
   * to move. Comparing DOM neighbours directly answers the only question
   * that matters for this optimization.
   */
  function repositionIsNoOp(rendered: ChangeEntry, entry: JournalEntry): boolean {
    if (dayKey(rendered.entry.created) !== dayKey(entry.created)) return false;

    const prevEl = rendered.el.previousElementSibling as HTMLElement | null;
    const nextEl = rendered.el.nextElementSibling as HTMLElement | null;
    const prevEntry = prevEl ? deps.getRendered(prevEl.dataset.path ?? "")?.entry : undefined;
    const nextEntry = nextEl ? deps.getRendered(nextEl.dataset.path ?? "")?.entry : undefined;

    // A rendered previous sibling must still sort strictly before `entry`
    // (it's newer), and a rendered next sibling must still sort strictly
    // after it (it's older). Either failing means this entry's corrected
    // time has crossed a neighbour and the row genuinely needs to move.
    if (prevEntry && compareEntries(prevEntry, entry) >= 0) return false;
    if (nextEntry && compareEntries(entry, nextEntry) >= 0) return false;

    return true;
  }

  /**
   * Resolves one path's state for `decideChangeAction`'s pure selection
   * logic — the only bridge between that DOM/Obsidian-free module and this
   * module's actual rendered-entry state, mirroring `mountStateOf`'s role
   * for `mountWindow.ts`.
   *
   * `fileStillExists` compares by IDENTITY (`===`), not merely by path: a
   * delete-then-recreate at the same path within one debounce window would
   * otherwise read as "still exists" (something resolves at that path) and
   * flush this stale editor's held text into the NEW, unrelated file.
   *
   * `dirty` compares the editor's current value against `savedBody`
   * directly, not `rendered.saveHandle !== null`: a debounce timer being
   * armed doesn't mean the value it will eventually save is actually
   * different from disk (a type-then-revert within the 500ms window still
   * leaves a timer armed over an unchanged value), and a timer being
   * disarmed doesn't mean nothing needs protecting (`scheduleSave` clears
   * `saveHandle` the instant its timeout fires, before the write it kicks
   * off has even resolved — so a write that's still in flight, or one that
   * already failed, both read as "no pending save" despite the editor still
   * holding text `savedBody` doesn't match). `false` when nothing is
   * mounted: a statically-rendered entry has no live editor to be dirty.
   */
  function renderedStateFor(rendered: ChangeEntry | undefined): RenderedState {
    if (!rendered) {
      return { exists: false, focused: false, dirty: false, fileStillExists: false };
    }

    return {
      exists: true,
      focused: rendered.editor?.hasFocus() ?? false,
      dirty: isDirty(rendered),
      fileStillExists: deps.fileIdentityStillValid(rendered.entry.file),
    };
  }

  /**
   * Reloads one entry's text from disk without remounting its editor. Used
   * when an entry changes from another pane while this view has it
   * statically rendered or mounted-but-unfocused (`applyChange`'s "content"
   * case already skips a focused editor entirely).
   *
   * REQUIRED: `savedBody` must be updated in the same breath as `setValue`,
   * seeded from `editor.getValue()` rather than from `body`. `save()` skips
   * the write when the value to save matches `savedBody`; install the
   * external body without advancing `savedBody` and the next flush (e.g. the
   * next time this entry scrolls out of the mount window) sees a difference,
   * writes the external content straight back, and re-fires `modify` — the
   * reload loop this whole design exists to prevent. Seeding from
   * `getValue()` rather than `body` matters for the same reason
   * `mountEditor` does: the editor may normalize line endings on load (e.g.
   * CRLF -> LF), so the value stored here must come from the same code path
   * the dirty-check in `save()` reads back, not from the raw disk read.
   */
  async function refreshEntryContent(rendered: ChangeEntry): Promise<void> {
    const body = await deps.readBody(rendered.entry.file);

    if (rendered.editor) {
      if (rendered.editor.getValue() === body) return;
      rendered.editor.setValue(body);
      rendered.savedBody = rendered.editor.getValue();
      return;
    }

    await deps.renderStatic(rendered);
  }

  /**
   * The actual body of `JournalView.applyChanges`. Applies one batch of
   * index changes from `JournalService` to the DOM.
   *
   * `generation` is captured once and re-checked after every `await` in the
   * loop below, exactly like `renderStatic`/`mountEditor`/`reloadNow`: even
   * though `reload()` cannot itself run concurrently with this (both go
   * through the same serialized chain), a scroll-driven `unmountEditor`
   * that flushes and destroys this exact editor is NOT serialized behind
   * that chain, so this still needs its own defense against acting on state
   * a concurrent operation has since torn down.
   *
   * Day-group cleanup (`removeEmptyDayGroups`) is deferred to the end of
   * the whole batch, not run per removal: it does two full-timeline
   * `querySelectorAll`s plus a complete `rebuildMonthHeaders`, and a sync
   * burst can remove on the order of a hundred entries in one batch —
   * running it per removal would make that work scale with the burst size
   * instead of staying flat.
   */
  async function applyChangesNow(changes: JournalChange[]): Promise<void> {
    // REQUIRED guard: see `JournalView.closed`'s doc. `JournalService`'s
    // vault-event listeners can fire between `onClose` setting this and the
    // view actually finishing teardown (or, in principle, right after —
    // nothing upstream promises event delivery stops the instant `onClose`
    // starts).
    if (deps.isClosed()) return;
    const generation = deps.getGeneration();
    let dayGroupsDirty = false;

    for (const change of changes) {
      if (deps.isClosed() || generation !== deps.getGeneration()) return;

      if (change.kind === "reload") {
        // Always the sole entry in its batch (see JournalChange's doc);
        // `reload()` itself enqueues onto the same chain this task is
        // already running inside, so it runs right after this task
        // resolves rather than reentrantly — fire it and stop.
        deps.reload();
        return;
      }

      if (change.kind === "removed") {
        const rendered = deps.getRendered(change.path);
        const action = decideChangeAction(change, renderedStateFor(rendered));
        if (action.type !== "remove") continue;

        if (action.flush && rendered) {
          await flushSave(rendered, deps.save);
          if (deps.isClosed() || generation !== deps.getGeneration()) return;

          if (isDirty(rendered)) {
            // The flush did not reach disk (the write is still failing) even
            // though the file itself is still there, just elsewhere (a
            // rename or a move out of the journal folder, not a genuine
            // delete — `action.flush` is only true when `fileStillExists`).
            // Tearing this rendering down now would destroy the editor and
            // replace the on-screen text with the stale `savedBody`, the
            // same loss `unmountEditor`'s decline exists to prevent.
            //
            // A plain decline is not enough here, unlike the "reposition"
            // branch below: `change.path` is only the STALE key this
            // rendering happens to still be filed under (Obsidian mutates
            // the renamed `TFile` in place, so `rendered` already IS the
            // current file — only our own bookkeeping is behind). A rename
            // always pairs this "removed" with a same-batch upsert for the
            // file's new path (see `JournalService.applyRenameSource`); if
            // this rendering is left keyed at the old path, that paired
            // upsert finds nothing at the new path and inserts a SECOND,
            // independent rendering — two live editors bound to the same
            // `TFile`, both polling, both able to write, fighting over the
            // same file. That is worse than the loss this decline exists to
            // prevent, not merely "briefly wrong" — so re-key instead of
            // just leaving it behind.
            //
            // Guarded on the destination being free: setting the rendered
            // entry at `newPath` would otherwise silently overwrite whatever
            // is ALREADY rendered there — reachable within one debounce
            // window if a different entry at that exact path is deleted
            // while this rename lands first. That victim's DOM node and (if
            // mounted) its still-polling editor would then be orphaned —
            // unreachable from the rendered map, so nothing could ever tear
            // it down; it would keep running for the rest of the session.
            // Falling through to the existing removal path when occupied is
            // safe: it still logs this entry's text before it's dropped,
            // rather than silently destroying the other row.
            const newPath = rendered.entry.file.path;
            if (reKeyRenderedEntry(change.path, newPath)) {
              // `dayGroups` is untouched: a rename/move changes neither
              // `entry.created` nor which day group this element already
              // sits in, only the path bookkeeping `reKeyRenderedEntry` did.
              //
              // With the rendered map now correctly keyed at `newPath`, the
              // paired upsert due later in this SAME batch finds
              // `state.exists === true` and either no-ops (dirty, per
              // `decideChangeAction`'s "content" case) or hits the
              // "reposition" branch below — either way, no duplicate. For a
              // move OUT of the journal folder there is no companion upsert
              // at all (see `JournalService.flush`'s "not an entry" branch),
              // so this re-keyed row simply stays, still holding the user's
              // text and still marked, until a write succeeds — the correct
              // outcome: dropping it would discard exactly the text this
              // whole decline exists to protect.
              continue;
            }
          }
        }
        if (removeRenderedEntry(change.path)) dayGroupsDirty = true;
        continue;
      }

      // Remaining kinds ("added" | "content" | "moved") all carry `entry`.
      const path = change.entry.file.path;
      const rendered = deps.getRendered(path);
      const action = decideChangeAction(change, renderedStateFor(rendered));

      switch (action.type) {
        case "noop":
          break;

        case "insert":
          deps.insertEntryInPlace(change.entry);
          break;

        case "refresh":
          if (rendered) {
            await refreshEntryContent(rendered);
            if (deps.isClosed() || generation !== deps.getGeneration()) return;
          }
          break;

        case "reposition":
          // A correction that doesn't actually move the entry anywhere in
          // the DOM (same day, still sorted between the same rendered
          // neighbours) doesn't need any of the teardown below: update the
          // record and the visible timestamp in place instead, preserving
          // focus, caret, selection, and — for the embedded editor — its
          // CM6 undo history. See `repositionIsNoOp`'s doc.
          if (rendered && repositionIsNoOp(rendered, change.entry)) {
            rendered.entry = change.entry;
            const timeEl = rendered.el.querySelector<HTMLElement>(".journal-entry-time");
            if (timeEl) {
              const label = formatTime(change.entry.created);
              timeEl.textContent = label;
              // The tooltip/aria-label baked the old time in at creation
              // (see createEntryEl) — stale otherwise, since nothing else
              // refreshes it and a correction is exactly when it's wrong.
              setTooltip(timeEl, `Change entry time (${label})`);
            }
            break;
          }

          if (action.flush && rendered) {
            await flushSave(rendered, deps.save);
            if (deps.isClosed() || generation !== deps.getGeneration()) return;

            if (isDirty(rendered)) {
              // Same reasoning as the "removed" branch above: the write is
              // still failing, so tearing the current rendering down and
              // re-inserting a fresh one from disk would discard exactly the
              // text the "not saved" marker promises is still safe. Leave
              // this entry at its old position, still marked, until a write
              // actually succeeds — a briefly wrong position is a far
              // smaller harm than losing what the user wrote.
              //
              // Unlike the "removed" branch, this is NOT at risk of becoming
              // a duplicate row: "reposition" only fires when the file's
              // PATH is unchanged (its `created` changed from elsewhere —
              // e.g. a Properties-pane edit — with no rename involved), so
              // `rendered` stays reachable at the same map key regardless —
              // there is no stale bookkeeping for a paired change to trip
              // over, so no re-key is needed here.
              //
              // KNOWN LIMITATION, deliberately left as-is: nothing re-runs
              // this once a later write succeeds — the row keeps its stale
              // day-group placement and its stale `.created` until the next
              // full `reload()`. A save()-success-triggered re-trigger would
              // need to safely re-enter `enqueueTimelineMutation`'s
              // serialized chain from a callback that runs completely
              // outside it today, plus re-validate the rendered map hasn't
              // changed by the time it runs — not a few-line fix, and (unlike
              // the "removed" branch's duplicate-editor risk) the harm here
              // is only a stale position, not two editors fighting over one
              // file — acceptable for the MVP.
              break;
            }
          }
          if (removeRenderedEntry(path)) dayGroupsDirty = true;
          deps.insertEntryInPlace(change.entry);
          break;

        case "remove":
        case "reloadView":
          // Unreachable for "added"/"content"/"moved" — decideChangeAction
          // only returns these for "removed"/"reload", both handled above.
          break;
      }
    }

    if (dayGroupsDirty) deps.removeEmptyDayGroups();
  }

  return { applyChangesNow, reKeyRenderedEntry, removeRenderedEntry, renderedStateFor };
}
