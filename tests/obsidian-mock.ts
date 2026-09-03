/**
 * Minimal stand-in for the `obsidian` module. Vitest aliases `obsidian` to this
 * file, so unit tests can import Obsidian types and exercise repository code
 * without a running Obsidian instance. Only what the tested code needs is here.
 *
 * `tsc` resolves `obsidian` to the real package's type definitions, while
 * vitest resolves it to this file — so a member added to a class here that
 * shadows a real Obsidian class, but that the real API does NOT have, will
 * type-check fine under vitest and then fail `tsc` the moment a test uses it
 * through a real-typed reference (exactly what happened with a `choose()`
 * helper once added to `SuggestModal` below). This mock must not invent
 * convenience surface on such classes; a test-only helper belongs in the
 * test harness or the test itself, never on a class standing in for a real
 * one.
 *
 * This file is not yet fully compliant with that rule. Four exceptions stand,
 * and each is safe today only because every access to its extra surface goes
 * through a mock-typed reference or an explicit cast — never through a
 * real-typed one, which is the only way the mismatch above could actually
 * bite:
 *
 * - `Menu`'s `items`/`shown`/`findItem` (below) — inspection surface the real
 *   `Menu` doesn't have. Safe because no test currently references `Menu` at
 *   all; the entire mock class is presently unused.
 * - `TFile`'s public constructor (below) — the real `TFile` declares none
 *   (Obsidian constructs it internally). Safe because every test constructs
 *   a `TFile` through this mock's own type, never through `obsidian`'s real
 *   type.
 * - `WorkspaceLeaf`'s `app` field (below) — not on the real class's public
 *   surface. Safe because it is only ever read through this mock's `ItemView`
 *   constructor, itself mock-typed.
 * - `Scope`'s `handlers` field (below) — inspection surface the real `Scope`
 *   keeps private. Unavoidable rather than convenient: real Obsidian owns the
 *   scope stack and decides which scope a keypress reaches, so there is no
 *   jsdom event a test could dispatch to reach a handler registered on
 *   `View.scope`, and no public way to ask a `Scope` what it holds. Safe
 *   because the only reader is `journalViewHarness.ts`'s `pressEscape`, which
 *   reaches it through `internals(view)` — `any`-typed — never through a
 *   real-typed `Scope`.
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
    // Derived from the path, not hardcoded to "md". `listEntries` walks the
    // journal folder's whole subtree now rather than asking the vault for
    // Markdown files only, so an attachment sitting next to the entries is a
    // case the tests have to be able to express.
    const dot = this.name.lastIndexOf(".");
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.stat = { ctime, mtime: ctime, size: 0 };
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export class Notice {
  constructor(public message: string) {}
}

/** An `EventRef`-shaped handle a mock `Events` emitter hands back from `on()`. */
export interface FakeEventRef {
  unregister: () => void;
}

export class Component {
  private registeredEvents: FakeEventRef[] = [];
  /** Callbacks registered via `register()`, run (in order) on `unload()`. */
  private unloadCallbacks: Array<() => void> = [];

  onload(): void {}
  onunload(): void {}
  load(): void {
    this.onload();
  }
  /**
   * Unloads AND actually unregisters every event handed to `registerEvent`,
   * mirroring real Obsidian: a `Component` that never receives another
   * event after `unload()` is exactly the guarantee `JournalService` (and
   * every other `registerEvent` caller) depends on. A no-op here would let
   * a test pass purely because `JournalService.onunload` also clears its
   * own `listeners` set, without ever proving the vault/metadata-cache
   * listeners themselves stopped firing.
   */
  unload(): void {
    this.onunload();
    for (const ref of this.registeredEvents) ref.unregister();
    this.registeredEvents = [];
    for (const cb of this.unloadCallbacks) cb();
    this.unloadCallbacks = [];
  }
  registerEvent(ref: FakeEventRef): void {
    this.registeredEvents.push(ref);
  }
  /** Registers a plain callback to run once, on `unload()`. */
  register(cb: () => void): void {
    this.unloadCallbacks.push(cb);
  }
  addChild<T extends Component>(component: T): T {
    component.load();
    return component;
  }
  removeChild<T extends Component>(component: T): T {
    component.unload();
    return component;
  }
}

export interface Debouncer<T extends unknown[], V> {
  (...args: T): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | void;
}

/**
 * Faithful to Obsidian's own `debounce`, which matters here: this used to
 * return `fn` unchanged, so a debounced call fired immediately and the
 * returned value had no `run()`. Anything relying on the delay — the settings
 * tab's guarantee that a half-typed folder name never reaches
 * `plugin.settings` — was therefore untestable, and a `hide()` flush would
 * have thrown.
 *
 * Uses the ambient timer functions, so `vi.useFakeTimers()` drives it.
 */
