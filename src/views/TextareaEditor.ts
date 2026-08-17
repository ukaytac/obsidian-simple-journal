import type { TFile } from "obsidian";
import type { EntryEditor } from "./EntryEditor";

/**
 * Fallback editor used when the internal embedded-editor API is unavailable.
 * Plain Markdown text editing: no live preview, no autocomplete, but it cannot
 * break, and it keeps the journal usable and the data safe.
 */
export class TextareaEditor implements EntryEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private changeCallback: ((value: string) => void) | null = null;
  private blurCallback: (() => void) | null = null;

  /**
   * Mirrors the textarea's value on every input and setValue. `getValue()`
   * falls back to this after `destroy()`, when the textarea is gone but the
   * caller (e.g. a debounced-save flush at teardown) still needs the truth.
   */
  private lastValue = "";

  /** A setValue() that arrived before mount(); applied once mount() runs. */
  private pendingValue: string | null = null;

  /** The height (px) last written to the textarea, to skip redundant resizes. */
  private lastHeight = 0;

  /**
   * The textarea's `clientWidth` as of the last successful measure.
   * `remeasure()` compares against this: `onResize()` fires for width
   * changes too (dragging the pane divider, opening a sidebar), which can
   * change how the same text wraps without the editor ever having been
   * hidden — so `needsResize` alone would miss it.
   */
  private lastWidth = 0;

  /**
   * True when a resize bailed out because the textarea was hidden
   * (`offsetParent` null or a mis-measured `scrollHeight`) and hasn't been
   * corrected since. Cleared once a resize actually measures and applies a
   * height. `remeasure()` also proceeds on a width change even when this
   * is false (see `lastWidth`).
   */
  private needsResize = false;

  mount(el: HTMLElement, _file: TFile | null, initialValue: string): void {
    // Idempotent: a second mount() tears down any previous textarea instead
    // of appending a duplicate and orphaning the old one with its listeners
    // still wired to this instance.
    if (this.textarea) {
      this.textarea.remove();
      this.textarea = null;
    }

    // A setValue() that arrived before mount (e.g. an external edit noticed
    // while this entry was still being constructed) wins; otherwise seed
    // with initialValue, which is not itself treated as a change.
    const value = this.pendingValue ?? initialValue;
    this.pendingValue = null;

    const textarea = el.createEl("textarea", { cls: "journal-entry-textarea" });
    textarea.value = value;
    textarea.rows = 1;
    this.lastValue = value;
    this.lastHeight = 0;
    this.lastWidth = 0;
    this.needsResize = false;

    textarea.addEventListener("input", (event) => {
      const previousValue = this.lastValue;
      this.lastValue = textarea.value;
      this.resize(event as InputEvent, previousValue);
      this.changeCallback?.(textarea.value);
    });
    // A resize skipped while merely scrolled out of view is recovered here:
    // focusing the entry means it's laid out again and remeasures
    // correctly. (A resize skipped because the whole leaf was hidden, e.g.
    // a background tab, is recovered via remeasure() instead — focus never
    // fires there until the tab is switched back to and the entry clicked.)
    textarea.addEventListener("focus", () => this.resize());
    textarea.addEventListener("blur", () => this.blurCallback?.());

    this.textarea = textarea;
    // Height depends on layout, so measure after the element is in the document.
    window.setTimeout(() => this.resize(), 0);
  }

  getValue(): string {
    return this.textarea?.value ?? this.lastValue;
  }

  setValue(value: string): void {
    this.lastValue = value;
    if (!this.textarea) {
      // mount() hasn't run yet; buffer instead of silently dropping it.
      this.pendingValue = value;
      return;
    }
    this.textarea.value = value;
    this.resize();
  }

  focus(): void {
    this.textarea?.focus();
  }

  hasFocus(): boolean {
    // Compare against the textarea's own document, not the global one: in a
    // popout window (Workspace.moveLeafToPopout, or the tab context menu's
    // "Move to new window") each leaf has its own document, and the global
    // `document.activeElement` is just the main window's <body>. Obsidian
    // augments Node with `doc` for exactly this cross-window comparison.
    return this.textarea !== null && this.textarea.doc.activeElement === this.textarea;
  }

  onChange(callback: (value: string) => void): void {
    this.changeCallback = callback;
  }

  onBlur(callback: () => void): void {
    this.blurCallback = callback;
  }

  flush(): void {
    // Before mount() runs, lastValue is just its "" initializer, not real
    // content (unless a setValue() buffered a pendingValue). Committing it
    // would let a "flush all" write an empty entry over real text that
    // simply hasn't been mounted yet.
    if (!this.textarea && this.pendingValue === null) return;
    this.changeCallback?.(this.textarea?.value ?? this.lastValue);
  }

  remeasure(): void {
    const textarea = this.textarea;
    if (!textarea) return;
    // Cheap on the common case: a single width read per call, batched with
    // every other mounted editor's read by the browser, versus a full
    // write-read-write cycle on all of them for every frame of a resize.
    if (!this.needsResize && textarea.clientWidth === this.lastWidth) return;
    this.resize();
  }

  destroy(): void {
    // No removeEventListener: the listeners are reachable only from this
    // now-detached, dereferenced node, so they're collected with it.
    this.textarea?.remove();
    this.textarea = null;
    this.changeCallback = null;
    this.blurCallback = null;
  }

  /**
   * TextareaEditor is "always usable" (see `EntryEditor.isUsable`'s doc) —
   * it has no internal API to fail out from under itself mid-session.
   * No-op.
   */
  onUnusable(_callback: () => void): void {
    // Intentional no-op.
  }

  /**
   * Resizes the textarea to fit its content. `event` is the triggering
   * input event, if any, and `previousValue` is the textarea's value just
   * before that event; together they let a fast path skip work that a
   * shrink cannot (see below). Called with neither from setValue() and the
   * focus handler, which always take the slow, accurate path.
   */
  private resize(event?: InputEvent, previousValue?: string): void {
    const textarea = this.textarea;
    if (!textarea) return;

    // Hidden (`display: none`, e.g. this leaf is a background tab) or
    // detached. Resizing now would read scrollHeight 0 and collapse the box
    // to zero height with overflow: hidden and resize: none, leaving it
    // invisible; bail out and flag it so remeasure() can retry once the
    // leaf is visible again (input/focus won't fire on a hidden textarea).
    if (!textarea.offsetParent) {
      this.needsResize = true;
      return;
    }

    // Most keystrokes insert text without changing the line count, and for
    // those scrollHeight reliably reports "no change" when it still matches
    // what's already applied — skipping the resize entirely below is safe.
    // But scrollHeight can't be trusted to detect a *shrink*: a box taller
    // than its content just reports its own height back, with no overflow
    // to reveal that the content now needs less room. So the fast path is
    // only for an edit whose value provably cannot have shrunk — a real
    // input event (an absent event, or one with no inputType, defaults to
    // the slow path) whose length and newline count are both non-decreasing
    // from the value just before it. That covers growth-only insertions,
    // plain deletions (excluded: length drops), a multi-line paste into
    // short content, and IME composition, while still forcing the slow
    // path for: setValue()/focus (no event) shrinking external edits,
    // historyUndo that removes text, and typing or pasting over a
    // multi-line selection (both can net-decrease length even though the
    // inputType itself is "insert*").
    const canSkipIfUnchanged =
      event !== undefined &&
      event.inputType !== undefined &&
      previousValue !== undefined &&
      textarea.value.length >= previousValue.length &&
      countNewlines(textarea.value) >= countNewlines(previousValue);

    if (canSkipIfUnchanged && this.lastHeight > 0 && textarea.scrollHeight === this.lastHeight) {
      return;
    }

    // A textarea's `height: auto` sizes to its `rows` attribute, not its
    // content, so collapsing to it first is what makes the following
    // scrollHeight read reflect the content's true height. Skipping this
    // step would let a box taller than its content just report its own
    // height back, masking a shrink (e.g. after deleting a paragraph).
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    if (scrollHeight <= 0) {
      // Not laid out despite offsetParent (e.g. mid-layout); flag for retry.
      this.needsResize = true;
      return;
    }

    this.needsResize = false;
    this.lastHeight = scrollHeight;
    this.lastWidth = textarea.clientWidth;
    textarea.style.height = `${scrollHeight}px`;
  }
}

function countNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++;
  }
  return count;
}
