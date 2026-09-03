// @vitest-environment jsdom
/**
 * What `main.ts` owes `Search journal`: which exit does what.
 *
 * Tested at the plugin level for the reason `mainMentionSurfaces.test.ts`
 * gives — the decision lives in this one file, and neither the modal that
 * hands the choice over nor the view that receives it can make it. Only
 * `Modal.open` is stubbed, so the real `SearchModal` still guards the choice
 * on its way through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { createFakeApp, installDomHelpers, Modal } from "./obsidian-mock";
import JournalEntriesPlugin from "../src/main";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { JournalView, VIEW_TYPE_JOURNAL } from "../src/views/JournalView";
import type { SearchChoice, SearchModal } from "../src/views/SearchModal";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

const ENTRY = "Journal/2026/08/2026-08-12-14-17-03.md";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  /** The modal `searchJournal` opened, once it has. */
  modal: () => SearchModal;
}

/**
 * Builds a real `JournalEntriesPlugin` over the fakes, with a leaf already
 * holding a `JournalView` so `openJournal()` resolves.
 *
 * The view is `Object.create`d rather than constructed: `searchJournal` only
 * reads `activeScope()` and `requestScope()` off it, and building a real one
 * would need the mount, paging and observer cluster this test says nothing
 * about. `instanceof JournalView` still holds, which is what `openJournal`
 * checks.
 */
function setup(): Setup {
  const app = createFakeApp();
  app.vault.addFile(ENTRY, "---\ncreated: 2026-08-12T14:17:03\n---\nİstanbul'da hava güzeldi");

  const plugin = new JournalEntriesPlugin(app as unknown as App, {} as PluginManifest);
  plugin.app = app as unknown as App;
  plugin.settings = {
    journalFolder: "Journal",
    entryFolders: "year-month",
    showMentionsUnderNotes: false,
    mentionsSidebar: false,
    mentionsFooterCollapsed: false,
  };
  plugin.repository = new EntryRepository(app as unknown as App, () => plugin.settings.journalFolder);
  plugin.journal = new JournalService(app as unknown as App, plugin.repository);
  plugin.journal.load();

  const view = Object.create(JournalView.prototype) as JournalView;
  view.activeScope = () => null;
  view.requestScope = vi.fn();
  app.workspace.addLeaf(VIEW_TYPE_JOURNAL, view);

  // `Modal.open()` is the last thing `searchJournal` does with the modal, and
  // the only way to reach the instance it built: nothing hands it back.
  let opened: SearchModal | null = null;
  vi.spyOn(Modal.prototype, "open").mockImplementation(function (this: unknown) {
    opened = this as SearchModal;
  });

  return {
    app,
    plugin,
    modal: () => {
      if (!opened) throw new Error("searchJournal opened no modal");
      return opened;
    },
  };
}

/** The choice a user makes by picking one result out of the list. */
function hitChoice(plugin: JournalEntriesPlugin): SearchChoice {
  const entry = plugin.journal.getEntries()[0];
  return { kind: "hit", hit: { entry, snippet: { before: "", match: "İstanbul", after: "" } } };
}

describe("searchJournal", () => {
  it("opens the chosen entry's own note, in a new tab", async () => {
    const { app, plugin, modal } = setup();

    await plugin.searchJournal();
    modal().onChooseSuggestion(hitChoice(plugin), new MouseEvent("click"));

    expect(app.workspace.opened).toEqual([
      { file: app.vault.files.get(ENTRY), pane: "tab" },
    ]);
  });

  /**
   * The regression this pins. Choosing a result used to call
   * `goToDateInJournal`, which anchors the timeline to the entry's calendar
   * DAY — hiding every entry newer than it, so the journal read as truncated,
   * and landing on the day's newest entry rather than the one that matched.
   * See CLAUDE.md § Search Rule 3.
   */
  it("leaves the timeline alone — no anchor, no scope", async () => {
    const { plugin, modal } = setup();
    const anchor = vi.spyOn(plugin, "goToDateInJournal");
    const view = await plugin.openJournal();

    await plugin.searchJournal();
    modal().onChooseSuggestion(hitChoice(plugin), new MouseEvent("click"));

    expect(anchor).not.toHaveBeenCalled();
    expect(view?.requestScope).not.toHaveBeenCalled();
  });
});
