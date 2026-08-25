// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
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
  document.body.innerHTML = "";
});

const TARGET_PATH = "People/Ekin Arslan Aytaç.md";

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  target: TFile;
  container: HTMLElement;
  goToDate: ReturnType<typeof vi.fn>;
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

  for (let i = 0; i < count; i++) {
    const day = String(24 - i).padStart(2, "0");
    const path = `Journal/2026/08/2026-08-${day}-21-40-00.md`;
    app.vault.addFile(path, `---\ncreated: 2026-08-${day}T21:40:00\n---\nEntry ${i} about [[Ekin Arslan Aytaç]]`);
    app.metadataCache.resolvedLinks[path] = { [TARGET_PATH]: 1 };
  }

  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();

  const goToDate = vi.fn();
  const plugin = {
    app,
    repository,
    journal: service,
    goToDateInJournal: goToDate,
  } as unknown as JournalEntriesPlugin;

  const container = document.body.createDiv();
  return { app, plugin, target, container, goToDate };
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

  it("re-renders when the metadata cache resolves a change", async () => {
    const { app, plugin, target, container } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);

    app.metadataCache.resolvedLinks["Journal/2026/08/2026-08-24-21-40-00.md"] = {};
    app.metadataCache.trigger("resolve", target);
    await vi.advanceTimersByTimeAsync(200);

    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });

  it("empties the container and stops responding to changes after destroy", async () => {
    const { app, plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    panel.destroy();

    expect(container.childElementCount).toBe(0);

    // The subscription must be gone, not merely ignored: a resolve after
    // teardown must not repopulate a detached container.
    app.metadataCache.trigger("resolve", target);
    await vi.advanceTimersByTimeAsync(200);
    expect(container.childElementCount).toBe(0);
  });
});
