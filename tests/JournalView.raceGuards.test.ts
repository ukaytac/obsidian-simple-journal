// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

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

/**
 * Wraps `fn` so every call first awaits `g.promise` before doing its real
 * work — the real work (reading the fake vault's in-memory map, etc.) still
 * runs correctly once released; only ITS TIMING is under the test's control.
 */
function gated<A extends unknown[], R>(g: ReturnType<typeof gate>, fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    await g.promise;
    return fn(...args);
  };
}

/**
 * These pin the `generation`/`opToken` guards `mountEditor`, `renderStatic`,
 * and `unmountEditor` each carry around their one `await` — see
 * `RenderedEntry.opToken`'s doc and `generation`'s doc in `JournalView.ts`.
 * The composer suite already pins the analogous `claimedGeneration` bail for
 * `commitComposer`; nothing outside it previously exercised these three.
 *
 * Every test here holds a real async gap open (a stubbed `vault.read` or
 * `vault.process` that awaits a manually-released gate) rather than relying
 * on incidental microtask timing, so the race is genuinely reproduced, not
 * merely asserted to be handled.
 */
describe("JournalView generation/opToken race guards", () => {
  it("mountEditor bails on a reload that lands while it is still reading the file", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered.get(file.path);
    rendered.intersecting = true;

    const g = gate();
    const originalRead = h.app.vault.read.bind(h.app.vault);
    h.app.vault.read = gated(g, originalRead);

    const mountPromise = internals(h.view).mountEditor(rendered);

    // The reload's own rebuild does not need the gate released: its own
    // `appendEntry`/`renderStatic` calls for the fresh entries it creates are
    // fire-and-forget, so `reload()` itself completes regardless of what
    // `mountEditor`'s in-flight read is still waiting on.
    await h.view.reload();
    expect(internals(h.view).rendered.get(file.path)).not.toBe(rendered);

    g.release();
    await mountPromise;
    await settle();

    // The stale RenderedEntry from the discarded generation must never have
    // mounted — the guard bails before touching `rendered.editor` at all.
    expect(rendered.editor).toBeNull();
  });

  it("renderStatic bails on a reload that lands while it is still reading the file", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();
    await settle();

    const rendered = internals(h.view).rendered.get(file.path);

    const g = gate();
    const originalRead = h.app.vault.read.bind(h.app.vault);
    h.app.vault.read = gated(g, originalRead);

    // Simulates a fresh static re-render already in flight for this entry
    // (e.g. one `unmountEditor` just started) when a reload supersedes it.
    const staticPromise = internals(h.view).renderStatic(rendered);
    expect(rendered.bodyEl.textContent).toBe("");

    await h.view.reload();

    g.release();
    await staticPromise;
    await settle();

    // Guarded: the stale entry's `bodyEl` is never written into once its
    // generation has been superseded, so it stays exactly as this
    // (superseded) renderStatic call itself left it before awaiting.
    expect(rendered.bodyEl.textContent).toBe("");
  });

  it("unmountEditor bails on a reload that lands while its flush is still in flight", async () => {
    const h = createHarness();
    const file = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "original body");
    h.service.load();
    await h.view.onOpen();

    const rendered = internals(h.view).rendered.get(file.path);
    const mountObserver = internals(h.view).mountObserver;
    mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
    await settle();
    expect(rendered.editor).not.toBeNull();
    expect(rendered.editor.hasFocus()).toBe(false); // not focused, so unmountEditor won't decline on that basis

    // Dirty the entry first: `mountLifecycle.ts`'s `unmountEditor` calls
    // `entrySave.ts`'s `flushSave`/`save` directly (via an injected
    // `SaveDeps`), not through a `JournalView` method — so there is no
    // `view.flushSave` to monkey-patch any more, and an unedited entry's
    // flush would skip the write entirely (`saveIfChanged`'s no-op path),
    // leaving nothing to gate. Editing first means the flush this test cares
    // about actually reaches `vault.process`.
    const textarea = rendered.bodyEl.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "edited, not yet flushed";
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));

    // Gates only the very first call to the real dependency underneath the
    // save pipeline — the one the direct `unmountEditor` call below is about
    // to make — and lets every later call (in particular `clearTimeline`'s
    // own re-flush of the same entry, a few lines down) through immediately.
    // This is what makes the race deterministic: `clearTimeline` — and the
    // destroy loop right after its own flush — runs to completion, via a
    // fully-awaited `reload()`, entirely BEFORE this gate is ever released,
    // rather than leaving two same-shaped promise chains to race each
    // other's microtask ordering.
    const g = gate();
    let gateArmed = true;
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    h.app.vault.process = async (...args: Parameters<typeof originalProcess>) => {
      if (gateArmed) {
        gateArmed = false;
        await g.promise;
      }
      return originalProcess(...args);
    };

    // Not going through the observer here (fire-and-forget): calling
    // directly and awaiting means a guard removal that lets this throw
    // (see below) fails the test loudly instead of becoming a silent
    // unhandled rejection.
    const unmountPromise = internals(h.view).unmountEditor(rendered);

    // Runs to completion: `clearTimeline`'s own flush of this same entry
    // goes through the (now un-gated) real `vault.process` and resolves
    // immediately, so nothing here depends on `g` — `reload()` fully
    // rebuilds the timeline, generation bumped and this entry's editor
    // already destroyed, before the line below ever runs.
    await h.view.reload();
    expect(internals(h.view).rendered.get(file.path)).not.toBe(rendered);
    expect(rendered.editor).toBeNull();

    g.release();

    // Guarded: bails on the stale generation instead of touching an editor
    // `clearTimeline` already destroyed. Removing the guard makes this
    // throw instead (`rendered.editor` is null: `null.hasFocus()`), which
    // turns this rejection, not a passing assertion, into the failure.
    await expect(unmountPromise).resolves.toBeUndefined();
    expect(rendered.editor).toBeNull();
  });
});

