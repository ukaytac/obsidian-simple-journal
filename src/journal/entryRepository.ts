import { App, TFile, TFolder } from "obsidian";
import type { JournalEntry } from "./entry";
import { resolveEntryDate } from "./entryDate";
import { replaceBody, splitFrontmatter } from "./markdownDoc";
import { sortEntries, sliceBefore } from "../services/entryIndex";
import { entryFolderPath, formatCreatedProperty, formatEntryFilename } from "../utils/dates";

const MAX_COLLISION_ATTEMPTS = 100;

const ASCII_ONLY = /^[\x00-\x7F]*$/;

/**
 * NFC-normalizes `value`, skipping the call entirely for plain-ASCII input
 * (the overwhelming common case for vault paths), which cannot differ under
 * normalization. `isEntryFile` runs once per Markdown file in the vault, so
 * this keeps that path cheap without giving up correctness for the Unicode
 * paths it exists to handle.
 */
function normalizeNfc(value: string): string {
  return ASCII_ONLY.test(value) ? value : value.normalize("NFC");
}

/**
 * Owns every interaction with journal entry files. Knows about the vault.
 * Knows nothing about the UI.
 */
export class EntryRepository {
  /**
   * Memoized resolution of the configured root to its real on-disk casing.
   * `prefix` (the resolved root plus a trailing slash, NFC-normalized) is
   * cached alongside it so `isEntryFile` — called once per Markdown file in
   * the vault — never redoes string normalization work that is constant
   * across an entire `listEntries()` pass.
   */
  private folderCache: { configured: string; resolved: string; prefix: string } | null = null;

  /** Memoized normalization of the raw setting value, keyed on that raw string. */
  private rawRootCache: { raw: string; normalized: string } | null = null;

  constructor(
    private readonly app: App,
    private readonly getFolder: () => string,
  ) {}

  /** The configured journal root: trimmed, defaulted, NFC-normalized. */
  private get root(): string {
    const raw = this.getFolder();
    if (this.rawRootCache?.raw === raw) return this.rawRootCache.normalized;

    const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
    const normalized = normalizeNfc(trimmed || "Journal");
    this.rawRootCache = { raw, normalized };
    return normalized;
  }

  /**
   * Resolves the configured root to its real on-disk casing, so a setting
   * like "journal" matches (and creates alongside) an existing "Journal/"
   * folder rather than mismatching it or colliding with it on a
   * case-insensitive filesystem. Memoized because `isEntryFile` runs once per
   * Markdown file in the vault, and a folder walk per call would be a real
   * cost at scale. Invalidated when the cached path no longer resolves to a
   * folder — a cheap lookup — so a folder created (or removed) after the
   * first resolution is still picked up.
   */
  private resolveFolder(): { resolved: string; prefix: string } {
    const configured = this.root;

    if (
      this.folderCache?.configured === configured &&
      this.app.vault.getAbstractFileByPath(this.folderCache.resolved) instanceof TFolder
    ) {
      return this.folderCache;
    }

    const resolved = this.resolveCasing(configured);
    const prefix = normalizeNfc(`${resolved}/`);
    this.folderCache = { configured, resolved, prefix };
    return this.folderCache;
  }

  /**
   * Walks the configured root's segments from the vault root. At each level,
   * looks for a child folder whose name matches the configured segment
   * case-insensitively (both sides NFC-normalized) and, if found, continues
   * from its real name; otherwise the segment doesn't exist yet and is kept
   * as configured, since it will be created with that casing.
   */
  private resolveCasing(configured: string): string {
    const segments = configured.split("/");
    let children = this.app.vault.getRoot().children;
    const resolved: string[] = [];

    for (const segment of segments) {
      const target = normalizeNfc(segment).toLowerCase();
      const match = children.find(
        (child): child is TFolder =>
          child instanceof TFolder && normalizeNfc(child.name).toLowerCase() === target,
      );

      if (match) {
        resolved.push(match.name);
        children = match.children;
      } else {
        resolved.push(segment);
        children = [];
      }
    }

    return resolved.join("/");
  }

  isEntryFile(file: TFile): boolean {
    if (file.extension !== "md") return false;
    return normalizeNfc(file.path).startsWith(this.resolveFolder().prefix);
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
    const folder = entryFolderPath(this.resolveFolder().resolved, at);
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
        // `getFolderByPath` would be simpler but is 1.5.7+; `getAbstractFileByPath`
        // plus an `instanceof` check works back to our declared minAppVersion.
        if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
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
