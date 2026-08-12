import { parseEntryFilename } from "../utils/dates";

export interface EntryDateSource {
  /** Filename without extension. */
  basename: string;
  /** File creation time in milliseconds, from TFile.stat.ctime. */
  ctime: number;
  /** Raw `created` frontmatter value, whatever the metadata cache produced. */
  created?: unknown;
}

const DATE_ONLY_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Number of days in `month` (1-12) of `year`, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Parses an ECMAScript date-only string ("2026", "2026-08", "2026-08-12") as
 * local midnight of that calendar date, rather than letting `new Date`
 * interpret it as UTC midnight — which shifts it onto the wrong local day in
 * any timezone behind UTC. This is the form Obsidian's own "Date" property
 * type writes, so it isn't a rare edge case.
 *
 * Returns null both when the string doesn't have this shape and when it has
 * the shape but names an impossible date (e.g. "2026-02-30"), so a garbage
 * value falls through to the filename rather than being coerced.
 */
function fromDateOnlyString(trimmed: string): Date | null {
  const match = DATE_ONLY_RE.exec(trimmed);
  if (!match) return null;

  const [, year, month, day] = match;
  const yearNum = Number(year);
  const monthNum = month ? Number(month) : 1;
  const dayNum = day ? Number(day) : 1;

  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) return null;

  return new Date(yearNum, monthNum - 1, dayNum);
}

/**
 * A `Date` at exactly UTC midnight is overwhelmingly a date-only YAML value
 * (Obsidian's metadata cache may hand back a parsed `Date` instead of the
 * raw string, and date-only YAML/ISO values parse to UTC midnight) rather
 * than a genuine instant. We can't tell the two apart from the `Date` alone,
 * so we deliberately treat UTC midnight as a calendar date and return local
 * midnight of its UTC year/month/day. This is a trade, not a certainty: a
 * user whose `created` really is T00:00:00Z will see local midnight instead
 * of the true instant — but misfiling a whole day is worse than shifting the
 * displayed time of that rare entry.
 */
function fromCreatedDateInstance(value: Date): Date | null {
  if (Number.isNaN(value.getTime())) return null;

  const isUtcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;

  if (isUtcMidnight) {
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  return value;
}

function fromCreatedProperty(value: unknown): Date | null {
  if (value instanceof Date) {
    return fromCreatedDateInstance(value);
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const dateOnly = fromDateOnlyString(trimmed);
  if (dateOnly) return dateOnly;
  if (DATE_ONLY_RE.test(trimmed)) return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Resolves the timestamp of a journal entry.
 *
 * Order, per CLAUDE.md: valid `created` property, then the plugin's filename
 * convention, then file creation time. A missing or malformed value never
 * removes an entry from the timeline.
 */
export function resolveEntryDate(source: EntryDateSource): Date {
  const fromProperty = fromCreatedProperty(source.created);
  if (fromProperty) return fromProperty;

  const fromFilename = parseEntryFilename(source.basename);
  if (fromFilename) return fromFilename.date;

  if (Number.isFinite(source.ctime)) return new Date(source.ctime);

  // Last resort: an entry with no usable timestamp anywhere still gets a
  // stable position rather than an Invalid Date that would poison sorting.
  return new Date(0);
}
