import { debounce, PluginSettingTab, Setting } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { DEFAULT_SETTINGS } from "./settings";

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
   * Saving and refreshing on every keystroke would, once Task 11 makes
   * `reload()` do real work, re-scan the vault for a half-typed folder name.
   * Debounced so only the value after the user pauses typing commits,
   * saves, and refreshes. The text field itself still shows every keystroke
   * immediately; only the commit to `plugin.settings` is delayed.
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.pendingFolder = this.plugin.settings.journalFolder;

    new Setting(containerEl)
      .setName("Journal folder")
      .setDesc("Vault folder that holds journal entries. Created when the first entry is written.")
      .addText((text) =>
        text
          .setPlaceholder("Journal")
          .setValue(this.plugin.settings.journalFolder)
          .onChange((value) => {
            this.pendingFolder = value.trim() || DEFAULT_SETTINGS.journalFolder;
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
