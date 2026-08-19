// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle } from "./journalViewHarness";
import type { FakeIntersectionObserver } from "./obsidian-mock";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
}

/**
 * NOTE on what this file can and cannot prove: a real `IntersectionObserver`
 * delivers an initial callback the moment `observe()` is called, describing
 * whatever the element's current on-screen intersection actually is —
 * that's how `appendEntry`'s "mount whatever's already visible" behaviour
 * works in production. `FakeIntersectionObserver` (jsdom has no layout
 * engine to derive real intersection from) does not replicate that: nothing
 * mounts here until a test explicitly calls `.trigger(...)`. So these tests
 * prove "given this intersection transition, `JournalView` mounts/unmounts/
 * evicts correctly" — not "the right real-world scroll position produces
 * that transition in the first place," which stays a manual/real-browser
 * concern (see `docs/manual-testing-editor.md`).
 */
describe("JournalView mount window", () => {
  it("mounts a live editor for an entry that enters the mount margin", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    const b = addEntry(h, new Date(2026, 7, 12, 10, 0, 0), "beta body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered;
    expect(rendered.get(a.path).editor).toBeNull();
    expect(rendered.get(b.path).editor).toBeNull();

    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    mountObserver.trigger([{ target: rendered.get(b.path).el, isIntersecting: true }]);
    await settle();

    expect(rendered.get(b.path).editor).not.toBeNull();
    expect(rendered.get(b.path).editor.getValue()).toBe("beta body");
    expect(rendered.get(b.path).bodyEl.querySelector("textarea")).toBeTruthy();
    // Untouched: only the triggered entry mounted.
    expect(rendered.get(a.path).editor).toBeNull();
  });

  it("leaving the mount margin unmounts the editor and restores static rendering", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered;
    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const el = rendered.get(a.path).el;

    mountObserver.trigger([{ target: el, isIntersecting: true }]);
    await settle();
    expect(rendered.get(a.path).editor).not.toBeNull();

    mountObserver.trigger([{ target: el, isIntersecting: false }]);
    await settle();

    expect(rendered.get(a.path).editor).toBeNull();
    expect(rendered.get(a.path).bodyEl.querySelector("textarea")).toBeNull();
  });

  /**
   * `enforceMountLimit`'s backstop exists, per `mountWindow.ts`'s own doc,
   * for exactly this shape: "more entries simultaneously within
   * MOUNT_ROOT_MARGIN than MAX_MOUNTED_EDITORS allows — a very tall pane,
   * or many short entries packed into MOUNT_ROOT_MARGIN." Every entry in
   * that scenario is, by definition, currently `intersecting`, so
   * `unmountEditor` must actually tear one down even though it is on
   * screen: it takes an `{ evict: true }` flag from `enforceMountLimit`'s
   * `onEvict` specifically to bypass its ordinary "re-entered
   * MOUNT_ROOT_MARGIN while the flush was in flight" decline for this one
   * caller, while still honoring the focused/dirty declines unconditionally
   * (see `unmountEditor`'s doc). Without that flag, every eviction's
   * fire-and-forget `unmountEditor` call would find `rendered.intersecting`
   * still true and re-add the victim via `ensureMountOrderContains`,
   * silently undoing the synchronous splice `enforceMountLimit` already did
   * — the cap would never actually bind.
   */
  it("enforces the mount cap: mounting beyond MAX_MOUNTED_EDITORS evicts down to the cap", async () => {
    const h = createHarness();
    // 65 entries: > the desktop cap (60), and > PAGE_SIZE (40), so a second
    // page has to load for all of them to be simultaneously rendered.
    for (let i = 0; i < 65; i++) {
      addEntry(h, new Date(2026, 7, 12, 0, 0, 0 - i), `entry ${i}`);
    }
    h.service.load();
    await h.view.onOpen();
    expect(internals(h.view).rendered.size).toBe(40);

    const sentinel = internals(h.view).observer as FakeIntersectionObserver;
    sentinel.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();
    expect(internals(h.view).rendered.size).toBe(65);

    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const rows = [...internals(h.view).rendered.values()] as Array<{ el: HTMLElement }>;
    // All 65 "on screen" at once (a very tall pane / short entries packed
    // into MOUNT_ROOT_MARGIN) — exactly the scenario `enforceMountLimit`'s
    // backstop, not the ordinary viewport-driven unmount, exists for.
    mountObserver.trigger(rows.map((r) => ({ target: r.el, isIntersecting: true })));
    await settle();
    await settle();
    await settle();

    expect(internals(h.view).mountOrder.length).toBeLessThanOrEqual(60);
    const mountedCount = [...internals(h.view).rendered.values()].filter(
      (r: { editor: unknown }) => r.editor !== null,
    ).length;
    expect(mountedCount).toBeLessThanOrEqual(60);
  });

  /**
   * `mountObserver`'s callback computes each entry's distance from the
   * viewport centre (`rendered.mountDistance`, fed to `pickEvictionCandidate`
   * as `MountState.distance`) from `observerEntry.boundingClientRect` and
   * `this.contentEl.getBoundingClientRect()` — real geometry, not mount
   * order. `FakeIntersectionObserver.trigger` reads `boundingClientRect` via
   * `target.getBoundingClientRect()` (see `obsidian-mock.ts`), which jsdom
   * defaults to an all-zero rect; stubbing it per element is how a test gets
   * to control "distance" at all. Every other test in this file leaves that
   * stub off, so every entry reports the same default distance (0) and
   * selection falls back to earliest-in-`mountOrder` — this test is the one
   * proving that when real distances DO differ, they change which entry
   * gets evicted, exactly as `enforceMountLimit`'s own distance unit tests
   * (`tests/mountWindow.test.ts`) already prove in isolation.
   */
  it("with real geometry, eviction targets the entry farthest from the viewport centre, not the oldest-mounted one", async () => {
    const h = createHarness();
    for (let i = 0; i < 65; i++) {
      addEntry(h, new Date(2026, 7, 12, 0, 0, 0 - i), `entry ${i}`);
    }
    h.service.load();
    await h.view.onOpen();

    const sentinel = internals(h.view).observer as FakeIntersectionObserver;
    sentinel.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();

    // Viewport centre at y=500.
    const contentEl = internals(h.view).contentEl as HTMLElement;
    contentEl.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1000, height: 1000, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const rows = [...internals(h.view).rendered.values()] as Array<{ el: HTMLElement }>;

    // Every row sits exactly at the centre (distance 0) except one,
    // deliberately far from it (distance 500) — NOT the oldest-mounted, so
    // mount-order-only selection (as exercised by every other test here)
    // would pick a different victim than distance-based selection must.
    const farIndex = 5;
    rows.forEach((r, i) => {
      const top = i === farIndex ? 0 : 500;
      r.el.getBoundingClientRect = () =>
        ({ top, bottom: top, height: 0, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
    });

    // Mount exactly the cap's worth first — no eviction pressure yet.
    mountObserver.trigger(rows.slice(0, 60).map((r) => ({ target: r.el, isIntersecting: true })));
    await settle();
    expect(internals(h.view).mountOrder.length).toBe(60);

    const farPath = [...internals(h.view).rendered.keys()][farIndex];
    const oldestPath = (internals(h.view).mountOrder as string[])[0];
    expect(farPath).not.toBe(oldestPath);
    expect(internals(h.view).rendered.get(farPath).editor).not.toBeNull();

    // Genuine over-cap pressure: a 61st row, at the centre (distance 0),
    // becomes intersecting.
    mountObserver.trigger([{ target: rows[60].el, isIntersecting: true }]);
    await settle();

    expect(internals(h.view).mountOrder.length).toBeLessThanOrEqual(60);
    // The farthest entry was evicted, even though it was not oldest-mounted...
    expect(internals(h.view).rendered.get(farPath).editor).toBeNull();
    // ...and the actually-oldest-mounted entry, merely near the centre,
    // survives instead — the opposite of what a mount-order-only rule
    // (the pre-distance implementation) would have picked.
    expect(internals(h.view).rendered.get(oldestPath).editor).not.toBeNull();
  });

  /**
   * Pins `pickEvictionCandidate`'s focus exclusion under GENUINE over-cap
   * pressure — `mountOrder` must actually exceed `MAX_MOUNTED_EDITORS` at
   * the moment selection runs, not merely have exceeded it earlier and
   * settled back down. (An earlier version of this test cycled an
   * already-mounted entry out and back in as its "pressure," which only
   * ever brought the count from 60 to 59 and back to 60 — never over the
   * cap, so `enforceMountLimit`'s `while (order.length > max)` loop never
   * ran and zero evictions ever happened. Mutating away the focus
   * exclusion entirely still left it green. This version mounts a 61st,
   * previously-unmounted row instead, which genuinely forces exactly one
   * eviction.)
   */
  it("eviction skips a genuinely-selected focused entry, evicting a different one instead", async () => {
    const h = createHarness();
    for (let i = 0; i < 65; i++) {
      addEntry(h, new Date(2026, 7, 12, 0, 0, 0 - i), `entry ${i}`);
    }
    h.service.load();
    await h.view.onOpen();

    const sentinel = internals(h.view).observer as FakeIntersectionObserver;
    sentinel.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();

    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const rows = [...internals(h.view).rendered.values()] as Array<{ el: HTMLElement }>;

    // Mount exactly the cap's worth first — no eviction pressure yet.
    mountObserver.trigger(rows.slice(0, 60).map((r) => ({ target: r.el, isIntersecting: true })));
    await settle();
    expect(internals(h.view).mountOrder.length).toBe(60);

    // Focus the oldest-mounted entry — the tie-break winner (default
    // distance 0 for everything here) `pickEvictionCandidate` would
    // otherwise pick first.
    const mountOrderBefore = [...internals(h.view).mountOrder] as string[];
    const focusPath = mountOrderBefore[0];
    const focusedRendered = internals(h.view).rendered.get(focusPath);
    (focusedRendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement).focus();
    expect(focusedRendered.editor.hasFocus()).toBe(true);

    const otherPath = mountOrderBefore[1];
    expect(internals(h.view).rendered.get(otherPath).editor).not.toBeNull();

    // Genuine over-cap pressure: a 61st row, never before in `mountOrder`,
    // becomes intersecting — `mountOrder` hits 61 and `enforceMountLimit`
    // must evict exactly one real victim to get back to 60.
    mountObserver.trigger([{ target: rows[60].el, isIntersecting: true }]);
    await settle();

    expect(internals(h.view).mountOrder.length).toBeLessThanOrEqual(60);
    // The focused entry survives...
    expect(internals(h.view).rendered.get(focusPath).editor).not.toBeNull();
    expect(internals(h.view).rendered.get(focusPath).editor.hasFocus()).toBe(true);
    // ...and a real eviction happened to someone else instead.
    expect(internals(h.view).rendered.get(otherPath).editor).toBeNull();
    // Untouched position, not merely "still present": if `pickEvictionCandidate`
    // ever selected the focused entry first (declined, then re-added via
    // `ensureMountOrderContains`, which APPENDS), it would end up at the END
    // of `mountOrder` instead of still at the front — a real, if
    // self-healing, extra round trip this asserts never happens.
    expect((internals(h.view).mountOrder as string[])[0]).toBe(focusPath);
  });

  /**
   * Same shape as the focus test above, for the dirty decline —
   * `pickEvictionCandidate`'s `unsaved` exclusion (`MountState.unsaved`,
   * fed from `JournalView.isDirty`). A genuinely dirty entry (a pending,
   * not-yet-flushed edit, still inside the 500ms save debounce) must never
   * be forced closed — that would silently discard the edit — even when it
   * is the oldest-mounted, tie-break-winning candidate under real pressure.
   */
  it("eviction skips a genuinely-selected dirty entry, evicting a different one instead", async () => {
    const h = createHarness();
    for (let i = 0; i < 65; i++) {
      addEntry(h, new Date(2026, 7, 12, 0, 0, 0 - i), `entry ${i}`);
    }
    h.service.load();
    await h.view.onOpen();

    const sentinel = internals(h.view).observer as FakeIntersectionObserver;
    sentinel.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();

    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const rows = [...internals(h.view).rendered.values()] as Array<{ el: HTMLElement }>;

    mountObserver.trigger(rows.slice(0, 60).map((r) => ({ target: r.el, isIntersecting: true })));
    await settle();
    expect(internals(h.view).mountOrder.length).toBe(60);

    const mountOrderBefore = [...internals(h.view).mountOrder] as string[];
    const dirtyPath = mountOrderBefore[0];
    const dirtyRendered = internals(h.view).rendered.get(dirtyPath);
    const textarea = dirtyRendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "edited, not yet flushed");
    // Genuinely dirty right now, well inside the debounce window.
    expect(dirtyRendered.editor.getValue()).not.toBe(dirtyRendered.savedBody);

    const otherPath = mountOrderBefore[1];
    expect(internals(h.view).rendered.get(otherPath).editor).not.toBeNull();

    mountObserver.trigger([{ target: rows[60].el, isIntersecting: true }]);
    await settle();

    expect(internals(h.view).mountOrder.length).toBeLessThanOrEqual(60);
    // The dirty entry survives, edit intact...
    expect(internals(h.view).rendered.get(dirtyPath).editor).not.toBeNull();
    expect(internals(h.view).rendered.get(dirtyPath).editor.getValue()).toBe("edited, not yet flushed");
    // ...and a real eviction happened to someone else instead.
    expect(internals(h.view).rendered.get(otherPath).editor).toBeNull();
  });

  it("unmounting flushes a pending edit to disk before tearing the editor down", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered;
    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const el = rendered.get(file.path).el;

    mountObserver.trigger([{ target: el, isIntersecting: true }]);
    await settle();

    const textarea = rendered.get(file.path).bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "edited body, not yet flushed");
    // Nothing on disk yet — still inside the 500ms save debounce.
    expect(h.app.vault.contents.get(file.path)).not.toContain("edited body");

    mountObserver.trigger([{ target: el, isIntersecting: false }]);
    await settle();
    await settle();

    expect(h.app.vault.contents.get(file.path)).toContain("edited body, not yet flushed");
    expect(rendered.get(file.path).editor).toBeNull();
  });

  /**
   * `mountEditor` is otherwise only ever invoked from `mountObserver`'s enter
   * TRANSITION callback — there is no periodic or click-driven remount
   * anywhere else. Distance-based eviction (above) makes it rare, but does
   * not make it impossible, for an entry to be evicted while it never
   * actually left `MOUNT_ROOT_MARGIN` (`rendered.intersecting` stays true):
   * that entry's transition already fired and won't fire again until it
   * leaves and re-enters, so without a separate recovery path such a row
   * would sit there looking editable — static markdown, no caret — while
   * silently swallowing every click and keystroke. This pins the recovery:
   * a `pointerdown` (or `focusin`) on `bodyEl` remounts it right there, and
   * the entry becomes usable again without a scroll round-trip.
   *
   * Reaches `unmountEditor(row, { evict: true })` directly, rather than
   * manufacturing real 61-entry pressure, since the recovery path — not
   * eviction selection itself (already covered above) — is what this test
   * is pinning.
   */
  it("a pointerdown on an evicted-but-still-intersecting entry remounts and focuses its editor", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered;
    const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
    const row = rendered.get(file.path);

    mountObserver.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    expect(row.editor).not.toBeNull();

    // The eviction-while-intersecting state `enforceMountLimit`'s `onEvict`
    // produces.
    await internals(h.view).unmountEditor(row, { evict: true });
    expect(row.editor).toBeNull();
    expect(row.intersecting).toBe(true);
    expect(row.bodyEl.querySelector("textarea")).toBeNull();

    row.bodyEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();

    expect(row.editor).not.toBeNull();
    expect(row.editor.hasFocus()).toBe(true);
    expect(row.bodyEl.querySelector("textarea")).toBeTruthy();
  });

  it("does nothing on interaction with an entry that has genuinely left the mount margin", async () => {
    // The guard (`!rendered.intersecting`) matters: without it, clicking a
    // statically-rendered entry that is off-screen for the ordinary,
    // correct reason (it scrolled out) would remount an editor nothing will
    // ever unmount again until the next real transition.
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered;
    const row = rendered.get(file.path);
    expect(row.editor).toBeNull();
    expect(row.intersecting).toBe(false);

    row.bodyEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();

    expect(row.editor).toBeNull();
  });
});
