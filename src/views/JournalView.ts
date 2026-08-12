import { ItemView, WorkspaceLeaf } from "obsidian";
import type JournalEntriesPlugin from "../main";

export const VIEW_TYPE_JOURNAL = "journal-entries-timeline";

export class JournalView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    protected readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_JOURNAL;
  }

  getDisplayText(): string {
    return "Journal";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("journal-view");
    this.contentEl.createDiv({ cls: "journal-timeline" });
  }

  /** Replaced with real behaviour in Task 15. */
  async startNewEntry(): Promise<void> {
    // No timeline yet.
  }

  /** Replaced with real behaviour in Task 12. */
  scrollToTop(): void {
    this.contentEl.scrollTo({ top: 0 });
  }

  /** Replaced with real behaviour in Task 11. */
  async reload(): Promise<void> {
    // No timeline yet.
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
