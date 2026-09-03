/**
 * Where an entry's file lives, in one place.
 *
 * Pure — no Obsidian, no vault. Every writer in the plugin computes its target
 * folder through `entryFolderPath` with the CURRENT setting: `createEntry` for
 * a new entry, `renameEntryToMatch` after a corrected timestamp, and
 * `reorganizeEntries` for the bulk move. Three callers, one function, so they
 * cannot disagree about where an entry belongs — the same structural guarantee
 * `EntryRepository.withFreeName` gives those same three about collision
 * suffixes.
 *
 * See CLAUDE.md § Storage Model. This is the "must be configurable later"
 * that section promised, kept to three fixed shapes rather than a pattern
 * language: a format string would mean a parser, a validator, an error state,
 * and a way for a user to break their own journal.
 */

/** The three shapes a journal folder can take. */
export type EntryFolderLayout = "year-month" | "year" | "flat";

/**
 * What every existing journal already uses, so an upgrade changes nothing and
 * a settings file with no value (or a corrupt one) lands here.
 */
export const DEFAULT_ENTRY_FOLDER_LAYOUT: EntryFolderLayout = "year-month";

/** Every layout, in the order the settings dropdown offers them. */
export const ENTRY_FOLDER_LAYOUTS: readonly EntryFolderLayout[] = [
  "year-month",
  "year",
  "flat",
];

/** Strips leading and trailing slashes so settings like "/Journal/" behave. */
function normalizeRoot(root: string): string {
  return root.replace(/^\/+|\/+$/g, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Joins path segments, dropping the empty ones a vault-root journal produces. */
function join(...segments: string[]): string {
  return segments.filter((segment) => segment !== "").join("/");
}

/**
 * The folder `date`'s entry belongs in under `layout`.
 *
 * Returns "" — not "/" and not "." — for a flat layout on a journal folder
 * that is itself the vault root. A caller building a file path from this must
 * join rather than interpolate, or it produces a leading slash; see
 * `EntryRepository.withFreeName`.
 */
export function entryFolderPath(root: string, date: Date, layout: EntryFolderLayout): string {
  const base = normalizeRoot(root);

  switch (layout) {
    case "flat":
      return base;
    case "year":
      return join(base, String(date.getFullYear()));
    case "year-month":
      return join(base, String(date.getFullYear()), pad(date.getMonth() + 1));
  }
}

/**
 * Whether `folder` is one of the three shapes this plugin produces, and so a
 * folder it may move a file OUT of.
 *
 * Replaces the older `isYearMonthFolder`, and answers a deliberately narrow
 * question: not "is this file ours" — the filename convention answers that,
 * and `YYYY-MM-DD-HH-mm-ss[-N].md` is nobody's hand-typed choice — but "did
 * the user file this somewhere on purpose?". `Journal/inbox/` is filing
 * something somewhere. The journal folder's own root is not, which is why the
 * flat shape counts as managed even though a user could have dropped a file
 * there: the consequence is bounded (a time correction relocates that one
 * file, with links following) and the alternative would make the flat layout
 * a place the plugin writes to but will not maintain.
 *
 * Shape only, with no year range: a folder a user named `2026` reads as the
 * year shape. Bounded and benign — the only effect is that a correction
 * crossing a year boundary moves the file to `2027`, which is what a folder
 * named by year would have wanted anyway.
 */
export function isManagedFolder(root: string, folder: string): boolean {
  const base = normalizeRoot(root);
  const path = normalizeRoot(folder);

  if (path === base) return true;

  // Not `startsWith(base)`: that would accept `Journal2/2026` for a `Journal`
  // journal. The separator has to be there, unless the root is the vault root
  // and there is no separator to require.
  if (base !== "" && !path.startsWith(`${base}/`)) return false;

  const rest = (base === "" ? path : path.slice(base.length + 1)).split("/");

  if (rest.length === 1) return /^\d{4}$/.test(rest[0]);
  if (rest.length === 2) return /^\d{4}$/.test(rest[0]) && /^\d{2}$/.test(rest[1]);
  return false;
}
