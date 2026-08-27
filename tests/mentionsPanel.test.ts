// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { createFakeApp, installDomHelpers } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import {
  createMentionsPanel,
  destroyMentionPanels,
  refreshMentionPanels,
} from "../src/mentions/MentionsPanel";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // The registry `refreshMentionPanels` walks is module-level, so a panel one
  // test leaves alive is still in it when the next one runs.
  destroyMentionPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const TARGET_PATH = "People/Ekin Arslan Aytaç.md";

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  target: TFile;
  /** The seeded entry files, newest first — same order the panel renders in. */
  entries: TFile[];
  container: HTMLElement;
  goToDate: ReturnType<typeof vi.fn>;
  /** Called when the panel's `journal.onChange` unsubscribe actually runs. */
  journalUnsubscribed: ReturnType<typeof vi.fn>;
  /** Observes the collapse toggle actually persisting, not merely flipping. */
  saveSettings: ReturnType<typeof vi.fn<[], Promise<void>>>;
}

/**
 * A promise plus its resolver, for parking one of the panel's awaits mid-flight.
 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Seeds `count` entries on descending days, each linking to the target, and
 * wires a real `EntryRepository` + `JournalService` over the fakes — the same
 * convention `journalViewHarness.ts` uses, so these tests exercise real
 * domain code rather than the behaviour of a mock.
 */
function setup(count: number): Setup {
  const app = createFakeApp();
  const target = app.vault.addFile(TARGET_PATH, "# Ekin\n");
  const entries: TFile[] = [];

  for (let i = 0; i < count; i++) {
    const day = String(24 - i).padStart(2, "0");
    const path = `Journal/2026/08/2026-08-${day}-21-40-00.md`;
    entries.push(
      app.vault.addFile(path, `---\ncreated: 2026-08-${day}T21:40:00\n---\nEntry ${i} about [[Ekin Arslan Aytaç]]`),
    );
    app.metadataCache.resolvedLinks[path] = { [TARGET_PATH]: 1 };
  }

  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();

  // Wraps the real `onChange` so a test can observe the unsubscribe the panel
  // is handed actually being called. The panel's own `destroyed` flag makes
  // "did a change still reach it?" unable to tell a removed listener from an
  // ignored one, which is exactly the hole this closes.
  const journalUnsubscribed = vi.fn();
  const realOnChange = service.onChange.bind(service);
  vi.spyOn(service, "onChange").mockImplementation((callback) => {
    const off = realOnChange(callback);
    return () => {
      journalUnsubscribed();
      off();
    };
  });

  const goToDate = vi.fn();
  const saveSettings = vi.fn(() => Promise.resolve());
  const plugin = {
    app,
    repository,
    journal: service,
    // The shipped defaults, not a hand-written literal: "expanded unless the
    // user collapsed it" is the product decision, and a test that spelled its
    // own `false` here would keep passing if the default were flipped.
    settings: { ...DEFAULT_SETTINGS },
    saveSettings,
    goToDateInJournal: goToDate,
  } as unknown as JournalEntriesPlugin;

  const container = document.body.createDiv();
  return { app, plugin, target, entries, container, goToDate, journalUnsubscribed, saveSettings };
}

