// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { FakeIntersectionObserver } from "./obsidian-mock";
import { addEntry, createHarness, installFakeRaf, internals, settle, timelineEl, type FakeRaf } from "./journalViewHarness";
import { TextareaEditor } from "../src/views/TextareaEditor";

/**
 * Staged mounting and hysteresis
 * (docs/superpowers/specs/2026-10-21-residency-and-staged-mounting-design.md
 * section 2): `mountObserver` only mounts, `keepObserver` (a wider band) only
 * unmounts, and rows entering the mount margin off screen are mounted a few
 * per frame, nearest first, instead of all in one callback.
 *
 * Geometry is stubbed per element: `FakeIntersectionObserver.trigger` reads
 * `boundingClientRect` from `target.getBoundingClientRect()`, and the callback
 * compares it with `contentEl.getBoundingClientRect()`. The viewport here is
 * y 0..1000; a row at y >= 1100 is inside the mount margin but off screen.
 */

let raf: FakeRaf;

beforeEach(() => {
  vi.useFakeTimers();
  raf = installFakeRaf(window as unknown as Window & typeof globalThis);
});

afterEach(() => {
  raf.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function rect(top: number, height = 50): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect;
}

function place(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () => rect(top);
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openWith(count: number) {
  const h = createHarness();
  const files: TFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push(addEntry(h, new Date(2026, 7, 12, 20, 0, 0 - i), `entry ${i}`));
  }
  h.service.load();
  await h.view.onOpen();
  await settle();
  const view = internals(h.view);
  (view.contentEl as HTMLElement).getBoundingClientRect = () => rect(0, 1000);
  const rows = files.map((file) => view.rendered.get(file.path));
  return {
    h,
    view,
    files,
    rows,
    mount: view.mountObserver as FakeIntersectionObserver,
    keep: view.keepObserver as FakeIntersectionObserver,
    residency: view.residencyObserver as FakeIntersectionObserver,
  };
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
}

describe("JournalView hysteresis", () => {
  it("observes every row on a keep band 600px wider than the mount margin", async () => {
    const { h, keep, mount } = await openWith(2);
    expect(keep).toBeTruthy();
    expect(mount.rootMargin).toBe("400px 0px");
    expect(keep.rootMargin).toBe("1000px 0px");
    const rows = Array.from(timelineEl(h.view).querySelectorAll(".journal-entry"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(keep.observed.has(row)).toBe(true);
  });

  it("is recreated on reload, with the rows of the new timeline", async () => {
    const { h, view, keep } = await openWith(1);

    await h.view.reload();
    await settle();

    const next = view.keepObserver as FakeIntersectionObserver;
    expect(next).not.toBe(keep);
    expect(keep.observed.size).toBe(0);
    const row = timelineEl(h.view).querySelector(".journal-entry") as Element;
    expect(next.observed.has(row)).toBe(true);
  });

  it("leaving the mount margin alone does not unmount", async () => {
    const { rows, mount, keep } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    expect(row.editor).not.toBeNull();

    mount.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();

    expect(row.intersecting).toBe(false);
    expect(row.withinKeep).toBe(true);
    expect(row.editor).not.toBeNull();
    expect(row.bodyEl.querySelector("textarea")).toBeTruthy();
  });

  it("leaving the keep band unmounts and restores static rendering", async () => {
    const { rows, mount, keep } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    mount.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();

    keep.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();

    expect(row.withinKeep).toBe(false);
    expect(row.editor).toBeNull();
    expect(row.bodyEl.querySelector("textarea")).toBeNull();
    expect(row.bodyEl.textContent).toContain("entry 0");
  });

  it("the flush-race decline reads withinKeep: back inside the keep band (but not the mount margin) while flushing keeps the editor", async () => {
    const { h, rows, mount, keep } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    mount.trigger([{ target: row.el, isIntersecting: false }]);

    // Dirty, so the flush really reaches `vault.process`, which is held open.
    typeInto(row.bodyEl.querySelector("textarea") as HTMLTextAreaElement, "typed before leaving");
    const gate = deferred();
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    h.app.vault.process = async (...args: Parameters<typeof originalProcess>) => {
      await gate.promise;
      return originalProcess(...args);
    };

    keep.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();
    // Back into the band while the flush is in flight — never the mount margin.
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    expect(row.intersecting).toBe(false);
    gate.release();
    await settle();
    await settle();

    expect(row.editor).not.toBeNull();
    expect(row.editor.getValue()).toBe("typed before leaving");
    expect(h.app.vault.contents.get(row.entry.file.path)).toContain("typed before leaving");
    expect(internals(h.view).mountOrder).toContain(row.entry.file.path);
  });

  it("an editor that blurs inside the keep band stays mounted, and unmounts on blur once outside it", async () => {
    const { rows, mount, keep } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    const textarea = row.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();

    mount.trigger([{ target: row.el, isIntersecting: false }]);
    textarea.blur();
    await settle();
    expect(row.editor).not.toBeNull();

    textarea.focus();
    keep.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();
    // Focused: declined.
    expect(row.editor).not.toBeNull();
    textarea.blur();
    await settle();
    expect(row.editor).toBeNull();
  });
});

describe("JournalView staged mounting", () => {
  it("a row on screen mounts in the callback, without waiting for a frame", async () => {
    const { rows, mount } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);

    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();

    expect(row.editor).not.toBeNull();
    expect(row.editor.getValue()).toBe("entry 0");
  });

  it("off-screen rows mount two per frame, nearest first", async () => {
    const { rows, mount } = await openWith(5);
    // Distances from the viewport centre (y 500): 625, 825, 725, 1025, 925.
    const tops = [1100, 1300, 1200, 1500, 1400];
    rows.forEach((row, i) => place(row.el, tops[i]));

    mount.trigger(rows.map((row) => ({ target: row.el, isIntersecting: true })));
    await settle();
    expect(rows.map((row) => row.editor !== null)).toEqual([false, false, false, false, false]);

    raf.flush();
    await settle();
    expect(rows.map((row) => row.editor !== null)).toEqual([true, false, true, false, false]);

    raf.flush();
    await settle();
    expect(rows.map((row) => row.editor !== null)).toEqual([true, true, true, false, true]);

    raf.flush();
    await settle();
    expect(rows.map((row) => row.editor !== null)).toEqual([true, true, true, true, true]);

    // Nothing left to schedule.
    raf.flush();
    await settle();
    expect(rows[0].editor).not.toBeNull();
  });

  it("a row that left the mount margin before its turn is skipped", async () => {
    const { h, rows, mount } = await openWith(3);
    const tops = [1100, 1200, 1300];
    rows.forEach((row, i) => place(row.el, tops[i]));
    const read = vi.spyOn(h.repository, "readBody");

    mount.trigger(rows.map((row) => ({ target: row.el, isIntersecting: true })));
    mount.trigger([{ target: rows[0].el, isIntersecting: false }]);
    raf.flush();
    await settle();

    expect(rows.map((row) => row.editor !== null)).toEqual([false, true, true]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(rows[0].bodyEl.textContent).toContain("entry 0");
  });

  it("reload clears the queue and cancels the frame", async () => {
    const { h, view, rows, mount } = await openWith(3);
    rows.forEach((row, i) => place(row.el, 1100 + i * 100));
    mount.trigger(rows.map((row) => ({ target: row.el, isIntersecting: true })));
    expect(view.pendingMounts.size).toBe(3);

    await h.view.reload();
    await settle();
    expect(view.pendingMounts.size).toBe(0);

    const read = vi.spyOn(h.repository, "readBody");
    raf.flush();
    await settle();
    expect(read).not.toHaveBeenCalled();
    for (const row of rows) expect(row.editor).toBeNull();
    for (const row of view.rendered.values()) expect(row.editor).toBeNull();
  });

  it("a queued row that residency re-renders is never left empty when it leaves before its turn", async () => {
    const { rows, mount, residency } = await openWith(1);
    const [row] = rows;
    const bodyEl = row.bodyEl as HTMLElement;
    Object.defineProperty(bodyEl, "offsetHeight", { configurable: true, value: 120 });
    residency.trigger([{ target: row.el, isIntersecting: false }]);
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(true);

    // A long jump: mount (off screen, so queued) and residency in one frame.
    place(row.el, 1100);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    residency.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    // Gone again before the queue reached it.
    mount.trigger([{ target: row.el, isIntersecting: false }]);
    raf.flush();
    await settle();

    expect(row.editor).toBeNull();
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(false);
    expect(bodyEl.textContent).toContain("entry 0");
    expect(bodyEl.style.minHeight).toBe("");
  });

  it("ignores a stale element on the mount and keep observers whose path now belongs to a live row", async () => {
    const { rows, mount, keep } = await openWith(1);
    const [row] = rows;
    const stale = document.createElement("div");
    stale.dataset.path = row.el.dataset.path;
    place(stale, 100);

    mount.trigger([{ target: stale, isIntersecting: true }]);
    raf.flush();
    await settle();
    expect(row.intersecting).toBe(false);
    expect(row.editor).toBeNull();

    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    expect(row.editor).not.toBeNull();

    keep.trigger([{ target: stale, isIntersecting: false }]);
    await settle();
    expect(row.withinKeep).toBe(true);
    expect(row.editor).not.toBeNull();
  });
});

describe("JournalView tapping a queued row", () => {
  it("a tap on a row still queued in pendingMounts mounts once, and the editor it mounts gets the caret", async () => {
    const { h, view, rows, mount } = await openWith(1);
    const [row] = rows;
    // Queued: inside the mount margin, off screen.
    place(row.el, 1100);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    expect(view.pendingMounts.has(row)).toBe(true);
    // Scrolled on screen with no new observer transition, then tapped.
    place(row.el, 100);
    const read = vi.spyOn(h.repository, "readBody");
    const focus = vi.spyOn(TextareaEditor.prototype, "focus");

    row.bodyEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The queue's frame arrives while the tap's mount is still reading.
    raf.flush();
    await settle();
    raf.flush();
    await settle();

    expect(row.editor).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.instances[0]).toBe(row.editor);
  });

  it("the queue skips a row whose mount is already in flight, even if it is still queued", async () => {
    const { h, view, rows, mount } = await openWith(1);
    const [row] = rows;
    place(row.el, 1100);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    const read = vi.spyOn(h.repository, "readBody");

    // A mount started some other way, leaving the row in the queue.
    const inFlight = view.mountEditor(row);
    expect(view.pendingMounts.has(row)).toBe(true);
    raf.flush();
    await inFlight;
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(row.editor).not.toBeNull();
    expect(row.mountsInFlight).toBe(0);
  });
});

describe("JournalView unmount freeze", () => {
  it("an unmount freezes the height as the intrinsic size too, and it survives the static render", async () => {
    const { rows, mount, keep } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    Object.defineProperty(row.bodyEl, "offsetHeight", { configurable: true, value: 120 });
    mount.trigger([{ target: row.el, isIntersecting: false }]);

    keep.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();

    expect(row.editor).toBeNull();
    expect(row.bodyEl.style.minHeight).toBe("");
    expect(row.bodyEl.classList.contains("is-static")).toBe(true);
    expect(row.bodyEl.style.getPropertyValue("contain-intrinsic-size")).toBe("auto 120px");
  });
});

describe("JournalView residency after an editor goes", () => {
  it("a row that left residency while focused is unloaded once its editor blurs and unmounts", async () => {
    const { rows, mount, keep, residency } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    const textarea = row.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    Object.defineProperty(row.bodyEl, "offsetHeight", { configurable: true, value: 120 });

    // A long flick with the caret still in it: out of every band at once.
    mount.trigger([{ target: row.el, isIntersecting: false }]);
    keep.trigger([{ target: row.el, isIntersecting: false }]);
    residency.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();
    expect(row.editor).not.toBeNull();
    expect(row.bodyEl.classList.contains("is-dehydrated")).toBe(false);

    textarea.blur();
    await settle();

    expect(row.editor).toBeNull();
    expect(row.bodyEl.classList.contains("is-dehydrated")).toBe(true);
    expect(row.renderComponent).toBeNull();
    expect(row.bodyEl.childNodes).toHaveLength(0);
    expect(row.bodyEl.style.minHeight).toBe("120px");
  });

  it("a row still inside residency keeps its rendered body when its editor unmounts", async () => {
    const { rows, mount, keep, residency } = await openWith(1);
    const [row] = rows;
    place(row.el, 100);
    residency.trigger([{ target: row.el, isIntersecting: true }]);
    keep.trigger([{ target: row.el, isIntersecting: true }]);
    mount.trigger([{ target: row.el, isIntersecting: true }]);
    await settle();
    mount.trigger([{ target: row.el, isIntersecting: false }]);

    keep.trigger([{ target: row.el, isIntersecting: false }]);
    await settle();

    expect(row.editor).toBeNull();
    expect(row.bodyEl.classList.contains("is-dehydrated")).toBe(false);
    expect(row.bodyEl.textContent).toContain("entry 0");
  });
});

describe("JournalView row removal", () => {
  it("a removed row is unobserved by all three observers and dropped from the queue", async () => {
    const { h, view, files, rows, mount, keep, residency } = await openWith(2);
    const [doomed, survivor] = rows;
    place(doomed.el, 1100);
    mount.trigger([{ target: doomed.el, isIntersecting: true }]);
    expect(view.pendingMounts.has(doomed)).toBe(true);

    h.app.vault.trigger("delete", files[0]);
    vi.advanceTimersByTime(300);
    await settle();

    expect(view.rendered.has(files[0].path)).toBe(false);
    for (const observer of [mount, keep, residency]) {
      expect(observer.observed.has(doomed.el)).toBe(false);
      expect(observer.observed.has(survivor.el)).toBe(true);
    }
    expect(view.pendingMounts.has(doomed)).toBe(false);
  });
});
