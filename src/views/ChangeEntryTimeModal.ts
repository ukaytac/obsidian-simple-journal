import { App, Modal, Notice } from "obsidian";
import { formatDateTimeLocalValue, parseDateTimeLocalValue } from "../utils/dates";

/**
 * Prompts for a corrected entry timestamp via a single native
 * `<input type="datetime-local">`, prefilled with the entry's currently
 * resolved `created` time. `datetime-local` is deliberate, per CLAUDE.md: it
 * is native, needs no dependency, and gives the OS's own picker on mobile.
 *
 * Confirms only when `parseDateTimeLocalValue` actually accepts the input —
 * an empty or unparseable value never calls `onConfirm`; the modal simply
 * stays open so the user can correct it. This is the "never risk writing a
 * broken `created`" half of CLAUDE.md's error-handling section; the write
 * itself is entirely the caller's responsibility.
 */
export class ChangeEntryTimeModal extends Modal {
  private inputEl!: HTMLInputElement;

  constructor(
    app: App,
    private readonly initial: Date,
    private readonly onConfirm: (value: Date) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Change entry time");

    this.inputEl = this.contentEl.createEl("input", { type: "datetime-local" });
    // Second-precision: `created` carries seconds, and the default
    // datetime-local step (minutes only) would silently round them away the
    // moment the user touches the picker, even if they never meant to
    // change the seconds at all.
    this.inputEl.step = "1";
    this.inputEl.value = formatDateTimeLocalValue(this.initial);
    this.inputEl.addClass("journal-change-time-input");

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.confirm();
    });

    const buttonRowEl = this.contentEl.createDiv({ cls: "journal-change-time-buttons" });

    buttonRowEl.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

    buttonRowEl
      .createEl("button", { text: "Change", cls: "mod-cta" })
      .addEventListener("click", () => this.confirm());

    // Focusing synchronously, before the modal's own open animation/DOM
    // insertion settles, is unreliable on some platforms; deferring one
    // tick matches how the rest of this codebase defers focus after a DOM
    // change (see JournalView's composer/editor focus calls).
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  private confirm(): void {
    const parsed = parseDateTimeLocalValue(this.inputEl.value);
    if (!parsed) {
      new Notice("Simple Journal: enter a valid date and time.");
      return;
    }

    this.close();
    this.onConfirm(parsed);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
