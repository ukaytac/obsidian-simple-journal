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

/** Bare tag text: no leading `#`, no surrounding whitespace. */
function normalizeTag(raw: string): string {
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
 * Whether `entry` carries `tag`, compared case-insensitively. `tag` may be
 * written with or without a leading `#`.
 *
 * EXACT match, deliberately: `work` does not match `work/project`. A scope is
 * a filter over a continuous timeline, not a hierarchy browser (a non-goal),
 * and the suggester lists every nested tag separately, so nothing becomes
 * unreachable.
 */
export function entryHasTag(entry: JournalEntry, tag: string): boolean {
  const needle = normalizeTag(tag).toLowerCase();
  if (!needle) return false;
  return entry.tags.some((value) => value.toLowerCase() === needle);
}

/**
 * The entries carrying `tag`, in their existing order — the tag scope's
 * filter predicate, kept here rather than in `JournalView` so this module
 * stays the one place tags are queried.
 *
 * Normalizes the needle ONCE instead of per entry, which is the whole reason
 * this exists as its own function rather than `entries.filter((entry) =>
 * entryHasTag(entry, tag))`: that form re-runs a regex replace, two trims and
 * a `toLowerCase()` on an unchanging value for every entry, so a scoped
 * filter over a 50k-entry journal did 50k of each. `entryHasTag` stays
 * exported for the single-entry question (`JournalView.matchesScope`).
 *
 * Always a NEW array; `entries` is never mutated. Callers rely on the
 * elements being the SAME entry objects, so reference-identity lookups
 * (`indexOf`, path cursors) keep working against the result.
 */
export function entriesWithTag(entries: readonly JournalEntry[], tag: string): JournalEntry[] {
  const needle = normalizeTag(tag).toLowerCase();
  if (!needle) return [];
  return entries.filter((entry) => entry.tags.some((value) => value.toLowerCase() === needle));
}

/** Every tag across `entries`, deduped and alphabetical — the suggester's list. */
export function collectTags(entries: readonly JournalEntry[]): string[] {
  return normalizeAll(entries.flatMap((entry) => entry.tags)).sort((a, b) => a.localeCompare(b));
}
