import type { JournalChange } from "../services/journalService";

/**
 * Per-path state `decideChangeAction` needs, resolved on demand by the
 * caller. Kept separate from `JournalView`'s own `RenderedEntry` so this
 * stays exercisable with fabricated state — same shape as `mountWindow.ts`'s
 * `MountState`/`stateOf` and `entrySave.ts`'s injected `write`/`onError`.
 */
export interface RenderedState {
  /** True if this path currently has a rendered entry (mounted or static). */
  exists: boolean;
  /** True if the rendered entry's editor currently holds keyboard focus. */
  focused: boolean;
  /**
   * True if the editor's current text differs from `savedBody` — the body
   * last known to be on disk. This is the state a "pending save" actually
   * needs to mean, and is deliberately NOT "is a debounced save timer
   * currently armed": `scheduleSave` re-arms on every keystroke regardless
   * of whether the net value changed, so a type-then-revert within the
   * debounce window leaves a timer armed over a value that already matches
   * disk again — bailing on that would withhold a perfectly safe refresh
   * for no reason. Conversely, a save whose write just failed clears its
   * timer immediately (before the write is even attempted) while the
   * editor's text still doesn't match what's on disk — a timer-based check
   * would wrongly treat that as safe to overwrite. Comparing the values
   * directly gets both right.
   */
  dirty: boolean;
  /**
   * True if the rendered entry's underlying file object still resolves, BY
   * IDENTITY (not merely by path — see `decideChangeAction`'s doc on
   * "remove"/"reposition"), somewhere in the current vault state. Only
   * consulted for "removed" and "moved".
   */
  fileStillExists: boolean;
}

export type ChangeAction =
  | { type: "noop" }
  | { type: "insert" }
  | { type: "refresh" }
  | { type: "remove"; flush: boolean }
  | { type: "reposition"; flush: boolean }
  | { type: "reloadView" };

/**
 * Pure decision logic behind `JournalView.applyChangesNow`. Exercised
 * directly with fabricated `RenderedState`, rather than only through a live
 * `JournalView` (which needs a DOM, `IntersectionObserver`s, and Obsidian
 * internals this test environment doesn't provide).
 *
 * `inScope` is whether the changed entry belongs in the timeline as
 * currently filtered — always `true` for an unscoped timeline, which is why
 * it defaults that way: an unscoped journal must behave exactly as it did
 * before tag scoping existed. Only consulted for the three kinds that carry
 * an entry; "removed" and "reload" are scope-independent.
 */
export function decideChangeAction(
  change: JournalChange,
  state: RenderedState,
  inScope = true,
): ChangeAction {
  switch (change.kind) {
    case "reload":
      return { type: "reloadView" };

    case "added":
      // An entry the scope excludes is not merely rendered elsewhere — it is
      // not part of this timeline at all, so there is nothing to insert.
      return inScope ? { type: "insert" } : { type: "noop" };

    case "removed":
      // Nothing rendered at this path (e.g. a delete of a path that was
      // never an entry, or the renameSource half of a rename that never
      // had a rendering to begin with): nothing to do.
      if (!state.exists) return { type: "noop" };
      // `fileStillExists` distinguishes a genuine deletion (flushing would
      // just fail and surface a confusing "failed to save" notice for an
      // intentional deletion) from the stale old-path half of a rename or a
      // move out of the journal folder (the file is still there, just
      // elsewhere — flush first so a mid-debounce edit isn't lost).
      return { type: "remove", flush: state.fileStillExists };

    case "moved":
      if (!inScope) return leaveScope(state);
      // Nothing rendered under this path yet: still insert it fresh, same
      // as "added" — reachable when a rename also changes the resolved
      // `created` (the old rendering, if any, was already torn down by this
      // same batch's "removed" for the old path).
      if (!state.exists) return { type: "insert" };
      return { type: "reposition", flush: state.fileStillExists };

    case "content":
      if (!inScope) return leaveScope(state);
      // Same reasoning as "moved": nothing rendered yet, insert fresh
      // rather than silently dropping the change (reachable after a
      // same-timestamp rename).
      if (!state.exists) return { type: "insert" };
      // Loop/clobber suppression: never touch an editor the user is
      // actively focused in, AND never touch one whose text is "dirty" —
      // differs from what's known to be on disk. The second case matters
      // even though the editor isn't focused: without it, `setValue`-ing the
      // external body over an in-flight edit would both discard that edit
      // AND get silently overwritten again moments later when the stale,
      // already-scheduled save fires with its stale captured value — losing
      // both the local edit and the external change, and leaving the
      // editor's on-screen text diverged from what actually lands on disk.
      if (state.focused || state.dirty) return { type: "noop" };
      return { type: "refresh" };
  }
}

/**
 * What to do with a rendered row whose entry no longer belongs in the
 * current scope — the user removed the scoped tag from it, or changed it to
 * a different one, from anywhere in Obsidian.
 *
 * The focused/dirty decline is the same one `"content"` makes above, and
 * matters MORE here: removing a scoped tag from an entry is something a user
 * plausibly does while typing in that very entry, and destroying the editor
 * mid-keystroke would take unsaved text with it. The row then stays visible
 * although out of scope until the next reload — a briefly over-inclusive
 * timeline, which is the safe direction to be wrong in.
 */
function leaveScope(state: RenderedState): ChangeAction {
  if (!state.exists) return { type: "noop" };
  if (state.focused || state.dirty) return { type: "noop" };
  return { type: "remove", flush: state.fileStillExists };
}
