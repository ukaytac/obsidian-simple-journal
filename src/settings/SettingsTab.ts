import { debounce, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { DEFAULT_SETTINGS } from "./settings";
import { ENTRY_FOLDER_LAYOUTS, type EntryFolderLayout } from "../journal/folderLayout";

/** The control keys this tab declares. */
const FOLDER_KEY = "journalFolder";
const LAYOUT_KEY = "entryFolders";
const UNDER_NOTES_KEY = "showMentionsUnderNotes";
const SIDEBAR_KEY = "mentionsSidebar";

const FOLDER_NAME = "Journal folder";
const FOLDER_DESC = "Vault folder that holds journal entries. Created when the first entry is written.";
const LAYOUT_NAME = "Entry folders";
const LAYOUT_DESC =
  "How new entries are foldered inside the journal folder. Existing entries stay where they are; " +
  "the Reorganize journal folders command moves them.";

/**
 * Each option names its own example path, because "Year" and "No subfolders"
 * are guesses until you see what they produce. The example uses the
 * placeholder folder name rather than the user's own: it is illustrating the
 * shape, and a live folder name would make the option label move around as
 * they type in the field above.
 */
const LAYOUT_OPTIONS: Record<EntryFolderLayout, string> = {
  "year-month": `Year and month — ${DEFAULT_SETTINGS.journalFolder}/2026/08/`,
  year: `Year — ${DEFAULT_SETTINGS.journalFolder}/2026/`,
  flat: `No subfolders — ${DEFAULT_SETTINGS.journalFolder}/`,
};

function isLayoutKey(value: unknown): value is EntryFolderLayout {
  return ENTRY_FOLDER_LAYOUTS.includes(value as EntryFolderLayout);
}

const UNDER_NOTES_NAME = "Show mentions under notes";
const UNDER_NOTES_DESC =
  "Add a panel at the bottom of a note listing the journal entries that link to it.";
const SIDEBAR_NAME = "Mentions sidebar";
const SIDEBAR_DESC =
  "Keep a journal mentions panel in the sidebar, following the active note.";

export class JournalSettingsTab extends PluginSettingTab {
  /**
   * Holds the latest typed value between keystrokes and the debounced
   * commit below. `EntryRepository` reads `plugin.settings.journalFolder`
   * live, and it creates that folder on write — so a half-typed value must
   * never reach `plugin.settings` even for the instant before the debounce
   * fires. Only the settled value, applied inside the debounced callback,
   * is assigned there.
   */
  private pendingFolder = "";

  /**
   * Saving and refreshing on every keystroke would re-scan the vault for a
   * half-typed folder name. Debounced so only the value after the user pauses
   * typing commits, saves, and refreshes. The text field itself still shows
   * every keystroke immediately; only the commit to `plugin.settings` is
   * delayed.
   *
   * Both rendering paths funnel through this, so the guarantee above holds
   * whichever one Obsidian picked.
   */
  private readonly saveAndRefresh = debounce(
    () => {
      this.plugin.settings.journalFolder = this.pendingFolder;
      void this.plugin.saveSettings().then(() => this.plugin.refreshJournal());
    },
    500,
    true,
  );

  constructor(private readonly plugin: JournalEntriesPlugin) {
    super(plugin.app, plugin);
  }

  /**
   * Commits immediately, like the toggles and unlike the folder field: a
   * dropdown has no half-typed state.
   *
   * Nothing is refreshed and nothing moves. The layout decides where the NEXT
   * entry is written, and the timeline reads entries wherever they are, so
   * there is nothing on screen for this to change — which is the whole reason
   * the setting can be instant and the migration has to be a command.
   */
  private setLayout(value: EntryFolderLayout): void {
    this.plugin.settings.entryFolders = value;
    void this.plugin.saveSettings();
  }

  /**
   * Unlike the folder field there is nothing to debounce here — a toggle has
   * no half-typed state — so this commits immediately and applies the change
   * to the live surfaces right away.
   */
  private setToggle(key: typeof UNDER_NOTES_KEY | typeof SIDEBAR_KEY, value: boolean): void {
    if (key === UNDER_NOTES_KEY) this.plugin.settings.showMentionsUnderNotes = value;
    else this.plugin.settings.mentionsSidebar = value;
    // This toggle going off is the only event allowed to close a mentions
    // leaf: one opened with `Open journal mentions` must survive the other
    // toggle and every later plugin load. See `applyMentionSettings`.
    void this.plugin
      .saveSettings()
      .then(() => this.plugin.applyMentionSettings(key === SIDEBAR_KEY && !value));
  }

  /**
   * The declarative path, used from Obsidian 1.13.0 on. Its real benefit is
   * not the rendering: a declared setting is indexed by Obsidian's settings
   * search, so someone looking for "journal folder" finds it without knowing
   * this plugin has a settings tab at all. `display()` below cannot be
   * indexed, because nothing can read intent out of imperative DOM building.
   *
   * When this returns a non-empty array, Obsidian ignores `display()`
   * entirely — the two never both run.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    // Seeded here as well as in display(), because on 1.13+ this is the only
    // one of the two that runs.
    this.pendingFolder = this.plugin.settings.journalFolder;

    return [
      {
        name: FOLDER_NAME,
        desc: FOLDER_DESC,
        control: {
          type: "text",
          key: FOLDER_KEY,
          placeholder: DEFAULT_SETTINGS.journalFolder,
        },
      },
      {
        name: LAYOUT_NAME,
        desc: LAYOUT_DESC,
        control: { type: "dropdown", key: LAYOUT_KEY, options: LAYOUT_OPTIONS },
      },
      {
        name: UNDER_NOTES_NAME,
        desc: UNDER_NOTES_DESC,
        control: { type: "toggle", key: UNDER_NOTES_KEY },
      },
      {
        name: SIDEBAR_NAME,
        desc: SIDEBAR_DESC,
        control: { type: "toggle", key: SIDEBAR_KEY },
      },
    ];
  }

  /**
   * Deliberately does not delegate unknown keys to `super`: this tab declares
   * exactly the keys below, and the base-class implementations do not exist
   * before 1.13.0, so a `super` call would be a latent crash on the older
   * versions `minAppVersion` still admits.
   */
  getControlValue(key: string): unknown {
    if (key === FOLDER_KEY) return this.plugin.settings.journalFolder;
    if (key === LAYOUT_KEY) return this.plugin.settings.entryFolders;
    if (key === UNDER_NOTES_KEY) return this.plugin.settings.showMentionsUnderNotes;
    if (key === SIDEBAR_KEY) return this.plugin.settings.mentionsSidebar;
    return undefined;
  }

  setControlValue(key: string, value: unknown): void {
    if (key === FOLDER_KEY) {
      this.pendingFolder = normalizeFolder(value);
      this.saveAndRefresh();
      return;
    }
    if (key === LAYOUT_KEY) {
      // Guarded rather than cast: this value arrives from Obsidian's own
      // control, and an unrecognised one must not reach `entryFolderPath`,
      // which has no case for it. Same reasoning as `sanitizeSettings`.
      if (isLayoutKey(value)) this.setLayout(value);
      return;
    }
    if (key === UNDER_NOTES_KEY || key === SIDEBAR_KEY) {
      this.setToggle(key, value === true);
    }
  }

  /**
   * The imperative path, kept for Obsidian versions below 1.13.0 — which
   * `minAppVersion: 1.7.2` still admits. Deprecated upstream in favour of
   * `getSettingDefinitions`, and not called at all once that returns
   * definitions, so on a current Obsidian this code is dormant.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.pendingFolder = this.plugin.settings.journalFolder;

    new Setting(containerEl)
      .setName(FOLDER_NAME)
      .setDesc(FOLDER_DESC)
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.journalFolder)
          .setValue(this.plugin.settings.journalFolder)
          .onChange((value) => {
            this.pendingFolder = normalizeFolder(value);
            this.saveAndRefresh();
          }),
      );

    new Setting(containerEl)
      .setName(LAYOUT_NAME)
      .setDesc(LAYOUT_DESC)
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(LAYOUT_OPTIONS)
          .setValue(this.plugin.settings.entryFolders)
          .onChange((value) => {
            if (isLayoutKey(value)) this.setLayout(value);
          }),
      );

    new Setting(containerEl)
      .setName(UNDER_NOTES_NAME)
      .setDesc(UNDER_NOTES_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showMentionsUnderNotes)
          .onChange((value) => this.setToggle(UNDER_NOTES_KEY, value)),
      );

    new Setting(containerEl)
      .setName(SIDEBAR_NAME)
      .setDesc(SIDEBAR_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mentionsSidebar)
          .onChange((value) => this.setToggle(SIDEBAR_KEY, value)),
      );
  }

  /**
   * Called when the tab is closed. A keystroke's debounced commit may still
   * be pending; flushing it here (rather than cancelling it) ensures the
   * user's last edit is never silently dropped, and that it lands before the
   * plugin might be disabled.
   */
  hide(): void {
    this.saveAndRefresh.run();
  }
}

/**
 * A blank field means "use the default" rather than "put entries in the vault
 * root", which is what an empty folder path would otherwise mean. `value` is
 * typed `unknown` because `setControlValue` receives whatever the control
 * produced.
 */
function normalizeFolder(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.journalFolder;
  return value.trim() || DEFAULT_SETTINGS.journalFolder;
}
