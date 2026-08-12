const ENTRY_FILENAME_RE =
  /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Filename stem for an entry created at `date`, without extension or collision suffix. */
export function formatEntryFilename(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-");
}

export interface ParsedEntryFilename {
  date: Date;
  /** 1 for a plain filename, 2+ for a same-second collision suffix. */
  collision: number;
}

/** Parses the plugin's filename convention. Returns null for anything else. */
export function parseEntryFilename(basename: string): ParsedEntryFilename | null {
  const match = ENTRY_FILENAME_RE.exec(basename);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, collision] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  // Reject values that rolled over, e.g. month 13 or day 45.
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute) ||
    date.getSeconds() !== Number(second)
  ) {
    return null;
  }

  return { date, collision: collision ? Number(collision) : 1 };
}

/** Strips leading and trailing slashes so settings like "/Journal/" behave. */
function normalizeRoot(root: string): string {
  return root.replace(/^\/+|\/+$/g, "");
}

export function entryFolderPath(root: string, date: Date): string {
  return `${normalizeRoot(root)}/${date.getFullYear()}/${pad(date.getMonth() + 1)}`;
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
