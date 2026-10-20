// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf as ObsidianWorkspaceLeaf } from "obsidian";
import { createFakeApp, installDomHelpers, WorkspaceLeaf as FakeWorkspaceLeaf } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { CalendarView } from "../src/views/CalendarView";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 20, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const AUG12 = "Journal/2026/08/2026-08-12-22-41-52.md";
const JUL03 = "Journal/2026/07/2026-07-03-09-00-00.md";

async function setup() {
  const app = createFakeApp();
  const aug = app.vault.addFile(AUG12, "");
  const jul = app.vault.addFile(JUL03, "");
  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();
  const plugin = { app, journal: service, goToDateInJournal: vi.fn() } as unknown as JournalEntriesPlugin;
  const view = new CalendarView(new FakeWorkspaceLeaf(app) as unknown as ObsidianWorkspaceLeaf, plugin);
  await view.onOpen();
  return { app, view, aug, jul };
}

function firstDayCell(view: CalendarView): Element | null {
  return view.contentEl.querySelector(".journal-calendar-day:not(.journal-calendar-day-blank)");
}

describe("CalendarView repaints", () => {
  it("keeps the same grid for a change that moves no dot", async () => {
    const { app, view, jul } = await setup();
    const before = firstDayCell(view);

    app.vault.trigger("modify", jul);
    vi.advanceTimersByTime(300);

    expect(firstDayCell(view)).toBe(before);
  });

  it("rebuilds the grid when a day in the shown month gains a dot", async () => {
    const { app, view } = await setup();
    const before = firstDayCell(view);

    const added = app.vault.addFile("Journal/2026/08/2026-08-15-08-00-00.md", "");
    app.vault.trigger("create", added);
    vi.advanceTimersByTime(300);

    expect(firstDayCell(view)).not.toBe(before);
    const dotted = view.contentEl.querySelectorAll(
      ".journal-calendar-day:not(.is-empty):not(.journal-calendar-day-blank)",
    );
    expect(dotted).toHaveLength(2);
  });

  it("refresh() always rebuilds", async () => {
    const { view } = await setup();
    const before = firstDayCell(view);

    view.refresh();

    expect(firstDayCell(view)).not.toBe(before);
  });
});
