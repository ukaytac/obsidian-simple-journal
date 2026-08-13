import { Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { DEFAULT_SETTINGS, type JournalSettings } from "./settings/settings";
import { JournalSettingsTab } from "./settings/SettingsTab";
import { JournalView, VIEW_TYPE_JOURNAL } from "./views/JournalView";

export default class JournalEntriesPlugin extends Plugin {
  settings: JournalSettings = { ...DEFAULT_SETTINGS };
  repository!: EntryRepository;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new EntryRepository(this.app, () => this.settings.journalFolder);

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

    this.registerProbeCommand();
  }

  /**
   * TEMPORARY — Task 8 spike. Probes the internal embedded-editor registry so
   * its real shape can be recorded in docs/editor-embed-api.md before the
   * editor layer is built on it. Removed once the spike is done.
   */
  private registerProbeCommand(): void {
    this.addCommand({
      id: "probe-embed-api",
      name: "DEBUG: probe embedded editor API",
      callback: () => {
        const registry = (
          this.app as unknown as {
            embedRegistry?: { embedByExtension?: Record<string, unknown> };
          }
        ).embedRegistry?.embedByExtension;

        console.log("--- Journal Entries embed probe ---");
        console.log("obsidian version:", (this.app as unknown as { appId?: string }).appId ?? "?");
        console.log("embedRegistry present:", Boolean(registry));
        console.log("extensions:", registry ? Object.keys(registry) : "none");
        console.log("md creator type:", typeof registry?.md);

        const file = this.app.workspace.getActiveFile();
        if (!file) {
          console.log("NO ACTIVE FILE — open a markdown note first, then run this again.");
          return;
        }
        if (typeof registry?.md !== "function") {
          console.log("NO md CREATOR — the internal API is absent on this version.");
          return;
        }

        const host = document.createElement("div");
        host.style.cssText = "position:fixed;bottom:0;right:0;width:400px;height:200px;z-index:9999;background:var(--background-primary);border:1px solid var(--background-modifier-border)";
        document.body.appendChild(host);

        const creator = registry.md as (
          context: unknown,
          file: unknown,
          subpath: string,
        ) => Record<string, unknown>;

        try {
          const embed = creator(
            { app: this.app, containerEl: host, showInline: true, depth: 0 },
            file,
            "",
          );

          console.log("embed own keys:", Object.keys(embed));
          console.log(
            "embed prototype keys:",
            Object.getOwnPropertyNames(Object.getPrototypeOf(embed)),
          );
          console.log("embed object:", embed);

          const globals = window as unknown as Record<string, unknown>;
          globals.__journalEmbed = embed;
          globals.__journalEmbedHost = host;
          console.log("Saved as window.__journalEmbed and window.__journalEmbedHost");
        } catch (error) {
          console.error("creator() threw:", error);
          host.remove();
        }
      },
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
