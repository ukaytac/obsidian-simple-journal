// @vitest-environment jsdom
//
// Pins the fix in dac8f26 ("keep watching focus until the deadline, not
// until first success"): the composer bug survived six attempts because the
// retry loop in `openComposer` treated *currently holding focus* as success
// and stopped watching at exactly the moment something else (most likely
// one of the timeline's own embedded editors mounting, per `openComposer`'s
// own doc) went on to steal it. None of the existing composer tests catch
// this — `JournalView.composer.test.ts`'s focus assertions all read state
// immediately after the composer's own synchronous `editor.focus()` call,
// before any `requestAnimationFrame`-driven retry has had a chance to run
// at all, so the very defect that survived five earlier fixes would have
// survived this suite too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, installFakeRaf, internals, type FakeRaf } from "./journalViewHarness";

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

/**
 * Appends a plain, unrelated textarea and focuses it: a stand-in for
 * whatever actually steals focus in the real app — per `openComposer`'s own
 * doc, most likely one of the timeline's own embedded editors mounting,
 * fire-and-forget, as `ObsidianEmbedEditor.mount` calls the embed's
 * `showEditor()`. This harness's fallback `TextareaEditor` has no such
 * editor to reproduce mounting one, so an unrelated textarea plays the same
 * role: something else, genuinely holding focus, that the composer did not
 * hand it to voluntarily.
 */
function stealFocus(): HTMLTextAreaElement {
  const stealer = document.createElement("textarea");
  document.body.appendChild(stealer);
  stealer.focus();
  return stealer;
}

let raf: FakeRaf | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  raf?.restore();
  raf = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("openComposer's focus-claim loop", () => {
  it("retakes focus stolen from a freshly opened composer that has received no input", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    raf = installFakeRaf(internals(h.view).contentEl.win);

    await h.view.startNewEntry();
    const composer = internals(h.view).composer;
    expect(composer.editor.hasFocus()).toBe(true);

    // First frame: nothing has stolen focus yet. Per the fix, holding focus
    // right now is not itself success — the loop only re-arms for the next
    // frame instead of stopping here (which is exactly what let a later
    // theft go unnoticed before dac8f26).
    raf.flush();
    expect(composer.editor.hasFocus()).toBe(true);

    const stealer = stealFocus();
    expect(composer.editor.hasFocus()).toBe(false);
    expect(document.activeElement).toBe(stealer);

    // Second frame: the loop notices focus is gone and retakes it.
    raf.flush();
    expect(composer.editor.hasFocus()).toBe(true);
    expect(document.activeElement).toBe(composerTextarea(h.view));
  });

  it("does not retake focus once the composer has received input", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    raf = installFakeRaf(internals(h.view).contentEl.win);

    await h.view.startNewEntry();
    const composer = internals(h.view).composer;
    raf.flush(); // arms the loop for a second frame

    // Whitespace only (mirrors JournalView.composer.test.ts's "abandoning"
    // test): `composerHasInput` is set on any change without crossing
    // `isMeaningful`'s commit threshold, so `this.composer` stays this same
    // entry — isolating this guard from the "no longer this.composer" one
    // pinned below, which fires even with no input at all.
    typeInto(composerTextarea(h.view), "   ");
    expect(internals(h.view).composerHasInput).toBe(true);
    expect(internals(h.view).composer).toBe(composer);

    const stealer = stealFocus();
    raf.flush();

    expect(composer.editor.hasFocus()).toBe(false);
    expect(document.activeElement).toBe(stealer);
  });

  it("does not retake focus once the claim deadline has lapsed", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    raf = installFakeRaf(internals(h.view).contentEl.win);

    await h.view.startNewEntry();
    const composer = internals(h.view).composer;

    // First frame: still focused, so the loop only re-arms itself.
    raf.flush();

    // Advance the (fake) clock past the claim window (400ms in
    // JournalView.ts's COMPOSER_FOCUS_CLAIM_MS) before the next frame runs,
    // so that frame is the last one the loop ever schedules.
    await vi.advanceTimersByTimeAsync(500);
    raf.flush();

    // Only now, after the loop has stopped scheduling itself, does
    // something else take focus — nothing is left watching to retake it.
    const stealer = stealFocus();
    raf.flush(); // nothing queued: a no-op

    expect(composer.editor.hasFocus()).toBe(false);
    expect(document.activeElement).toBe(stealer);
  });

  it("stops claiming focus for a composer that is no longer this.composer", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    raf = installFakeRaf(internals(h.view).contentEl.win);

    await h.view.startNewEntry();
    const composer = internals(h.view).composer;
    raf.flush(); // arms the loop for a second frame

    // Simulates the composer having been torn down/replaced by something
    // other than input reaching it (e.g. the view closing) — `this.composer`
    // no longer refers to the entry this loop was claiming for, independent
    // of `composerHasInput`, which stays false throughout.
    internals(h.view).composer = null;
    expect(internals(h.view).composerHasInput).toBe(false);

    const stealer = stealFocus();
    raf.flush();

    expect(composer.editor.hasFocus()).toBe(false);
    expect(document.activeElement).toBe(stealer);
  });
});
