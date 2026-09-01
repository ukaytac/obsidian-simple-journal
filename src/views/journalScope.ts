import type { JournalEntry } from "../journal/entry";
import { entryHasTag } from "../journal/entryTags";

/**
 * What the timeline is currently filtered to, if anything.
 *
 * A SCOPE, never an anchor: neither kind is a point on the chronological
 * axis, so both compose with `anchorDate` rather than competing with it.
 * Exactly one can be active — setting either replaces the other, which the
 * union makes structural rather than a rule to remember. That is the line
 * that keeps this on the right side of CLAUDE.md's `advanced filters`
 * non-goal: the intersection of two filters is a query builder.
 *
 * NEVER persisted. See `JournalView.scope`.
 *
 * Lives here rather than in `JournalView.ts` for two reasons: that file is
 * already past three thousand lines, and `timelineDom.ts` needs to take one
 * of these without importing the view it belongs to.
 */
export type JournalScope =
  | { kind: "tag"; tag: string }
  | {
      kind: "text";
      /** As the user typed it. Shown in the scope bar; re-parsed for matching. */
      query: string;
      /**
       * The paths that matched, resolved BEFORE the scope was ever set.
       *
       * This is what keeps `scopeMatches` synchronous. A text scope's
       * predicate is "did this entry's body contain the terms", which
       * cannot be answered without reading a file — so it is answered once,
       * by whoever built the scope, and the view only ever asks a set.
       * Every hot path that filters the timeline stays as cheap as it was
       * when the only scope was a tag.
       */
      paths: ReadonlySet<string>;
    };

/** Whether `entry` belongs in the timeline under `scope`. Synchronous, always. */
export function scopeMatches(scope: JournalScope | null, entry: JournalEntry): boolean {
  if (scope === null) return true;
  return scope.kind === "tag" ? entryHasTag(entry, scope.tag) : scope.paths.has(entry.file.path);
}

/**
 * What an empty timeline says under this scope. Naming the scope matters:
 * saying "nothing on or before this date" while a scope is silently
 * excluding everything else sends the user looking in the wrong place.
 */
export function scopeEmptyText(scope: JournalScope): string {
  return scope.kind === "tag"
    ? `No entries tagged #${scope.tag}.`
    : `No entries matching “${scope.query}”.`;
}
