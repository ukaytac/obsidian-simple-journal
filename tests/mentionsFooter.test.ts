// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import {
  createFakeApp,
  installDomHelpers,
  MarkdownView as FakeMarkdownView,
  type WorkspaceLeaf as FakeWorkspaceLeaf,
} from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { createMentionsFooter, findContentFlowEl } from "../src/mentions/mentionsFooter";
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
const ENTRY = "Journal/2026/08/2026-08-24-21-40-00.md";

/** Lets the footer's `void panel.render()` — kicked off but never awaited — finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  footer: ReturnType<typeof createMentionsFooter>;
  /** How many panels have subscribed to the journal and never unsubscribed. */
  livePanels: () => number;
}

/**
 * Wires a real `EntryRepository` + `JournalService` over the fakes, the same
 * convention `tests/mentionsView.test.ts` and `tests/mentionsPanel.test.ts`
 * follow, so what these tests exercise below the Obsidian shell is the
 * plugin's own code rather than the behaviour of a mock.
 *
 * `counts.a` seeds entries mentioning NOTE_A; NOTE_B is deliberately left
 * unmentioned so one test can prove an empty panel still mounts.
 */
function setup(counts: { a?: number } = {}): Setup {
  const app = createFakeApp();
  app.vault.addFile(NOTE_A, "# Ekin\n");
  app.vault.addFile(NOTE_B, "# Simple Journal\n");
  app.vault.addFile(ENTRY, "---\ncreated: 2026-08-24T21:40:00\n---\nAn entry with no links.\n");

  for (let i = 0; i < (counts.a ?? 0); i++) {
    const day = String(24 - i).padStart(2, "0");
    const path = `Journal/2026/08/2026-08-${day}-09-40-00.md`;
    app.vault.addFile(path, `---\ncreated: 2026-08-${day}T09:40:00\n---\nEntry ${i} about [[${NOTE_A}]]`);
    app.metadataCache.resolvedLinks[path] = { [NOTE_A]: 1 };
  }

  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();

  // Counts subscribe/unsubscribe pairs so a leaked panel is observable. The
  // panel's own `destroyed` flag cannot tell a removed listener from an
  // ignored one — the same hole `mentionsView.test.ts` closes this way.
  let live = 0;
  const realOnChange = service.onChange.bind(service);
  vi.spyOn(service, "onChange").mockImplementation((callback) => {
    live++;
    const off = realOnChange(callback);
    return () => {
      live--;
      off();
    };
  });

  const plugin = {
    app,
    repository,
    journal: service,
    settings: { journalFolder: "Journal", showMentionsUnderNotes: true, mentionsSidebar: false },
    goToDateInJournal: vi.fn(),
  } as unknown as JournalEntriesPlugin;

  return { app, plugin, footer: createMentionsFooter(plugin), livePanels: () => live };
}

function fileAt(app: Setup["app"], path: string): TFile {
  return app.vault.files.get(path) as unknown as TFile;
}

type Sizer = "markdown-preview-sizer" | "cm-sizer" | "none";

/**
 * Registers a markdown leaf holding a `MarkdownView` over `file`, with
 * `sizer` standing in for whichever layout element the real reading or live
 * preview mode would have built.
 */
function addMarkdownLeaf(
  app: Setup["app"],
  file: TFile | null,
  sizer: Sizer = "markdown-preview-sizer",
): { leaf: FakeWorkspaceLeaf; view: FakeMarkdownView } {
  const leaf = app.workspace.addLeaf("markdown");
  const view = new FakeMarkdownView(leaf);
  view.file = file as unknown as (typeof view)["file"];
  if (sizer !== "none") view.contentEl.createDiv({ cls: sizer });
  leaf.view = view;
  return { leaf, view };
}

/** Every footer container currently in the document. */
function footerEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".journal-mentions-footer"));
}

function footerIn(view: FakeMarkdownView): HTMLElement | null {
  return view.containerEl.querySelector<HTMLElement>(".journal-mentions-footer");
}