describe("createMentionsPanel", () => {
  it("renders a header, day headers and timestamps for the mentioning entries", async () => {
    const { plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.querySelector(".journal-mentions-count")?.textContent).toBe("2");
    expect(container.querySelectorAll(".journal-mentions-day")).toHaveLength(2);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("renders entry body text, without the frontmatter", async () => {
    const { plugin, target, container } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    const body = container.querySelector(".journal-mentions-body")?.textContent ?? "";
    expect(body).toContain("Entry 0 about [[Ekin Arslan Aytaç]]");
    expect(body).not.toContain("created:");
    panel.destroy();
  });

  it("reads bodies through the cached read, never the uncached one", async () => {
    const { app, plugin, target, container } = setup(2);
    const cachedRead = vi.spyOn(app.vault, "cachedRead");
    const read = vi.spyOn(app.vault, "read");

    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    panel.destroy();
  });

  it("shows the first five entries and pages the rest in", async () => {
    const { plugin, target, container } = setup(8);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(5);
    const more = container.querySelector<HTMLButtonElement>(".journal-mentions-more");
    expect(more?.textContent).toBe("Show 3 more");

    more?.click();
    // The click handler kicks off an async render; advancing by 0 with fake
    // timers flushes its microtasks without waiting on the 200 ms debounce,
    // which this path does not go through.
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);
    expect(container.querySelector(".journal-mentions-more")).toBeNull();
    panel.destroy();
  });

  it("opens the journal at the entry's date when its timestamp is clicked", async () => {
    const { plugin, target, container, goToDate } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    container.querySelector<HTMLButtonElement>(".journal-mentions-time")?.click();
    expect(goToDate).toHaveBeenCalledTimes(1);
    expect((goToDate.mock.calls[0][0] as Date).getDate()).toBe(24);
    panel.destroy();
  });

  it("renders the given empty text when nothing mentions the target", async () => {
    const { plugin, target, container } = setup(0);
    const panel = createMentionsPanel({
      plugin,
      container,
      target,
      emptyText: "No journal entries mention this note yet.",
    });
    await panel.render();

    expect(container.textContent).toBe("No journal entries mention this note yet.");
    expect(container.querySelector(".journal-mentions-header")).toBeNull();
    panel.destroy();
  });

  it("renders nothing at all when no empty text is given", async () => {
    const { plugin, target, container } = setup(0);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });

  it("re-renders when the metadata cache resolves a journal entry", async () => {
    const { app, plugin, target, container, entries } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);

    app.metadataCache.resolvedLinks[entries[0].path] = {};
    app.metadataCache.trigger("resolve", entries[0]);
    await vi.advanceTimersByTimeAsync(200);

    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });

  it("ignores a resolve for a file that is not a journal entry", async () => {
    const { app, plugin, target, container, entries } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    // `resolve` fires for the host note on every keystroke. Rebuilding for it
    // is a read plus a markdown render per visible entry, five times a second
    // while someone types — the whole reason the subscription is filtered.
    // Staged data a re-render would pick up, so an accidental one is visible.
    app.metadataCache.resolvedLinks[entries[0].path] = {};
    app.metadataCache.trigger("resolve", target);
    await vi.advanceTimersByTimeAsync(200);

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);
    panel.destroy();
  });

  it("re-renders when the journal service reports a change", async () => {
    const { app, plugin, target, container, entries } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    app.vault.trigger("delete", entries[0]);
    // The service debounces its own batch by 300 ms; the panel debounces its
    // refresh by a further 200 ms on top of that.
    await vi.advanceTimersByTimeAsync(500);

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);
    panel.destroy();
  });

  it("shows a failure line for an entry it cannot read, and still renders the others", async () => {
    const { plugin, target, container } = setup(2);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(plugin.repository, "readBodyCached").mockImplementationOnce(() =>
      Promise.reject(new Error("read failed")),
    );

    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    // A bare timestamp with an empty body would be indistinguishable from an
    // entry the user genuinely left empty.
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    expect(container.querySelectorAll(".journal-mentions-error")).toHaveLength(1);
    expect(container.querySelector(".journal-mentions-error")?.textContent).toBe(
      "This entry could not be read.",
    );
    expect(errors).toHaveBeenCalled();
    panel.destroy();
  });

  it("shows a failure line for an entry it cannot render, and still finishes the panel", async () => {
    const { plugin, target, container } = setup(8);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Stands in for a post-processor belonging to some other plugin throwing.
    vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(() =>
      Promise.reject(new Error("post-processor exploded")),
    );

    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(5);
    expect(container.querySelectorAll(".journal-mentions-error")).toHaveLength(1);
    expect(container.querySelector(".journal-mentions-error")?.textContent).toBe(
      "This entry could not be rendered.",
    );
    // The half-built failure mode: no "Show more" means no way back to the
    // rest of the mentions.
    expect(container.querySelector(".journal-mentions-more")).not.toBeNull();
    expect(errors).toHaveBeenCalled();
    panel.destroy();
  });

  it("drops an older render whose reads finish after a newer one has painted", async () => {
    const { plugin, target, container } = setup(8);
    const panel = createMentionsPanel({ plugin, container, target });

    const gate = deferred();
    const realRead = plugin.repository.readBodyCached.bind(plugin.repository);
    vi.spyOn(plugin.repository, "readBodyCached").mockImplementationOnce(async (file) => {
      await gate.promise;
      return realRead(file);
    });

    const first = panel.render();
    await vi.advanceTimersByTimeAsync(0);

    const second = panel.render();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".journal-mentions-more")).toHaveLength(1);

    gate.release();
    await Promise.all([first, second]);

    expect(container.querySelectorAll(".journal-mentions-more")).toHaveLength(1);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(5);
    panel.destroy();
  });

  it("drops an older render that is still inside its loop when a newer one paints", async () => {
    const { plugin, target, container } = setup(8);
    const panel = createMentionsPanel({ plugin, container, target });

    // Parks the FIRST render inside the entry loop rather than before it. All
    // the body reads happen up front, ahead of the post-`Promise.all` token
    // check, so a slow read can only ever exercise that one; the renderer is
    // the only await the IN-LOOP check guards. Without that check the older
    // render walks out of the loop and appends a second "Show more" to a
    // container the newer one already owns.
    const gate = deferred();
    const realRender = MarkdownRenderer.render.bind(MarkdownRenderer);
    vi.spyOn(MarkdownRenderer, "render").mockImplementationOnce(async (...args) => {
      await gate.promise;
      await realRender(...args);
    });

    const first = panel.render();
    await vi.advanceTimersByTimeAsync(0);

    const second = panel.render();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".journal-mentions-more")).toHaveLength(1);

    gate.release();
    await Promise.all([first, second]);

    expect(container.querySelectorAll(".journal-mentions-more")).toHaveLength(1);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(5);
    panel.destroy();
  });

  it("discards a render still in flight when the panel is destroyed", async () => {
    const { plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });

    const gate = deferred();
    const realRead = plugin.repository.readBodyCached.bind(plugin.repository);
    vi.spyOn(plugin.repository, "readBodyCached").mockImplementationOnce(async (file) => {
      await gate.promise;
      return realRead(file);
    });

    const pending = panel.render();
    panel.destroy();
    gate.release();
    await pending;

    expect(container.childElementCount).toBe(0);
    expect(container.classList.contains("journal-mentions")).toBe(false);
  });

  it("empties the container and removes its subscriptions on destroy", async () => {
    const { app, plugin, target, container, entries, journalUnsubscribed } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    panel.destroy();

    expect(container.childElementCount).toBe(0);
    expect(journalUnsubscribed).toHaveBeenCalledTimes(1);

    // The listener must be GONE, not merely ignored — the panel's `destroyed`
    // flag alone would satisfy any assertion about the container. The resolve
    // handler calls `isEntryFile` before any guard of the panel's own, so a
    // spy on it observes the listener itself running. Counting listeners on
    // the mock emitter instead would mean inventing inspection surface the
    // real `MetadataCache` does not have (see tests/obsidian-mock.ts's
    // header policy).
    const isEntryFile = vi.spyOn(plugin.repository, "isEntryFile");
    app.metadataCache.trigger("resolve", entries[0]);
    await vi.advanceTimersByTimeAsync(200);

    expect(isEntryFile).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });
});

