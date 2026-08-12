import { parseEntryFilename } from "../utils/dates";

export interface EntryDateSource {
  /** Filename without extension. */
  basename: string;
  /** File creation time in milliseconds, from TFile.stat.ctime. */
  ctime: number;
  /** Raw `created` frontmatter value, whatever the metadata cache produced. */
  created?: unknown;
}

function fromCreatedProperty(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") return null;

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