export function debounce<T extends unknown[], V>(
  fn: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;

  const fire = (): V | void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
    if (pending === null) return;
    const args = pending;
    pending = null;
    return fn(...args);
  };

  const debounced = ((...args: T) => {
    pending = args;
    // `resetTimer` false keeps the deadline set by the first call in a burst;
    // true restarts it on every call.
    if (handle !== null && !resetTimer) return debounced;
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(fire, timeout);
    return debounced;
  }) as Debouncer<T, V>;

  debounced.cancel = () => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
    pending = null;
    return debounced;
  };

  debounced.run = fire;

  return debounced;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Minimal stand-in for Obsidian's `Events` base class: synchronous `on`
 * (matching the real Vault/MetadataCache, which fire listeners inline, not
 * queued) plus a test-only `trigger` to fire a named event by hand. The
 * returned ref's `unregister` actually removes the listener — matching real
 * Obsidian's `Component.registerEvent`/`unload` contract closely enough to
 * let a test prove a `Component` genuinely stops receiving events after
 * `unload()`, not merely that its own bookkeeping was cleared.
 */
class FakeEvents {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(name: string, callback: (...args: any[]) => void): FakeEventRef {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);

    return {
      unregister: () => {
        const current = this.listeners.get(name);
        if (!current) return;
        const index = current.indexOf(callback);
        if (index >= 0) current.splice(index, 1);
      },
    };
  }

  trigger(name: string, ...args: any[]): void {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  }

  offref(ref: FakeEventRef): void {
    ref.unregister();
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

  /**
   * Real Obsidian returns null for a path that is missing or is a file, which
   * is what `listEntries` relies on to mean "no journal folder yet".
   */
  getFolderByPath(path: string): TFolder | null {
    if (path === "") return this.getRoot();
    if (!this.folders.has(path)) return null;
    const folder = this.folderNode(path);
    folder.children = this.childrenOf(path);
    return folder;
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

  /**
   * Real `Vault.cachedRead` — not invented surface, so the header policy is
   * satisfied. Delegates to the same content map as `read`: this mock has no
   * staleness to model, and modelling one would only let a test assert
   * behaviour of a cache Obsidian owns rather than of this plugin. What a
   * test using this CAN prove is that a display-only caller went through the
   * cached path at all (by spying on it), not that a stale value is handled.
   * Reads the map directly rather than delegating to `read`, so a test can
   * spy on the two independently.
   */
  async cachedRead(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? "";
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.contents.get(file.path) ?? "");
    this.contents.set(file.path, next);
    return next;
  }
}

/**
 * Only the static walker is needed from `Vault`; the instance surface the code
 * uses is `FakeVault`, handed over as `app.vault`. Obsidian's own
 * implementation visits the root as well as its descendants, so this does too
 * — callers must filter by type rather than assume only files arrive.
 */
export class Vault {
  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
    cb(root);
    for (const child of root.children ?? []) {
      if (child instanceof TFolder) Vault.recurseChildren(child, cb);
      else cb(child);
    }
  }
}

/**
 * Shape `getFileCache` returns and `getAllTags` accepts. Named once so the
 * two cannot drift apart if the shape later grows a member such as
 * `position`.
 */
export interface FakeFileCache {
  frontmatter?: Record<string, unknown>;
  tags?: Array<{ tag: string }>;
}

/**
 * In-memory metadata cache. Frontmatter is supplied per path by the test;
 * inline `#tag` occurrences are supplied separately via `inlineTags` (bare
 * tag text, no `#`), because a real cache reports the two through different
 * fields and `resolveTags` must be provable against both.
 */
export class FakeMetadataCache extends FakeEvents {
  frontmatter = new Map<string, Record<string, unknown>>();
  /** Inline tags per path, WITHOUT the leading `#`. */
  inlineTags = new Map<string, string[]>();
  /**
   * Source path → destination path → link count, exactly as Obsidian's own
   * `resolvedLinks`. Obsidian folds body links, embeds, aliased links and
   * frontmatter links into this one map before a plugin ever sees them, so a
   * test seeds it directly rather than trying to model the four kinds.
   */
  resolvedLinks: Record<string, Record<string, number>> = {};

  /**
   * NOT MODELLED — always null, deliberately, and that is not "no match
   * found". No test resolves a linkpath: `findMentions` needs only
   * `resolvedLinks`, and the one caller that does resolve one
   * (`mentionsCodeBlock`'s `note:` directive) has its parser tested directly
   * instead, because resolution itself is Obsidian's job, not this plugin's.
   *
   * This exists only so modules calling it type-check against the mock. A
   * later test that genuinely needs resolution must make this map
   * linkpath → TFile the way `resolvedLinks` above is seeded — silently
   * accepting "nothing ever resolves" would make such a test prove nothing.
   */
  getFirstLinkpathDest(_linkpath: string, _sourcePath: string): TFile | null {
    return null;
  }

