import { App, TFile, TFolder } from "obsidian";
import type { JournalEntry } from "./entry";
import { resolveEntryDate } from "./entryDate";
import {
  hasCreatedLine,
  replaceBody,
  restoreSeparator,
  setCreatedProperty,
  splitFrontmatter,
  stripSeparator,
  UnsafeFrontmatterError,
} from "./markdownDoc";
import { sortEntries, sliceBefore } from "../services/entryIndex";
import {
  entryFolderPath,
  formatCreatedProperty,
  formatEntryFilename,
  parseEntryFilename,
} from "../utils/dates";

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
   * prefers a child folder whose name matches the configured segment
   * exactly (NFC-normalized); only when no exact match exists does a
   * case-insensitive match win. Without that preference, two siblings
   * differing only in case (possible on a case-sensitive filesystem, or after
   * a sync conflict) would resolve to whichever happened to be listed first —
   * an outcome that must never depend on iteration order. A segment matching
   * neither doesn't exist yet and is kept as configured, since it will be
   * created with that casing.
   */
  private resolveCasing(configured: string): string {
    const segments = configured.split("/");
    let children = this.app.vault.getRoot().children;
    const resolved: string[] = [];

    for (const segment of segments) {
      const exactTarget = normalizeNfc(segment);
      const looseTarget = exactTarget.toLowerCase();
      let looseMatch: TFolder | undefined;
      let exactMatch: TFolder | undefined;

      for (const child of children) {
        if (!(child instanceof TFolder)) continue;
        const name = normalizeNfc(child.name);

        if (name === exactTarget) {
          exactMatch = child;
          break;
        }
        if (!looseMatch && name.toLowerCase() === looseTarget) {
          looseMatch = child;
        }
      }

      const match = exactMatch ?? looseMatch;

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

  /**
   * The configured journal folder, resolved to its real on-disk casing (see
   * `resolveFolder`). Exposed so callers outside this class — currently only
   * `JournalService`, to recognize a rename of the journal folder itself, or
   * of one of its ancestors — can reason about the journal root without
   * duplicating this class's casing-resolution logic.
   */
  rootPath(): string {
    return this.resolveFolder().resolved;
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
   * Creates an entry file for `at`, optionally seeded with `body` (in the
   * same separator-free convention as `readBody`/`writeBody`). Passing the
   * body here rather than following up with a separate `writeBody` call
   * keeps a brand-new entry to one write and one `modify` event, which
   * matters for the composer's lazy-creation flow (the first meaningful
   * keystroke commits the file). Never overwrites: a name taken by an entry
   * written in the same second gets a numeric suffix.
   */
  async createEntry(at: Date, body = ""): Promise<TFile> {
    const folder = entryFolderPath(this.resolveFolder().resolved, at);
    await this.ensureFolder(folder);

    const stem = formatEntryFilename(at);
    const frontmatter = `---\ncreated: "${formatCreatedProperty(at)}"\n---\n`;
    const contents = frontmatter + restoreSeparator(frontmatter, body);

    return this.withFreeName(folder, stem, (path) => this.app.vault.create(path, contents));
  }

  /**
   * Tries path candidates `folder/stem.md`, `folder/stem-2.md`, ... up to
   * `MAX_COLLISION_ATTEMPTS`, calling `write(path)` for the first one not
   * already occupied. Shared by `createEntry` and `renameEntryToMatch` so
   * their collision-suffix strategies cannot drift apart.
   *
   * A path occupied by `selfFile` itself is treated as free, not taken:
   * relevant only to a rename, where a later-numbered candidate could
   * coincidentally already be the very file being renamed (its own,
   * possibly mismatched, current name) — that file is about to vacate
   * whatever path it currently holds, so it can never be a real collision
   * for `write` to lose a race against.
   *
   * If `write` itself throws (a lost race against another writer creating
   * or occupying the same path), the next suffix is tried rather than
   * risking an overwrite.
   */
  private async withFreeName(
    folder: string,
    stem: string,
    write: (path: string) => Promise<TFile>,
    selfFile: TFile | null = null,
  ): Promise<TFile> {
    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? stem : `${stem}-${attempt}`;
      const path = `${folder}/${name}.md`;

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && existing !== selfFile) continue;

      try {
        return await write(path);
      } catch (error) {
        // Lost a race against another writer. Try the next suffix rather than
        // risking an overwrite.
        if (attempt === MAX_COLLISION_ATTEMPTS) throw error;
      }
    }

    throw new Error(`Journal Entries: could not find a free filename for ${stem}`);
  }

  /**
   * Moves (and/or renames) `file` so its filename matches `at`, the entry's
   * corrected `created` timestamp — used by `JournalView.commitEntryTimeChange`
   * after `setEntryCreated` has already written the new `created` value, so
   * the filename convention (this plugin's filename IS the timestamp) stops
   * contradicting the entry's own frontmatter.
   *
   * Only touches a file whose current name already follows the plugin's
   * `YYYY-MM-DD-HH-mm-ss[-N].md` convention (`parseEntryFilename` returns
   * non-null). A file the user deliberately named something else and placed
   * in the journal folder keeps that name untouched — CLAUDE.md treats the
   * filename as an internal identifier precisely so nothing (including this)
   * ever re-derives it from content a user didn't choose it from.
   *
   * A no-op, returning `file` unchanged with no vault call at all, when the
   * computed target path already equals the file's current path (e.g. the
   * correction only changed a value that isn't part of the filename, like
   * seconds-level precision the user can't actually enter, or simply didn't
   * change the minute). Otherwise moves via `fileManager.renameFile` — which
   * both relocates the file and updates any links to it, unlike `vault.rename`
   * — reusing `createEntry`'s exact collision-suffix strategy through
   * `withFreeName` so a target already held by another entry created in the
   * same second gets the same deterministic `-2`, `-3`, ... suffix rather
   * than ever overwriting it.
   */
  async renameEntryToMatch(file: TFile, at: Date): Promise<TFile> {
    if (!parseEntryFilename(file.basename)) return file;

    const folder = entryFolderPath(this.resolveFolder().resolved, at);
    const stem = formatEntryFilename(at);
    const targetPath = `${folder}/${stem}.md`;

    if (targetPath === file.path) return file;

    await this.ensureFolder(folder);

    return this.withFreeName(
      folder,
      stem,
      async (path) => {
        await this.app.fileManager.renameFile(file, path);
        return file;
      },
      file,
    );
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

  /**
   * The entry text, without its frontmatter block and without the blank-line
   * separator that conventionally follows it. A conventional file —
   * `---\n...\n---\n\ntext` — has that blank line only to separate the
   * frontmatter from the text, not as part of the text itself, so this
   * strips exactly that one newline before handing the body to callers (the
   * editor, lazy-creation "is this empty?" checks, etc.). A file with no
   * frontmatter at all has no separator to strip: the whole document is the
   * body, untouched. See `stripSeparator` for the exact rule.
   *
   * A brand-new entry (`createEntry`'s `---\n...\n---\n\n` template) therefore
   * reads back as `""`, not `"\n"`.
   */
  async readBody(file: TFile): Promise<string> {
    const { frontmatter, body } = splitFrontmatter(await this.app.vault.read(file));
    return stripSeparator(frontmatter, body);
  }

  /**
   * Replaces the entry text. Frontmatter is preserved exactly, and the
   * blank-line separator `readBody` stripped is restored before the write —
   * in whichever newline flavour (`\n`/`\r\n`) the file's frontmatter already
   * uses, so a CRLF file is never converted. If the file being written to
   * currently lacks that blank line (in particular, one written by an
   * older build of this plugin before this fix, or a file the last save left
   * in that shape), this *adds* it: that's intended, not a bug — it restores
   * the Obsidian convention rather than perpetuating a deviation from it.
   */
  async writeBody(file: TFile, body: string): Promise<void> {
    await this.app.vault.process(file, (data) => {
      const { frontmatter } = splitFrontmatter(data);
      return replaceBody(data, restoreSeparator(frontmatter, body));
    });
  }

  /**
   * Corrects an entry's timestamp by rewriting its `created` property in
   * place, via `setCreatedProperty` — surgically, not through
   * `fileManager.processFrontMatter`, whose YAML re-serialization can
   * reformat, reorder, or requote a user's other properties (see CLAUDE.md's
   * "never rewrite or normalize unrelated frontmatter" and
   * `setCreatedProperty`'s own doc). The filename is deliberately left
   * alone: filenames are internal identifiers, never re-derived from
   * content or timestamp.
   *
   * Deliberately does NOT call `JournalService.markSelfWrite` for this
   * path, unlike `writeBody`. That mark exists to suppress a redundant
   * re-render of an editor that already reflects the value it just wrote —
   * but repositioning a moved entry in the timeline depends entirely on
   * `JournalService` seeing this write's `modify`/`changed` event and
   * noticing `created` changed (`JournalService.applyUpsert`'s "moved"
   * case). Marking this a self-write would swallow that event and leave the
   * entry sitting in its old position until the next full reload.
   *
   * Before writing, cross-checks the raw text's `created` line against
   * Obsidian's OWN YAML parse (`metadataCache.getFileCache`) — the same
   * cache `entryFor` already reads. `setCreatedProperty`'s own
   * `assertSafeCreatedLine` guard catches an ambiguous match only when a
   * SECOND, genuine `created` line also exists to raise the alarm; it
   * cannot catch a single match that is itself a false positive (found
   * inside another property's own multi-line value) when there is no real
   * `created` key anywhere else in the block. That shape looks, to a pure
   * regex, exactly like an ordinary one-line property. The metadata cache
   * has no such blind spot — it either parsed a `created` key or it didn't
   * — so disagreement between it and `hasCreatedLine` is precisely the
   * signal that our match isn't the real property. Refuses (writing
   * nothing) in two cases:
   *
   * - The raw text visibly has a frontmatter block, but the cache reports
   *   NO frontmatter at all for this file — its YAML parse failed
   *   entirely (e.g. an unbalanced quote elsewhere in the block), so there
   *   is nothing to cross-check against.
   * - `hasCreatedLine` matched a line, but the cache's parsed frontmatter
   *   has no `created` key. A missing `created` is an ordinary, SUPPORTED
   *   state on its own — `resolveEntryDate` falls back to the filename or
   *   `ctime` — so this is only unsafe here because our own match claims
   *   otherwise; that contradiction is exactly the disagreement being
   *   caught.
   */
  async setEntryCreated(file: TFile, at: Date): Promise<void> {
    await this.app.vault.process(file, (data) => {
      const { frontmatter } = splitFrontmatter(data);
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;

      // Only a block that *also* looks like it holds a `created` line is
      // dangerous when Obsidian reports nothing: that is the disagreement worth
      // refusing over. An empty `---\n---` block, or one whose cache entry has
      // simply not been populated yet, has nothing for an insert to orphan —
      // refusing those would be a permanent dead end on a safe document.
      if (frontmatter && hasCreatedLine(frontmatter) && !cached) {
        throw new UnsafeFrontmatterError(
          "This entry's frontmatter could not be parsed by Obsidian; refusing to guess at it.",
        );
      }
      if (hasCreatedLine(frontmatter) && !(cached && "created" in cached)) {
        throw new UnsafeFrontmatterError(
          "This entry's \"created\" line does not match Obsidian's own reading of its frontmatter.",
        );
      }

      return setCreatedProperty(data, formatCreatedProperty(at));
    });
  }
}
