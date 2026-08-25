// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild as ObsidianMarkdownRenderChild,
  TFile,
} from "obsidian";
import { createFakeApp, installDomHelpers } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { destroyMentionPanels } from "../src/mentions/MentionsPanel";
import {
  isInsideMentionsPanel,
  parseMentionsBlock,
  registerMentionsCodeBlock,
} from "../src/mentions/mentionsCodeBlock";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // A block whose render child is never unloaded leaves a panel in
  // `MentionsPanel`'s module-level registry, which outlives the test file's
  // individual tests.
  destroyMentionPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("parseMentionsBlock", () => {
  it("reads no target from an empty block", () => {
    expect(parseMentionsBlock("")).toEqual({ noteLink: null });
    expect(parseMentionsBlock("\n\n  \n")).toEqual({ noteLink: null });
  });

  it("reads a note: directive", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseMentionsBlock("\n   note:   [[Ekin]]   \n")).toEqual({ noteLink: "Ekin" });
  });

  it("uses the link target, not the alias", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç|Ekin]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("ignores anything it does not understand rather than erroring", () => {
    expect(parseMentionsBlock("sort: oldest\nlimit: 3")).toEqual({ noteLink: null });
  });
});

describe("isInsideMentionsPanel", () => {
  it("is false for a block in an ordinary note", () => {
    const el = document.body.createDiv();
    expect(isInsideMentionsPanel(el)).toBe(false);
  });

  it("is true for a block rendered inside a panel's own output", () => {
    const panel = document.body.createDiv({ cls: "journal-mentions" });
    const el = panel.createDiv({ cls: "journal-mentions-body" }).createDiv();
    expect(isInsideMentionsPanel(el)).toBe(true);
  });
});

/**
 * The shell itself, not just its two pure functions: what the processor does
 * with a source string and an element, and — the part nothing else covers —
 * that the render child it hands Obsidian actually destroys the panel when
 * Obsidian unloads it. That teardown is the only thing standing between a
 * closed note and a panel still holding two vault subscriptions.
 */
