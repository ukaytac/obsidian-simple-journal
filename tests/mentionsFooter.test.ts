// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownViewModeType } from "obsidian";
import {
  createFakeApp,
  installDomHelpers,
  MarkdownView as FakeMarkdownView,
  type TFile as FakeTFile,
  type WorkspaceLeaf as FakeWorkspaceLeaf,
} from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { createMentionsFooter, findContentFlowEl } from "../src/mentions/mentionsFooter";
import { destroyMentionPanels } from "../src/mentions/MentionsPanel";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

/**
 * jsdom's own `MutationObserver`, wrapped so a test can count the ones still
 * connected.
 *
 * A wrapper rather than a fake: the footer waits for Obsidian to build a
 * pane's sizer by observing for it, so the regression test below needs a real
 * DOM mutation to really wake it. Only the bookkeeping is added — every
 * observer here is the genuine article, delivering asynchronously.
 *
 * Nothing in `src/` builds a `MutationObserver` except `mentionsFooter.ts`, so
 * the count is unambiguous.
 */
const RealMutationObserver = window.MutationObserver;

let observersLive = 0;

class CountingMutationObserver extends RealMutationObserver {
  /** So a repeated `observe()` on one instance is still one live observer. */
  private counted = false;

  observe(target: Node, options?: MutationObserverInit): void {
    if (!this.counted) {
      this.counted = true;
      observersLive++;
    }
    super.observe(target, options);
  }

  disconnect(): void {
    if (this.counted) {
      this.counted = false;
      observersLive--;
    }
    super.disconnect();
  }
}

/** How many observers the footer has started and not disconnected. */
function liveObservers(): number {
  return observersLive;
}

beforeEach(() => {
  vi.useFakeTimers();
  observersLive = 0;
  window.MutationObserver = CountingMutationObserver;
});

afterEach(() => {
  // The registry a collapse toggle repaints through is module-level, so a
  // panel one test leaves mounted is still in it when the next one clicks.
  destroyMentionPanels();
  window.MutationObserver = RealMutationObserver;
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
  /** Observes a collapse actually being remembered, not merely drawn. */
  saveSettings: ReturnType<typeof vi.fn<() => Promise<void>>>;
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

  const saveSettings = vi.fn(() => Promise.resolve());
  const plugin = {
    app,
    repository,
    journal: service,
    settings: {
      journalFolder: "Journal",
      showMentionsUnderNotes: true,
      mentionsSidebar: false,
      mentionsFooterCollapsed: false,
    },
    saveSettings,
    goToDateInJournal: vi.fn(),
  } as unknown as JournalEntriesPlugin;

  return {
    app,
    plugin,
    footer: createMentionsFooter(plugin),
    livePanels: () => live,
    saveSettings,
  };
}

/**
 * The mock's `TFile`, not `obsidian`'s: nothing here hands a file into `src/`
 * directly — the footer reads it off `MarkdownView.file` — so keeping the
 * mock's own type all the way through spares every call site a cast.
 */
function fileAt(app: Setup["app"], path: string): FakeTFile {
  return app.vault.files.get(path) as FakeTFile;
}

type Sizer = "markdown-preview-sizer" | "cm-sizer";

/**
 * A `MarkdownView` whose mode the test can move.
 *
 * It is a subclass here rather than a settable field on the mock's
 * `MarkdownView` because `tests/obsidian-mock.ts`'s header forbids inventing
 * surface the real class lacks on a class standing in for it: `tsc` resolves
 * `obsidian` to the real package, so such a field type-checks under vitest and
 * then fails the moment anything reaches it through a real-typed reference.
 * This class is the test's own, named nowhere in `obsidian`, so `mode` is
 * reached through this same declaration under both resolutions.
 */
class ModeableMarkdownView extends FakeMarkdownView {
  mode: MarkdownViewModeType = "preview";

  getMode(): MarkdownViewModeType {
    return this.mode;
  }
}

/**
 * Registers a markdown leaf holding a `MarkdownView` over `file`, in `mode`,
 * with `sizers` standing in for whichever layout elements the real reading or
 * live preview mode would have built — more than one when the case under test
 * is a view holding both panes at once, and `[]` for a pane holding neither.
 */
function addMarkdownLeaf(
  app: Setup["app"],
  file: FakeTFile | null,
  sizers: Sizer | Sizer[] = "markdown-preview-sizer",
  mode: MarkdownViewModeType = "preview",
): { leaf: FakeWorkspaceLeaf; view: ModeableMarkdownView } {
  const leaf = app.workspace.addLeaf("markdown");
  const view = new ModeableMarkdownView(leaf);
  view.file = file;
  view.mode = mode;
  // Built inside `contentEl`, one level below the `containerEl` the footer
  // actually searches, so the query has to descend exactly as it does in real
  // Obsidian rather than matching a top-level child.
  for (const cls of Array.isArray(sizers) ? sizers : [sizers]) {
    view.contentEl.createDiv({ cls });
  }
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

/** Every content-flow element currently marked as holding a footer. */
function hostEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".journal-mentions-footer-host"));
}

