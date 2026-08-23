import type { TFile } from "obsidian";

export interface JournalEntry {
  file: TFile;
  created: Date;
  /**
   * Every tag on the entry, `#` stripped — inline and frontmatter alike, in
   * no particular order. Resolved by `entryTags.ts`; see its doc for why the
   * two kinds are not distinguished here. `[]` when the entry has none, or
   * has not been indexed yet.
   *
   * REPLACE-ONLY: never mutate this array in place. Every producer builds a
   * fresh array and assigns it wholesale (see `JournalService.applyUpsert`'s
   * `existing.tags = entry.tags`, which aliases a freshly-parsed array
   * straight into this long-lived index object). `readonly string[]` makes
   * that a compile error rather than a convention to remember: `.push`,
   * `.splice`, and every other mutating array method are rejected by `tsc`
   * on this field, while the wholesale replacement above — and every
   * consumer here, which only ever reads (`.some`, `flatMap`,
   * `normalizeAll`'s `readonly string[]` parameter, `toEqual` in tests) —
   * keeps working untouched. Same precedent as `refreshEntryTags`'s
   * `Pick<>` narrowing in `JournalView.ts`.
   */
  tags: readonly string[];
}