  getFileCache(file: TFile): FakeFileCache | null {
    const fm = this.frontmatter.get(file.path);
    const inline = this.inlineTags.get(file.path);
    // Null for a file the test said nothing about, matching a real cache that
    // has not indexed (or found anything in) the file — `entryFor` relies on
    // that to fall back to the filename convention.
    if (!fm && !inline) return null;

    const cache: FakeFileCache = {};
    if (fm) cache.frontmatter = fm;
    // Real Obsidian reports inline tags WITH the `#`, and with a `position`
    // nothing under test reads — only `.tag` is modeled.
    if (inline) cache.tags = inline.map((tag) => ({ tag: `#${tag}` }));
    return cache;
  }
}

/**
 * Stand-in for Obsidian's `parseFrontMatterTags`. Returns tags WITH a leading
 * `#`, like the real function, and accepts both of the shapes a user's
 * frontmatter can legitimately hold — a YAML list, or one comma/space
 * separated string — under either the plural `tags` key or the singular
 * `tag` key.
 */
export function parseFrontMatterTags(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!frontmatter) return null;

  const raw = frontmatter.tags ?? frontmatter.tag;
  if (raw === undefined || raw === null) return null;

  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const tags = list
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.startsWith("#") ? value : `#${value}`));

  return tags.length > 0 ? tags : null;
}

/**
 * Stand-in for Obsidian's `getAllTags`: inline tags and frontmatter tags
 * merged into one array, each with its `#`. Deliberately does NOT dedupe —
 * `resolveTags` dedupes for itself, and leaving duplicates in makes a test
 * that relies on that dedupe prove something real.
 */
export function getAllTags(cache: FakeFileCache | null): string[] | null {
  if (!cache) return null;

  const tags = [
    ...(cache.tags ?? []).map((entry) => entry.tag),
    ...(parseFrontMatterTags(cache.frontmatter) ?? []),
  ];

  return tags.length > 0 ? tags : null;
}

export class FakeFileManager {
  trashed: TAbstractFile[] = [];

  constructor(private readonly vault: FakeVault) {}

  /**
   * Takes a `TAbstractFile` like the real method, so a FOLDER can be trashed
   * too — what `reorganizeEntries` does with the year/month folders it
   * empties. A trashed folder stops existing as far as `getFolderByPath` is
   * concerned; a trashed file is only recorded, matching what the rest of
   * this mock's callers assert on.
   */
  async trashFile(file: TAbstractFile): Promise<void> {
    this.trashed.push(file);
    if (file instanceof TFolder) this.vault.folders.delete(file.path);
  }

  /**
   * Real Obsidian mutates the SAME `TFile` object in place on rename (never
   * hands back a new one) and fires the vault's own "rename" event with
   * `(file, oldPath)` — `EntryRepository.renameEntryToMatch` and
   * `JournalService`'s rename handling both depend on that identity, so this
   * models it rather than just moving map entries around. Throws if the
   * destination is already occupied, mirroring the real method's "safely"
   * contract (it never silently overwrites) — `renameEntryToMatch`'s own
   * collision loop is what's expected to avoid ever calling this with a
   * taken path in the first place.
   */
  async renameFile(file: TFile, newPath: string): Promise<void> {
    if (this.vault.files.has(newPath)) throw new Error("Destination already exists.");

    const oldPath = file.path;
    const data = this.vault.contents.get(oldPath) ?? "";

    this.vault.files.delete(oldPath);
    this.vault.contents.delete(oldPath);

    file.path = newPath;
    file.name = newPath.split("/").pop() ?? newPath;
    file.basename = file.name.replace(/\.md$/, "");

    this.vault.files.set(newPath, file);
    this.vault.contents.set(newPath, data);

    for (let current = parentPath(newPath); current; current = parentPath(current)) {
      this.vault.folders.add(current);
    }

    this.vault.trigger("rename", file, oldPath);
  }
}

/** Assembles the four fakes into something shaped like `App`. */
export function createFakeApp(): {
  vault: FakeVault;
  metadataCache: FakeMetadataCache;
  fileManager: FakeFileManager;
  workspace: FakeWorkspace;
  scope: Scope;
} {
  const vault = new FakeVault();
  const workspace = new FakeWorkspace();
  const app = {
    vault,
    metadataCache: new FakeMetadataCache(),
    fileManager: new FakeFileManager(vault),
    workspace,
    // The app-wide keymap scope. Present because `JournalView`'s constructor
    // passes it as the parent of the view's own scope, exactly as `View.scope`'s
    // own documented example does.
    scope: new Scope(),
  };
  // Handed back so leaves this workspace mints (`getRightLeaf`, `addLeaf`)
  // carry an app, the way a real leaf does — `ItemView`'s constructor below
  // reads it off the leaf, so a view built on a leaf without one would see
  // `app === undefined`.
  workspace.app = app;
  return app;
}

