import { PluginSettingTab, Setting } from "obsidian";
import type JournalEntriesPlugin from "../main";

export class JournalSettingsTab extends PluginSettingTab {
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
          .onChange(async (value) => {
            this.plugin.settings.journalFolder = value.trim() || "Journal";
            await this.plugin.saveSettings();
            this.plugin.refreshJournal();
          }),
      );
  }
}
