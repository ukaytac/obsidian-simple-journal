// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile, WorkspaceLeaf as ObsidianWorkspaceLeaf } from "obsidian";
import {
  createFakeApp,
  installDomHelpers,
  WorkspaceLeaf as FakeWorkspaceLeaf,
} from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { MentionsView } from "../src/mentions/MentionsView";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const NOTE_A = "People/Ekin Arslan Aytaç.md";
const NOTE_B = "Projects/Simple Journal.md";

const EMPTY_PROMPT = "Open a note to see the journal entries that mention it.";

/** Lets the panel's `void render()` — kicked off but never awaited — finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Reaches past `private` to check the view holds no panel. The DOM alone
 * cannot tell "no panel" from "a panel that rendered nothing", and those are
 * different states: the second one would make the next `file-open` for the
 * same note short-circuit. Same reflection convention as
 * `journalViewHarness.ts`'s `internals`.
 */
function panelOf(view: MentionsView): unknown {
  return (view as unknown as { panel: unknown }).panel;
}

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  service: JournalService;
  plugin: JournalEntriesPlugin;
  view: MentionsView;
  /** Called when the panel's `journal.onChange` unsubscribe actually runs. */
  journalUnsubscribed: ReturnType<typeof vi.fn>;
  /**
   * Adds `count` entries mentioning `targetPath`, straight into the fake
   * vault with no event fired. `setup` has already called `service.load()`,
   * which snapshots the vault, so anything seeded through this afterwards is
   * invisible until an explicit `service.rebuild()` — which is exactly the
   * situation the `refresh()` test below needs.
   */
  seed: (targetPath: string, count: number, hour: string) => void;
}

/**
 * Wires a real `EntryRepository` + `JournalService` over the fakes and builds
 * a real `MentionsView` on top of them, the same convention
 * `tests/mentionsPanel.test.ts` and `tests/journalViewHarness.ts` follow — so
 * what these tests exercise below the Obsidian shell is the plugin's own
 * code, not the behaviour of a mock.
 *
 * Pass the entry counts here for a journal that should already exist when the
 * service loads; `Setup.seed` is for entries added after that, and says what
 * it takes to make them visible.
 */
function setup(counts: { a?: number; b?: number } = {}): Setup {
  const app = createFakeApp();
  app.vault.addFile(NOTE_A, "# Ekin\n");
  app.vault.addFile(NOTE_B, "# Simple Journal\n");

  /**
   * `hour` keeps the two targets' entry filenames distinct while leaving each
   * target's own entries on descending days — the order the panel renders in.
   */
  const seed = (targetPath: string, count: number, hour: string): void => {
    for (let i = 0; i < count; i++) {
      const day = String(24 - i).padStart(2, "0");
      const path = `Journal/2026/08/2026-08-${day}-${hour}-40-00.md`;
      app.vault.addFile(
        path,
        `---\ncreated: 2026-08-${day}T${hour}:40:00\n---\nEntry ${i} about [[${targetPath}]]`,
      );
      app.metadataCache.resolvedLinks[path] = { [targetPath]: 1 };
    }
  };

  if (counts.a) seed(NOTE_A, counts.a, "21");
  if (counts.b) seed(NOTE_B, counts.b, "09");

  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();

  // Wraps the real `onChange` so a test can observe the unsubscribe the panel
  // was handed actually running. The panel's own `destroyed` flag makes "did a
  // change still reach it?" unable to tell a removed listener from an ignored
  // one — the same hole `mentionsPanel.test.ts` closes this way.
  const journalUnsubscribed = vi.fn();
  const realOnChange = service.onChange.bind(service);
  vi.spyOn(service, "onChange").mockImplementation((callback) => {
    const off = realOnChange(callback);
    return () => {
      journalUnsubscribed();
      off();
    };
  });

  const plugin = {
    app,
    repository,
    journal: service,
    goToDateInJournal: vi.fn(),
  } as unknown as JournalEntriesPlugin;

  const leaf = new FakeWorkspaceLeaf(app);
  const view = new MentionsView(leaf as unknown as ObsidianWorkspaceLeaf, plugin);

  return { app, service, plugin, view, journalUnsubscribed, seed };
}

function fileAt(app: Setup["app"], path: string): TFile {
  return app.vault.files.get(path) as unknown as TFile;
}

/** The mentions count the panel renders, or null when no panel is on screen. */
function shownCount(view: MentionsView): string | null {
  return view.contentEl.querySelector(".journal-mentions-count")?.textContent ?? null;
}

function shownEntries(view: MentionsView): number {
  return view.contentEl.querySelectorAll(".journal-mentions-entry").length;
}