describe("findContentFlowEl", () => {
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE GUARD ON THIS CODEBASE'S SECOND INTERNALS EXCEPTION. DO NOT DELETE.
   *
   * `mentionsFooter.ts` reaches into Obsidian's own layout elements
   * (`.markdown-preview-sizer`, `.cm-sizer`) because no public API can append
   * to a note's content flow — see the module header and CLAUDE.md § Editing
   * for the precedent this borrows. The exception is only safe while its
   * absence is a silent no-op: if a future Obsidian renames or restructures
   * those elements, the feature must simply disappear, altering no note and
   * risking no journal data.
   *
   * This test is what holds that promise. It is the reason the plugin may
   * keep the exception at all.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it("does nothing and throws nothing when neither layout element exists", async () => {
    const { app, plugin, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "none");

    expect(() => footer.sync()).not.toThrow();
    await settle();

    expect(findContentFlowEl(view.containerEl)).toBeNull();
    expect(footerEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
    // Nothing was added to the view at all, not merely nothing recognisable.
    expect(view.contentEl.children).toHaveLength(0);
    expect(plugin.app.vault.getMarkdownFiles().length).toBeGreaterThan(0);
  });

  it("finds the reading-view sizer", () => {
    const container = document.createElement("div");
    const sizer = container.createDiv({ cls: "markdown-preview-sizer" });
    expect(findContentFlowEl(container)).toBe(sizer);
  });

  it("finds the live-preview sizer", () => {
    const container = document.createElement("div");
    const sizer = container.createDiv({ cls: "cm-sizer" });
    expect(findContentFlowEl(container)).toBe(sizer);
  });
});

describe("createMentionsFooter", () => {
  it("mounts a panel into the reading-view sizer", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "markdown-preview-sizer");

    footer.sync();
    await settle();

    const el = footerIn(view);
    expect(el).not.toBeNull();
    expect(el?.parentElement).toBe(findContentFlowEl(view.containerEl));
    expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
  });

  it("mounts a panel into the live-preview sizer", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "cm-sizer");

    footer.sync();
    await settle();

    expect(footerIn(view)?.parentElement).toBe(findContentFlowEl(view.containerEl));
  });

  it("mounts nothing while the setting is off", async () => {
    const { app, plugin, footer, livePanels } = setup({ a: 2 });
    plugin.settings.showMentionsUnderNotes = false;
    addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();

    expect(footerEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
  });

  it("unmounts everything when the setting is turned off after mounting", async () => {
    const { app, plugin, footer, livePanels } = setup({ a: 2 });
    addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();
    expect(footerEls()).toHaveLength(1);

    plugin.settings.showMentionsUnderNotes = false;
    footer.sync();
    await settle();

    expect(footerEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
  });

  it("gives a journal entry no footer of its own", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, ENTRY));

    footer.sync();
    await settle();

    expect(footerIn(view)).toBeNull();
    expect(livePanels()).toBe(0);
  });

  it("gives a view with no file no footer", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, null);

    footer.sync();
    await settle();

    expect(footerIn(view)).toBeNull();
    expect(livePanels()).toBe(0);
  });

  it("skips a leaf whose view is not a MarkdownView", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    // Since Obsidian 1.7.2 an unloaded background tab reports a deferred view
    // here, which is exactly this shape: a leaf of type "markdown" whose view
    // is not a `MarkdownView`.
    app.workspace.addLeaf("markdown", { file: fileAt(app, NOTE_A) });

    expect(() => footer.sync()).not.toThrow();
    await settle();

    expect(footerEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
  });

  it("mounts a panel that renders nothing visible for a note with no mentions", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_B));

    footer.sync();
    await settle();

    const el = footerIn(view);
    // Mounted (so a later mention appears without a relayout) but childless,
    // which `.journal-mentions:empty` in styles.css collapses to nothing.
    expect(el).not.toBeNull();
    expect(el?.children).toHaveLength(0);
    expect(el?.textContent).toBe("");
    expect(livePanels()).toBe(1);
  });

  it("leaves an expanded footer alone when the same file is synced again", async () => {
    const { app, footer, livePanels } = setup({ a: 8 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();
    footerIn(view)?.querySelector<HTMLButtonElement>(".journal-mentions-more")?.click();
    await settle();
    expect(footerIn(view)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);

    const el = footerIn(view);
    footer.sync();
    await settle();

    // Element identity, not just the entry count: a rebuilt panel would be
    // back to its initial five inside a fresh container, silently discarding
    // the pages the user asked for.
    expect(footerIn(view)).toBe(el);
    expect(footerIn(view)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);
    expect(livePanels()).toBe(1);
  });

  it("replaces the footer when the same view moves to a different file", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();
    const el = footerIn(view);
    expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    view.file = fileAt(app, NOTE_B) as unknown as (typeof view)["file"];
    footer.sync();
    await settle();

    expect(footerIn(view)).not.toBe(el);
    expect(footerIn(view)?.children).toHaveLength(0);
    expect(footerEls()).toHaveLength(1);
    expect(livePanels()).toBe(1);
  });

  it("remounts when the sizer is replaced under it, as a mode switch does", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "markdown-preview-sizer");

    footer.sync();
    await settle();
    expect(footerIn(view)).not.toBeNull();

    // What switching between reading view and live preview does: the old
    // layout element goes away wholesale, taking the footer's container with
    // it, and a different one takes its place.
    view.contentEl.empty();
    view.contentEl.createDiv({ cls: "cm-sizer" });
    footer.sync();
    await settle();

    expect(footerIn(view)?.parentElement).toBe(findContentFlowEl(view.containerEl));
    expect(footerEls()).toHaveLength(1);
    expect(livePanels()).toBe(1);
  });

  it("releases the panel of a view that disappeared between syncs", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { leaf, view } = addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();
    expect(livePanels()).toBe(1);

    // A closed tab: the leaf is gone from the workspace, but the view element
    // this plugin wrote into is not this plugin's to be handed back.
    leaf.detach();
    footer.sync();
    await settle();

    expect(livePanels()).toBe(0);
    expect(footerIn(view)).toBeNull();
    expect(footerEls()).toHaveLength(0);
  });

  it("destroy() removes every footer and releases every panel", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view: first } = addMarkdownLeaf(app, fileAt(app, NOTE_A));
    const { view: second } = addMarkdownLeaf(app, fileAt(app, NOTE_B), "cm-sizer");

    footer.sync();
    await settle();
    expect(footerEls()).toHaveLength(2);
    expect(livePanels()).toBe(2);

    footer.destroy();

    expect(footerEls()).toHaveLength(0);
    expect(footerIn(first)).toBeNull();
    expect(footerIn(second)).toBeNull();
    expect(livePanels()).toBe(0);
  });
});
