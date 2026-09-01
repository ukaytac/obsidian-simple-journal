import type { TFile } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import { bodyMatchesTerms, buildSnippet, type SearchSnippet } from "../journal/entrySearch";

/**
 * The one thing search needs from `EntryRepository`, named as an interface so
 * the tests can supply a map instead of a vault.
 *
 * `readBodyCached` and not `readBody`: search never writes back what it read,
 * which is exactly the case Obsidian's guidance reserves `cachedRead` for —
 * and the same reason the mentions panel uses it. It also strips the
 * frontmatter for us, which is what makes "the body, and only the body" a
 * property of the reader rather than a rule this file has to remember.
 */
export interface JournalSnapshotReader {
  readBodyCached(file: TFile): Promise<string>;
}

export interface SnapshotEntry {
  entry: JournalEntry;
  /** Body only — `readBodyCached` has already taken the frontmatter off. */
  body: string;
}

export interface JournalSnapshot {
  entries: SnapshotEntry[];
  /** How many entries could not be read. Surfaced by the modal; see below. */
  unreadable: number;
}

export interface SearchHit {
  entry: JournalEntry;
  snippet: SearchSnippet;
}

/**
 * Reads every entry's body once.
 *
 * Once per search session, not once per keystroke: the modal filters this
 * snapshot in memory as the user types. A per-keystroke scan is the
 * "obviously unscalable decision" CLAUDE.md § Performance warns against; a
 * single pass over a journal is not, and `cachedRead` means a second search
 * in the same session pays almost nothing.
 *
 * If this is ever felt on a large journal, the answer is an incrementally
 * maintained index fed by `JournalService`'s existing change batching — and
 * the reason that stays a one-file change is that nothing outside this module
 * knows search reads anything at all.
 *
 * An unreadable entry is logged and dropped rather than thrown: one bad file
 * must not take the whole search with it. It is also COUNTED, because the
 * worst thing a search can do is quietly answer with less than it has —
 * `SearchModal` shows the count, which is CLAUDE.md § Error Handling's "fail
 * visibly" for a path that writes nothing and so risks no data.
 */
export async function readJournalSnapshot(
  reader: JournalSnapshotReader,
  entries: readonly JournalEntry[],
): Promise<JournalSnapshot> {
  const results = await Promise.all(
    entries.map(async (entry): Promise<SnapshotEntry | null> => {
      try {
        return { entry, body: await reader.readBodyCached(entry.file) };
      } catch (error) {
        console.error(`Simple Journal: could not read ${entry.file.path} to search it`, error);
        return null;
      }
    }),
  );

  return {
    entries: results.filter((result): result is SnapshotEntry => result !== null),
    unreadable: results.filter((result) => result === null).length,
  };
}

/**
 * Pure: the snapshot is already in memory, so this is string work only and
 * safe to run on every keystroke.
 *
 * Order is the snapshot's order, which is the index's order, which is the
 * journal's order — newest first, as it is everywhere else. Not a preference
 * and not sortable; see CLAUDE.md's North Star.
 */
export function searchSnapshot(snapshot: JournalSnapshot, terms: readonly string[]): SearchHit[] {
  if (terms.length === 0) return [];
  return snapshot.entries
    .filter(({ body }) => bodyMatchesTerms(body, terms))
    .map(({ entry, body }) => ({ entry, snippet: buildSnippet(body, terms) }));
}

/**
 * The paths a set of hits covers — what a text scope is built from, and the
 * reason `JournalView.matchesScope` can stay synchronous: the question "does
 * this entry's body contain the terms" is answered once, here, by the side
 * that is already allowed to read files.
 */
export function hitPaths(hits: readonly SearchHit[]): Set<string> {
  return new Set(hits.map((hit) => hit.entry.file.path));
}