describe("MentionsView", () => {
  it("renders a panel for the active file", async () => {
    const { app, view } = setup({ a: 2, b: 3 });
    app.workspace.activeFile = fileAt(app, NOTE_A);

    await view.onOpen();
    await settle();

    // 2, not 5: the panel answers for the active file only, and the three
    // entries mentioning the other note are in the same journal folder.
    expect(shownCount(view)).toBe("2");
    expect(shownEntries(view)).toBe(2);
  });

  it("rebuilds the panel when file-open reports a different file", async () => {
    const { app, view, journalUnsubscribed } = setup({ a: 2, b: 3 });
    app.workspace.activeFile = fileAt(app, NOTE_A);
    await view.onOpen();
    await settle();
    expect(shownCount(view)).toBe("2");

    const noteB = fileAt(app, NOTE_B);
    app.workspace.activeFile = noteB;
    app.workspace.trigger("file-open", noteB);
    await settle();

    expect(shownCount(view)).toBe("3");
    // The old panel was destroyed, not merely detached from the DOM: its
    // journal subscription would otherwise keep re-rendering into a container
    // nothing can see.
    expect(journalUnsubscribed).toHaveBeenCalledTimes(1);
  });

  it("leaves an expanded panel alone when file-open reports the file already shown", async () => {
    const { app, view } = setup({ a: 8 });
    app.workspace.activeFile = fileAt(app, NOTE_A);
    await view.onOpen();
    await settle();

    view.contentEl.querySelector<HTMLButtonElement>(".journal-mentions-more")?.click();
    await settle();
    expect(shownEntries(view)).toBe(8);

    const panelEl = view.contentEl.firstElementChild;
    app.workspace.trigger("file-open", fileAt(app, NOTE_A));
    await settle();

    // The point of the `shownPath` short-circuit: Obsidian fires `file-open`
    // for plenty of reasons that leave the active file where it was, and a
    // rebuild would silently throw away the pages the user asked for. Eight
    // entries AND the same element prove no rebuild happened — a rebuilt
    // panel would be back to its initial five in a fresh container.
    expect(shownEntries(view)).toBe(8);
    expect(view.contentEl.firstElementChild).toBe(panelEl);
  });

  it("shows the prompt and holds no panel when there is no active file", async () => {
    const { app, view } = setup({ a: 2 });
    app.workspace.activeFile = null;

    await view.onOpen();
    await settle();

    expect(view.contentEl.textContent).toBe(EMPTY_PROMPT);
    expect(panelOf(view)).toBeNull();
  });

  it("returns to the prompt when the active file goes away", async () => {
    const { app, view } = setup({ a: 2 });
    app.workspace.activeFile = fileAt(app, NOTE_A);
    await view.onOpen();
    await settle();
    expect(shownCount(view)).toBe("2");

    app.workspace.activeFile = null;
    app.workspace.trigger("file-open", null);
    await settle();

    expect(view.contentEl.textContent).toBe(EMPTY_PROMPT);
    expect(panelOf(view)).toBeNull();
  });

  it("destroys the panel and its subscriptions on close", async () => {
    const { app, view, plugin, journalUnsubscribed } = setup({ a: 2 });
    app.workspace.activeFile = fileAt(app, NOTE_A);
    await view.onOpen();
    await settle();

    await view.onClose();

    expect(view.contentEl.childElementCount).toBe(0);
    expect(journalUnsubscribed).toHaveBeenCalledTimes(1);

    // The panel's metadata-cache listener must be GONE, not merely ignored:
    // its own `destroyed` flag would satisfy any assertion about the DOM on
    // its own. `isEntryFile` is the first thing that listener calls, ahead of
    // every guard the panel owns, so a spy on it observes the listener itself
    // running — the same technique, and the same reason, as
    // `mentionsPanel.test.ts`'s teardown test.
    const isEntryFile = vi.spyOn(plugin.repository, "isEntryFile");
    const entry = fileAt(app, "Journal/2026/08/2026-08-24-21-40-00.md");
    app.metadataCache.trigger("resolve", entry);
    await vi.advanceTimersByTimeAsync(200);

    expect(isEntryFile).not.toHaveBeenCalled();
    expect(view.contentEl.childElementCount).toBe(0);
  });

  it("stops listening for file-open once the view is unloaded", async () => {
    const { app, view } = setup({ a: 2, b: 3 });
    app.workspace.activeFile = fileAt(app, NOTE_A);
    await view.onOpen();
    await settle();

    // `registerEvent`, not a bare `on`, is what ties the subscription to the
    // view's Component lifecycle — so it is released even along a teardown
    // path that never reaches `onClose`. Spying on `getActiveFile` observes
    // the handler itself: `refresh()` calls it before any state of its own.
    const getActiveFile = vi.spyOn(app.workspace, "getActiveFile");
    view.unload();

    const noteB = fileAt(app, NOTE_B);
    app.workspace.activeFile = noteB;
    app.workspace.trigger("file-open", noteB);
    await settle();

    expect(getActiveFile).not.toHaveBeenCalled();
    expect(shownCount(view)).toBe("2");
  });

  it("renders from a rebuilt index that no onChange announced, when refresh() is called", async () => {
    const { app, service, view, seed } = setup();
    app.workspace.activeFile = null;
    await view.onOpen();
    await settle();
    expect(view.contentEl.textContent).toBe(EMPTY_PROMPT);

    // What a Journal-folder setting change looks like from here: `main.ts`'s
    // `refreshJournal` replaces the index with `rebuild()`, which deliberately
    // emits nothing to `onChange`, and then drives each view's public
    // `refresh()` by hand. Nothing the panel subscribes to fires along that
    // path, so `refresh()` is the only thing that can repaint.
    seed(NOTE_A, 2, "21");
    service.rebuild();
    app.workspace.activeFile = fileAt(app, NOTE_A);

    view.refresh();
    await settle();

    expect(shownCount(view)).toBe("2");
  });
});
