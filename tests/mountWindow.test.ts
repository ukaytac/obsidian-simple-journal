import { describe, expect, it } from "vitest";
import { enforceMountLimit, pickEvictionCandidate, type MountState } from "../src/views/mountWindow";

/** Builds a lookup function from a plain path -> state record, for terse fixtures. */
function statesOf(map: Record<string, MountState>): (path: string) => MountState | undefined {
  return (path) => map[path];
}

describe("pickEvictionCandidate", () => {
  it("prefers a non-intersecting candidate over the oldest-mounted one", () => {
    // Oldest-mounted (first in `order`) is still on screen; a later-mounted
    // entry has already scrolled off. The off-screen one must win, not the
    // one that merely mounted first — this is exactly the case a naive
    // mount-order-only FIFO gets wrong.
    const order = ["a", "b", "c"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: true },
      b: { mounted: true, focused: false, intersecting: false },
      c: { mounted: true, focused: false, intersecting: true },
    });

    expect(pickEvictionCandidate(order, states)).toBe("b");
  });

  it("never picks a focused candidate, even if it is off-screen", () => {
    const order = ["a", "b"];
    const states = statesOf({
      a: { mounted: true, focused: true, intersecting: false },
      b: { mounted: true, focused: false, intersecting: true },
    });

    // "a" is off-screen but focused; "b" is on-screen. The focused one must
    // never be picked, so the fallback (on-screen, unfocused) wins instead.
    expect(pickEvictionCandidate(order, states)).toBe("b");
  });

  it("falls back to the oldest-mounted intersecting entry when nothing is off-screen", () => {
    const order = ["a", "b", "c"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: true },
      b: { mounted: true, focused: false, intersecting: true },
      c: { mounted: true, focused: false, intersecting: true },
    });

    expect(pickEvictionCandidate(order, states)).toBe("a");
  });

  it("returns null when every mounted candidate is focused", () => {
    const order = ["a"];
    const states = statesOf({
      a: { mounted: true, focused: true, intersecting: false },
    });

    expect(pickEvictionCandidate(order, states)).toBeNull();
  });

  it("returns null for an empty order", () => {
    expect(pickEvictionCandidate([], statesOf({}))).toBeNull();
  });

  it("skips a path whose state is missing (e.g. already unmounted) or reports unmounted", () => {
    const order = ["ghost", "a"];
    const states = statesOf({
      // "ghost" has no entry at all — stateOf returns undefined.
      a: { mounted: true, focused: false, intersecting: false },
    });

    expect(pickEvictionCandidate(order, states)).toBe("a");
  });

  it("skips a path whose state explicitly reports mounted: false", () => {
    const order = ["stale", "a"];
    const states = statesOf({
      stale: { mounted: false, focused: false, intersecting: false },
      a: { mounted: true, focused: false, intersecting: true },
    });

    expect(pickEvictionCandidate(order, states)).toBe("a");
  });

  it("never picks an unsaved candidate, even if it is off-screen and unfocused", () => {
    // "a" holds text that failed to save (see JournalView.isDirty) — evicting
    // it would destroy the editor and fall back to stale disk content,
    // silently discarding exactly the text its "not saved" marker promises
    // is still safe. "b" is on-screen but otherwise fine, so it becomes the
    // fallback instead.
    const order = ["a", "b"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: false, unsaved: true },
      b: { mounted: true, focused: false, intersecting: true },
    });

    expect(pickEvictionCandidate(order, states)).toBe("b");
  });

  it("returns null when every mounted candidate is focused or unsaved", () => {
    const order = ["a", "b"];
    const states = statesOf({
      a: { mounted: true, focused: true, intersecting: false },
      b: { mounted: true, focused: false, intersecting: false, unsaved: true },
    });

    expect(pickEvictionCandidate(order, states)).toBeNull();
  });

  it("treats a missing `unsaved` field as evictable (false), not as pinned", () => {
    const order = ["a"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: false },
    });

    expect(pickEvictionCandidate(order, states)).toBe("a");
  });

  it("among intersecting candidates, picks the one farthest from the viewport centre, not the oldest-mounted", () => {
    // "a" is oldest-mounted (first in `order`) but closest to centre; "b",
    // mounted later, is farthest. Distance must win over mount order.
    const order = ["a", "b", "c"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: true, distance: 5 },
      b: { mounted: true, focused: false, intersecting: true, distance: 50 },
      c: { mounted: true, focused: false, intersecting: true, distance: 20 },
    });

    expect(pickEvictionCandidate(order, states)).toBe("b");
  });

  it("among off-screen candidates, picks the one farthest away, and off-screen still beats any on-screen distance", () => {
    const order = ["a", "b", "c"];
    const states = statesOf({
      // Off-screen but physically close (just past the root margin edge).
      a: { mounted: true, focused: false, intersecting: false, distance: 10 },
      // On-screen but reports a larger raw distance number than "a" — must
      // still lose to "a", since the off-screen tier is preferred outright.
      b: { mounted: true, focused: false, intersecting: true, distance: 1000 },
      // Off-screen and farther than "a" — this is the real winner.
      c: { mounted: true, focused: false, intersecting: false, distance: 400 },
    });

    expect(pickEvictionCandidate(order, states)).toBe("c");
  });

  it("breaks an exact distance tie by earliest position in `order`, matching pre-distance behaviour", () => {
    const order = ["a", "b", "c"];
    const states = statesOf({
      a: { mounted: true, focused: false, intersecting: true, distance: 30 },
      b: { mounted: true, focused: false, intersecting: true, distance: 30 },
      c: { mounted: true, focused: false, intersecting: true, distance: 30 },
    });

    expect(pickEvictionCandidate(order, states)).toBe("a");
  });
});

