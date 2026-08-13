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

    textarea.addEventListener("input", (event) => {
      this.lastValue = textarea.value;
      this.resize(event as InputEvent);
      this.changeCallback?.(textarea.value);
    });
    // A resize skipped while hidden (see resize()) is recovered here: when
    // the entry is scrolled back into view and focused, it is laid out
    // again and remeasures correctly.
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
    this.changeCallback?.(this.textarea?.value ?? this.lastValue);
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
   * Resizes the textarea to fit its content. `event` is the triggering
   * input event, if any; its `inputType` lets a plain insertion skip work
   * that a deletion cannot (see below).
   */
  private resize(event?: InputEvent): void {
    const textarea = this.textarea;
    if (!textarea) return;

    // A hidden element (e.g. this entry is scrolled out of view while an
    // external edit calls setValue on it) reports scrollHeight 0. Resizing
    // now would collapse the box to zero height with overflow: hidden and
    // resize: none, leaving it invisible; bail out and let the next input
    // or focus event (wired in mount()) retry once it is laid out again.
    if (!textarea.offsetParent) return;

    // Most keystrokes insert text without changing the line count. A
    // deletion can shrink the content below the box's current height
    // without triggering overflow, so scrollHeight alone can't be trusted
    // to detect a shrink — but it reliably reports "no change" for a
    // non-deleting keystroke when it still matches what's already applied.
    // In that case the box is already the right size: skip both style
    // writes below, and the layout each would force.
    const isDeletion = event?.inputType?.startsWith("delete") ?? false;
    if (!isDeletion && this.lastHeight > 0 && textarea.scrollHeight === this.lastHeight) {
      return;
    }

    // A textarea's `height: auto` sizes to its `rows` attribute, not its
    // content, so collapsing to it first is what makes the following
    // scrollHeight read reflect the content's true height. Skipping this
    // step would let a box taller than its content just report its own
    // height back, masking a shrink (e.g. after deleting a paragraph).
    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    if (scrollHeight <= 0) return; // not laid out despite offsetParent; retry later

    this.lastHeight = scrollHeight;
    textarea.style.height = `${scrollHeight}px`;
  }
}
