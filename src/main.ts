import { Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { DEFAULT_SETTINGS, type JournalSettings } from "./settings/settings";
import { JournalSettingsTab } from "./settings/SettingsTab";
import { createEntryEditorFactory, type EntryEditorFactory } from "./views/EntryEditor";
import { JournalView, VIEW_TYPE_JOURNAL } from "./views/JournalView";

export default class JournalEntriesPlugin extends Plugin {
  settings: JournalSettings = { ...DEFAULT_SETTINGS };
  repository!: EntryRepository;
  editorFactory!: EntryEditorFactory;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new EntryRepository(this.app, () => this.settings.journalFolder);
    this.editorFactory = createEntryEditorFactory(this.app);

    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));
    this.addSettingTab(new JournalSettingsTab(this));

    this.addRibbonIcon("book-open", "Open journal", () => {
      void this.openJournal();
    });

    this.addCommand({
      id: "open-journal",
      name: "Open journal",
      callback: () => void this.openJournal(),
    });

    this.addCommand({
      id: "new-journal-entry",
      name: "New journal entry",
      callback: () => void this.newEntry(),
    });

    this.addCommand({
      id: "go-to-today",
      name: "Go to today",
      callback: () => void this.goToToday(),
    });
  }

  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (typeof this.settings.journalFolder !== "string" || this.settings.journalFolder.trim() === "") {
      this.settings.journalFolder = DEFAULT_SETTINGS.journalFolder;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Opens the journal view, reusing an existing leaf when one exists. Returns
   * null if the leaf's view isn't a JournalView by the time this resolves —
   * for example if the plugin was disabled mid-await, which detaches the
   * leaf and leaves it with an empty view.
   */
  async openJournal(): Promise<JournalView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof JournalView ? view : null;
  }

  async newEntry(): Promise<void> {
    const view = await this.openJournal();
    if (view) await view.startNewEntry();
  }

  async goToToday(): Promise<void> {
    const view = await this.openJournal();
    if (view) view.scrollToTop();
  }

  refreshJournal(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
      // A deferred leaf's view is a DeferredView, not a JournalView — its
      // onOpen rebuilds it when it loads, so it needs no refresh here. Skip
      // rather than throw, or one deferred leaf would abort the whole loop.
      const view = leaf.view;
      if (view instanceof JournalView) void view.reload();
    }
  }
}
