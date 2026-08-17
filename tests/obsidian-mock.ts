/**
 * Minimal stand-in for the `obsidian` module. Vitest aliases `obsidian` to this
 * file, so unit tests can import Obsidian types and exercise repository code
 * without a running Obsidian instance. Only what the tested code needs is here.
 */

export class TAbstractFile {
  // Typed `any` so mock instances remain structurally assignable to the real
  // `obsidian` package's TFile/TAbstractFile when tsc (unlike vitest) resolves
  // "obsidian" to the real .d.ts. Not exercised by any tested code.
  vault: any;
  parent: any;
  path = "";
  name = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "md";
  stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(path: string, ctime = 0) {
    super();
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.basename = this.name.replace(/\.md$/, "");
    this.extension = "md";
    this.stat = { ctime, mtime: ctime, size: 0 };
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export class Notice {
  constructor(public message: string) {}
}

export class Component {
  onload(): void {}
  onunload(): void {}
  load(): void {
    this.onload();
  }
  unload(): void {
    this.onunload();
  }
  registerEvent(): void {}
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  return fn;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Minimal stand-in for Obsidian's `Events` base class: synchronous `on`
 * (matching the real Vault/MetadataCache, which fire listeners inline, not
 * queued) plus a test-only `trigger` to fire a named event by hand. `on`
 * returns an opaque ref only so call sites that store it type-check; nothing
 * in this mock ever unregisters by ref (the mock's `Component.registerEvent`
 * is a no-op), matching every other simplification in this file.
 */
class FakeEvents {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(name: string, callback: (...args: any[]) => void): { name: string } {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
    return { name };
  }

  trigger(name: string, ...args: any[]): void {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  }
}

/**
 * In-memory vault. Files are stored as path -> contents. `folders` is the
 * single source of truth for folder existence — exact, path-keyed, so
 * `getAbstractFileByPath` stays an O(1) lookup like the real vault's path
 * index. `addFile` keeps it complete by registering every ancestor
 * directory, the same way a real vault never has a file without its parent
 * folders also existing.
 */
export class FakeVault extends FakeEvents {
  files = new Map<string, TFile>();
  contents = new Map<string, string>();
  folders = new Set<string>();
  trashed: string[] = [];

  // Real Obsidian hands back the same TFolder instance on every lookup for a
  // given path; reusing instances here (rather than allocating fresh ones per
  // call) keeps `getAbstractFileByPath` cheap enough to call once per file,
  // matching production cost instead of a mock-only allocation tax.
  private folderNodes = new Map<string, TFolder>();

  addFile(path: string, data: string, ctime = 0): TFile {
    const file = new TFile(path, ctime);
    this.files.set(path, file);
    this.contents.set(path, data);

    for (let current = parentPath(path); current; current = parentPath(current)) {
      this.folders.add(current);
    }

    return file;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()];
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) return this.files.get(path) as TFile;
    if (this.folders.has(path) || path === "") return this.folderNode(path);
    return null;
  }

  private folderNode(path: string): TFolder {
    let folder = this.folderNodes.get(path);
    if (!folder) {
      folder = new TFolder();
      folder.path = path;
      folder.name = path.split("/").pop() ?? path;
      this.folderNodes.set(path, folder);
    }
    return folder;
  }

  /** The vault's root folder, with a real (if shallow-computed) child tree. */
  getRoot(): TFolder {
    const root = this.folderNode("");
    root.children = this.childrenOf("");
    return root;
  }

  private childrenOf(parent: string): TAbstractFile[] {
    const children: TAbstractFile[] = [];

    for (const folderPath of this.folders) {
      if (parentPath(folderPath) !== parent) continue;
      const folder = this.folderNode(folderPath);
      folder.children = this.childrenOf(folderPath);
      children.push(folder);
    }

    for (const [filePath, file] of this.files) {
      if (parentPath(filePath) !== parent) continue;
      children.push(file);
    }

    return children;
  }

  /**
   * Mirrors a case-insensitive filesystem (e.g. macOS's default APFS): two
   * sibling folders differing only in case collide, matching the real
   * failure mode a mismatched-casing setting can trigger.
   */
  async createFolder(path: string): Promise<void> {
    const parent = parentPath(path);
    const name = path.slice(parent ? parent.length + 1 : 0).toLowerCase();

    for (const existing of this.folders) {
      if (parentPath(existing) !== parent) continue;
      const existingName = existing.slice(parent ? parent.length + 1 : 0).toLowerCase();
      if (existingName === name) throw new Error("Folder already exists.");
    }

    this.folders.add(path);
  }

  async create(path: string, data: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error("File already exists.");
    return this.addFile(path, data);
  }

  async read(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? "";
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.contents.get(file.path) ?? "");
    this.contents.set(file.path, next);
    return next;
  }
}

/** In-memory metadata cache. Frontmatter is supplied per path by the test. */
export class FakeMetadataCache extends FakeEvents {
  frontmatter = new Map<string, Record<string, unknown>>();

  getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
    const fm = this.frontmatter.get(file.path);
    return fm ? { frontmatter: fm } : null;
  }
}

export class FakeFileManager {
  trashed: TFile[] = [];

  async trashFile(file: TFile): Promise<void> {
    this.trashed.push(file);
  }
}

/** Assembles the three fakes into something shaped like `App`. */
export function createFakeApp(): {
  vault: FakeVault;
  metadataCache: FakeMetadataCache;
  fileManager: FakeFileManager;
} {
  return {
    vault: new FakeVault(),
    metadataCache: new FakeMetadataCache(),
    fileManager: new FakeFileManager(),
  };
}

export class App {}
export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class Menu {}
export class MarkdownRenderer {}
export class WorkspaceLeaf {}