/**
 * Pins `enqueueTimelineMutation`'s serialization: queued mutations run in
 * the order they were enqueued, and a task that throws neither wedges the
 * chain nor stops a later task from running.
 *
 * A genuine finding surfaced while building this: the implementation
 * carries two independent mechanisms for "a throw doesn't break the chain
 * for the next enqueue" — passing `task` as both the fulfillment AND
 * rejection handler on the previous link (`.then(task, task)`), and
 * re-sanitizing `this.timelineMutationChain` to a never-rejecting promise
 * immediately afterwards (`result.catch(() => undefined)`). Because that
 * reassignment happens synchronously, in the same call, before any other
 * caller can ever read the field again, `this.timelineMutationChain` is
 * provably never a rejected promise at the moment any `.then()` call reads
 * it — which means the `.then(task, task)` double-handler is dead code
 * *given* the `.catch()` line stays, and the `.catch()` line is equally dead
 * *given* the double-handler stays. Deleting either one alone leaves this
 * test green; only deleting both together turns it red. The test below
 * mutates both to demonstrate this, and pins the pair as the actual unit of
 * behaviour, rather than claiming either line in isolation is load-bearing.
 */
describe("JournalView enqueueTimelineMutation serialization", () => {
  it("runs enqueued mutations in order, and a throwing task neither breaks the chain nor loses the next one", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();

    const order: string[] = [];
    const view = internals(h.view);

    const firstGate = gate();
    const p1 = view.enqueueTimelineMutation(async () => {
      order.push("first-start");
      await firstGate.promise;
      order.push("first-end");
    });
    const p2 = view.enqueueTimelineMutation(async () => {
      order.push("second");
      throw new Error("boom");
    });
    const p3 = view.enqueueTimelineMutation(async () => {
      order.push("third");
      return "third-result";
    });

    // Nothing past the first task has started: it is still holding the
    // chain open on `firstGate`.
    await settle();
    expect(order).toEqual(["first-start"]);

    firstGate.release();
    await settle();
    await settle();
    await settle();

    // Strict order, not just "all eventually ran": the second and third
    // tasks' own bodies never started until the first's turn finished.
    expect(order).toEqual(["first-start", "first-end", "second", "third"]);

    // Each call's own returned promise still carries ITS OWN real outcome...
    await expect(p2).rejects.toThrow("boom");
    // ...while the failure is fully contained: the next enqueued mutation
    // still ran and resolved normally, never blocked behind p2's rejection.
    await expect(p3).resolves.toBe("third-result");
    await expect(p1).resolves.toBeUndefined();
  });
});
