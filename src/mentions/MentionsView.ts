import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Fixed forever, for the same reason the journal and calendar view types are:
 * a saved workspace layout refers to it.
 */
export const VIEW_TYPE_MENTIONS = "simple-journal-mentions";

/**
 * Shell B: the sidebar. A thin Obsidian shell around `MentionsPanel` — it
 * owns which file is being shown and nothing else.
 *
 * Unlike the automatic footer, it does not exclude journal entries: the user
 * opened this panel deliberately, and it costs nothing to answer honestly for
 * whatever file is active. Recursion is not a concern here either, because no
 * note ever renders this view inside itself.
 */
export class MentionsView extends ItemView {
  private panel: MentionsPanel | null = null;
  private shownPath: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MENTIONS;
  }

  getDisplayText(): string {
    return "Journal mentions";
  }

  getIcon(): string {
    return "quote";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("journal-mentions-view");

    // `registerEvent` ties the unsubscribe to this view's own Component
    // lifecycle — the same reasoning behind `CalendarView.onOpen`'s
    // `this.register` — so it fires even along a teardown path that skips
    // `onClose`, and a later event can never reach a detached DOM.
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));

    this.refresh();
  }

  async onClose(): Promise<void> {
    this.teardownPanel();
    this.contentEl.empty();
  }

  /** Public so `main.ts`'s `refreshJournal` can drive it, as it does the calendar. */
  refresh(): void {
    const file = this.app.workspace.getActiveFile();

    if (!(file instanceof TFile)) {
      this.teardownPanel();
      this.contentEl.createDiv({
        cls: "journal-mentions-empty",
        text: "Open a note to see the journal entries that mention it.",
      });
      return;
    }

    // Rebuilding for a file already on screen would drop the user's expanded
    // "Show more" state for no reason.
    if (this.panel && this.shownPath === file.path) return;

    this.teardownPanel();
    this.shownPath = file.path;
    this.panel = createMentionsPanel({
      plugin: this.plugin,
      container: this.contentEl.createDiv(),
      target: file,
      emptyText: "No journal entries mention this note yet.",
    });
    void this.panel.render();
  }

  private teardownPanel(): void {
    this.panel?.destroy();
    this.panel = null;
    this.shownPath = null;
    this.contentEl.empty();
  }
}