/** The footer's header, which in this shell alone is the collapse control. */
function collapseToggleIn(view: FakeMarkdownView): HTMLElement | null {
  return view.containerEl.querySelector<HTMLElement>("button.journal-mentions-header");
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
    const { app, footer, livePanels } = setup({ a: 2 });
    const before = app.vault.contents.get(NOTE_A);
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

    expect(() => footer.sync()).not.toThrow();
    await settle();

    expect(findContentFlowEl(view.containerEl, view.getMode())).toBeNull();
    expect(footerEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
    // Nothing was added to the view at all, not merely nothing recognisable.
    expect(view.contentEl.children).toHaveLength(0);
    // And the half of the promise that actually matters: the note on disk is
    // byte-for-byte what it was. Losing this surface must cost the user
    // nothing but the surface.
    expect(app.vault.contents.get(NOTE_A)).toBe(before);
  });

  it("finds the reading-view sizer in preview mode, and only then", () => {
    const container = document.createElement("div");
    const sizer = container.createDiv({ cls: "markdown-preview-sizer" });
    expect(findContentFlowEl(container, "preview")).toBe(sizer);
    // A reading-view sizer is not source mode's content flow, however alone
    // it happens to be in the pane — mounting into it would be mounting into
    // the pane the user is not looking at.
    expect(findContentFlowEl(container, "source")).toBeNull();
  });

  it("finds the CodeMirror sizer in source mode, and only then", () => {
    const container = document.createElement("div");
    const sizer = container.createDiv({ cls: "cm-sizer" });
    // "source" is both live preview and raw source; both are CodeMirror.
    expect(findContentFlowEl(container, "source")).toBe(sizer);
    expect(findContentFlowEl(container, "preview")).toBeNull();
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
    expect(el?.parentElement).toBe(findContentFlowEl(view.containerEl, "preview"));
    expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
  });

  it("mounts a panel into the live-preview sizer", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "cm-sizer", "source");

    footer.sync();
    await settle();

    expect(footerIn(view)?.parentElement).toBe(findContentFlowEl(view.containerEl, "source"));
  });

  /**
   * A `MarkdownView` can hold `.markdown-source-view` and
   * `.markdown-reading-view` at the same time, the inactive one hidden rather
   * than removed — so both sizers can be in the DOM at once, with `.cm-sizer`
   * first in document order. A single comma-separated selector would then
   * hand back whichever came first, and in reading view the footer would be
   * mounted into a hidden pane where the user never sees it. The view's own
   * mode decides, not document order.
   */
  it("mounts into the reading-view sizer in preview mode though a cm-sizer precedes it", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(
      app,
      fileAt(app, NOTE_A),
      ["cm-sizer", "markdown-preview-sizer"],
      "preview",
    );

    footer.sync();
    await settle();

    const el = footerIn(view);
    expect(el).not.toBeNull();
    expect(el?.parentElement).toBe(view.contentEl.querySelector(".markdown-preview-sizer"));
    expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
  });

  it("mounts into the live-preview sizer in source mode though both sizers exist", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(
      app,
      fileAt(app, NOTE_A),
      ["cm-sizer", "markdown-preview-sizer"],
      "source",
    );

    footer.sync();
    await settle();

    const el = footerIn(view);
    expect(el).not.toBeNull();
    expect(el?.parentElement).toBe(view.contentEl.querySelector(".cm-sizer"));
    expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
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

    view.file = fileAt(app, NOTE_B);
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

    // One shape a mode switch can take: the old layout element goes away
    // wholesale, taking the footer's container with it, and the other mode's
    // takes its place.
    view.contentEl.empty();
    view.contentEl.createDiv({ cls: "cm-sizer" });
    view.mode = "source";
    footer.sync();
    await settle();

    expect(footerIn(view)?.parentElement).toBe(findContentFlowEl(view.containerEl, "source"));
    expect(footerEls()).toHaveLength(1);
    expect(livePanels()).toBe(1);
  });

  it("moves the footer to the other sizer on a mode switch that keeps both panes", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    // The other shape: nothing is removed, the inactive pane is merely
    // hidden, so the footer has to be taken out of a sizer that is still
    // there rather than being orphaned by its removal.
    const { view } = addMarkdownLeaf(
      app,
      fileAt(app, NOTE_A),
      ["cm-sizer", "markdown-preview-sizer"],
      "preview",
    );
    const preview = view.contentEl.querySelector<HTMLElement>(".markdown-preview-sizer");
    const source = view.contentEl.querySelector<HTMLElement>(".cm-sizer");

    footer.sync();
    await settle();
    expect(footerIn(view)?.parentElement).toBe(preview);

    view.mode = "source";
    footer.sync();
    await settle();

    expect(footerIn(view)?.parentElement).toBe(source);
    expect(preview?.querySelector(".journal-mentions-footer")).toBeNull();
    expect(footerEls()).toHaveLength(1);
    expect(livePanels()).toBe(1);
  });

  /**
   * The host mark, and why it is worth five tests of its own.
   *
   * `styles.css` caps the editor's click-past-the-text padding on notes that
   * carry a footer, and it used to find them with
   * `.cm-sizer:has(> .journal-mentions-footer)` — a selector that is true by
   * construction and needs nothing pinning it. A class this shell writes is
   * bookkeeping instead, and bookkeeping can go stale in both directions: a
   * mark left behind caps a note with no footer to justify it, and a mark
   * never written leaves the panel most of a screen below the text. Neither
   * shows up in any other assertion here, because neither changes what is
   * mounted — only what it is styled like. So they are pinned here.
   */
  it("marks the sizer it mounted a footer into", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "cm-sizer", "source");

    footer.sync();
    await settle();

    const sizer = findContentFlowEl(view.containerEl, "source");
    expect(hostEls()).toEqual([sizer]);
  });

  it("takes the mark off when the setting is turned off", async () => {
    const { app, plugin, footer } = setup({ a: 2 });
    addMarkdownLeaf(app, fileAt(app, NOTE_A), "cm-sizer", "source");

    footer.sync();
    await settle();
    expect(hostEls()).toHaveLength(1);

    plugin.settings.showMentionsUnderNotes = false;
    footer.sync();
    await settle();

    expect(hostEls()).toHaveLength(0);
  });

  /**
   * The mark has to travel with the footer, not merely be added at the far
   * end: the pane left behind is still in the DOM, hidden rather than
   * removed, and a mark stranded on it caps a sizer that holds nothing.
   */
  it("moves the mark with the footer on a mode switch", async () => {
    const { app, footer } = setup({ a: 2 });
    const { view } = addMarkdownLeaf(
      app,
      fileAt(app, NOTE_A),
      ["cm-sizer", "markdown-preview-sizer"],
      "preview",
    );
    const preview = view.contentEl.querySelector<HTMLElement>(".markdown-preview-sizer");
    const source = view.contentEl.querySelector<HTMLElement>(".cm-sizer");

    footer.sync();
    await settle();
    expect(hostEls()).toEqual([preview]);

    view.mode = "source";
    footer.sync();
    await settle();

    expect(hostEls()).toEqual([source]);
  });

  it("leaves no mark on a note that must never have a footer", async () => {
    const { app, footer } = setup({ a: 2 });
    addMarkdownLeaf(app, fileAt(app, ENTRY), "cm-sizer", "source");

    footer.sync();
    await settle();

    expect(hostEls()).toHaveLength(0);
  });

  /**
   * The pane Obsidian has not built yet.
   *
   * Switching into reading view fires `layout-change` *before*
   * `.markdown-preview-sizer` exists, so the sync it drives finds nothing and
   * — per rule 1 — mounts nothing; before the footer watched for the element,
   * nothing re-triggered and the note stayed bare until some unrelated
   * workspace event happened to fire. Found in a real vault, not by this
   * suite: every other test here builds the sizer before it calls `sync()`.
   */
  describe("a content flow that arrives after the sync", () => {
    /**
     * A mutation is delivered on its own microtask and the sync it wakes then
     * renders, so the mount lands a turn after the DOM changed.
     */
    async function settleAfterMutation(): Promise<void> {
      await settle();
      await settle();
    }

    it("mounts the footer when the sizer appears, with no further workspace event", async () => {
      const { app, footer } = setup({ a: 2 });
      // The first switch into reading view: the event that brings us here has
      // already fired, and the pane it announced is not built.
      const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(footerIn(view)).toBeNull();

      // Obsidian builds the pane. Nothing else happens: no `layout-change`,
      // no `active-leaf-change`, no `file-open`, no second `sync()`.
      const sizer = view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();

      expect(footerIn(view)?.parentElement).toBe(sizer);
      expect(footerIn(view)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    });

    it("stops watching once the footer has mounted", async () => {
      const { app, footer } = setup({ a: 2 });
      const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(1);

      view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();

      expect(footerIn(view)).not.toBeNull();
      // Otherwise the footer's own writes into the sizer would keep waking an
      // observer that has nothing left to wait for.
      expect(liveObservers()).toBe(0);
    });

    it("watches a view once however many times it is synced", async () => {
      const { app, footer } = setup({ a: 2 });
      addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      // `sync()` runs on three frequently-firing workspace events, so an
      // observer per call would be a real leak, not a tidiness point.
      footer.sync();
      footer.sync();
      footer.sync();
      await settle();

      expect(liveObservers()).toBe(1);
    });

    it("does not watch a view that must never have a footer", async () => {
      const { app, footer } = setup({ a: 2 });
      const { view: entry } = addMarkdownLeaf(app, fileAt(app, ENTRY), []);
      const { view: empty } = addMarkdownLeaf(app, null, []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(0);

      // And the sizer arriving changes nothing, which is the half a bare
      // observer count cannot prove.
      entry.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      empty.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();

      expect(footerEls()).toHaveLength(0);
    });

    it("stops watching a view whose note turned into one it must not footer", async () => {
      const { app, footer } = setup({ a: 2 });
      const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(1);

      // The pane was still building when the user navigated it to a journal
      // entry. What it eventually builds is no longer anything to wait for.
      view.file = fileAt(app, ENTRY);
      footer.sync();
      await settle();
      expect(liveObservers()).toBe(0);

      view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();
      expect(footerEls()).toHaveLength(0);
    });

    it("stops watching a view that disappeared before its sizer arrived", async () => {
      const { app, footer } = setup({ a: 2 });
      const { leaf, view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(1);

      leaf.detach();
      footer.sync();
      await settle();
      expect(liveObservers()).toBe(0);

      // A closed tab whose DOM is still reachable must not be written into.
      view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();
      expect(footerEls()).toHaveLength(0);
    });

    it("stops watching when the setting is turned off", async () => {
      const { app, plugin, footer } = setup({ a: 2 });
      const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(1);

      plugin.settings.showMentionsUnderNotes = false;
      footer.sync();
      await settle();
      expect(liveObservers()).toBe(0);

      // Off must mean gone, including gone from anything still pending.
      view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();
      expect(footerEls()).toHaveLength(0);
    });

    it("destroy() stops watching too", async () => {
      const { app, footer } = setup({ a: 2 });
      const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A), []);

      footer.sync();
      await settle();
      expect(liveObservers()).toBe(1);

      footer.destroy();
      expect(liveObservers()).toBe(0);

      // `main.ts` drops its reference after this, so a footer mounted now
      // would be one nothing could ever take down again.
      view.contentEl.createDiv({ cls: "markdown-preview-sizer" });
      await settleAfterMutation();
      expect(footerEls()).toHaveLength(0);
    });
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

  /**
   * The footer is the one shell that asks for `collapsible`, so this is where
   * "the setting is one boolean for the whole vault" has to hold across more
   * than one open note.
   */
  it("collapses every other open note's footer with the one that was clicked", async () => {
    const { app, plugin, footer, saveSettings } = setup({ a: 2 });
    // Two panes on the same note, which is the arrangement that makes a
    // disagreement visible on one screen.
    const { view: first } = addMarkdownLeaf(app, fileAt(app, NOTE_A));
    const { view: second } = addMarkdownLeaf(app, fileAt(app, NOTE_A), "cm-sizer", "source");

    footer.sync();
    await settle();
    expect(footerIn(first)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    expect(footerIn(second)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    collapseToggleIn(first)?.click();
    await settle();

    expect(plugin.settings.mentionsFooterCollapsed).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    for (const view of [first, second]) {
      const el = footerIn(view);
      expect(collapseToggleIn(view)?.getAttribute("aria-expanded")).toBe("false");
      expect(el?.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);
      // The count is what keeps a collapsed footer from reading as breakage.
      expect(el?.querySelector(".journal-mentions-count")?.textContent).toBe("2");
    }
  });

  it("mounts a footer collapsed onto a note opened after the state was stored", async () => {
    const { app, plugin, footer } = setup({ a: 2 });
    plugin.settings.mentionsFooterCollapsed = true;
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_A));

    footer.sync();
    await settle();

    expect(collapseToggleIn(view)?.getAttribute("aria-expanded")).toBe("false");
    expect(footerIn(view)?.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);
  });

  it("still renders nothing at all for a note with no mentions while collapsed", async () => {
    const { app, plugin, footer } = setup({ a: 2 });
    plugin.settings.mentionsFooterCollapsed = true;
    const { view } = addMarkdownLeaf(app, fileAt(app, NOTE_B));

    footer.sync();
    await settle();

    // A "Journal mentions 0" header under every unmentioned note the user
    // opens would be the noise this shell's missing `emptyText` prevents —
    // collapsing must not smuggle one in.
    expect(footerIn(view)?.children).toHaveLength(0);
    expect(footerIn(view)?.textContent).toBe("");
  });

  it("destroy() removes every footer and releases every panel", async () => {
    const { app, footer, livePanels } = setup({ a: 2 });
    const { view: first } = addMarkdownLeaf(app, fileAt(app, NOTE_A));
    const { view: second } = addMarkdownLeaf(app, fileAt(app, NOTE_B), "cm-sizer", "source");

    footer.sync();
    await settle();
    expect(footerEls()).toHaveLength(2);
    expect(livePanels()).toBe(2);

    footer.destroy();

    expect(footerEls()).toHaveLength(0);
    expect(footerIn(first)).toBeNull();
    expect(footerIn(second)).toBeNull();
    expect(hostEls()).toHaveLength(0);
    expect(livePanels()).toBe(0);
  });
});
