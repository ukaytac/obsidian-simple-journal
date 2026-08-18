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

/**
 * Position in `list` (sorted newest→oldest by `compareEntries`) of the first
 * entry at or before the end of `date`'s calendar day — where an anchored
 * timeline ("Go to date") starts. Entries before this position are strictly
 * newer than the anchor and must never render in an anchored timeline; see
 * `JournalView.goToDate` and `insertEntryInPlace`'s anchor-aware bounds
 * check, which both depend on this being the live, current position rather
 * than one cached at anchor time — the count of entries newer than the
 * anchor can change (a new entry created while anchored, one deleted, etc.),
 * and recomputing this fresh each time is what keeps that comparison correct
 * without drifting stale.
 *
 * Binary search, not `findIndex`: `list` is already sorted for exactly this
 * predicate (monotonically "newer than the anchor" then "at or before it"),
 * and this can run once per vault-event batch against a journal with tens of
 * thousands of entries.
 *
 * Returns `list.length` when every entry is newer than the anchor (an
 * anchored view of a date with nothing at or before it is empty), and `0`
 * when every entry already qualifies (the anchor is at or after the newest
 * entry — behaviourally identical to no anchor at all).
 */
export function anchorPosition(list: readonly JournalEntry[], date: Date): number {
  const endOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();

  let low = 0;
  let high = list.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].created.getTime() > endOfDay) low = mid + 1;
    else high = mid;
  }

  return low;
}

/**
 * The `pageAfter` cursor that seeds an anchored timeline: the path of the
 * entry immediately before `anchorPosition`, or `null` when that position is
 * 0 — nothing to skip, so paging starts exactly like an unanchored reload.
 *
 * If the anchored day itself has no entries, `anchorPosition` naturally
 * lands on the nearest older entry instead of a dead end — anchoring to a
 * point in time, not to a specific entry, is the intended behaviour (see
 * `JournalView.goToDate`'s doc).
 */
export function anchorSeed(list: readonly JournalEntry[], date: Date): string | null {
  const position = anchorPosition(list, date);
  return position === 0 ? null : list[position - 1].file.path;
}
