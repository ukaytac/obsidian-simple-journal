// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { createFakeApp, installDomHelpers } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { createMentionsPanel } from "../src/mentions/MentionsPanel";
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
  const plugin = {
    app,
    repository,
    journal: service,
    goToDateInJournal: goToDate,
  } as unknown as JournalEntriesPlugin;

  const container = document.body.createDiv();
  return { app, plugin, target, entries, container, goToDate, journalUnsubscribed };
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
