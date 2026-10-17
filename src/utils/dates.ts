/**
 * The filename shapes an entry may be written in. See CLAUDE.md § Filename
 * formats: fixed shapes rather than a pattern language, each admitted only if
 * it carries the full date and time to the second with the year first, and
 * never removed once admitted — `parseEntryFilename` must keep recognising
 * entries already named with it.
 */
export type EntryFilenameFormat = "dashed" | "compact";

/** What every existing journal already uses, so an upgrade changes nothing. */
export const DEFAULT_ENTRY_FILENAME_FORMAT: EntryFilenameFormat = "dashed";

/** Every format, in the order the settings dropdown offers them. */
export const ENTRY_FILENAME_FORMATS: readonly EntryFilenameFormat[] = ["dashed", "compact"];

// One expression per shape, each capturing year, month, day, hour, minute,
// second and the optional collision suffix in that order. The shapes cannot
// match each other's names, so at most one of these ever applies.
const ENTRY_FILENAME_RES: readonly (readonly [EntryFilenameFormat, RegExp])[] = [
  ["dashed", /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-([1-9]\d*))?$/],
  ["compact", /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:-([1-9]\d*))?$/],
];

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Number of days in `month` (1-12) of `year`, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Filename stem for an entry created at `date`, without extension or collision suffix. */
export function formatEntryFilename(
  date: Date,
  format: EntryFilenameFormat = DEFAULT_ENTRY_FILENAME_FORMAT,
): string {
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())];
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())];

  switch (format) {
    case "dashed":
      return [...day, ...time].join("-");
    case "compact":
      return `${day.join("")}_${time.join("")}`;
  }
}

export interface ParsedEntryFilename {
  date: Date;
  /** 1 for a plain filename, 2+ for a same-second collision suffix. */
  collision: number;
  /** Which admitted shape the name is in. */
  format: EntryFilenameFormat;
}

/**
 * Parses the plugin's filename convention, in every admitted shape whatever
 * the current setting — reading is format-blind, so a journal holding both
 * shapes is not a broken state. Returns null for anything else, including
 * genuinely impossible dates (month 13, 31 April, etc).
 *
 * Note: during the DST fall-back hour, two distinct instants (e.g. 01:30 EST
 * and 01:30 EDT) format to the same filename, so parsing recovers only one
 * of them. This is inherent to the filename format and is not fixed here —
 * callers that need the exact instant should prefer the `created` property,
 * which carries an explicit offset and round-trips exactly.
 */
export function parseEntryFilename(basename: string): ParsedEntryFilename | null {
  let match: RegExpExecArray | null = null;
  let format: EntryFilenameFormat = DEFAULT_ENTRY_FILENAME_FORMAT;
  for (const [candidate, re] of ENTRY_FILENAME_RES) {
    match = re.exec(basename);
    if (match) {
      format = candidate;
      break;
    }
  }
  if (!match) return null;

  const [, year, month, day, hour, minute, second, collision] = match;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const secondNum = Number(second);

  // Validate components numerically rather than round-tripping through Date:
  // Date *normalizes* nonexistent local times (e.g. the DST spring-forward
  // gap) instead of rolling over, so comparing getHours()/etc. against the
  // input would wrongly reject legitimate filenames landing in that gap.
  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) return null;
  if (hourNum > 23) return null;
  if (minuteNum > 59) return null;
  if (secondNum > 59) return null;

  const date = new Date(yearNum, monthNum - 1, dayNum, hourNum, minuteNum, secondNum);

  return { date, collision: collision ? Number(collision) : 1, format };
}

/** ISO 8601 with an explicit local offset, e.g. 2026-08-12T22:41:52+03:00. */
export function formatCreatedProperty(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    offset
  );
}

/** Local calendar day identifier, used to group entries. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Orders two `dayKey` strings newest first, mirroring `compareEntries`'s
 * sign convention (negative when `a` is newer than `b`). `dayKey` is always
 * `"YYYY-MM-DD"` with every component zero-padded to a fixed width, so plain
 * code-point comparison already agrees with calendar order — no parsing back
 * into a `Date` is needed, and unlike `localeCompare` this can't vary by
 * locale or platform.
 */
export function compareDayKeys(a: string, b: string): number {
  return b < a ? -1 : b > a ? 1 : 0;
}

export function formatDayHeader(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
  const month = date.toLocaleDateString("en-US", { month: "long" }).toUpperCase();
  return `${weekday}, ${date.getDate()} ${month}`;
}

export function formatMonthHeader(date: Date): string {
  const month = date.toLocaleDateString("en-US", { month: "long" }).toUpperCase();
  return `${month} ${date.getFullYear()}`;
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Formats `date` as an HTML `<input type="datetime-local">` value, in LOCAL
 * time components (matching every other formatter in this file — there is
 * no UTC conversion anywhere here). Includes seconds, since an entry's
 * `created` value carries second precision and the input is given
 * `step="1"` so the picker doesn't silently round it away.
 */
export function formatDateTimeLocalValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// `T` separates date and time, per the datetime-local value spec. Seconds
// are optional (the spec's own minute-granularity default, reachable when
// `step` isn't at least 1). Deliberately anchored start-to-end (`^`/`$`, no
// trailing input allowed) and with no timezone/offset group at all: a
// datetime-local value never carries one, so accepting `Z` or `+03:00` here
// would silently accept input that was never actually local-only.
const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses an `<input type="datetime-local">` value as LOCAL time — the same
 * convention every other date in this codebase uses (see `formatCreatedProperty`,
 * `resolveEntryDate`) — never as UTC. Returns null for anything empty,
 * malformed, or naming an impossible calendar date/time, so a caller never
 * has to separately guard against `Invalid Date` poisoning a write.
 */
export function parseDateTimeLocalValue(value: string): Date | null {
  const match = DATETIME_LOCAL_RE.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const secondNum = second ? Number(second) : 0;

  // Validated numerically, not by round-tripping through Date, for the same
  // reason as parseEntryFilename: Date *normalizes* an out-of-range or
  // DST-gap local time instead of rejecting it.
  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) return null;
  if (hourNum > 23) return null;
  if (minuteNum > 59) return null;
  if (secondNum > 59) return null;

  return new Date(yearNum, monthNum - 1, dayNum, hourNum, minuteNum, secondNum);
}
