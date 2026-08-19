/**
 * The pure selection/termination logic behind the editor mount window's
 * backstop cap (`MAX_MOUNTED_EDITORS` in JournalView). Kept separate from
 * `JournalView` — which owns the DOM, the `IntersectionObserver`, and the
 * actual async unmount — so this can be exercised directly with fabricated
 * state, the same way `services/entryIndex.ts` keeps ordering/paging logic
 * independent of the view.
 *
 * The primary mechanism that bounds mounted editors is `mountObserver`
 * reacting to entries entering/leaving the viewport; this only runs when a
 * mount pushes the count over the cap (a very tall pane, or many short
 * entries packed into `MOUNT_ROOT_MARGIN`).
 */

/** Per-entry state `pickEvictionCandidate` needs, resolved on demand by `stateOf`. */
export interface MountState {
  /** True if this entry currently has a mounted, live editor. */
  mounted: boolean;
  /** True if that editor currently holds keyboard focus. Never evicted. */
  focused: boolean;
  /** True if the entry's element currently intersects the viewport. */
  intersecting: boolean;
  /**
   * True if the editor holds text that hasn't reached disk (see
   * `JournalView.isDirty`) — most likely a failed write still showing its
   * "not saved" marker. Never evicted, same as `focused`: forcing this
   * editor closed would fall back to stale disk content and silently drop
   * the very text the marker promises is still safe. Optional, defaulting
   * to evictable (`false`/`undefined`), so callers/fixtures that predate
   * this field are unaffected.
   */
  unsaved?: boolean;
  /**
   * Absolute distance (any consistent unit — `JournalView` uses pixels
   * between element centre and viewport centre) between this entry and the
   * centre of the viewport, as of the most recent `mountObserver` callback.
   * Optional, defaulting to `0`, so callers/fixtures that predate this field
   * (every existing unit test) keep their exact prior tie-broken-by-`order`
   * behaviour: with every candidate reporting the same default distance,
   * selection within a tier collapses back to "first eligible in `order`",
   * i.e. oldest-mounted.
   */
  distance?: number;
}

/**
 * Picks which mounted entry to evict. `order` lists candidate paths
 * oldest-mounted first; `stateOf` resolves each path's current state.
 *
 * Two tiers, each scored by `distance` (largest wins, ties broken by
 * earliest position in `order`): candidates NOT currently intersecting the
 * viewport are always preferred over ones that are, and within either tier
 * the one physically farthest from the viewport centre goes first — the
 * entry the user is least likely to be looking at, not merely whichever
 * happened to mount first (e.g. on the very first page load, before the
 * user has scrolled at all, when many entries can finish mounting within
 * the same tick). Never picks a focused entry, or one whose text hasn't
 * reached disk yet (`unsaved`) — see `MountState.unsaved`'s doc. Returns
 * null when nothing is safely evictable at all — `order` is empty, every
 * candidate's state is missing/unmounted, or every mounted candidate is
 * focused or unsaved.
 *
 * A candidate excluded only for being `unsaved` is not retried once no
 * evictable entry remains: this can leave the mounted count above `max` for
 * as long as its write keeps failing (`enforceMountLimit`'s loop simply
 * stops when this returns null). That is intentional — see `MountState.unsaved`.
 */
export function pickEvictionCandidate(
  order: readonly string[],
  stateOf: (path: string) => MountState | undefined,
): string | null {
  let offscreen: { path: string; distance: number } | null = null;
  let onscreen: { path: string; distance: number } | null = null;

  for (const path of order) {
    const state = stateOf(path);
    if (!state?.mounted || state.focused || state.unsaved) continue;

    const distance = state.distance ?? 0;
    const bucket = state.intersecting ? "onscreen" : "offscreen";
    const current = bucket === "offscreen" ? offscreen : onscreen;

    // Strictly greater, not >=: ties keep whichever was found FIRST, i.e.
    // earliest in `order` — the oldest-mounted, matching this function's
    // pre-distance behaviour exactly when every candidate reports the same
    // (default `0`) distance.
    if (current === null || distance > current.distance) {
      if (bucket === "offscreen") offscreen = { path, distance };
      else onscreen = { path, distance };
    }
  }

  return offscreen?.path ?? onscreen?.path ?? null;
}

/**
 * Repeatedly evicts until `order.length <= max` or nothing more can safely
 * be evicted, removing each victim from `order` (via `splice`) itself,
 * synchronously, before calling `onEvict` — so the caller's `onEvict` can
 * kick off an actual (async) unmount without also having to manage `order`,
 * and the same path can never be picked twice regardless of what `onEvict`
 * does or how long it takes.
 *
 * Terminates in at most `order.length` iterations: each one either splices a
 * real member out of `order`, permanently shrinking it, or
 * `pickEvictionCandidate` returns null and the loop breaks outright — e.g.
 * every remaining mounted entry is focused, which for a single document can
 * only ever be one entry, but the check does not assume that.
 */
export function enforceMountLimit(
  order: string[],
  max: number,
  stateOf: (path: string) => MountState | undefined,
  onEvict: (path: string) => void,
): void {
  while (order.length > max) {
    const victim = pickEvictionCandidate(order, stateOf);
    if (victim === null) break;

    const index = order.indexOf(victim);
    if (index >= 0) order.splice(index, 1);

    onEvict(victim);
  }
}
