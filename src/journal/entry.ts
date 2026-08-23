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
   * straight into this long-lived index object). That is safe only because
   * nothing anywhere calls `.push`/`.splice`/etc. on a `tags` array after the
   * fact — a convention this type cannot enforce, so it is written here
   * instead.
   */
  tags: string[];
}
