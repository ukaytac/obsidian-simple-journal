import { App, TFile, TFolder } from "obsidian";
import type { JournalEntry } from "./entry";
import { resolveEntryDate } from "./entryDate";
import { replaceBody, splitFrontmatter } from "./markdownDoc";
import { sortEntries, sliceBefore } from "../services/entryIndex";
import { entryFolderPath, formatCreatedProperty, formatEntryFilename } from "../utils/dates";

const MAX_COLLISION_ATTEMPTS = 100;

/**
 * Owns every interaction with journal entry files. Knows about the vault.
 * Knows nothing about the UI.
 */
export class EntryRepository {
  constructor(
    private readonly app: App,
    private readonly getFolder: () => string,
  ) {}

  private get root(): string {
    const trimmed = this.getFolder().trim().replace(/^\/+|\/+$/g, "");
    return trimmed || "Journal";
  }

  isEntryFile(file: TFile): boolean {
    if (file.extension !== "md") return false;
    const prefix = `${this.root}/`.toLowerCase();
    return file.path.toLowerCase().startsWith(prefix);
  }

  /** Builds the entry record for a file, or null if the file is not an entry. */
  entryFor(file: TFile): JournalEntry | null {
    if (!this.isEntryFile(file)) return null;

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const created = resolveEntryDate({
      basename: file.basename,
      ctime: file.stat.ctime,
      created: frontmatter?.created,
    });

    return { file, created };
  }

  /** Every entry in the vault, newest first. */
  listEntries(): JournalEntry[] {
    const entries: JournalEntry[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const entry = this.entryFor(file);
      if (entry) entries.push(entry);
    }

    return sortEntries(entries);
  }

  /** Reverse-chronological query, as described in CLAUDE.md. */
  getEntries(options: { before?: Date; limit?: number } = {}): JournalEntry[] {
    return sliceBefore(this.listEntries(), options.before, options.limit);
  }

  /**
   * Creates an entry file for `at`. Never overwrites: a name taken by an entry
   * written in the same second gets a numeric suffix.
   */
  async createEntry(at: Date): Promise<TFile> {
    const folder = entryFolderPath(this.root, at);
    await this.ensureFolder(folder);

    const stem = formatEntryFilename(at);
    const contents = `---\ncreated: "${formatCreatedProperty(at)}"\n---\n\n`;

    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? stem : `${stem}-${attempt}`;
      const path = `${folder}/${name}.md`;

      if (this.app.vault.getAbstractFileByPath(path)) continue;

      try {
        return await this.app.vault.create(path, contents);
      } catch (error) {
        // Lost a race against another writer. Try the next suffix rather than
        // risking an overwrite.
        if (attempt === MAX_COLLISION_ATTEMPTS) throw error;
      }
    }

    throw new Error(`Journal Entries: could not find a free filename for ${stem}`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(`Journal Entries: ${current} exists but is not a folder`);
      }

      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        // Lost a race against another writer (Sync, Templater, ...) creating
        // the same folder. If it now exists, proceed rather than losing the
        // entry the user is about to write; otherwise the failure is real.
        if (!this.app.vault.getFolderByPath(current)) throw error;
      }
    }
  }

  /** The entry text, without its frontmatter block. */
  async readBody(file: TFile): Promise<string> {
    return splitFrontmatter(await this.app.vault.read(file)).body;
  }

  /** Replaces the entry text. Frontmatter is preserved exactly. */
  async writeBody(file: TFile, body: string): Promise<void> {
    await this.app.vault.process(file, (data) => replaceBody(data, body));
  }

  async deleteEntry(file: TFile): Promise<void> {
    await this.app.fileManager.trashFile(file);
  }
}
