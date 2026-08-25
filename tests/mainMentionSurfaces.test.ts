// @vitest-environment jsdom
/**
 * What `main.ts` owes the three mention surfaces, tested at the plugin level
 * because that is where the bugs were: which surface gets placed, which gets
 * repainted, and which gets torn down are all decisions this one file makes
 * on behalf of shells that cannot make them for themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import {
  createFakeApp,
  installDomHelpers,
  MarkdownView as FakeMarkdownView,
  type TFile as FakeTFile,
} from "./obsidian-mock";
import JournalEntriesPlugin from "../src/main";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { createMentionsFooter, type MentionsFooter } from "../src/mentions/mentionsFooter";
import { createMentionsPanel, destroyMentionPanels } from "../src/mentions/MentionsPanel";
import { VIEW_TYPE_MENTIONS } from "../src/mentions/MentionsView";
import { JournalSettingsTab } from "../src/settings/SettingsTab";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // `MentionsPanel`'s registry is module-level, so a panel a test leaves alive
  // is still registered when the next one runs — and `refreshJournal` below
  // renders every registered panel. Cleaning up here keeps one test's leftovers
  // out of the next test's assertions.
  destroyMentionPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const NOTE = "Notes/Trip.md";

/** Lets a `void panel.render()` — kicked off but never awaited — finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  note: FakeTFile;
  /** Called when a panel's `journal.onChange` unsubscribe actually runs. */
  journalUnsubscribed: ReturnType<typeof vi.fn>;
}

/**
 * Builds a real `JournalEntriesPlugin` over the fakes.
 *
 * `onload()` is deliberately NOT run: it wants a real Obsidian `Plugin` base
 * for `registerView`/`addCommand`/`registerMarkdownCodeBlockProcessor`, none
 * of which the mock has, and modelling that scheduling would be the guesswork
 * `tests/obsidian-mock.ts`'s header warns against. The fields the methods
 * under test actually read are wired here instead — including the private
 * `mentionsFooter`, reached by the same reflection convention
 * `tests/mentionsView.test.ts` uses for a private panel.
 *
 * `journalFolder` starts as "Diary", which holds nothing: every seeded entry
 * lives under "Journal", so the index is empty until a test points the setting
 * at it. That is exactly the folder-setting change `refreshJournal` exists for.
 */
function setup(entryCount = 2): Setup {
  const app = createFakeApp();
  app.vault.addFile(NOTE, "# Trip\n");

  for (let i = 0; i < entryCount; i++) {
    const day = String(24 - i).padStart(2, "0");
    const path = `Journal/2026/08/2026-08-${day}-21-40-00.md`;
    app.vault.addFile(path, `---\ncreated: 2026-08-${day}T21:40:00\n---\nEntry ${i} about [[Trip]]`);
    app.metadataCache.resolvedLinks[path] = { [NOTE]: 1 };
  }

  const plugin = new JournalEntriesPlugin(app as unknown as App, {} as PluginManifest);
  plugin.app = app as unknown as App;
  plugin.settings = {
    journalFolder: "Diary",
    showMentionsUnderNotes: true,
    mentionsSidebar: false,
  };
  plugin.repository = new EntryRepository(app as unknown as App, () => plugin.settings.journalFolder);
  plugin.journal = new JournalService(app as unknown as App, plugin.repository);
  plugin.journal.load();

  // Counts subscribe/unsubscribe pairs so a leaked panel is observable — the
  // panel's own `destroyed` flag cannot tell a removed listener from an
  // ignored one. Same convention as `tests/mentionsPanel.test.ts`.
  const journalUnsubscribed = vi.fn();
  const realOnChange = plugin.journal.onChange.bind(plugin.journal);
  vi.spyOn(plugin.journal, "onChange").mockImplementation((callback) => {
    const off = realOnChange(callback);
    return () => {
      journalUnsubscribed();
      off();
    };
  });

  (plugin as unknown as { mentionsFooter: MentionsFooter }).mentionsFooter =
    createMentionsFooter(plugin);

  return { app, plugin, note: app.vault.files.get(NOTE) as FakeTFile, journalUnsubscribed };
}

function mentionsLeaves(app: Setup["app"]): unknown[] {
  return app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS);
}

/** A markdown pane holding `file`, with the reading-view sizer the footer mounts into. */
function addMarkdownLeaf(app: Setup["app"], file: FakeTFile): FakeMarkdownView {
  const leaf = app.workspace.addLeaf("markdown");
  const view = new FakeMarkdownView(leaf);
  view.file = file;
  view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
  leaf.view = view;
  return view;
}

