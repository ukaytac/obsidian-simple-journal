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
   * FAILS against the current implementation — a genuine gap found while
   * writing this suite, not a pre-existing known one.
   *
   * `enforceMountLimit`'s backstop exists, per `mountWindow.ts`'s own doc,
   * for exactly this shape: "more entries simultaneously within
   * MOUNT_ROOT_MARGIN than MAX_MOUNTED_EDITORS allows — a very tall pane,
   * or many short entries packed into MOUNT_ROOT_MARGIN." But every entry
   * in that scenario is, by definition, currently `intersecting` — and
   * `unmountEditor` unconditionally declines to unmount ANY entry with
   * `rendered.intersecting === true` (see its own "Re-entered
   * MOUNT_ROOT_MARGIN while the flush was in flight" branch), re-adding it
   * to `mountOrder` via `ensureMountOrderContains` instead of tearing it
   * down.
   *
   * `enforceMountLimit` (in `mountWindow.ts`) splices its chosen victim out
   * of `mountOrder` SYNCHRONOUSLY, before ever calling `onEvict` — so its
   * own `while (order.length > max)` loop sees the count drop and can
   * correctly select `max` survivors in one synchronous pass. But
   * `onEvict` here is `void this.unmountEditor(rendered)`, fire-and-forget:
   * every one of those evictions is an async call that, once it actually
   * runs, finds `rendered.intersecting` still true (nothing changed it) and
   * calls `ensureMountOrderContains` — which pushes the very same path
   * back onto the end of `mountOrder`. Once all of them have resolved, the
   * count is back to its pre-eviction size; only the *order* of
   * `mountOrder` changed. Net result: when every candidate is intersecting
   * — precisely the scenario this backstop's doc cites as its reason to
   * exist — it does not actually bound the mounted count at all.
   */
  it.fails("enforces the mount cap: mounting beyond MAX_MOUNTED_EDITORS evicts down to the cap", async () => {
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
});
