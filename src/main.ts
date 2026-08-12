import { Plugin } from "obsidian";

export default class JournalEntriesPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("Journal Entries: loaded");
  }
}
