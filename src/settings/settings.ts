import {
  DEFAULT_ENTRY_FOLDER_LAYOUT,
  ENTRY_FOLDER_LAYOUTS,
  type EntryFolderLayout,
} from "../journal/folderLayout";

export interface JournalSettings {
  /** Vault-relative folder that holds journal entries. */
  journalFolder: string;
  /**
   * How new entries are foldered inside `journalFolder`: by year and month,
   * by year, or not at all. See CLAUDE.md § Storage Model.
   *
   * Governs where a new entry is WRITTEN, and where a corrected timestamp
   * puts an entry the plugin already manages. It moves nothing on its own —
   * bringing an existing journal over to one shape is the
   * `Reorganize journal folders` command, which previews and confirms first.
   */
  entryFolders: EntryFolderLayout;
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
  entryFolders: DEFAULT_ENTRY_FOLDER_LAYOUT,
  showMentionsUnderNotes: false,
  mentionsSidebar: false,
  mentionsFooterCollapsed: false,
};

function isLayout(value: unknown): value is EntryFolderLayout {
  return ENTRY_FOLDER_LAYOUTS.includes(value as EntryFolderLayout);
}

/**
 * Turns whatever is in `data.json` into settings the rest of the plugin may
 * trust.
 *
 * `stored` is `unknown` on purpose: `Plugin.loadData` returns whatever JSON is
 * on disk, which a user or an older build may have written, so nothing about
 * its shape is guaranteed. Every field is checked here and nowhere else, which
 * is why a hand-edited `data.json` cannot poison a folder path, flip a panel
 * into a non-boolean state, or hand `entryFolderPath` a layout it has no case
 * for.
 *
 * Pure, and separate from the loading, so it can be tested without a real
 * Obsidian `Plugin` behind it.
 */
export function sanitizeSettings(stored: unknown): JournalSettings {
  // No cast needed: every property of `Partial<JournalSettings>` is optional,
  // so the narrowed `object` satisfies it. The checks below are what actually
  // decide what is usable.
  const raw: Partial<JournalSettings> =
    typeof stored === "object" && stored !== null ? stored : {};

  const settings: JournalSettings = { ...DEFAULT_SETTINGS, ...raw };

  if (typeof settings.journalFolder !== "string" || settings.journalFolder.trim() === "") {
    settings.journalFolder = DEFAULT_SETTINGS.journalFolder;
  }

  if (!isLayout(settings.entryFolders)) {
    settings.entryFolders = DEFAULT_SETTINGS.entryFolders;
  }

  if (typeof settings.showMentionsUnderNotes !== "boolean") {
    settings.showMentionsUnderNotes = DEFAULT_SETTINGS.showMentionsUnderNotes;
  }
  if (typeof settings.mentionsSidebar !== "boolean") {
    settings.mentionsSidebar = DEFAULT_SETTINGS.mentionsSidebar;
  }
  // Remembered UI state rather than a configured setting, but it is written to
  // the same `data.json` and read by the same code, so it gets the same check.
  if (typeof settings.mentionsFooterCollapsed !== "boolean") {
    settings.mentionsFooterCollapsed = DEFAULT_SETTINGS.mentionsFooterCollapsed;
  }

  return settings;
}
