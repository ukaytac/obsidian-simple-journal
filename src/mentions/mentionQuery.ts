import type { TFile } from "obsidian";
import type { JournalEntry } from "../journal/entry";

/**
 * The ONE place "which entries mention this note?" is answered — as
 * `entryDate.ts` is the one place an entry's chronology is resolved, and
 * `entryTags.ts` the one place its tags are.
 *
 * SOURCE-BLIND, deliberately. Obsidian folds a body `[[link]]`, an embed
 * `![[link]]`, an aliased `[[link|text]]` and a frontmatter `people: "[[link]]"`
 * into one `resolvedLinks` map before a plugin ever sees them, and its search,
 * graph and backlinks pane treat all four identically. So does this. Nothing
 * downstream may ask which kind a reference was.
 *
 * An UNRESOLVED link (`unresolvedLinks`) is not a mention: it points at no
 * file, so there is no note for the panel to be attached to. Neither is a
 * plain-text occurrence of the note's name — full-text matching is semantic
 * search by another name, and that is a documented non-goal.
 *
 * `metadataCache.getFileBacklinks` is NOT used, on purpose. It appears in
 * Obsidian's published developer docs but is absent from the installed type
 * definitions, which makes it an undocumented internal by this project's
 * standard (CLAUDE.md, "Development Principles"). It also answers the wrong,
 * vault-sized question: we only ever ask about journal entries, of which the
 * service already holds a sorted index.
 */

/** Obsidian's `metadataCache.resolvedLinks`: source path → dest path → count. */
export type ResolvedLinks = Record<string, Record<string, number>>;

/**
 * The entries that link to `target`, in the order `entries` was given.
 *
 * `entries` is expected to be `JournalService.getEntries()`, which is already
 * sorted newest → oldest, so no sorting happens here — sorting a second time
 * would be a second place for the timeline's ordering rule to drift.
 *
 * An entry linking to the target more than once appears once: `resolvedLinks`
 * carries a count, and the count is deliberately ignored.
 */
export function findMentions(
  entries: readonly JournalEntry[],
  target: TFile,
  resolvedLinks: ResolvedLinks,
): JournalEntry[] {
  const targetPath = target.path;
  const mentions: JournalEntry[] = [];

  for (const entry of entries) {
    // A journal entry that links to itself does not list itself.
    if (entry.file.path === targetPath) continue;
    const outgoing = resolvedLinks[entry.file.path];
    if (!outgoing) continue;
    if ((outgoing[targetPath] ?? 0) > 0) mentions.push(entry);
  }

  return mentions;
}
