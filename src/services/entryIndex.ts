import type { JournalEntry } from "../journal/entry";
import { parseEntryFilename } from "../utils/dates";

function collisionIndex(basename: string): number {
  return parseEntryFilename(basename)?.collision ?? 1;
}

/**
 * Total ordering, newest first. Entries created within the same second are
 * ordered by their collision suffix so that the later one appears above.
 * Falls back to a code-point path comparison so the order is never ambiguous
 * — not `localeCompare`, whose ICU collation treats Unicode-equivalent but
 * distinct byte sequences (e.g. NFC vs NFD forms of "café") as equal and
 * varies by locale/platform, which would make a synced vault order tied
 * entries differently on different devices.
 */
export function compareEntries(a: JournalEntry, b: JournalEntry): number {
  const byTime = b.created.getTime() - a.created.getTime();
  if (byTime !== 0) return byTime;

  const byCollision = collisionIndex(b.file.basename) - collisionIndex(a.file.basename);
  if (byCollision !== 0) return byCollision;

  return b.file.path < a.file.path ? -1 : b.file.path > a.file.path ? 1 : 0;
}

export function sortEntries(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort(compareEntries);
}

/**
 * Inserts into an already sorted list and returns the insertion index. If an
 * entry with the same path is already present (e.g. its timestamp was
 * edited), that stale copy is removed first so the list never accumulates
 * duplicate paths.
 */
export function insertSorted(list: JournalEntry[], entry: JournalEntry): number {
  removeByPath(list, entry.file.path);

  let low = 0;
  let high = list.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareEntries(list[mid], entry) < 0) low = mid + 1;
    else high = mid;
  }

  list.splice(low, 0, entry);
  return low;
}

/** Removes the entry with this path. Returns its former index, or -1. */
export function removeByPath(list: JournalEntry[], path: string): number {
  const index = list.findIndex((entry) => entry.file.path === path);
  if (index >= 0) list.splice(index, 1);
  return index;
}

export function findByPath(list: JournalEntry[], path: string): JournalEntry | null {
  return list.find((entry) => entry.file.path === path) ?? null;
}

/**
 * Date-based paging: entries strictly older than `before`.
 * Prefer `pageAfter` for timeline paging — see the note in this module's task.
 */
export function sliceBefore(
  list: JournalEntry[],
  before?: Date,
  limit?: number,
): JournalEntry[] {
  const cutoff = before?.getTime();
  const filtered =
    cutoff === undefined ? list : list.filter((entry) => entry.created.getTime() < cutoff);

  return limit === undefined ? filtered.slice() : filtered.slice(0, limit);
}

/**
 * Position-based paging: the next `limit` entries after the entry at
 * `lastPath`. Unlike date-based paging this cannot skip entries that share a
 * timestamp with the cursor.
 *
 * A `null` cursor means "first page" and returns it. A non-null cursor whose
 * entry is no longer in the list (deleted, renamed, or removed by sync while
 * the caller was scrolled down) returns `null` rather than silently falling
 * back to the first page — treating a lost cursor as page 1 would make
 * infinite scroll re-append entries the caller already rendered and never
 * advance. Callers must treat `null` as "re-anchor", not "empty page".
 */
export function pageAfter(
  list: JournalEntry[],
  lastPath: string | null,
  limit: number,
): JournalEntry[] | null {
  if (lastPath === null) return list.slice(0, limit);

  const index = list.findIndex((e) => e.file.path === lastPath);
  if (index === -1) return null;

  return list.slice(index + 1, index + 1 + limit);
}
