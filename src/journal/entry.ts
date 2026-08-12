import type { TFile } from "obsidian";

export interface JournalEntry {
  file: TFile;
  created: Date;
}
