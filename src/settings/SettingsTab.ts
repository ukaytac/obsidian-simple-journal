import { debounce, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { DEFAULT_SETTINGS } from "./settings";

/** The one control key this tab declares. */
const FOLDER_KEY = "journalFolder";

const FOLDER_NAME = "Journal folder";
const FOLDER_DESC = "Vault folder that holds journal entries. Created when the first entry is written.";

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
    ];
  }

  /**
   * Deliberately does not delegate unknown keys to `super`: this tab declares
   * exactly one, and the base-class implementations do not exist before
   * 1.13.0, so a `super` call would be a latent crash on the older versions
   * `minAppVersion` still admits.
   */
  getControlValue(key: string): unknown {
    if (key === FOLDER_KEY) return this.plugin.settings.journalFolder;
    return undefined;
  }

  setControlValue(key: string, value: unknown): void {
    if (key !== FOLDER_KEY) return;
    this.pendingFolder = normalizeFolder(value);
    this.saveAndRefresh();
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