export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}

/**
 * Minimal stand-in for Obsidian's `Modal`. Not exercised directly by any
 * test in `tests/JournalView.*.test.ts` (nothing there opens
 * `ChangeEntryTimeModal`) — this only needs to exist so `class ... extends
 * Modal` resolves to a real constructor when `JournalView.ts`'s import
 * graph pulls `ChangeEntryTimeModal` in.
 */
export class Modal {
  contentEl: HTMLElement;
  titleEl: HTMLElement;

  constructor(public app?: unknown) {
    this.contentEl = document.createElement("div");
    this.titleEl = document.createElement("div");
  }
  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

/**
 * Minimal stand-in for Obsidian's `SuggestModal`. Real Obsidian renders a
 * floating prompt with a filtered list; jsdom has no layout for that, so this
 * exposes only the three abstract members a subclass implements. A test
 * drives a choice by calling the real, public `onChooseSuggestion(item, evt)`
 * directly — see the constraint note atop this file for why nothing
 * convenience-only is added here.
 */
export abstract class SuggestModal<T> extends Modal {
  limit = 50;
  emptyStateText = "";
  inputEl: HTMLInputElement;

  constructor(app?: unknown) {
    super(app);
    this.inputEl = document.createElement("input");
  }

  setPlaceholder(text: string): void {
    this.inputEl.placeholder = text;
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

/**
 * The subset of Obsidian's `ViewState` this mock records. `group` is omitted
 * deliberately — nothing under test sets it, and modelling leaf grouping
 * would mean modelling the split tree this workspace does not have.
 */
export interface FakeViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
}

/**
 * Which workspace currently holds a given leaf, so `detach()` can remove
 * itself from it. A module-level `WeakMap` rather than a field on the leaf:
 * the real `WorkspaceLeaf` exposes no `workspace` member, and this class
 * shadows it, so a field would be exactly the invented surface this file's
 * header forbids.
 */
const leafWorkspaces = new WeakMap<WorkspaceLeaf, FakeWorkspace>();

/** Which `PaneType` a leaf was minted for, when it came from `getLeaf`. */
const leafPaneKinds = new WeakMap<WorkspaceLeaf, "tab" | "split" | "window" | boolean | undefined>();

/**
 * Minimal stand-in for Obsidian's `WorkspaceLeaf`. Real Obsidian hands a leaf
 * to a registered view's constructor and the view reads `app`/other state
 * off it during construction (see `ItemView` below) — `app` is exposed here
 * for exactly that. Everything else below is on the real class: `view`,
 * `getViewState`, `setViewState`, `detach`.
 *
 * `setViewState` records the state and does NOT construct a view for it —
 * this mock has no view registry to look one up in, and inventing the
 * scheduling by which real Obsidian builds, opens and (since 1.7.2) defers a
 * view would be guesswork of exactly the kind `JournalView.composer.test.ts`
 * declines to build on. A test that needs a leaf carrying a view assigns
 * `leaf.view` itself, or asks `FakeWorkspace.addLeaf` for one.
 */
export class WorkspaceLeaf {
  view: unknown = null;
  private viewState: FakeViewState = { type: "empty" };

  constructor(public app?: unknown) {}

  getViewState(): FakeViewState {
    // A copy: the real method hands back a fresh object, so a caller mutating
    // it must not be able to reach back into this leaf.
    return { ...this.viewState };
  }

  async setViewState(viewState: FakeViewState, _eState?: unknown): Promise<void> {
    this.viewState = { ...viewState };
  }

  /**
   * Records the open on the workspace holding this leaf rather than on the
   * leaf itself: this class shadows the real `WorkspaceLeaf` export, so
   * test-only state added here is exactly what the header's policy warns can
   * leak into production types. `FakeWorkspace` is free to carry it.
   *
   * Async with a discarded second parameter, like the real method, so a
   * caller type-checked against the real `.d.ts` behaves the same way here.
   */
  async openFile(file: TFile, _state?: unknown): Promise<void> {
    leafWorkspaces.get(this)?.recordOpen(this, file);
  }

