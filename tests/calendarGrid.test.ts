import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import { buildMonthGrid, entryDaysInMonth, WEEKDAY_HEADER } from "../src/views/calendarGrid";
import { sortEntries } from "../src/services/entryIndex";

function entry(basename: string, created: Date): JournalEntry {
  return {
    file: { path: `Journal/${basename}.md`, basename } as JournalEntry["file"],
    created,
  };
}

describe("WEEKDAY_HEADER", () => {
  it("is Monday-first", () => {
    expect(WEEKDAY_HEADER).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });
});

describe("buildMonthGrid", () => {
  it("pads the leading blanks so day 1 sits under its correct Monday-first weekday", () => {
    // August 1, 2026 is a Saturday -> Monday-first index 5.
    const grid = buildMonthGrid(2026, 7);
    expect(grid.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(grid[5]).toEqual(new Date(2026, 7, 1));
  });

  it("has no leading blanks when the month starts on a Monday", () => {
    // June 1, 2026 is a Monday.
    const grid = buildMonthGrid(2026, 5);
    expect(grid[0]).toEqual(new Date(2026, 5, 1));
  });

  it("lists every day of the month in order", () => {
    const grid = buildMonthGrid(2026, 7); // August 2026, 31 days
    const dates = grid.filter((c): c is Date => c !== null);
    expect(dates).toHaveLength(31);
    expect(dates[0]).toEqual(new Date(2026, 7, 1));
    expect(dates[30]).toEqual(new Date(2026, 7, 31));
  });

  it("pads trailing blanks so the grid always fills complete weeks", () => {
    const grid = buildMonthGrid(2026, 7);
    expect(grid.length % 7).toBe(0);
    // Last real day is Aug 31, 2026 (a Monday) -> Monday-first index 0, so no
    // trailing blank is actually needed once the last week is filled with
    // however many further weeks remain empty; assert the invariant that
    // every cell after the last real date is null.
    const lastRealIndex = grid.findIndex((c) => c !== null && c.getTime() === new Date(2026, 7, 31).getTime());
    for (let i = lastRealIndex + 1; i < grid.length; i++) {
      expect(grid[i]).toBeNull();
    }
  });

  it("handles a leap-year February correctly", () => {
    const grid = buildMonthGrid(2028, 1); // 2028 is a leap year
    const dates = grid.filter((c): c is Date => c !== null);
    expect(dates).toHaveLength(29);
    expect(dates[28]).toEqual(new Date(2028, 1, 29));
  });

  it("handles a non-leap-year February correctly", () => {
    const grid = buildMonthGrid(2026, 1);
    const dates = grid.filter((c): c is Date => c !== null);
    expect(dates).toHaveLength(28);
  });

  it("handles the December -> January year boundary", () => {
    const grid = buildMonthGrid(2026, 11); // December 2026
    const dates = grid.filter((c): c is Date => c !== null);
    expect(dates).toHaveLength(31);
    expect(dates[0]).toEqual(new Date(2026, 11, 1));
    expect(dates[30]).toEqual(new Date(2026, 11, 31));
  });

  it("handles the January month whose previous month rolls back a year", () => {
    const grid = buildMonthGrid(2027, 0); // January 2027
    const dates = grid.filter((c): c is Date => c !== null);
    expect(dates).toHaveLength(31);
    expect(dates[0]).toEqual(new Date(2027, 0, 1));
  });
});

describe("entryDaysInMonth", () => {
  it("returns only the dayKeys with an entry inside the given month", () => {
    const index = sortEntries([
      entry("2026-09-02-10-00-00", new Date(2026, 8, 2, 10, 0, 0)), // September — outside
      entry("2026-08-31-23-59-00", new Date(2026, 7, 31, 23, 59, 0)),
      entry("2026-08-12-22-41-52", new Date(2026, 7, 12, 22, 41, 52)),
      entry("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21)), // same day as above
      entry("2026-08-01-00-00-01", new Date(2026, 7, 1, 0, 0, 1)),
      entry("2026-07-31-12-00-00", new Date(2026, 6, 31, 12, 0, 0)), // July — outside
    ]);

    const days = entryDaysInMonth(index, 2026, 7); // August 2026
    expect(days).toEqual(new Set(["2026-08-31", "2026-08-12", "2026-08-01"]));
  });

  it("returns an empty set for an empty index", () => {
    expect(entryDaysInMonth([], 2026, 7)).toEqual(new Set());
  });

  it("returns an empty set for a month with entries elsewhere but none in it", () => {
    const index = sortEntries([
      entry("2026-06-15-10-00-00", new Date(2026, 5, 15, 10, 0, 0)),
      entry("2026-10-01-10-00-00", new Date(2026, 9, 1, 10, 0, 0)),
    ]);

    expect(entryDaysInMonth(index, 2026, 7)).toEqual(new Set());
  });

  it("handles entries right at the month's first and last instants", () => {
    const index = sortEntries([
      entry("2026-08-01-00-00-00", new Date(2026, 7, 1, 0, 0, 0)),
      entry("2026-08-31-23-59-59", new Date(2026, 7, 31, 23, 59, 59)),
      entry("2026-07-31-23-59-59", new Date(2026, 6, 31, 23, 59, 59)), // just before the month
      entry("2026-09-01-00-00-00", new Date(2026, 8, 1, 0, 0, 0)), // just after the month
    ]);

    expect(entryDaysInMonth(index, 2026, 7)).toEqual(new Set(["2026-08-01", "2026-08-31"]));
  });

  it("handles a December/January month across a year boundary", () => {
    const index = sortEntries([
      entry("2026-12-25-10-00-00", new Date(2026, 11, 25, 10, 0, 0)),
      entry("2027-01-05-10-00-00", new Date(2027, 0, 5, 10, 0, 0)),
      entry("2026-11-30-10-00-00", new Date(2026, 10, 30, 10, 0, 0)),
    ]);

    expect(entryDaysInMonth(index, 2026, 11)).toEqual(new Set(["2026-12-25"]));
    expect(entryDaysInMonth(index, 2027, 0)).toEqual(new Set(["2027-01-05"]));
  });

  it("deduplicates multiple entries on the same day into one dayKey", () => {
    const index = sortEntries([
      entry("2026-08-12-22-41-52", new Date(2026, 7, 12, 22, 41, 52)),
      entry("2026-08-12-17-23-41", new Date(2026, 7, 12, 17, 23, 41)),
      entry("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21)),
    ]);

    expect(entryDaysInMonth(index, 2026, 7)).toEqual(new Set(["2026-08-12"]));
  });
});
