import { debounce, PluginSettingTab, Setting } from "obsidian";
import type JournalEntriesPlugin from "../main";

export class JournalSettingsTab extends PluginSettingTab {
  /**
   * Saving and refreshing on every keystroke would, once Task 11 makes
   * `reload()` do real work, re-scan the vault for a half-typed folder name.
   * Debounced so only the value after the user pauses typing triggers either.
   * The setting itself (`journalFolder`) is still updated immediately in
   * `onChange` below, so the in-memory value never lags behind the field.
   */
  private readonly saveAndRefresh = debounce(
    () => {
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

    new Setting(containerEl)
      .setName("Journal folder")
      .setDesc("Vault folder that holds journal entries. Created when the first entry is written.")
      .addText((text) =>
        text
          .setPlaceholder("Journal")
          .setValue(this.plugin.settings.journalFolder)
          .onChange((value) => {
            this.plugin.settings.journalFolder = value.trim() || "Journal";
            this.saveAndRefresh();
          }),
      );
  }
}
