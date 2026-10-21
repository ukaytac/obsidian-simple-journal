// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeIntersectionObserver } from "./obsidian-mock";
import { addEntry, createHarness, internals, settle, timelineEl } from "./journalViewHarness";
import { formatCreatedProperty } from "../src/utils/dates";

/**
 * Residency (docs/superpowers/specs/2026-10-21-residency-and-staged-mounting-design.md
 * section 1): a static row far outside the viewport gives back its rendered
 * body and its `Component`, keeping its height, and renders again from disk
 * when it comes back.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openWith(body = "alpha body") {
  const h = createHarness();
  const at = new Date(2026, 7, 12, 9, 0, 0);
  const file = addEntry(h, at, body);
  h.service.load();
  await h.view.onOpen();
  await settle();
  const view = internals(h.view);
  const rendered = view.rendered.get(file.path);
  const residency = view.residencyObserver as FakeIntersectionObserver;
  return { h, at, file, view, rendered, residency };
}

describe("JournalView residency", () => {
  it("observes every row, far outside the mount margin", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "a");
    addEntry(h, new Date(2026, 7, 11, 9, 0, 0), "b");
    h.service.load();
    await h.view.onOpen();
    await settle();

    const residency = internals(h.view).residencyObserver as FakeIntersectionObserver;
    expect(residency).toBeTruthy();
    expect(residency.rootMargin).toBe("3000px 0px");
    const rows = Array.from(timelineEl(h.view).querySelectorAll(".journal-entry"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(residency.observed.has(row)).toBe(true);
  });

  it("is recreated on reload, with the rows of the new timeline", async () => {
    const { h, view, residency } = await openWith();

    await h.view.reload();
    await settle();

    const next = view.residencyObserver as FakeIntersectionObserver;
    expect(next).not.toBe(residency);
    expect(residency.observed.size).toBe(0);
    const row = timelineEl(h.view).querySelector(".journal-entry") as Element;
    expect(next.observed.has(row)).toBe(true);
  });

  it("a static row leaving is emptied, keeps its height, has its component unloaded, and is marked", async () => {
    const { rendered, residency } = await openWith();
    const bodyEl = rendered.bodyEl as HTMLElement;
    expect(bodyEl.textContent).toContain("alpha body");
    Object.defineProperty(bodyEl, "offsetHeight", { configurable: true, value: 120 });
    const component = rendered.renderComponent;
    const unload = vi.spyOn(component, "unload");

    residency.trigger([{ target: rendered.el, isIntersecting: false }]);

    expect(unload).toHaveBeenCalledTimes(1);
    expect(rendered.renderComponent).toBeNull();
    expect(bodyEl.childNodes).toHaveLength(0);
    expect(bodyEl.style.minHeight).toBe("120px");
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(true);
    expect(bodyEl.classList.contains("is-static")).toBe(false);
  });

  it("entering re-renders the row and clears the held height once it lands", async () => {
    const { rendered, residency } = await openWith();
    const bodyEl = rendered.bodyEl as HTMLElement;
    Object.defineProperty(bodyEl, "offsetHeight", { configurable: true, value: 120 });
    residency.trigger([{ target: rendered.el, isIntersecting: false }]);

    residency.trigger([{ target: rendered.el, isIntersecting: true }]);
    // Held across the read.
    expect(bodyEl.style.minHeight).toBe("120px");
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(false);
    await settle();

    expect(bodyEl.textContent).toContain("alpha body");
    expect(bodyEl.style.minHeight).toBe("");
    expect(bodyEl.classList.contains("is-static")).toBe(true);
    expect(rendered.renderComponent).not.toBeNull();
  });

  it("entering does nothing to a row that was never unloaded", async () => {
    const { h, rendered, residency } = await openWith();
    const cached = vi.spyOn(h.repository, "readBodyCached");

    residency.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();

    expect(cached).not.toHaveBeenCalled();
    expect(rendered.bodyEl.textContent).toContain("alpha body");
  });

  it("a row coming back inside the mount margin is left to the mount, which clears the mark and the height", async () => {
    const { view, rendered, residency } = await openWith();
    const bodyEl = rendered.bodyEl as HTMLElement;
    Object.defineProperty(bodyEl, "offsetHeight", { configurable: true, value: 120 });
    residency.trigger([{ target: rendered.el, isIntersecting: false }]);

    // A long jump: both observers report in the same frame, mount first.
    (view.mountObserver as FakeIntersectionObserver).trigger([{ target: rendered.el, isIntersecting: true }]);
    residency.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();

    expect(rendered.editor).not.toBeNull();
    expect(rendered.editor.getValue()).toBe("alpha body");
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(false);
    expect(bodyEl.style.minHeight).toBe("");
  });

  it("never unloads a row with an editor", async () => {
    const { view, rendered, residency } = await openWith();
    (view.mountObserver as FakeIntersectionObserver).trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    expect(rendered.editor).not.toBeNull();
    const token = rendered.opToken;

    residency.trigger([{ target: rendered.el, isIntersecting: false }]);

    expect(rendered.editor).not.toBeNull();
    expect(rendered.editor.getValue()).toBe("alpha body");
    expect(rendered.bodyEl.querySelector("textarea")).not.toBeNull();
    expect(rendered.bodyEl.classList.contains("is-dehydrated")).toBe(false);
    expect(rendered.opToken).toBe(token);
  });

  it("ignores a stale element whose path now belongs to a different row", async () => {
    const { view, rendered, residency } = await openWith();
    const stale = document.createElement("div");
    stale.dataset.path = rendered.el.dataset.path;

    residency.trigger([{ target: stale, isIntersecting: false }]);

    expect(view.rendered.get(rendered.el.dataset.path)).toBe(rendered);
    expect(rendered.bodyEl.classList.contains("is-dehydrated")).toBe(false);
    expect(rendered.bodyEl.textContent).toContain("alpha body");
  });

  it("an external change to an unloaded row does not render it, and it comes back with the new text", async () => {
    const { h, at, file, rendered, residency } = await openWith("original body");
    const bodyEl = rendered.bodyEl as HTMLElement;
    residency.trigger([{ target: rendered.el, isIntersecting: false }]);

    h.app.vault.contents.set(file.path, `---\ncreated: "${formatCreatedProperty(at)}"\n---\n\nchanged elsewhere`);
    h.app.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);
    await settle();

    expect(bodyEl.childNodes).toHaveLength(0);
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(true);
    expect(rendered.renderComponent).toBeNull();

    residency.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    expect(bodyEl.textContent).toContain("changed elsewhere");
  });

  it("a render in flight when the row is unloaded does not write into it", async () => {
    const { h, view, rendered, residency } = await openWith();
    const bodyEl = rendered.bodyEl as HTMLElement;
    Object.defineProperty(bodyEl, "offsetHeight", { configurable: true, value: 120 });
    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });

    const inFlight = view.renderStatic(rendered);
    residency.trigger([{ target: rendered.el, isIntersecting: false }]);
    gate.release();
    await inFlight;
    await settle();

    expect(bodyEl.childNodes).toHaveLength(0);
    expect(bodyEl.classList.contains("is-dehydrated")).toBe(true);
    expect(bodyEl.style.minHeight).toBe("120px");
    expect(rendered.renderComponent).toBeNull();
  });
});
