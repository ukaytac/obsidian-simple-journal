import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { JournalService } from "./services/journalService";
import { DEFAULT_SETTINGS, type JournalSettings } from "./settings/settings";
import { JournalSettingsTab } from "./settings/SettingsTab";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./views/CalendarView";
import { createEntryEditorFactory, type EntryEditorFactory } from "./views/EntryEditor";
import { JournalView, VIEW_TYPE_JOURNAL } from "./views/JournalView";

export default class JournalEntriesPlugin extends Plugin {
  settings: JournalSettings = { ...DEFAULT_SETTINGS };
  repository!: EntryRepository;
  editorFactory!: EntryEditorFactory;
  journal!: JournalService;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new EntryRepository(this.app, () => this.settings.journalFolder);
    this.editorFactory = createEntryEditorFactory(this.app);

    this.journal = new JournalService(this.app, this.repository);
    // Ties the service's lifecycle to the plugin: its vault/metadata-cache
    // event registrations are released automatically on unload.
    this.addChild(this.journal);

    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));
    this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));
    this.addSettingTab(new JournalSettingsTab(this));

    this.addRibbonIcon("book-open", "Open journal", () => {
      void this.openJournal();
    });

    // On mobile the ribbon is the "..." menu, which is the only place a plugin
    // can put a reachable shortcut — the "+" new-file menu has no public API.
    // Capture is the primary flow, so it needs its own entry there rather than
    // living only in the command palette.
    this.addRibbonIcon("plus", "New journal entry", () => {
      void this.newEntry();
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

    // No ribbon icon for this — the ribbon already has two (Open journal,
    // New journal entry), and CLAUDE.md warns against ribbon/UI clutter.
    // Not opened automatically alongside the journal, either: this is an
    // optional companion view, not part of the MVP's core flow.
    this.addCommand({
      id: "open-calendar",
      name: "Open calendar",
      callback: () => void this.openCalendar(),
    });

    // Lets a phone home-screen shortcut (or any other launcher) capture a
    // thought in one tap: `obsidian://journal-new` reuses the exact same
    // path as the command/ribbon icon below, just triggered externally.
    //
    // `onLayoutReady` covers the URI arriving before the workspace has
    // finished laying out — e.g. this cold-launching the app rather than
    // hitting an already-running one — by running immediately if the layout
    // is already ready, or queuing until it is (`@since 0.11.0`, same as
    // `registerObsidianProtocolHandler` itself; both are safely under this
    // plugin's declared `minAppVersion`). `newEntry()` already handles "no
    // journal view open yet" via `openJournal()`, so nothing here duplicates
    // that.
    //
    // Which vault actually receives this URI at all is decided by Obsidian
    // itself, outside this plugin's control: without a `?vault=` query
    // parameter the OS routes it to whichever vault last had focus, and if
    // that vault doesn't have this plugin enabled, nothing here ever runs —
    // there is no hook available to detect or redirect that case from
    // inside a single vault's plugin instance.
    this.registerObsidianProtocolHandler("journal-new", () => {
      this.app.workspace.onLayoutReady(() => {
        this.newEntry().catch((error) => {
          console.error(
            "Journal Entries: could not create a new entry from the obsidian://journal-new link",
            error,
          );
          new Notice(
            "Journal Entries: could not open a new entry from the link. See the developer console for details.",
          );
        });
      });
    });

    this.app.workspace.onLayoutReady(() => void this.autoOpenCalendarOnce());
  }

  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (typeof this.settings.journalFolder !== "string" || this.settings.journalFolder.trim() === "") {
      this.settings.journalFolder = DEFAULT_SETTINGS.journalFolder;
    }

    // A non-boolean here would make the once-only guard below either nag on
    // every load or never run at all, depending on which way it coerced.
    if (typeof this.settings.hasAutoOpenedCalendar !== "boolean") {
      this.settings.hasAutoOpenedCalendar = DEFAULT_SETTINGS.hasAutoOpenedCalendar;
    }
  }

  /**
   * Places the calendar in the sidebar the first time the plugin loads, then
   * records that it has done so and never forces it again.
   *
   * Deferred to `onLayoutReady` because the right split does not necessarily
   * exist yet during `onload`, and `getRightLeaf` can return null when it
   * doesn't. The callback fires immediately when the layout is already
   * initialized, which is the case when a user enables the plugin by hand
   * rather than at startup.
   *
   * The flag is written whether or not the open succeeds: a failure that
   * repeats every load is worse than a calendar the user opens themselves.
   */
  private async autoOpenCalendarOnce(): Promise<void> {
    if (this.settings.hasAutoOpenedCalendar) return;

    this.settings.hasAutoOpenedCalendar = true;

    try {
      await this.saveSettings();

      // Respect a layout that already has one — nothing to place.
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length > 0) return;

      await this.openCalendar();
    } catch (error) {
      console.error("Journal Entries: could not place the calendar in the sidebar", error);
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

  /**
   * Errors are surfaced rather than swallowed. Every caller invokes this as
   * `void this.newEntry()`, so anything thrown below became an unhandled
   * rejection that never even reached the console — the command would appear
   * to open the journal and do nothing else, with no trace of why.
   */
  async newEntry(): Promise<void> {
    try {
      const view = await this.openJournal();

      if (!view) {
        console.error("Journal Entries: the journal view was not available after opening it");
        new Notice("Journal Entries: could not open the journal.");
        return;
      }

      await view.startNewEntry();
    } catch (error) {
      console.error("Journal Entries: could not start a new entry", error);
      new Notice("Journal Entries: could not start a new entry. See the developer console.");
    }
  }

  async goToToday(): Promise<void> {
    const view = await this.openJournal();
    if (view) await view.goToToday();
  }

  /**
   * Opens the calendar view in the right sidebar, reusing an existing leaf
   * when one exists — same shape as `openJournal`. Returns null if
   * `getRightLeaf` itself returns null (no right split exists to create a
   * leaf in — not expected in Obsidian's normal layout, but the API is
   * documented as nullable) or if the leaf's view isn't a CalendarView by
   * the time this resolves.
   */
  async openCalendar(): Promise<CalendarView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return null;
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof CalendarView ? view : null;
  }

  /**
   * Opens (or reveals) the journal view and calls `goToDate` on it — the
   * calendar sidebar's click handler goes through this rather than reaching
   * into `openJournal`/`JournalView` itself, mirroring `newEntry`/
   * `goToToday`'s existing shape. A day with no entries still navigates:
   * `goToDate`/`anchorPosition` naturally land on the nearest older entry,
   * which is the correct reading of "take me to this point in time" (see
   * `JournalView.goToDate`'s doc).
   */
  async goToDateInJournal(date: Date): Promise<void> {
    const view = await this.openJournal();
    if (view) await view.goToDate(date);
  }

  refreshJournal(): void {
    this.journal.rebuild();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
      // A deferred leaf's view is a DeferredView, not a JournalView — its
      // onOpen rebuilds it when it loads, so it needs no refresh here. Skip
      // rather than throw, or one deferred leaf would abort the whole loop.
      const view = leaf.view;
      if (view instanceof JournalView) void view.reload();
    }
    // `rebuild()` above replaces the index directly, without going through
    // `JournalService`'s normal `onChange` batching — so a `CalendarView`,
    // which only re-renders from its `onChange` subscription, would
    // otherwise show stale dots until some unrelated vault event happened to
    // fire later. Refreshed here explicitly, same reasoning as the
    // JournalView loop above.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
      const view = leaf.view;
      if (view instanceof CalendarView) view.refresh();
    }
  }
}
