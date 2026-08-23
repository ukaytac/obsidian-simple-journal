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
 *
 * TRIPWIRE for future maintainers: `remove` is reachable for `"content"` and
 * `"moved"` when `inScope` is `false` (via `decideScopeExit`), and
 * `changeApplication.ts`'s `applyChangesNow` handles it in its `"remove"`
 * case. If that case is ever refactored to drop `"content"`/`"moved"` back
 * to a bare `break` (as it still does for the genuinely-unreachable
 * `"reloadView"`), every scope exit decided here silently becomes a no-op
 * that no test catches.
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
      if (!inScope) return decideScopeExit(state);
      // Nothing rendered under this path yet: still insert it fresh, same
      // as "added" — reachable when a rename also changes the resolved
      // `created` (the old rendering, if any, was already torn down by this
      // same batch's "removed" for the old path).
      if (!state.exists) return { type: "insert" };
      return { type: "reposition", flush: state.fileStillExists };

    case "content":
      if (!inScope) return decideScopeExit(state);
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
 * The focused/dirty decline mirrors `"content"`'s above, but for `"moved"`
 * it is a NEW decision, not a reuse of an existing one: in-scope `moved`
 * above deliberately does NOT suppress on focus (reverse-chronological
 * ordering is a product requirement — see "a focused editor is still
 * repositioned" in `tests/applyChange.test.ts`), while an out-of-scope
 * `moved` routed here through `decideScopeExit` DOES decline on
 * focus/dirty. The asymmetry is intentional: ordering must happen even at
 * the cost of disturbing focus, because a wrongly-ordered timeline is a
 * product-visible bug, whereas a filter being loose about one row is
 * cosmetic and can wait.
 *
 * A declined exit leaves the row rendered, out of scope, until the next
 * full `reload()` — and nothing re-runs this decision once the entry later
 * goes clean or loses focus, the same known gap the `reposition` branch's
 * own KNOWN LIMITATION note in `changeApplication.ts` documents for its own
 * case. In a long session with no settings/anchor/folder change to trigger
 * a reload, that is effectively the rest of the session; for an entry whose
 * writes keep failing, it is unbounded. Retaining the row is still the safe
 * direction to be wrong in — the alternative risks destroying unsaved text
 * — but it is not merely "briefly" wrong, and should not be described that
 * way.
 *
 * `flush: state.fileStillExists` is not the redundant guard it can look
 * like. `fileStillExists` is compared by IDENTITY, not by path (see
 * `RenderedState`'s doc) — so `exists: true, fileStillExists: false` is
 * genuinely reachable here: a delete-then-recreate at the same path inside
 * one debounce window, where the row is still rendered but the `TFile` it
 * points at is no longer the live one. In that window, flushing would aim a
 * stale editor's text at a DIFFERENT file than the one now at that path.
 * The focused/dirty decline just above and this flag are therefore two
 * independent guards that happen to agree in the common case, not one
 * checking the other's work — `tests/applyChange.test.ts`'s "a scope exit's
 * flush tracks fileStillExists, not a hardcoded true" pins the derivation so
 * a future simplification to a literal `true` gets caught.
 */
function decideScopeExit(state: RenderedState): ChangeAction {
  if (!state.exists) return { type: "noop" };
  if (state.focused || state.dirty) return { type: "noop" };
  return { type: "remove", flush: state.fileStillExists };
}