  /**
   * Removes the leaf from whichever `FakeWorkspace` holds it, so
   * `getLeavesOfType` stops returning it — the observable half of the real
   * method that anything under test can act on. The real one also destroys
   * the leaf's view; nothing here does, because no view this mock builds owns
   * resources outside the DOM its own `onClose` empties.
   */
  detach(): void {
    leafWorkspaces.get(this)?.removeLeaf(this);
  }
}

/**
 * In-memory workspace, handed over as `app.workspace`.
 *
 * Named `FakeWorkspace`, not `Workspace`, on purpose: it therefore shadows no
 * real Obsidian export, so the test-only state it carries (`activeFile`,
 * `leaves`, `app`, `addLeaf`) cannot leak into production types the way the
 * header's policy warns about. Every member a `src/` module actually calls is
 * real `Workspace` API, with the real signatures — `revealLeaf` async,
 * `getRightLeaf` nullable — so a caller type-checked against the real `.d.ts`
 * behaves the same way here.
 *
 * Extends `FakeEvents` for `on`/`offref`, plus the test-driven `trigger`
 * used to fire `file-open`.
 */
export class FakeWorkspace extends FakeEvents {
  /** Set by `createFakeApp`, so minted leaves carry an app. */
  app: unknown = undefined;
  /** What `getActiveFile()` reports. A test assigns this directly. */
  activeFile: TFile | null = null;
  /** Every leaf currently in this workspace, in the order it was added. */
  leaves: WorkspaceLeaf[] = [];

  getActiveFile(): TFile | null {
    return this.activeFile;
  }

  /**
   * Matches on the leaf's recorded view state, not on `leaf.view`, so a leaf
   * whose view this mock cannot build is still findable. Only leaves this
   * workspace knows about are searched — a bare `new WorkspaceLeaf(app)` (the
   * `journalViewHarness.ts` convention, where a view is constructed directly
   * and no workspace is involved) is not one of them; use `addLeaf`.
   */
  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    return this.leaves.filter((leaf) => leaf.getViewState().type === viewType);
  }

  /**
   * Mints a leaf, the way the real method does for every `PaneType` this mock
   * has a notion of. The pane kind is recorded rather than modelled: this
   * workspace has no split tree, so "tab" and "split" would be the same leaf
   * either way, and a test that asserts WHICH kind was asked for reads
   * `opened` below.
   */
  getLeaf(newLeaf?: "tab" | "split" | "window" | boolean): WorkspaceLeaf {
    const leaf = this.addLeaf("empty");
    leafPaneKinds.set(leaf, newLeaf);
    return leaf;
  }

  /**
   * Test-only: every `WorkspaceLeaf.openFile` this workspace's leaves have
   * served, in order, with the pane kind the leaf was minted for. `getLeaf`
   * is how production code asks for a new tab, and `openFile` is what it
   * then puts in it — a test asserting "opened in a new tab" needs both
   * halves, so they are recorded together.
   */
  opened: { file: TFile; pane: "tab" | "split" | "window" | boolean | undefined }[] = [];

  /** Called by `WorkspaceLeaf.openFile()`; not part of the real API. */
  recordOpen(leaf: WorkspaceLeaf, file: TFile): void {
    this.opened.push({ file, pane: leafPaneKinds.get(leaf) });
  }

  /**
   * Real Obsidian returns null when there is no right sidebar to put a leaf
   * in (and `main.ts`'s callers all handle that), so the return type says so
   * even though this mock always has room.
   */
  getRightLeaf(_split: boolean): WorkspaceLeaf | null {
    return this.addLeaf("empty");
  }

  /** Async on the real class; nothing to reveal here, but the shape matters. */
  async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {}

  /**
   * Runs immediately. Real Obsidian defers until the layout is ready and runs
   * it straight away afterwards; this mock is always "afterwards", and a test
   * that needs to observe the deferral would have to model a layout this has
   * no notion of.
   */
  onLayoutReady(callback: () => unknown): void {
    callback();
  }

  /**
   * Test-only: registers a leaf of `type`, optionally already holding `view`.
   * The real workspace mints leaves through `setViewState`, which builds the
   * view from the plugin's own registry — see `WorkspaceLeaf.setViewState`
   * for why this mock does not attempt that, and hands the view over instead.
   */
  addLeaf(type: string, view?: unknown): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app);
    void leaf.setViewState({ type });
    leaf.view = view ?? null;
    this.leaves.push(leaf);
    leafWorkspaces.set(leaf, this);
    return leaf;
  }

  /** Called by `WorkspaceLeaf.detach()`; not part of the real API. */
  removeLeaf(leaf: WorkspaceLeaf): void {
    const index = this.leaves.indexOf(leaf);
    if (index >= 0) this.leaves.splice(index, 1);
    leafWorkspaces.delete(leaf);
  }
}