/**
 * Collapsing, which only ONE of the three shells asks for.
 *
 * The footer arrives unasked at the bottom of an ordinary note, so it needs a
 * way to be got out of the way; the sidebar and the code block were both
 * opened deliberately, and collapsing either leaves nothing behind worth
 * looking at. So `collapsible` is off unless a shell asks — which is what the
 * "no toggle at all" test below pins.
 */
describe("a collapsible panel", () => {
  function header(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(".journal-mentions-header");
  }

  /**
   * Which chevron the header is showing. The mock records the id rather than
   * injecting an SVG (jsdom has no icon registry), which is all this needs:
   * the discoverability decision is that the direction tracks the state, and a
   * chevron stuck pointing down through a collapse is the failure.
   */
  function chevron(container: HTMLElement): string | undefined {
    return container.querySelector<HTMLElement>(".journal-mentions-chevron")?.dataset.icon;
  }

  it("is expanded when nothing has been stored yet", async () => {
    const { plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();

    // The justification for this whole surface is seeing entry CONTENT rather
    // than a list of links; starting collapsed would quietly undo that.
    expect(header(container)?.getAttribute("aria-expanded")).toBe("true");
    expect(chevron(container)).toBe("chevron-down");
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("renders the header and its count, and nothing else, when collapsed", async () => {
    const { plugin, target, container } = setup(8);
    plugin.settings.mentionsFooterCollapsed = true;
    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();

    // The count is the half that must survive: it is what makes the collapsed
    // state a visible cause rather than a panel that silently vanished.
    expect(container.querySelector(".journal-mentions-count")?.textContent).toBe("8");
    expect(header(container)?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);
    expect(container.querySelectorAll(".journal-mentions-day")).toHaveLength(0);
    expect(container.querySelector(".journal-mentions-more")).toBeNull();
    panel.destroy();
  });

  it("reads no entry bodies while it is collapsed", async () => {
    const { app, plugin, target, container } = setup(8);
    plugin.settings.mentionsFooterCollapsed = true;
    const cachedRead = vi.spyOn(app.vault, "cachedRead");

    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();

    // Every footer on every open note repaints on the panel's two
    // subscriptions; a collapsed one showing nothing must not still pay for
    // five reads each time.
    expect(cachedRead).not.toHaveBeenCalled();
    panel.destroy();
  });

  it("persists the toggle and flips aria-expanded", async () => {
    const { plugin, target, container, saveSettings } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();

    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.settings.mentionsFooterCollapsed).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(header(container)?.getAttribute("aria-expanded")).toBe("false");
    expect(chevron(container)).toBe("chevron-right");
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);

    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.settings.mentionsFooterCollapsed).toBe(false);
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(header(container)?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("keeps the pages the user had asked for across a collapse and back", async () => {
    const { plugin, target, container } = setup(8);
    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();
    container.querySelector<HTMLButtonElement>(".journal-mentions-more")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);

    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);
    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);

    // Collapsing is a change of what is drawn, not of what the panel knows:
    // dropping back to the initial five would silently discard a click the
    // user had already made.
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);
    panel.destroy();
  });

  it("collapses every other live panel with it", async () => {
    const { plugin, target, container } = setup(2);
    const other = document.body.createDiv();
    const a = createMentionsPanel({ plugin, container, target, collapsible: true });
    const b = createMentionsPanel({ plugin, container: other, target, collapsible: true });
    await Promise.all([a.render(), b.render()]);

    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);

    // One boolean, not one per note: a second open note left expanded would
    // be a footer disagreeing with the switch the user just threw.
    expect(header(other)?.getAttribute("aria-expanded")).toBe("false");
    expect(other.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);
    a.destroy();
    b.destroy();
  });

  it("starts collapsed when a panel mounted earlier had already collapsed it", async () => {
    const state = setup(2);
    const { plugin, target, container } = state;
    const first = createMentionsPanel({ plugin, container, target, collapsible: true });
    await first.render();
    header(container)?.click();
    await vi.advanceTimersByTimeAsync(0);

    // The note opened after the switch was thrown — a footer mounting into a
    // view that did not exist when the toggle happened.
    const later = document.body.createDiv();
    const second = createMentionsPanel({ plugin, container: later, target, collapsible: true });
    await second.render();

    expect(header(later)?.getAttribute("aria-expanded")).toBe("false");
    expect(later.querySelectorAll(".journal-mentions-entry")).toHaveLength(0);
    first.destroy();
    second.destroy();
  });

  it("gives a panel that did not ask to be collapsible no toggle at all", async () => {
    const { plugin, target, container } = setup(2);
    plugin.settings.mentionsFooterCollapsed = true;
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    // The sidebar and the code block, both of which the user opened on
    // purpose: the stored state is not theirs to obey, and there is nothing
    // for a keyboard or a screen reader to activate.
    expect(header(container)?.tagName).toBe("DIV");
    expect(header(container)?.hasAttribute("aria-expanded")).toBe(false);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("renders nothing at all for a note with no mentions, collapsed or not", async () => {
    const { plugin, target, container } = setup(0);
    const panel = createMentionsPanel({ plugin, container, target, collapsible: true });
    await panel.render();
    expect(container.childElementCount).toBe(0);

    plugin.settings.mentionsFooterCollapsed = true;
    await panel.render();

    // A bare "Journal mentions 0" header under every note the user opens is
    // exactly the noise the footer's missing `emptyText` exists to prevent.
    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });
});