describe("applyMentionSettings", () => {
  /**
   * The bug this pins: `applyMentionSettings` used to detach unconditionally
   * whenever the sidebar setting was off, and it runs on every plugin load. So
   * a panel opened with `Open journal mentions` — which CLAUDE.md § Mentions
   * Rule 5 and the README both promise works whatever the setting says —
   * disappeared at the next Obsidian start. Same "permanently locks the user
   * out" shape as the calendar placement policy `ensureCalendarLeaf`'s doc
   * describes being rewritten to avoid.
   */
  it("leaves a manually opened panel alone on a plugin load with the setting off", async () => {
    const { app, plugin } = setup();
    plugin.settings.mentionsSidebar = false;

    await plugin.openMentions();
    expect(mentionsLeaves(app)).toHaveLength(1);

    // What `onLayoutReady` calls: no argument, so it may only ever ensure.
    plugin.applyMentionSettings();

    expect(mentionsLeaves(app)).toHaveLength(1);
  });

  /**
   * The unrelated toggle must not take the sidebar with it either — driven
   * through the real settings tab, because "the tab passes the right flag" and
   * "the plugin does the right thing with it" are two halves of one promise
   * and the bug lived in the join between them.
   */
  it("leaves it alone when the footer toggle is flipped in the settings tab", async () => {
    const { app, plugin } = setup();
    plugin.settings.mentionsSidebar = false;
    await plugin.openMentions();
    // `saveData` belongs to the real `Plugin` base the mock does not model;
    // what this test is about starts after the save resolves.
    vi.spyOn(plugin, "saveSettings").mockResolvedValue();
    const tab = new JournalSettingsTab(plugin);

    tab.setControlValue("showMentionsUnderNotes", false);
    await settle();

    expect(plugin.settings.showMentionsUnderNotes).toBe(false);
    expect(mentionsLeaves(app)).toHaveLength(1);
  });

  it("closes it when the sidebar toggle is switched off in the settings tab", async () => {
    const { app, plugin } = setup();
    plugin.settings.mentionsSidebar = true;
    await plugin.openMentions();
    vi.spyOn(plugin, "saveSettings").mockResolvedValue();
    const tab = new JournalSettingsTab(plugin);

    tab.setControlValue("mentionsSidebar", false);
    await settle();

    expect(mentionsLeaves(app)).toHaveLength(0);
  });

  it("detaches only when the sidebar setting itself is turned off", async () => {
    const { app, plugin } = setup();
    await plugin.openMentions();

    plugin.settings.mentionsSidebar = false;
    plugin.applyMentionSettings(true);

    expect(mentionsLeaves(app)).toHaveLength(0);
  });

  it("places one leaf when the setting is on, and never a second", async () => {
    const { app, plugin } = setup();
    plugin.settings.mentionsSidebar = true;

    plugin.applyMentionSettings();
    await settle();
    expect(mentionsLeaves(app)).toHaveLength(1);

    plugin.applyMentionSettings();
    await settle();
    expect(mentionsLeaves(app)).toHaveLength(1);
  });
});

describe("refreshJournal", () => {
  /**
   * A footer panel and a code-block panel are driven by neither of the two
   * loops over leaves in `refreshJournal`: no view lookup can reach them.
   * `journal.rebuild()` announces nothing to `onChange` by design, so without
   * an explicit repaint they keep listing entries resolved against the old
   * Journal folder until some unrelated entry file happens to re-resolve.
   */
  it("repaints a panel that no view lookup can reach", async () => {
    const { plugin, note } = setup();
    const container = document.body.createDiv();
    const panel = createMentionsPanel({ plugin, container, target: note });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);

    plugin.settings.journalFolder = "Journal";
    plugin.refreshJournal();
    await settle();

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("does not repaint a panel that has been destroyed", async () => {
    const { plugin, note } = setup();
    const container = document.body.createDiv();
    const panel = createMentionsPanel({ plugin, container, target: note });
    await panel.render();
    panel.destroy();

    plugin.settings.journalFolder = "Journal";
    plugin.refreshJournal();
    await settle();

    expect(container.childElementCount).toBe(0);
  });

  /**
   * The footers need the same treatment for a second reason: which notes get
   * one at all depends on the Journal folder, so a note that just became an
   * entry keeps a footer it must not have.
   */
  it("syncs the footers, so a note that just became an entry loses its own", async () => {
    const { app, plugin, note } = setup();
    plugin.settings.journalFolder = "Journal";
    const view = addMarkdownLeaf(app, note);

    plugin.refreshJournal();
    await settle();
    expect(view.containerEl.querySelector(".journal-mentions-footer")).not.toBeNull();

    // "Notes" now IS the journal folder, so the note the footer is under is an
    // entry — and an entry's own timeline already shows this.
    plugin.settings.journalFolder = "Notes";
    plugin.refreshJournal();
    await settle();

    expect(view.containerEl.querySelector(".journal-mentions-footer")).toBeNull();
  });
});

describe("onunload", () => {
  /**
   * A code-block panel is owned by its note's preview component, not by this
   * plugin, and unregistering a post-processor does not by itself unload
   * children already loaded — so its subscriptions can outlive the plugin.
   * Stood in for here by a panel nothing else holds.
   */
  it("destroys every live panel, including one no shell of this plugin owns", async () => {
    const { app, plugin, note, journalUnsubscribed } = setup();
    plugin.settings.journalFolder = "Journal";
    // `setup` loaded the service against the empty "Diary" folder; nothing
    // here goes through `refreshJournal`, so the index is rebuilt by hand.
    plugin.journal.rebuild();
    const container = document.body.createDiv();
    const panel = createMentionsPanel({ plugin, container, target: note });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    plugin.onunload();

    expect(container.childElementCount).toBe(0);
    expect(journalUnsubscribed).toHaveBeenCalledTimes(1);

    // The metadata-cache listener must be GONE, not merely ignored: the
    // panel's own `destroyed` flag would satisfy any assertion about the DOM.
    // `isEntryFile` is the first thing that listener calls, so a spy on it
    // observes the listener itself running — the same technique, and the same
    // reason, as `tests/mentionsPanel.test.ts`'s teardown test.
    const isEntryFile = vi.spyOn(plugin.repository, "isEntryFile");
    const entry = app.vault.files.get("Journal/2026/08/2026-08-24-21-40-00.md") as FakeTFile;
    app.metadataCache.trigger("resolve", entry);
    await vi.advanceTimersByTimeAsync(200);

    expect(isEntryFile).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });
});
