export interface JournalSettings {
  /** Vault-relative folder that holds journal entries. */
  journalFolder: string;
}

export const DEFAULT_SETTINGS: JournalSettings = {
  journalFolder: "Journal",
};
