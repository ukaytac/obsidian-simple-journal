import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { collectTags } from "./journal/entryTags";
import { JournalService } from "./services/journalService";
import { DEFAULT_SETTINGS, type JournalSettings } from "./settings/settings";
import { JournalSettingsTab } from "./settings/SettingsTab";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./views/CalendarView";
import { createEntryEditorFactory, type EntryEditorFactory } from "./views/EntryEditor";
import { JournalView, VIEW_TYPE_JOURNAL } from "./views/JournalView";
import { TagScopeModal } from "./views/TagScopeModal";

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
      callback: () => {
        void this.openJournal();
      },
    });

    this.addCommand({
      id: "new-journal-entry",
      name: "New journal entry",
      callback: () => {
        void this.newEntry();
      },
    });

    this.addCommand({
      id: "go-to-today",
      name: "Go to today",
      callback: () => {
        void this.goToToday();
      },
    });

    this.addCommand({
      id: "filter-journal-by-tag",
      name: "Filter journal by tag",
      callback: () => {
        void this.filterByTag();
      },
    });

    // No ribbon icon for this — the ribbon already has two (Open journal,
    // New journal entry), and CLAUDE.md warns against ribbon/UI clutter.
    // Not opened automatically alongside the journal, either: this is an
    // optional companion view, not part of the MVP's core flow.
    this.addCommand({
      id: "open-calendar",
      name: "Open calendar",
      callback: () => {
        void this.openCalendar();
      },
    });

    // Lets a phone home-screen shortcut (or any other launcher) capture a
    // thought in one tap: `obsidian://simple-journal-new` reuses the exact same
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
    this.registerObsidianProtocolHandler("simple-journal-new", () => {
      this.app.workspace.onLayoutReady(() => {
        this.newEntry().catch((error) => {
          console.error(
            "Simple Journal: could not create a new entry from the obsidian://simple-journal-new link",
            error,
          );
          new Notice(
            "Could not open a new entry from the link. See the developer console for details.",
          );
        });
      });
    });

    this.app.workspace.onLayoutReady(() => void this.ensureCalendarLeaf());
  }

  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically.
  }

  async loadSettings(): Promise<void> {
    // `loadData` is typed `any`: it returns whatever JSON is on disk, which a
    // user or an older build may have written, so nothing about its shape is
    // guaranteed. Naming that as `unknown` rather than spreading `any` keeps
    // the validation below the only thing that decides what is usable — and
    // that check is why a hand-edited data.json cannot poison the folder path.
    const stored: unknown = await this.loadData();
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      typeof stored === "object" && stored !== null ? (stored as Partial<JournalSettings>) : {},
    );

    if (typeof this.settings.journalFolder !== "string" || this.settings.journalFolder.trim() === "") {
      this.settings.journalFolder = DEFAULT_SETTINGS.journalFolder;
    }
  }

  /**
   * Ensures a calendar leaf exists somewhere in the workspace on every load,
   * placing one in the right sidebar if none is found anywhere (either
   * sidebar or the main area). This used to run once, on first install,
   * guarded by a `hasAutoOpenedCalendar` flag — the reasoning being that
   * Obsidian persists the workspace layout, so re-placing it on every load
   * would put it back for a user who deliberately closed it. In practice
   * that policy backfired: once a saved layout lost its calendar leaf for any
   * reason, the flag being `true` meant the plugin would never place it
   * again, and the only way back was a command few people had found in the
   * first place. Ensuring presence on every load trades "might reappear for
   * someone who closed it on purpose" for "never permanently locks anyone
   * out," which is the safer failure mode.
   *
   * Deferred to `onLayoutReady` because the right split does not necessarily
   * exist yet during `onload`, and `getRightLeaf` can return null when it
   * doesn't. The callback fires immediately when the layout is already
   * initialized, which is the case when a user enables the plugin by hand
   * rather than at startup.
   *
   * This must never steal focus or change what the user is looking at, so it
   * deliberately does not reuse `openCalendar`'s "open and show" path: it
   * calls `setViewState` with `active: false` (the new leaf is not made the
   * focused leaf) and never calls `revealLeaf` (the sidebar is not
   * uncollapsed and the tab is not switched to). `Open calendar` the command
   * is unaffected and keeps activating/revealing, since the user asked for
   * it explicitly there.
   */
  private async ensureCalendarLeaf(): Promise<void> {
    try {
      // A calendar leaf anywhere — either sidebar or the main area — counts;
      // do not create a second one and do not move an existing one.
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length > 0) return;

      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return;

      await rightLeaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: false });
    } catch (error) {
      console.error("Simple Journal: could not place the calendar in the sidebar", error);
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
        console.error("Simple Journal: the journal view was not available after opening it");
        new Notice("Could not open the journal.");
        return;
      }

      await view.startNewEntry();
    } catch (error) {
      console.error("Simple Journal: could not start a new entry", error);
      new Notice("Could not start a new entry. See the developer console.");
    }
  }

  async goToToday(): Promise<void> {
    const view = await this.openJournal();
    if (view) await view.goToToday();
  }

  /**
   * Opens (or reveals) the journal and prompts for a tag to scope it to —
   * same shape as `newEntry`/`goToToday`/`goToDateInJournal`, so nothing
   * about opening the view is duplicated here.
   *
   * The tag list comes from the index, so it contains exactly the tags that
   * are actually reachable in the timeline — never a vault-wide tag list
   * offering choices that would scope the journal to nothing.
   *
   * Wrapped in try/catch, like `newEntry`, and for the same reason: this is
   * invoked as `void this.filterByTag()` (see the command registration
   * above), and it starts with the same `await this.openJournal()` call as
   * `newEntry` does — `leaf.setViewState(...)` then `revealLeaf(leaf)` —
   * which can throw for the same reasons `newEntry`'s doc names. Left
   * unwrapped, that throw would be an unhandled rejection that never reaches
   * the console: the command would appear to do nothing. An earlier version
   * of this comment claimed the whole path was "synchronous, in-memory, and
   * has no realistic failure mode" — true of the tag-collection and
   * modal-opening code below `openJournal()`, never of `openJournal()`
   * itself. `goToToday` and `goToDateInJournal` share that same unwrapped
   * `openJournal()` call and the same exposure; this method just no longer
   * joins them in leaving it unhandled.
   *
   * The modal callback below calls `view.requestTagScope(...)`, not
   * `view.setTagScope(...)` directly: `setTagScope`'s returned promise can
   * genuinely reject (`reload()` flushes every pending debounced save
   * through `clearTimeline` — a real vault write — and `renderStatic` awaits
   * `readBody` unguarded), and this callback has no `async` caller of its
   * own to hand that rejection to. `requestTagScope` is the one guarded
   * wrapper every fire-and-forget tag-scope call site uses; see its doc on
   * `JournalView`.
   */
  async filterByTag(): Promise<void> {
    try {
      const view = await this.openJournal();

      if (!view) {
        console.error("Simple Journal: the journal view was not available after opening it");
        new Notice("Could not open the journal.");
        return;
      }

      const tags = collectTags(this.journal.getEntries());
      const active = view.activeTagScope();

      // Nothing to choose and nothing to clear — a prompt would be a dead end.
      if (tags.length === 0 && active === null) {
        new Notice("No tags in the journal yet.");
        return;
      }

      new TagScopeModal(this.app, tags, active !== null, (choice) => {
        view.requestTagScope(choice.kind === "clear" ? null : choice.tag);
      }).open();
    } catch (error) {
      console.error("Simple Journal: could not open the tag filter", error);
      new Notice("Could not open the tag filter. See the developer console.");
    }
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