describe("enforceMountLimit", () => {
  it("evicts by distance when the cap forces multiple evictions among intersecting entries", () => {
    const order = ["a", "b", "c", "d", "e"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: false, intersecting: true, distance: 5 },
      b: { mounted: true, focused: false, intersecting: true, distance: 90 },
      c: { mounted: true, focused: false, intersecting: true, distance: 10 },
      d: { mounted: true, focused: false, intersecting: true, distance: 70 },
      e: { mounted: true, focused: false, intersecting: true, distance: 1 },
    };
    const evicted: string[] = [];

    enforceMountLimit(order, 3, statesOf(states), (path) => evicted.push(path));

    expect(order.length).toBe(3);
    // The two farthest (b: 90, d: 70) go first, regardless of mount order —
    // the three closest (a, c, e) survive.
    expect(evicted).toEqual(["b", "d"]);
    expect(order).toEqual(["a", "c", "e"]);
  });

  it("evicts down to exactly the cap, preferring off-screen entries", () => {
    const order = ["a", "b", "c", "d", "e"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: false, intersecting: true },
      b: { mounted: true, focused: false, intersecting: false },
      c: { mounted: true, focused: false, intersecting: true },
      d: { mounted: true, focused: false, intersecting: false },
      e: { mounted: true, focused: false, intersecting: true },
    };
    const evicted: string[] = [];

    enforceMountLimit(order, 3, statesOf(states), (path) => evicted.push(path));

    expect(order.length).toBe(3);
    // Only two evictions are needed to get from 5 down to the cap of 3, and
    // both off-screen entries (b, d) are picked before any on-screen one —
    // "a", the oldest-mounted on-screen entry, survives untouched.
    expect(evicted).toEqual(["b", "d"]);
    expect(order).toEqual(["a", "c", "e"]);
  });

  it("does nothing when already at or under the cap", () => {
    const order = ["a", "b"];
    const evicted: string[] = [];

    enforceMountLimit(
      order,
      5,
      statesOf({
        a: { mounted: true, focused: false, intersecting: true },
        b: { mounted: true, focused: false, intersecting: true },
      }),
      (path) => evicted.push(path),
    );

    expect(evicted).toEqual([]);
    expect(order).toEqual(["a", "b"]);
  });

  it("terminates and evicts nothing when every mounted candidate is focused", () => {
    // The adversarial case the coordinator flagged: with a naive
    // requeue-on-focus loop this is exactly where a spin could hide. Every
    // entry here is (unrealistically, but the algorithm must not assume
    // otherwise) reported focused.
    const order = ["a", "b", "c", "d"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: true, intersecting: false },
      b: { mounted: true, focused: true, intersecting: false },
      c: { mounted: true, focused: true, intersecting: true },
      d: { mounted: true, focused: true, intersecting: true },
    };
    const evicted: string[] = [];

    enforceMountLimit(order, 1, statesOf(states), (path) => evicted.push(path));

    expect(evicted).toEqual([]);
    expect(order.length).toBe(4);
  });

  it("stops above the cap, evicting nothing, when every remaining candidate is unsaved", () => {
    // The trade-off documented on MountState.unsaved and at JournalView's
    // unmountEditor decline: an entry whose write keeps failing pins a mount
    // slot rather than being forced closed and losing the user's text.
    // Mixed with one genuinely evictable entry so the loop is shown to evict
    // exactly that one and then stop — order.length ends up ABOVE max, not
    // merely unchanged, which is the failure mode a plain "evicts nothing"
    // check wouldn't distinguish from this one.
    const order = ["a", "b", "c"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: false, intersecting: false, unsaved: true },
      b: { mounted: true, focused: false, intersecting: false },
      c: { mounted: true, focused: false, intersecting: false, unsaved: true },
    };
    const evicted: string[] = [];

    enforceMountLimit(order, 1, statesOf(states), (path) => evicted.push(path));

    expect(evicted).toEqual(["b"]);
    expect(order).toEqual(["a", "c"]);
    expect(order.length).toBeGreaterThan(1);
  });

  it("terminates on a large adversarial mix without evicting a focused entry", () => {
    // 200 candidates, one focused, cap far below the count: this is the
    // shape most likely to reveal an O(n^2)-but-still-terminating loop
    // masquerading as a hang, or a focus-driven requeue that never lets go.
    const order: string[] = [];
    const states: Record<string, MountState> = {};

    for (let i = 0; i < 200; i++) {
      const path = `entry-${i}`;
      order.push(path);
      states[path] = {
        mounted: true,
        focused: i === 42, // exactly one focused candidate, buried in the middle
        intersecting: i % 3 === 0,
      };
    }

    const evicted: string[] = [];
    enforceMountLimit(order, 10, statesOf(states), (path) => evicted.push(path));

    expect(order.length).toBe(10);
    expect(evicted).not.toContain("entry-42");
    expect(order).toContain("entry-42");
    // Every evicted path really was removed from `order`, and nothing was
    // evicted twice.
    expect(new Set(evicted).size).toBe(evicted.length);
    for (const path of evicted) expect(order).not.toContain(path);
  });

  it("tolerates onEvict flipping the victim's own state to unmounted", () => {
    // Mirrors the live view loosely: JournalView's onEvict starts an async
    // unmountEditor(), which eventually nulls rendered.editor — here that
    // mutation happens synchronously inside onEvict instead, to check the
    // pure function doesn't misbehave if a caller's bookkeeping is already
    // updated by the time onEvict returns (order itself was already spliced
    // by enforceMountLimit before onEvict ran, so this should be a no-op as
    // far as this loop's own behaviour goes).
    const order = ["a", "b"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: false, intersecting: false },
      b: { mounted: true, focused: false, intersecting: false },
    };
    const evicted: string[] = [];

    enforceMountLimit(order, 1, statesOf(states), (path) => {
      evicted.push(path);
      states[path] = { ...states[path], mounted: false };
    });

    expect(evicted).toEqual(["a"]);
    expect(order).toEqual(["b"]);
    expect(states.a.mounted).toBe(false);
  });

  it("tolerates onEvict adding a new path mid-loop, still terminating at the cap", () => {
    // Mirrors a concurrent mount landing while eviction is in progress:
    // JournalView's mountEditor pushes onto the same mountOrder array that
    // enforceMountLimit is iterating (well, over its `order` parameter, the
    // same array by reference). The newly added path must still be
    // correctly evicted if it's evictable and the cap requires it, and the
    // loop must still terminate.
    const order = ["a", "b"];
    const states: Record<string, MountState> = {
      a: { mounted: true, focused: false, intersecting: false },
      b: { mounted: true, focused: false, intersecting: false },
      c: { mounted: true, focused: false, intersecting: false },
    };
    let addedC = false;
    const evicted: string[] = [];

    enforceMountLimit(order, 0, statesOf(states), (path) => {
      evicted.push(path);
      if (path === "a" && !addedC) {
        addedC = true;
        order.push("c");
      }
    });

    expect(order).toEqual([]);
    expect(evicted).toEqual(["a", "b", "c"]);
  });

  it("removes the victim from `order` before invoking onEvict", () => {
    // JournalView relies on this ordering: its onEvict starts an async
    // unmount, and mountOrder must already reflect the removal by then so a
    // concurrent enforceMountLimit call (from a different entry's mount)
    // can't pick the same victim again while the unmount is still in flight.
    const order = ["a", "b"];
    let orderLengthDuringCallback = -1;

    enforceMountLimit(
      order,
      0,
      statesOf({
        a: { mounted: true, focused: false, intersecting: false },
        b: { mounted: true, focused: false, intersecting: false },
      }),
      () => {
        if (orderLengthDuringCallback === -1) orderLengthDuringCallback = order.length;
      },
    );

    expect(orderLengthDuringCallback).toBe(1);
    expect(order).toEqual([]);
  });
});
