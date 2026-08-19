export interface JournalSettings {
  /** Vault-relative folder that holds journal entries. */
  journalFolder: string;
  /**
   * Whether the calendar has been placed in the sidebar once already.
   *
   * The calendar is otherwise reachable only through its command, which made
   * it effectively undiscoverable — it was there for weeks before anyone found
   * it. So it is opened once, on the first load after install, and never
   * forced again: Obsidian persists the workspace layout, so re-opening it on
   * every load would put it back for anyone who deliberately closed it.
   */
  hasAutoOpenedCalendar: boolean;
}

export const DEFAULT_SETTINGS: JournalSettings = {
  journalFolder: "Journal",
  hasAutoOpenedCalendar: false,
};
