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
   * FAILS against the current implementation — pins the intended behaviour
   * per the task brief, not a claim that this is unintentional: this is the
   * open "composer bug" `JournalView.startNewEntry`/`openComposer` and
   * `main.ts`'s `newEntry` currently carry TEMPORARY TRACE console logging
   * for. `clearTimeline` (run by every `reload()`, including one triggered
   * by something entirely unrelated to the composer — a settings change, a
   * folder-rename `"reload"` change, ...) unconditionally destroys an open,
   * uncommitted composer:
   *
   * ```
   * if (this.composer) {
   *   ...
   *   this.composer.editor?.destroy();
   *   this.composer = null;
   * }
   * ```
   *
   * with only a `console.debug`/`console.error` left behind as a trace. An
   * unrelated background reload should not be able to silently sweep away a
   * composer the user has open (and may be about to type into) — that is
   * the "does not silently sweep an open composer away" requirement this
   * test pins.
   */
  it.fails("a reload triggered by something unrelated does not discard an open, empty composer", async () => {
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
});