describe("registerMentionsCodeBlock", () => {
  const NOTE_A = "People/Ekin Arslan Aytaç.md";
  const NOTE_B = "Projects/Simple Journal.md";

  type BlockProcessor = (
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) => void;

  interface Setup {
    app: ReturnType<typeof createFakeApp>;
    plugin: JournalEntriesPlugin;
    /** The processor the plugin registered for the `simple-journal` language. */
    process: BlockProcessor;
    /** Every render child the processor handed to its post-processor context. */
    children: ObsidianMarkdownRenderChild[];
    /** Called when a panel's `journal.onChange` unsubscribe actually runs. */
    journalUnsubscribed: ReturnType<typeof vi.fn>;
  }

  /**
   * Wires a real `EntryRepository` + `JournalService` over the fakes and lets
   * the real `registerMentionsCodeBlock` register itself against a plugin
   * stand-in whose only job is to capture the processor —
   * `registerMarkdownCodeBlockProcessor` is `Plugin` API the mock does not
   * model, and modelling Obsidian's own markdown pipeline to reach it would be
   * guesswork of the kind `tests/obsidian-mock.ts`'s header warns against.
   *
   * Two entries mention NOTE_A; NOTE_B is mentioned by nothing.
   */
  function setup(): Setup {
    const app = createFakeApp();
    app.vault.addFile(NOTE_A, "# Ekin\n");
    app.vault.addFile(NOTE_B, "# Simple Journal\n");

    for (let i = 0; i < 2; i++) {
      const day = String(24 - i).padStart(2, "0");
      const path = `Journal/2026/08/2026-08-${day}-21-40-00.md`;
      app.vault.addFile(
        path,
        `---\ncreated: 2026-08-${day}T21:40:00\n---\nEntry ${i} about [[Ekin Arslan Aytaç]]`,
      );
      app.metadataCache.resolvedLinks[path] = { [NOTE_A]: 1 };
    }

    const repository = new EntryRepository(app as unknown as App, () => "Journal");
    const service = new JournalService(app as unknown as App, repository);
    service.load();

    const journalUnsubscribed = vi.fn();
    const realOnChange = service.onChange.bind(service);
    vi.spyOn(service, "onChange").mockImplementation((callback) => {
      const off = realOnChange(callback);
      return () => {
        journalUnsubscribed();
        off();
      };
    });

    // The mock's `getFirstLinkpathDest` never resolves anything by design (see
    // its comment), so a test that needs resolution has to model it — which is
    // the honest split anyway: resolving a linkpath is Obsidian's job, and
    // what this shell does with the answer is ours.
    vi.spyOn(app.metadataCache, "getFirstLinkpathDest").mockImplementation((linkpath) => {
      for (const [path, file] of app.vault.files) {
        if (path === `${linkpath}.md`) return file;
      }
      return null;
    });

    let process: BlockProcessor | null = null;
    const children: ObsidianMarkdownRenderChild[] = [];
    const plugin = {
      app,
      repository,
      journal: service,
      goToDateInJournal: vi.fn(),
      registerMarkdownCodeBlockProcessor: (_language: string, handler: BlockProcessor) => {
        process = handler;
      },
    } as unknown as JournalEntriesPlugin;

    registerMentionsCodeBlock(plugin);
    if (!process) throw new Error("the code block processor was never registered");

    return { app, plugin, process, children, journalUnsubscribed };
  }

  /** A post-processor context for a block sitting in `sourcePath`. */
  function contextFor(state: Setup, sourcePath: string): MarkdownPostProcessorContext {
    return {
      docId: "doc",
      sourcePath,
      frontmatter: null,
      addChild: (child: ObsidianMarkdownRenderChild) => {
        state.children.push(child);
        child.load();
      },
      getSectionInfo: () => null,
    } as unknown as MarkdownPostProcessorContext;
  }

  /** Lets a `void panel.render()` — kicked off but never awaited — finish. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("targets the note the block sits in when there is no directive", async () => {
    const state = setup();
    const el = document.body.createDiv();

    state.process("", el, contextFor(state, NOTE_A));
    await settle();

    expect(el.querySelector(".journal-mentions-count")?.textContent).toBe("2");
    expect(el.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
  });

  it("targets the note a directive names, wherever the block sits", async () => {
    const state = setup();
    const el = document.body.createDiv();

    // The block is in NOTE_B, which nothing mentions; the directive points it
    // at NOTE_A, which two entries mention.
    state.process("note: [[People/Ekin Arslan Aytaç]]", el, contextFor(state, NOTE_B));
    await settle();

    expect(el.querySelector(".journal-mentions-count")?.textContent).toBe("2");
  });

  it("falls back to the empty state when a note: target resolves to nothing", async () => {
    const state = setup();
    const el = document.body.createDiv();

    state.process("note: [[No Such Note]]", el, contextFor(state, NOTE_A));
    await settle();

    // The same line a note with no mentions gets, and for the same reason: an
    // error message in the middle of someone's note is worse than the obvious
    // default. And no panel was mounted, so nothing subscribed to anything.
    expect(el.textContent).toBe("No journal entries mention this note yet.");
    expect(state.children).toHaveLength(0);
  });

  it("renders an inert placeholder for a block nested inside a panel, and mounts nothing", async () => {
    const state = setup();
    const panelEl = document.body.createDiv({ cls: "journal-mentions" });
    const el = panelEl.createDiv({ cls: "journal-mentions-body" }).createDiv();

    state.process("", el, contextFor(state, NOTE_A));
    await settle();

    expect(el.querySelector(".journal-mentions-nested")?.textContent).toBe(
      "Journal mentions block (not expanded here).",
    );
    // The recursion guard is only a guard if it stops short of a panel: a
    // mounted one would render entry markdown, whose own block would mount
    // another.
    expect(el.querySelector(".journal-mentions-entry")).toBeNull();
    expect(state.children).toHaveLength(0);
    expect(state.journalUnsubscribed).not.toHaveBeenCalled();
  });

  it("destroys the panel and releases its subscriptions when Obsidian unloads the block", async () => {
    const state = setup();
    const el = document.body.createDiv();
    state.process("", el, contextFor(state, NOTE_A));
    await settle();
    expect(el.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    // What Obsidian does when the note closes or the fence is edited.
    expect(state.children).toHaveLength(1);
    state.children[0].unload();

    expect(el.childElementCount).toBe(0);
    expect(state.journalUnsubscribed).toHaveBeenCalledTimes(1);

    // The metadata-cache listener must be GONE, not merely ignored: the
    // panel's own `destroyed` flag would satisfy any assertion about the DOM.
    // `isEntryFile` is the first thing that listener calls, ahead of every
    // guard the panel owns, so a spy on it observes the listener itself
    // running — the same technique, and the same reason, as
    // `tests/mentionsPanel.test.ts`'s teardown test.
    const isEntryFile = vi.spyOn(state.plugin.repository, "isEntryFile");
    const entry = state.app.vault.files.get(
      "Journal/2026/08/2026-08-24-21-40-00.md",
    ) as unknown as TFile;
    state.app.metadataCache.trigger("resolve", entry);
    await vi.advanceTimersByTimeAsync(200);

    expect(isEntryFile).not.toHaveBeenCalled();
    expect(el.childElementCount).toBe(0);
  });
});
