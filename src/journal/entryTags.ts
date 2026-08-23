import { getAllTags, parseFrontMatterTags, type CachedMetadata } from "obsidian";
import type { JournalEntry } from "./entry";

/**
 * The ONE place tags are resolved from a file's cache — `resolveTags` and
 * `frontmatterTags` below — exactly as `entryDate.ts` is the one place an
 * entry's chronology is resolved.
 *
 * Obsidian draws no semantic distinction between an inline `#tag` and a
 * frontmatter `tags:` entry — `getAllTags` merges both, and search, the tag
 * pane and the graph all treat them identically. Neither does this plugin,
 * with exactly one exception: `frontmatterTags`, which exists because the
 * timeline hides the properties panel (`styles.css`'s
 * `.journal-entry-embed .metadata-container`) and so has to surface the one
 * kind of tag it would otherwise make invisible.
 *
 * `entryHasTag`, `entriesWithTag` and `collectTags` are a different layer:
 * they query and aggregate tags already resolved onto `JournalEntry[]`,
 * closer in kind to `entryIndex.ts` than to the resolvers above. They live
 * here only because they are small, inseparable-in-practice functions built
 * directly on the resolvers' output. If tag querying grows — multi-tag
 * filters, "any of N tags" — that belongs in its own module rather than
 * accreting onto this one.
 *
 * Nothing here ever WRITES a tag. Frontmatter belongs to the user (only
 * `created` is ours, via `setCreatedProperty`), and the body needs no help:
 * the embedded editor is a real Obsidian editor, so typing `#` brings up
 * Obsidian's own tag autocomplete.
 */

/**
 * Bare tag text: no leading `#`, no surrounding whitespace.
 *
 * Trims TWICE, deliberately: stripping the `#` can expose whitespace that
 * was never at the edge of the original string — `"# work"` trims to itself
 * (no edge whitespace), then loses its `#` to leave `" work"`, which still
 * has a leading space until the second trim removes it. A single trim before
 * the replace, or none after it, both leave that space in.
 *
 * Exported so every place that turns user-typed or frontmatter-adjacent text
 * into a tag comparison — `TagScopeModal`'s suggester query included — goes
 * through the one function that owns this rule, rather than each caller
 * approximating it and drifting apart the way the modal's own
 * `query.trim().replace(/^#+/, "").toLowerCase()` once did (it was missing
 * exactly this second trim).
 */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim();
}

/**
 * Normalizes, drops anything empty, and dedupes case-insensitively —
 * Obsidian treats `#Work` and `#work` as the same tag — while keeping the
 * casing that appeared first, which is what gets displayed.
 */
function normalizeAll(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const value of raw) {
    const tag = normalizeTag(value);
    if (!tag) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

/**
 * Every tag on the entry, inline and frontmatter alike, `#` stripped.
 *
 * An absent cache yields `[]` rather than throwing: the timeline must not
 * break because one entry has not been indexed yet, the same principle
 * `resolveEntryDate`'s fallback chain follows. `metadataCache.on("changed")`
 * already queues an upsert, so the entry picks its tags up moments later.
 */
export function resolveTags(cache: CachedMetadata | null | undefined): string[] {
  if (!cache) return [];
  return normalizeAll(getAllTags(cache) ?? []);
}

/**
 * Only the frontmatter side. Used for the chips in an entry's header, and
 * for nothing else — see this module's doc for why that one asymmetry exists.
 */
export function frontmatterTags(cache: CachedMetadata | null | undefined): string[] {
  if (!cache?.frontmatter) return [];
  return normalizeAll(parseFrontMatterTags(cache.frontmatter) ?? []);
}

/**
 * Builds the EXACT, case-insensitive "does this entry carry `tag`" predicate
 * — the one comparison `entryHasTag` and `entriesWithTag` both need — so the
 * product decision it encodes (`work` does not match `work/project`; see
 * `entryHasTag`'s doc for why) lives in exactly one place. A future "match
 * nested tags" change edits this function and both callers pick it up.
 *
 * Normalizes the needle ONCE, at predicate-construction time, not per entry:
 * `entriesWithTag` calls this once and filters with the result, so a scoped
 * filter over a 50k-entry journal does one regex replace/trim/`toLowerCase()`
 * total, not 50k of each. An empty needle normalizes to `""`, which the
 * returned predicate always rejects, matching the "empty needle matches
 * nothing" behaviour both exported functions have always had.
 */
function tagMatcher(tag: string): (entry: JournalEntry) => boolean {
  const needle = normalizeTag(tag).toLowerCase();
  if (!needle) return () => false;
  return (entry) => entry.tags.some((value) => value.toLowerCase() === needle);
}

/**
 * Whether `entry` carries `tag`, compared case-insensitively. `tag` may be
 * written with or without a leading `#`.
 *
 * EXACT match, deliberately: `work` does not match `work/project`. A scope is
 * a filter over a continuous timeline, not a hierarchy browser (a non-goal),
 * and the suggester lists every nested tag separately, so nothing becomes
 * unreachable.
 */
export function entryHasTag(entry: JournalEntry, tag: string): boolean {
  return tagMatcher(tag)(entry);
}

/**
 * The entries carrying `tag`, in their existing order — the tag scope's
 * filter predicate, kept here rather than in `JournalView` so this module
 * stays the one place tags are queried.
 *
 * Built on `tagMatcher` rather than `entries.filter((entry) =>
 * entryHasTag(entry, tag))`: that form would re-normalize the unchanging
 * needle for every entry, so a scoped filter over a 50k-entry journal did
 * 50k regex replaces/trims/`toLowerCase()`s instead of one. `entryHasTag`
 * stays exported for the single-entry question (`JournalView.matchesScope`).
 *
 * Always a NEW array; `entries` is never mutated. Callers rely on the
 * elements being the SAME entry objects, so reference-identity lookups
 * (`indexOf`, path cursors) keep working against the result.
 */
export function entriesWithTag(entries: readonly JournalEntry[], tag: string): JournalEntry[] {
  return entries.filter(tagMatcher(tag));
}

/** Every tag across `entries`, deduped and alphabetical — the suggester's list. */
export function collectTags(entries: readonly JournalEntry[]): string[] {
  return normalizeAll(entries.flatMap((entry) => entry.tags)).sort((a, b) => a.localeCompare(b));
}
