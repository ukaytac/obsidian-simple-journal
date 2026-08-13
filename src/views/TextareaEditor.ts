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

  mount(el: HTMLElement, _file: TFile | null, initialValue: string): void {
    const textarea = el.createEl("textarea", { cls: "journal-entry-textarea" });
    textarea.value = initialValue;
    textarea.rows = 1;

    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };

    textarea.addEventListener("input", () => {
      resize();
      this.changeCallback?.(textarea.value);
    });
    textarea.addEventListener("blur", () => this.blurCallback?.());

    this.textarea = textarea;
    // Height depends on layout, so measure after the element is in the document.
    window.setTimeout(resize, 0);
  }

  getValue(): string {
    return this.textarea?.value ?? "";
  }

  setValue(value: string): void {
    if (!this.textarea) return;
    this.textarea.value = value;
    this.textarea.style.height = "auto";
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
  }

  focus(): void {
    this.textarea?.focus();
  }

  hasFocus(): boolean {
    return this.textarea !== null && document.activeElement === this.textarea;
  }

  onChange(callback: (value: string) => void): void {
    this.changeCallback = callback;
  }

  onBlur(callback: () => void): void {
    this.blurCallback = callback;
  }

  destroy(): void {
    this.textarea?.remove();
    this.textarea = null;
    this.changeCallback = null;
    this.blurCallback = null;
  }
}