/** What this mock's `Scope.register` stores and hands back. */
export interface FakeKeymapHandler {
  modifiers: string[] | null;
  key: string | null;
  func: (evt: KeyboardEvent, ctx: { modifiers: string | null; key: string | null; vkey: string }) => unknown;
}

/**
 * Minimal stand-in for Obsidian's `Scope` — the view-level keymap
 * `JournalView`'s constructor registers Escape on (`View.scope`, `@since
 * 1.5.7`).
 *
 * Nothing here dispatches, because nothing here could: real Obsidian owns the
 * scope stack and decides which scope sees a given keypress, and that is
 * exactly the part a fake cannot honestly reproduce. Tests therefore invoke a
 * registered handler directly (`journalViewHarness.ts`'s `pressEscape`), which
 * pins what the handler decides and deliberately claims nothing about when
 * Obsidian calls it — see `docs/manual-testing.md` for the one ordering
 * question left open to a person (whether vim's keymap consumes Escape
 * first).
 */
export class Scope {
  /** Inspection surface the real `Scope` lacks — see this file's header. */
  handlers: FakeKeymapHandler[] = [];

  constructor(public parent?: Scope) {}

  register(
    modifiers: string[] | null,
    key: string | null,
    func: FakeKeymapHandler["func"],
  ): FakeKeymapHandler {
    const handler: FakeKeymapHandler = { modifiers, key, func };
    this.handlers.push(handler);
    return handler;
  }

  unregister(handler: FakeKeymapHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index >= 0) this.handlers.splice(index, 1);
  }
}

/**
 * Faithful-enough stand-in for `ItemView`/`View`: real fields (`app`, `leaf`,
 * `containerEl`, `contentEl`) plus `addAction`, so a concrete subclass
 * (`JournalView`) can be constructed and driven under jsdom. Real Obsidian's
 * `containerEl` holds a `view-header` and a `view-content` (whose child is
 * `contentEl`); only `contentEl` itself is modeled here since nothing under
 * test reads the header.
 *
 * Extends `Component` so `this.register(...)`/`this.registerEvent(...)`
 * (used by `JournalView.onOpen`) work exactly as they do for every other
 * `Component` in these tests.
 */
export class ItemView extends Component {
  app: unknown;
  /** `@since 1.5.7`. Real Obsidian defaults this to null; a view assigns it. */
  scope: Scope | null = null;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
    // Real Obsidian's containerEl is always attached to the live document;
    // JournalView never checks `isConnected` today, but attaching here keeps
    // this mock honest for any future test that does.
    document.body.appendChild(this.containerEl);
  }

  /** @since 1.1.0 */
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("div");
    el.className = "view-action";
    el.dataset.icon = icon;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", callback as (evt: MouseEvent) => void);
    this.containerEl.appendChild(el);
    return el;
  }

  /** `@since 0.9.7`. A no-op here; tests call it directly when they need it. */
  onResize(): void {}
}

/** Builder handed to a `Menu.addItem` callback. */
export class FakeMenuItem {
  title = "";
  icon: string | undefined;
  disabled = false;
  private clickHandler: (() => void) | null = null;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onClick(callback: () => void): this {
    this.clickHandler = callback;
    return this;
  }
  /** Test-only: fires whatever `onClick` registered, if anything. */
  click(): void {
    this.clickHandler?.();
  }
}

/**
 * Minimal stand-in for Obsidian's `Menu`. Records every item added via
 * `addItem` (rather than actually rendering a floating menu, which jsdom has
 * no layout for) so a test can find and click one directly through
 * `findItem`/`FakeMenuItem.click()` — e.g. to exercise "Delete entry" without
 * a real mouse event ever reaching real screen coordinates.
 */
export class Menu {
  items: FakeMenuItem[] = [];
  shown = false;

  addItem(builder: (item: FakeMenuItem) => void): this {
    const item = new FakeMenuItem();
    builder(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_event: MouseEvent): this {
    this.shown = true;
    return this;
  }
  showAtPosition(_position: { x: number; y: number }): this {
    this.shown = true;
    return this;
  }
  /** Test-only convenience: the first item whose title matches exactly. */
  findItem(title: string): FakeMenuItem | undefined {
    return this.items.find((item) => item.title === title);
  }
}

/**
 * Stand-in for Obsidian's `ButtonComponent`. Real Obsidian's constructor
 * creates a `<button>` and appends it to `containerEl`; the fluent setters
 * below cover exactly what `JournalView.createEntryEl` calls.
 */
export class ButtonComponent {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement("button");
    containerEl.appendChild(this.buttonEl);
  }
  setIcon(icon: string): this {
    this.buttonEl.dataset.icon = icon;
    return this;
  }
  setTooltip(text: string): this {
    setTooltip(this.buttonEl, text);
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }
  onClick(callback: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", callback as (evt: MouseEvent) => void);
    return this;
  }
}

