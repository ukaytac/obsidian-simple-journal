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
  /**
   * Whether the footer's panel is collapsed to its header. Remembered UI
   * state, not a setting: it deliberately does NOT appear in the settings tab
   * — the only way to change it is the header the state is about.
   *
   * One boolean for the whole vault rather than one per note, so a user who
   * has folded the panel away does not have to fold it again under every note
   * they open.
   *
   * Expanded by default, because the justification for this whole surface is
   * seeing entry content instead of a list of filenames; starting collapsed
   * would quietly turn it back into the list.
   */
  mentionsFooterCollapsed: boolean;
}

export const DEFAULT_SETTINGS: JournalSettings = {
  journalFolder: "Journal",
  showMentionsUnderNotes: false,
  mentionsSidebar: false,
  mentionsFooterCollapsed: false,
};
