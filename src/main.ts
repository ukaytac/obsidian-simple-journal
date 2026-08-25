import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { collectTags } from "./journal/entryTags";
import { destroyMentionPanels, refreshMentionPanels } from "./mentions/MentionsPanel";
import { MentionsView, VIEW_TYPE_MENTIONS } from "./mentions/MentionsView";
import { MENTIONS_BLOCK_SNIPPET, registerMentionsCodeBlock } from "./mentions/mentionsCodeBlock";
import { createMentionsFooter, type MentionsFooter } from "./mentions/mentionsFooter";
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
  private mentionsFooter: MentionsFooter | null = null;

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
    this.registerView(VIEW_TYPE_MENTIONS, (leaf) => new MentionsView(leaf, this));
    this.addSettingTab(new JournalSettingsTab(this));

    // No setting gates this. A toggle that turned the processor off would
    // leave raw ```simple-journal fences visible in notes the user had
    // already written, reading as breakage. The block is opt-in per note
    // already: the way to not have one is to not write one.
    registerMentionsCodeBlock(this);

    // Gated on `showMentionsUnderNotes` inside `sync()` rather than here, so
    // toggling the setting takes effect on the next event without a reload.
    this.mentionsFooter = createMentionsFooter(this);
    // Both of the first two are needed, not one. `active-leaf-change` covers
    // switching tabs; `layout-change` covers splitting, closing, and
    // switching a pane between reading view and live preview — which replaces
    // the layout element the footer is mounted in wholesale, and fires no
    // leaf change at all. `file-open` covers a pane that stays put while the
    // note inside it changes.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncMentionsFooter()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncMentionsFooter()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncMentionsFooter()));

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

    // Writes the empty fence rather than a `note:` directive: the block's
    // default target is the note it sits in, which is what someone inserting
    // it here almost always wants, and an unwanted directive is more work to
    // remove than a wanted one is to add.
    this.addCommand({
      id: "insert-mentions-block",
      name: "Insert journal mentions block",
      editorCallback: (editor) => {
        editor.replaceSelection(MENTIONS_BLOCK_SNIPPET);
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

    // Works whether or not `mentionsSidebar` is on: that setting governs
    // automatic placement, and a command is how you reach a thing.
    this.addCommand({
      id: "open-journal-mentions",
      name: "Open journal mentions",
      callback: () => {
        void this.openMentions();
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

    this.app.workspace.onLayoutReady(() => {
      void this.ensureCalendarLeaf();
      this.applyMentionSettings();
    });
  }

  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically.
    // The mentions footer is the exception, and the reason this method is no
    // longer empty: it is a DOM node this plugin put inside somebody else's
    // `MarkdownView`, so nothing else will ever take it back out. Left here,
    // it would sit under the user's notes with a dead panel behind it until
    // the pane was closed.
    this.mentionsFooter?.destroy();
    this.mentionsFooter = null;
    // Belt and braces rather than a known leak. A code block's panel belongs
    // to its note's preview component, not to this plugin, and unregistering
    // a post-processor does not by itself unload children that are already
    // loaded — so its `metadataCache` ref and `journal.onChange` listener can
    // outlive the plugin. Whether Obsidian force-rerenders open previews on
    // unregister (which would tear them down anyway) is not knowable from the
    // API, so this does not depend on the answer. `destroy()` is idempotent,
    // so a panel Obsidian does unload a moment later costs nothing.
    destroyMentionPanels();
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

    // Same reasoning as the folder check above: `data.json` is user-editable,
    // so a non-boolean here must not reach the code that reads it.
    if (typeof this.settings.showMentionsUnderNotes !== "boolean") {
      this.settings.showMentionsUnderNotes = DEFAULT_SETTINGS.showMentionsUnderNotes;
    }
    if (typeof this.settings.mentionsSidebar !== "boolean") {
      this.settings.mentionsSidebar = DEFAULT_SETTINGS.mentionsSidebar;
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
   * Opens (or reveals) the mentions sidebar. Mirrors `openCalendar`: an
   * existing leaf anywhere is reused, and the command path activates and
   * reveals because the user asked for it explicitly.
   */
  async openMentions(): Promise<MentionsView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;

    if (!existing[0]) {
      await leaf.setViewState({ type: VIEW_TYPE_MENTIONS, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);

    return leaf.view instanceof MentionsView ? leaf.view : null;
  }

  /**
   * Brings the optional mention surfaces into line with the current settings.
   * Called on layout-ready and after either toggle changes, so turning one on
   * takes effect without a reload — and turning one off actually removes it
   * rather than leaving it until the next restart.
   *
   * `sidebarTurnedOff` is the ONE thing that may close a mentions leaf, and
   * only the sidebar toggle itself passes it. This used to detach whenever the
   * setting was off, which meant the layout-ready call — and a change to the
   * unrelated footer toggle — silently closed a panel the user had opened with
   * `Open journal mentions`. That command works whatever the setting says
   * (CLAUDE.md § Mentions Rule 5: the setting governs automatic placement
   * only), so destroying its result on the next Obsidian start is the same
   * "permanently locks the user out" failure `ensureCalendarLeaf`'s doc
   * describes the calendar's placement policy being rewritten to avoid.
   */
  applyMentionSettings(sidebarTurnedOff = false): void {
    if (this.settings.mentionsSidebar) void this.ensureMentionsLeaf();
    else if (sidebarTurnedOff) this.detachMentionsLeaves();
    // `sync()` reads the setting itself, so this one call covers both
    // directions: mounting the footers when the toggle goes on, and removing
    // them when it goes off rather than leaving them until the next restart.
    this.syncMentionsFooter();
  }

  /**
   * Wrapped rather than called inline so the null check — the footer does not
   * exist until `onload` reaches it, and is dropped again in `onunload` —
   * lives in one place. `sync()` itself never throws; if that ever changes,
   * this is where the guard goes.
   */
  private syncMentionsFooter(): void {
    this.mentionsFooter?.sync();
  }

  /**
   * Places a mentions leaf in the right sidebar if none exists anywhere.
   * Identical policy to `ensureCalendarLeaf` — including never stealing
   * focus (`active: false`) and never revealing the sidebar — except that it
   * is gated on a setting, because unlike the calendar this surface is
   * opt-in.
   */
  private async ensureMentionsLeaf(): Promise<void> {
    try {
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS).length > 0) return;

      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return;

      await rightLeaf.setViewState({ type: VIEW_TYPE_MENTIONS, active: false });
    } catch (error) {
      console.error("Simple Journal: could not place the mentions panel in the sidebar", error);
    }
  }

  /**
   * Turning the setting off must remove the panel, not merely stop re-placing
   * it — leaving a surface the user just switched off sitting there until the
   * next restart is the same failure as ignoring the switch. Reached only from
   * that one transition; see `applyMentionSettings`.
   */
  private detachMentionsLeaves(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS)) {
      leaf.detach();
    }
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
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS)) {
      const view = leaf.view;
      if (view instanceof MentionsView) view.refresh();
    }
    // The other two mention shells reach no leaf lookup at all, and need the
    // same treatment for the same reason. Which notes get a footer depends on
    // the journal folder, so this both drops the footer from a note that just
    // became an entry and gives one to a note that stopped being one; the
    // repaint below then covers every footer and code-block panel that stayed
    // put but is now answering against the wrong folder. The sidebar's panel
    // is repainted twice over (once above, once below) — harmless: a render
    // is idempotent and token-guarded.
    this.syncMentionsFooter();
    refreshMentionPanels();
  }
}