/**
 * Sets the accessible tooltip Obsidian's real `setTooltip` installs. Real
 * Obsidian shows this on hover via its own floating-UI popover, which jsdom
 * cannot render; `aria-label` is what every test actually needs to assert
 * against (e.g. `createEntryEl`'s time button), so that's what this sets.
 */
export function setTooltip(
  el: HTMLElement,
  text: string,
  _options?: { placement?: string; delay?: number },
): void {
  el.setAttribute("aria-label", text);
}

/**
 * Stand-in for Obsidian's real `setIcon`, which injects an `<svg>` from its
 * own icon registry — something no jsdom test has or needs. Recording the id
 * on `dataset` matches what `ButtonComponent.setIcon` above already does, so a
 * test that cares which icon was asked for reads it the same way either way.
 */
export function setIcon(el: HTMLElement, iconId: string): void {
  el.dataset.icon = iconId;
}

/**
 * Stand-in for Obsidian's `MarkdownRenderer.render`. Real rendering produces
 * fully-formatted HTML (lists, embeds, callouts, ...); this mock cannot and
 * does not attempt that — it only proves `renderStatic` reached this call
 * with the right text and that `el` ends up populated, which is all the
 * render-order/paging/reconciliation tests in `tests/JournalView.*.test.ts`
 * need. Markdown *fidelity* is explicitly NOT something this lets a test
 * assert.
 */
export class MarkdownRenderer {
  static async render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    el.textContent = markdown;
  }
}

/**
 * Stand-in for the class `mentionsCodeBlock.ts` subclasses to hand its panel's
 * lifecycle to Obsidian. Shape matches the real one exactly (a single
 * `containerEl` constructor parameter, `Component` as the base), so nothing
 * here is invented surface — see this file's header policy.
 */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

/** Mirrors the real module's exported alias for `MarkdownView.getMode()`. */
export type MarkdownViewModeType = "source" | "preview";

/**
 * Stand-in for the class `mentionsFooter.ts` narrows leaf views with, and
 * which `tests/mentionsFooter.test.ts` constructs to stand in for a note's
 * pane.
 *
 * SHORTCUT, documented so the next reader need not verify it: the real
 * `MarkdownView` reaches `ItemView` through `FileView` → `EditableFileView` →
 * `TextFileView`, and inherits `file: TFile | null` from `FileView`. Skipping
 * those three is safe because nothing under test touches anything they add.
 */
export class MarkdownView extends ItemView {
  file: TFile | null = null;

  /**
   * Real, documented Obsidian API, so no header exception applies — but it is
   * deliberately a fixed return rather than a settable `mode` field. A field
   * the real class does not have is exactly the mismatch this file's header
   * forbids; a test that needs the other mode subclasses this instead.
   */
  getMode(): MarkdownViewModeType {
    return "preview";
  }
}

/** `Platform.isMobile` is read once, at `JournalView`'s module load, so
 * flipping this after import has no effect on that module's own top-level
 * constants (`MAX_MOUNTED_EDITORS`, `MOUNT_ROOT_MARGIN`) — only on any code
 * that reads `Platform.isMobile` itself, live, elsewhere. */
export const Platform = { isMobile: false };

type DomElementInfo = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  prepend?: boolean;
};

