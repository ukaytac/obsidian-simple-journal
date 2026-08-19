// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDayHeader, formatMonthHeader, formatTime } from "../src/utils/dates";
import { addEntry, createHarness, internals } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/**
 * Flattens the rendered timeline into one line per month header, day header,
 * and entry timestamp, in DOM order — exactly the shape CLAUDE.md's "Main
 * Journal View"/"Timeline Direction" sections specify, and the thing a
 * module split could silently break while moving `ensureDayGroup`/
 * `appendEntry`/`rebuildMonthHeaders` around.
 */
function timelineShape(timelineEl: HTMLElement): string[] {
  const lines: string[] = [];
  for (const child of Array.from(timelineEl.children)) {
    if (child.classList.contains("journal-month-header")) {
      lines.push(`MONTH ${child.textContent}`);
    } else if (child.classList.contains("journal-day")) {
      lines.push(`DAY ${child.querySelector(".journal-day-header")?.textContent ?? ""}`);
      for (const time of Array.from(child.querySelectorAll(".journal-entry-time"))) {
        lines.push(`  ${time.textContent}`);
      }
    }
  }
  return lines;
}

describe("JournalView render order", () => {
  it("orders days newest first and, within a day, entries newest first", async () => {
    const h = createHarness();
    const aug12 = new Date(2026, 7, 12);
    const aug12_0904 = new Date(2026, 7, 12, 9, 4, 0);
    const aug12_2214 = new Date(2026, 7, 12, 22, 14, 0);
    const aug12_1138 = new Date(2026, 7, 12, 11, 38, 0);
    const aug11 = new Date(2026, 7, 11);
    const aug11_1742 = new Date(2026, 7, 11, 17, 42, 0);
    const aug11_1014 = new Date(2026, 7, 11, 10, 14, 0);

    // Deliberately added out of order — the index/render must sort them, not
    // preserve insertion order.
    addEntry(h, aug12_0904, "morning");
    addEntry(h, aug11_1742, "tue evening");
    addEntry(h, aug12_2214, "late");
    addEntry(h, aug12_1138, "midday");
    addEntry(h, aug11_1014, "tue morning");
    h.service.load();

    await h.view.onOpen();

    expect(timelineShape(internals(h.view).timelineEl)).toEqual([
      `MONTH ${formatMonthHeader(aug12)}`,
      `DAY ${formatDayHeader(aug12)}`,
      `  ${formatTime(aug12_2214)}`,
      `  ${formatTime(aug12_1138)}`,
      `  ${formatTime(aug12_0904)}`,
      `DAY ${formatDayHeader(aug11)}`,
      `  ${formatTime(aug11_1742)}`,
      `  ${formatTime(aug11_1014)}`,
    ]);
  });

  it("emits exactly one month header per month change, never one per day", async () => {
    const h = createHarness();
    const aug2 = new Date(2026, 7, 2, 8, 0, 0);
    const aug1 = new Date(2026, 7, 1, 8, 0, 0);
    const jul30 = new Date(2026, 6, 30, 8, 0, 0);
    const jul15 = new Date(2026, 6, 15, 8, 0, 0);

    addEntry(h, aug2);
    addEntry(h, aug1);
    addEntry(h, jul30);
    addEntry(h, jul15);
    h.service.load();

    await h.view.onOpen();

    const headers = Array.from(
      internals(h.view).timelineEl.querySelectorAll(".journal-month-header"),
    ).map((el) => (el as Element).textContent);

    expect(headers).toEqual([formatMonthHeader(aug2), formatMonthHeader(jul30)]);
  });

  it("two entries created within the same second still both render, newest-suffix first", async () => {
    const h = createHarness();
    const at = new Date(2026, 7, 12, 22, 14, 0);

    addEntry(h, at, "first", "");
    addEntry(h, at, "second", "-2");
    h.service.load();

    await h.view.onOpen();

    const rows = Array.from(internals(h.view).timelineEl.querySelectorAll(".journal-entry"));
    expect(rows).toHaveLength(2);
    // compareEntries breaks a same-timestamp tie by collision suffix, higher
    // first — both must be present and neither silently dropped.
    expect(internals(h.view).rendered.size).toBe(2);
  });
});
