// @vitest-environment jsdom
/**
 * Pins the path `unmountEditor` uses AFTER its flush's await. `mountOrder`
 * and the entry's own `TFile.path` can both be re-keyed to a NEW path while
 * that flush is in flight — `reKeyRenderedEntry`, driven by
 * `commitEntryTimeChange`'s own rename or by an external/sync rename arriving
 * through `applyChangesNow`. The teardown's `order.indexOf(...)` and the
 * three decline branches' `ensureMountOrderContains(...)` (see
 * `mountLifecycle.ts`'s `unmountEditor`) must therefore read the entry's
 * CURRENT path, not one captured before the await: reading the stale path
 * leaves `mountOrder` permanently claiming a mounted editor for an entry
 * that no longer has one, and `pickEvictionCandidate` skips such a phantom
 * (its `MountState` resolves to `undefined`) rather than clearing it — so the
 * effective `MAX_MOUNTED_EDITORS` cap silently shrinks by one for good, and
 * the next mount evicts a live editor that did not need evicting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle } from "./journalViewHarness";
import type { FakeIntersectionObserver } from "./obsidian-mock";

/**
 * A promise plus its own external resolver, so a test can hold an async
 * operation open at a precise `await` point (rather than merely at "the next
 * microtask") and release it once whatever needs to race it has run.
 */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("unmountEditor across a concurrent re-key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("removes the entry from mountOrder even if it is re-keyed mid-flush", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const view = internals(h.view);
    const rendered = view.rendered.get(file.path);
    const mountObserver = view.mountObserver as FakeIntersectionObserver;

    mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    expect(rendered.editor).not.toBeNull();

    const oldPath = file.path;
    expect(view.mountOrder).toContain(oldPath);

    // The entry has genuinely left the mount margin: not focused, not dirty,
    // so `unmountEditor` runs its teardown rather than taking a decline
    // branch.
    rendered.intersecting = false;

    // Dirty the entry so its flush actually reaches `vault.process` — gating
    // that real dependency (rather than a `JournalView` method) is what
    // holds the async gap open here: `mountLifecycle.ts`'s `unmountEditor`
    // calls `entrySave.ts`'s `flushSave`/`save` directly via an injected
    // `SaveDeps`, and an unedited entry's flush would skip the write
    // entirely (`saveIfChanged`'s no-op path), leaving nothing to gate.
    const textarea = rendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "edited before the rename";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));

    const g = gate();
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    h.app.vault.process = async (...args: Parameters<typeof originalProcess>) => {
      await g.promise;
      return originalProcess(...args);
    };

    const unmountPromise = view.unmountEditor(rendered);
    await settle();

    // The rename Obsidian performs by mutating the `TFile` in place, plus the
    // synchronous re-key `commitEntryTimeChange` does rather than waiting for
    // the vault event to come back around.
    const newPath = `${h.folder}/2026/08/2026-08-12-14-30-00.md`;
    await h.app.fileManager.renameFile(file, newPath);
    expect(view.reKeyRenderedEntry(oldPath, newPath)).toBe(true);
    expect(view.mountOrder).toContain(newPath);

    g.release();
    await unmountPromise;
    await settle();

    // The editor is gone...
    expect(rendered.editor).toBeNull();
    // ...so `mountOrder` must not still claim this entry has one mounted.
    expect(view.mountOrder).not.toContain(newPath);
    expect(view.mountOrder).not.toContain(oldPath);
  });
});
