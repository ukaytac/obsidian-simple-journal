export interface JournalSettings {
  /** Vault-relative folder that holds journal entries. */
  journalFolder: string;
  /**
   * Show a mentions panel at the bottom of notes that journal entries link
   * to. Off by default: this is the surface that relies on Obsidian's
   * internal layout DOM (see `mentionsFooter.ts`), and nobody should end up
   * with UI appearing under their notes without having asked for it.
   */
  showMentionsUnderNotes: boolean;
  /**
   * Keep a journal mentions panel in the sidebar. Governs AUTOMATIC PLACEMENT
   * only — exactly as the calendar's placement policy does. The view type is
   * always registered (a saved layout referring to an unregistered type is a
   * broken layout), and `Open journal mentions` works regardless, because a
   * command is how you reach a thing.
   */
  mentionsSidebar: boolean;
}

export const DEFAULT_SETTINGS: JournalSettings = {
  journalFolder: "Journal",
  showMentionsUnderNotes: false,
  mentionsSidebar: false,
};
