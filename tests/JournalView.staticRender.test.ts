// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle } from "./journalViewHarness";

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

describe("JournalView static rendering", () => {
  it("reads entry bodies through the cached read, never the uncached one", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    const cached = vi.spyOn(h.repository, "readBodyCached");
    const uncached = vi.spyOn(h.repository, "readBody");

    await h.view.onOpen();
    await settle();

    expect(cached).toHaveBeenCalledTimes(1);
    expect(uncached).not.toHaveBeenCalled();
  });

  it("marks a body pending until its first render lands, then clears the mark", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });

    await h.view.onOpen();
    await settle();
    const bodyEl = internals(h.view).rendered.get(a.path).bodyEl as HTMLElement;
    expect(bodyEl.classList.contains("is-pending")).toBe(true);

    gate.release();
    await settle();

    expect(bodyEl.classList.contains("is-pending")).toBe(false);
    expect(bodyEl.textContent).toContain("alpha body");
  });

  it("leaves no min-height behind after a render", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const rendered = internals(h.view).rendered.get(a.path);
    Object.defineProperty(rendered.bodyEl, "offsetHeight", { configurable: true, value: 120 });

    await internals(h.view).renderStatic(rendered);

    expect((rendered.bodyEl as HTMLElement).style.minHeight).toBe("");
  });

  it("renders a known body without reading the file at all", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const rendered = internals(h.view).rendered.get(a.path);
    const cached = vi.spyOn(h.repository, "readBodyCached");
    const uncached = vi.spyOn(h.repository, "readBody");

    await internals(h.view).renderStatic(rendered, "known text");

    expect(cached).not.toHaveBeenCalled();
    expect(uncached).not.toHaveBeenCalled();
    expect((rendered.bodyEl as HTMLElement).textContent).toContain("known text");
  });
});

describe("JournalView off-screen skipping", () => {
  it("marks a rendered static body as skippable, and an editor's body as not", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const rendered = internals(h.view).rendered.get(a.path);
    expect((rendered.bodyEl as HTMLElement).classList.contains("is-static")).toBe(true);

    const mountObserver = internals(h.view).mountObserver as {
      trigger(states: Array<{ target: Element; isIntersecting: boolean }>): void;
    };
    mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    expect(rendered.editor).not.toBeNull();
    expect((rendered.bodyEl as HTMLElement).classList.contains("is-static")).toBe(false);

    // Unmounting is the keep band's job since staged mounting; leaving the
    // mount margin alone no longer tears an editor down.
    const keepObserver = internals(h.view).keepObserver as {
      trigger(states: Array<{ target: Element; isIntersecting: boolean }>): void;
    };
    keepObserver.trigger([{ target: rendered.el, isIntersecting: false }]);
    await settle();
    expect(rendered.editor).toBeNull();
    expect((rendered.bodyEl as HTMLElement).classList.contains("is-static")).toBe(true);
  });

  it("does not mark a body whose render was superseded by a mount", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });
    await h.view.onOpen();
    const rendered = internals(h.view).rendered.get(a.path);
    (internals(h.view).mountObserver as {
      trigger(states: Array<{ target: Element; isIntersecting: boolean }>): void;
    }).trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    gate.release();
    await settle();

    expect(rendered.editor).not.toBeNull();
    expect((rendered.bodyEl as HTMLElement).classList.contains("is-static")).toBe(false);
  });
});
