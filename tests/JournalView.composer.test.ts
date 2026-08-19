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

/** Dispatches a real input event with `inputType` set, as a live editor produces. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
}

function composerTextarea(view: ReturnType<typeof createHarness>["view"]): HTMLTextAreaElement {
  const textarea = internals(view).composer?.bodyEl.querySelector("textarea");
  if (!textarea) throw new Error("no composer textarea mounted");
  return textarea as HTMLTextAreaElement;
}

describe("JournalView composer lifecycle", () => {
  it("opens an uncommitted composer at the top of today, with no file created yet", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();

    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();
    expect(h.app.vault.files.size).toBe(0);

    const composerEl = internals(h.view).timelineEl.querySelector(".journal-entry-composer") as HTMLElement | null;
    expect(composerEl).toBeTruthy();
    // No entry yet to act on: both affordances start disabled/hidden (see
    // `createEntryEl`'s doc), and `commitComposer` is what turns them on.
    expect(composerEl!.querySelector<HTMLButtonElement>(".journal-entry-time")!.disabled).toBe(true);
    expect(
      composerEl!.querySelector(".journal-entry-actions")!.classList.contains("journal-entry-actions-pending"),
    ).toBe(true);
  });

  it("the very first meaningful keystroke commits a real, titleless Markdown file", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    typeInto(composerTextarea(h.view), "First thought of the day");
    await settle();
    await settle();

    expect(h.app.vault.files.size).toBe(1);
    const [path] = h.app.vault.files.keys();
    expect(h.app.vault.contents.get(path)).toContain("First thought of the day");
    // No `# Heading` was injected — CLAUDE.md's "no titles" requirement.
    expect(h.app.vault.contents.get(path)).not.toMatch(/^#/m);

    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).rendered.has(path)).toBe(true);
    const rowEl = internals(h.view).timelineEl.querySelector(`[data-path="${path}"]`);
    expect(rowEl?.classList.contains("journal-entry-composer")).toBe(false);
  });

  it("abandoning an empty, focused composer removes it and creates no file", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    const textarea = composerTextarea(h.view);
    textarea.focus();
    textarea.blur();
    await settle();

    expect(internals(h.view).composer).toBeNull();
    expect(h.app.vault.files.size).toBe(0);
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeNull();
  });

  it("a blur that never followed a real focus does not discard the composer", async () => {
    // openComposer's own activation-churn guard: a leaf being activated can
    // blur the composer before it was ever genuinely focused, and that must
    // not read as abandonment (see `composerEverFocused`'s doc). In this
    // harness `openComposer` itself already calls `editor.focus()`
    // synchronously, so `composerEverFocused` is already true by the time
    // `startNewEntry()` returns — reproducing the actual "blur races
    // focus" window needs reaching past that (real Obsidian's own
    // leaf-activation focus-stealing is exactly the timing this guards
    // against, and isn't reproducible from outside a live workspace), so
    // this resets the guard field directly to exercise its own branch.
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();
    internals(h.view).composerEverFocused = false;

    composerTextarea(h.view).dispatchEvent(new FocusEvent("blur"));
    await settle();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });

  /**
   * Pins the fix for the "composer bug": `clearTimeline` (run by every
   * `reload()`, including one triggered by something entirely unrelated to
   * the composer — a settings change, a folder-rename `"reload"` change, or
   * `onOpen`'s own first `reload()` landing after `startNewEntry` already
   * opened one) used to unconditionally destroy an open, uncommitted
   * composer. `reloadNow` now snapshots it via `clearTimeline`'s return
   * value and re-establishes it afterwards (`reestablishComposer`), so an
   * unrelated background reload can no longer silently sweep it away.
   */
  it("a reload triggered by something unrelated does not discard an open, empty composer", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 1, 9, 0, 0), "pre-existing entry");
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();

    // A reload triggered for a reason that has nothing to do with the
    // composer itself (e.g. the settings tab's debounced `refreshJournal`).
    await h.view.reload();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });

  /**
   * Reproduces the user's actual reported path as faithfully as this harness
   * can: "journal not open, `New journal entry` hotkey pressed from another
   * note." `main.ts`'s `newEntry()` is `await this.openJournal(); await
   * view.startNewEntry();`, and `openJournal()`'s doc already flags the
   * hazard under test — `setViewState` resolving does not guarantee
   * `JournalView.onOpen()` has run, let alone finished (`initialLoad`'s doc
   * says the same from the other side).
   *
   * This harness cannot drive that literally: `createHarness`'s
   * `createFakeApp()` returns only `{ vault, metadataCache, fileManager }` —
   * no `app.workspace` at all — and `obsidian-mock.ts`'s `Plugin`/
   * `WorkspaceLeaf` are empty stubs with no `getLeaf`/`setViewState`/
   * `revealLeaf`. Inventing a fake `setViewState` would mean guessing at
   * real Obsidian's closed-source leaf-opening scheduling — exactly the kind
   * of unverified assumption behind the two already-wrong fixes this bug
   * survived (Context7's official API docs describe only that `setViewState`
   * "resolves when the view state has been updated" and `onOpen()` "resolves
   * when the opening process is complete," and say nothing about exact
   * timing or re-invocation), so this deliberately does not go through
   * `main.ts`.
   *
   * Instead it exercises the one adjacent fact the codebase already commits
   * to in its own comments — `JournalView.onOpen can run more than once over
   * a view's life` (see the ribbon "+" action's registration comment) — by
   * calling `onOpen()` a second time after a composer is already open, the
   * same way Obsidian re-invoking it on this instance would. This is a
   * genuine, independently-reachable trigger for the same `clearTimeline`
   * defect the test above pins, not a restatement of it; it is NOT proof
   * that a second `onOpen()` call is what the user's own trace would show —
   * only that if the timing hazard `openJournal`'s doc describes manifests
   * as *any* extra reload landing after `startNewEntry` succeeds (a second
   * `onOpen`, a deferred-leaf hydration, a revealLeaf-triggered refresh —
   * this harness cannot distinguish between them), the fix below is what
   * makes the composer survive it regardless of which one it is.
   */
  it("a composer survives onOpen running again over the view's life", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();

    // Obsidian re-invoking onOpen() on the same view instance later in its
    // life — not a reload the plugin itself chose to trigger.
    await h.view.onOpen();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });
});
