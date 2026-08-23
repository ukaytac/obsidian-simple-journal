import type { TFile } from "obsidian";

export interface JournalEntry {
  file: TFile;
  created: Date;
  /**
   * Every tag on the entry, `#` stripped — inline and frontmatter alike, in
   * no particular order. Resolved by `entryTags.ts`; see its doc for why the
   * two kinds are not distinguished here. `[]` when the entry has none, or
   * has not been indexed yet.
   */
  tags: string[];
}
