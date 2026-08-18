/**
 * Pure calendar-grid math for the month calendar sidebar (`CalendarView`).
 * No Obsidian/DOM dependency, so it's testable directly — same pattern as
 * `mountWindow.ts`, `applyChange.ts`, `entrySave.ts`, and `composerCommit.ts`.
 */

import type { JournalEntry } from "../journal/entry";
import { anchorPosition } from "../services/entryIndex";
import { dayKey } from "../utils/dates";

/**
 * Weekday header labels, Monday-first. Fixed for now — CLAUDE.md's Settings
 * section says "Avoid premature configurability," and there is no V1
 * requirement for an alternative week start, so this is a constant rather
 * than a setting.
 */
export const WEEKDAY_HEADER: readonly string[] = ["M", "T", "W", "T", "F", "S", "S"];

/** One cell in the month grid: `null` for a leading/trailing blank. */
export type MonthGridCell = Date | null;

/**
 * Builds the grid of cells for `year`/`month` (`month` is 0-indexed, same as
 * `Date.getMonth()`), Monday-first.
 *
 * Leading blanks pad the first row so day 1 sits under its correct weekday;
 * trailing blanks pad the last row so every row has exactly 7 cells. Handles
 * year boundaries and leap years by letting `Date`'s own day-of-month
 * normalization compute the month length and starting weekday, rather than
 * hand-rolled month-length tables.
 */
export function buildMonthGrid(year: number, month: number): MonthGridCell[] {
  const first = new Date(year, month, 1);
  // Day 0 of the *next* month is the last day of *this* month — this is the
  // same trick `dates.ts`'s `daysInMonth` uses, and it normalizes correctly
  // across a December -> January rollover (month + 1 === 12 becomes January
  // of `year + 1`, and day 0 of that is December 31 of `year`).
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Date#getDay() is 0 = Sunday..6 = Saturday. Shift to Monday-first: 0 =
  // Monday..6 = Sunday.
  const firstWeekday = (first.getDay() + 6) % 7;

  const cells: MonthGridCell[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);

  return cells;
}

/**
 * The set of `dayKey`s (local calendar days) that have at least one entry in
 * `year`/`month` (`month` 0-indexed), computed from `index` — the same
 * newest-first-sorted array `JournalService.getEntries()` returns.
 *
 * Bounded by two `anchorPosition` binary searches rather than a linear scan
 * of the whole index: `index` can hold tens of thousands of entries, and
 * this runs on every month change and every vault change. `anchorPosition`
 * returns the position of the first entry at or before the end of a given
 * day in a newest-first-sorted list; called once for the last day of this
 * month and once for the last day of the *previous* month, the entries
 * strictly between those two positions are exactly this month's entries —
 * no third search algorithm needed, and no need to touch anything outside
 * that range.
 */
export function entryDaysInMonth(
  index: readonly JournalEntry[],
  year: number,
  month: number,
): Set<string> {
  // Day 0 of the month after `month` is the last day of `month` itself.
  const lastDayOfMonth = new Date(year, month + 1, 0);
  // Day 0 of `month` is the last day of the *previous* month — correctly
  // rolling back a year when `month` is January (month === 0).
  const lastDayOfPreviousMonth = new Date(year, month, 0);

  const start = anchorPosition(index, lastDayOfMonth);
  const end = anchorPosition(index, lastDayOfPreviousMonth);

  const days = new Set<string>();
  for (let i = start; i < end; i++) {
    days.add(dayKey(index[i].created));
  }
  return days;
}