function applyDomElementInfo(el: HTMLElement, info?: DomElementInfo | string): void {
  if (!info) return;
  if (typeof info === "string") {
    for (const cls of info.split(" ").filter(Boolean)) el.classList.add(cls);
    return;
  }
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(" ").filter(Boolean);
    for (const cls of classes) el.classList.add(cls);
  }
  if (info.text !== undefined) el.textContent = info.text;
  if (info.title !== undefined) el.setAttribute("title", info.title);
  if (info.attr) {
    for (const [key, value] of Object.entries(info.attr)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "boolean") {
        if (value) el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  if (info.parent instanceof HTMLElement) {
    if (info.prepend) info.parent.prepend(el);
    else info.parent.appendChild(el);
  }
}

/**
 * Installs the subset of Obsidian's runtime DOM patches (`obsidian.d.ts`'s
 * global `Node`/`Element`/`HTMLElement` augmentations, plus the bare global
 * `createDiv`/`createSpan`/`createEl` functions) that `JournalView` actually
 * calls, onto a jsdom window. Plain jsdom has none of these — Obsidian
 * installs them at runtime onto the real browser's prototypes.
 *
 * Deliberately narrower than a full re-implementation of every method
 * `obsidian.d.ts` declares (`show`/`hide`/`matchParent`/`getCssPropertyValue`/
 * ...) — only what `JournalView.ts` itself uses. Safe to call more than once
 * per test file (each assignment is idempotent) and safe to call from a
 * module that is also loaded under a plain Node environment, since nothing
 * here runs until this function is actually invoked (never at module
 * evaluation time).
 */
export function installDomHelpers(win: Window & typeof globalThis): void {
  const nodeProto = win.Node.prototype as unknown as Record<string, unknown>;
  const elementProto = win.Element.prototype as unknown as Record<string, unknown>;

  Object.defineProperty(win.Node.prototype, "doc", {
    configurable: true,
    get(this: Node): Document {
      return this.ownerDocument ?? win.document;
    },
  });
  Object.defineProperty(win.Node.prototype, "win", {
    configurable: true,
    get(this: Node): Window {
      return (this.ownerDocument?.defaultView as Window | null) ?? win;
    },
  });

  function createElImpl(
    this: HTMLElement,
    tag: string,
    info?: DomElementInfo | string,
  ): HTMLElement {
    const child = this.ownerDocument.createElement(tag);
    applyDomElementInfo(child, info);
    this.appendChild(child);
    return child;
  }
  nodeProto.createEl = createElImpl;
  nodeProto.createDiv = function (this: HTMLElement, info?: DomElementInfo | string): HTMLElement {
    return createElImpl.call(this, "div", info);
  };
  nodeProto.createSpan = function (this: HTMLElement, info?: DomElementInfo | string): HTMLElement {
    return createElImpl.call(this, "span", info);
  };

  elementProto.empty = function (this: Element): void {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  elementProto.addClass = function (this: Element, ...classes: string[]): void {
    this.classList.add(...classes);
  };
  elementProto.removeClass = function (this: Element, ...classes: string[]): void {
    this.classList.remove(...classes);
  };
  elementProto.hasClass = function (this: Element, cls: string): boolean {
    return this.classList.contains(cls);
  };
  elementProto.toggleClass = function (this: Element, classes: string | string[], value: boolean): void {
    for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, value);
  };
  elementProto.setText = function (this: Element, value: string): void {
    this.textContent = value;
  };
  // jsdom has no layout engine, so it implements neither of these — both are
  // no-ops here, same as they effectively are in a headless CI browser with
  // nothing to actually scroll.
  if (typeof elementProto.scrollTo !== "function") {
    elementProto.scrollTo = function (): void {};
  }
  if (typeof elementProto.scrollIntoView !== "function") {
    elementProto.scrollIntoView = function (): void {};
  }

  const globalScope = win as unknown as Record<string, unknown>;
  globalScope.createDiv = (info?: DomElementInfo | string): HTMLElement => {
    const el = win.document.createElement("div");
    applyDomElementInfo(el, info);
    return el;
  };
  globalScope.createSpan = (info?: DomElementInfo | string): HTMLElement => {
    const el = win.document.createElement("span");
    applyDomElementInfo(el, info);
    return el;
  };
  globalScope.createEl = (tag: string, info?: DomElementInfo | string): HTMLElement => {
    const el = win.document.createElement(tag);
    applyDomElementInfo(el, info);
    return el;
  };

  globalScope.IntersectionObserver = FakeIntersectionObserver;
}

/**
 * Fabricated intersection-observer entry, just enough of the real
 * `IntersectionObserverEntry` shape for `JournalView`'s two observer
 * callbacks (`mountObserver`, the paging `observer`) to read `target` and
 * `isIntersecting` off it.
 */
export interface FakeIntersectionObserverEntry {
  target: Element;
  isIntersecting: boolean;
}

/**
 * Stand-in for the browser's `IntersectionObserver`, which plain jsdom does
 * not implement at all (no layout engine to drive real intersection
 * geometry). Real intersection — actual scroll position, actual element
 * bounds — is NOT modeled or claimed here: this only records which elements
 * are currently `observe()`d and lets a test fire a fabricated intersection
 * transition for any of them via `trigger()`. What a test using this can
 * prove is "given this intersection event, `JournalView` reacts correctly";
 * it cannot prove that the right real-world scroll position produces that
 * event in the first place — that remains a manual/real-browser concern.
 */
export class FakeIntersectionObserver implements Pick<IntersectionObserver, "observe" | "unobserve" | "disconnect" | "takeRecords" | "root" | "rootMargin" | "thresholds"> {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: ReadonlyArray<number>;
  observed = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | Document | null | undefined) ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    const threshold = options?.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
  }

  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Test-only: delivers a fabricated intersection transition for `states`. */
  trigger(states: FakeIntersectionObserverEntry[]): void {
    const entries = states.map(({ target, isIntersecting }) => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: Date.now(),
    })) as unknown as IntersectionObserverEntry[];
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}