/**
 * The registry the panel keeps of itself. It exists because `journal.rebuild()`
 * emits nothing to `onChange` (see the doc on `rebuild()` in
 * `journalService.ts`), and two of the three shells — the footer and the code
 * block — hold panels no leaf lookup can reach, so `main.ts` has nothing else
 * to drive them with.
 */
describe("the live-panel registry", () => {
  /** Drops the link from one entry, so a repaint has something to show. */
  function unlink(setup: Setup, index: number): void {
    setup.app.metadataCache.resolvedLinks[setup.entries[index].path] = {};
  }

  it("re-renders every live panel", async () => {
    const state = setup(2);
    const { plugin, target, container } = state;
    const other = document.body.createDiv();
    const a = createMentionsPanel({ plugin, container, target });
    const b = createMentionsPanel({ plugin, container: other, target });
    await Promise.all([a.render(), b.render()]);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    expect(other.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);

    unlink(state, 0);
    refreshMentionPanels();
    await vi.advanceTimersByTimeAsync(0);

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);
    expect(other.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);
    a.destroy();
    b.destroy();
  });

  it("forgets a panel once it is destroyed", async () => {
    const state = setup(2);
    const panel = createMentionsPanel({
      plugin: state.plugin,
      container: state.container,
      target: state.target,
    });
    await panel.render();
    panel.destroy();

    // Membership has to be observed directly, not through the DOM: `render()`
    // early-returns once the panel is destroyed, so a container assertion
    // passes just as well for a panel the registry is still holding — and a
    // retained one is a leak, since the closure keeps its container, its
    // target file and the plugin alive for as long as Obsidian runs. The
    // registry calls `render` on the very object `createMentionsPanel`
    // returned, so a spy on that property observes membership itself. Same
    // reasoning as the `isEntryFile` spy in the teardown tests above.
    const render = vi.spyOn(panel, "render");
    unlink(state, 0);
    refreshMentionPanels();
    await vi.advanceTimersByTimeAsync(0);

    expect(render).not.toHaveBeenCalled();
    expect(state.container.childElementCount).toBe(0);
  });

  it("destroys every live panel, and tolerates being asked twice", async () => {
    const state = setup(2);
    const panel = createMentionsPanel({
      plugin: state.plugin,
      container: state.container,
      target: state.target,
    });
    await panel.render();

    destroyMentionPanels();
    expect(state.container.childElementCount).toBe(0);
    expect(state.journalUnsubscribed).toHaveBeenCalledTimes(1);

    // The double-destroy the plugin's `onunload` can genuinely produce: this
    // path, then the panel's own render child unloading a moment later.
    expect(() => panel.destroy()).not.toThrow();
    expect(state.journalUnsubscribed).toHaveBeenCalledTimes(1);
  });
});
