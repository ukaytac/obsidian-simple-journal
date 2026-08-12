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

/** In-memory vault. Files are stored as path -> contents. */
export class FakeVault {
  files = new Map<string, TFile>();
  contents = new Map<string, string>();
  folders = new Set<string>();
  trashed: string[] = [];

  addFile(path: string, data: string, ctime = 0): TFile {
    const file = new TFile(path, ctime);
    this.files.set(path, file);
    this.contents.set(path, data);
    return file;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()];
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) return this.files.get(path) as TFile;
    if (this.folders.has(path)) {
      const folder = new TFolder();
      folder.path = path;
      return folder;
    }
    return null;
  }

  async createFolder(path: string): Promise<void> {
    if (this.folders.has(path)) throw new Error("Folder already exists.");
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
export class FakeMetadataCache {
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
