/**
 * Shared harness for `tests/JournalView.*.test.ts`. Wires a REAL
 * `EntryRepository` and a REAL `JournalService` (the same production classes
 * `journalService.test.ts`/`entryRepository.test.ts` already exercise
 * directly) to the fakes in `obsidian-mock.ts`, and constructs a real
 * `JournalView` on top of them under jsdom.
 *
 * Only the outermost Obsidian UI shell — `ItemView`, DOM helpers,
 * `IntersectionObserver`, `Menu`, `ButtonComponent`, `MarkdownRenderer` — is
 * faked. Everything below that (repository, index, service, change
 * batching) is the plugin's own code, so a test built on this harness is
 * exercising real domain logic, not merely the behaviour of a fake.
 */
import type { App, TFile, WorkspaceLeaf as ObsidianWorkspaceLeaf } from "obsidian";
import {
  createFakeApp,
  installDomHelpers,
  type Scope as FakeScope,
  WorkspaceLeaf as FakeWorkspaceLeaf,
} from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { JournalView } from "../src/views/JournalView";
import { TextareaEditor } from "../src/views/TextareaEditor";
import type { EntryEditorFactory } from "../src/views/EntryEditor";
import type JournalEntriesPlugin from "../src/main";
import { formatCreatedProperty, formatEntryFilename } from "../src/utils/dates";
import { entryFolderPath } from "../src/journal/folderLayout";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

export interface Harness {
  app: ReturnType<typeof createFakeApp>;
  repository: EntryRepository;
  service: JournalService;
  plugin: JournalEntriesPlugin;
  view: JournalView;
  /** The configured journal folder, for building matching entry paths. */
  folder: string;
}

/**
 * Builds a harness. Deliberately does NOT call `service.load()` or
 * `view.onOpen()` itself: `JournalService.load()` snapshots the vault into
 * its index at that moment (`rebuild()`), and does not re-scan it later —
 * only a real vault event (or another explicit `rebuild()`) updates it after
 * that. So the intended order is: seed the vault via `addEntry` for however
 * many entries the test wants a journal to already contain, THEN
 * `harness.service.load()`, THEN `await harness.view.onOpen()`. Anything
 * added after `load()` needs a real vault event (see `addEntry`'s doc) to
 * become visible to the already-loaded service/view.
 */
export function createHarness(folder = "Journal"): Harness {
  const app = createFakeApp();
  const repository = new EntryRepository(app as unknown as App, () => folder);
  const service = new JournalService(app as unknown as App, repository);

  const editorFactory: EntryEditorFactory = {
    usingFallback: true,
    create: () => new TextareaEditor(),
  };

  const plugin = {
    repository,
    journal: service,
    editorFactory,
  } as unknown as JournalEntriesPlugin;

  const leaf = new FakeWorkspaceLeaf(app);
  const view = new JournalView(leaf as unknown as ObsidianWorkspaceLeaf, plugin);

  return { app, repository, service, plugin, view, folder };
}

/**
 * Adds an entry file directly to the fake vault (no vault event fires —
 * mirrors `journalService.test.ts`'s own `fake.vault.addFile` convention).
 * Call this BEFORE `harness.service.load()` for a journal's initial
 * contents; for entries that need to appear as an external change to an
 * already-loaded service/view, fire a real vault event instead (`create`/
 * `modify`/`rename`/`delete` via `harness.app.vault.trigger(...)`, or
 * `harness.app.fileManager.renameFile(...)`), then
 * `vi.advanceTimersByTime(300)` to flush `JournalService`'s debounce.
 *
 * Uses only the plugin's filename convention for its timestamp — no
 * frontmatter is registered with the fake metadata cache — so
 * `resolveEntryDate` falls back to parsing the filename. That is enough to
 * control ordering/grouping precisely without also having to keep a fake
 * metadata cache in sync with file content.
 */
export function addEntry(harness: Harness, created: Date, body = "", suffix = ""): TFile {
  const dir = entryFolderPath(harness.folder, created, "year-month");
  const path = `${dir}/${formatEntryFilename(created)}${suffix}.md`;
  const content = `---\ncreated: "${formatCreatedProperty(created)}"\n---\n\n${body}`;
  return harness.app.vault.addFile(path, content) as unknown as TFile;
}

/**
 * Registers `tags` (bare, no `#`) as the INLINE tags of an already-added
 * entry file. Must be called before `harness.service.load()` for the tags to
 * be in the initial index — `entryFor` reads the cache once, when the index
 * is built.
 */
export function tagEntry(harness: Harness, file: TFile, tags: string[]): void {
  harness.app.metadataCache.inlineTags.set(file.path, tags);
}

/**
 * Same, for FRONTMATTER tags — the ones the timeline renders chips for.
 * Overwrites (does not merge with) any frontmatter already registered for
 * this path — safe today only because `addEntry` never writes into
 * `metadataCache.frontmatter` itself. A future helper touching the same map
 * for the same path would need to merge instead.
 */
export function tagEntryInFrontmatter(harness: Harness, file: TFile, tags: string[]): void {
  harness.app.metadataCache.frontmatter.set(file.path, { tags });
}

/**
 * Test-only reflection into `JournalView`'s private state and methods —
 * `rendered`, `dayGroups`, `timelineEl`, `observer`/`mountObserver`,
 * `composer`, `lastLoadedPath`, `applyChangesNow`, etc. Typed `any`
 * deliberately: this exists precisely to reach past the `private` keyword,
 * which TypeScript only enforces at compile time anyway.
 */
export function internals(view: JournalView): any {
  return view;
}

/**
 * Presses Escape at the view's own keymap scope — the path a real Escape
 * takes, since `JournalView`'s constructor registers there (`View.scope`)
 * rather than on `contentEl`.
 *
 * Invokes the registered handler directly. Real Obsidian owns the scope stack
 * and decides which scope sees a keypress; no jsdom `KeyboardEvent` can
 * reproduce that, so a test that dispatched one would be asserting against a
 * dispatch mechanism this repo invented rather than against Obsidian's. What
 * this pins is what the handler decides, and its return value — `false` means
 * "handled, preventDefault", anything else means the key carries on to the
 * parent scope (see `KeymapEventListener`).
 */
export function pressEscape(view: JournalView): unknown {
  const scope = internals(view).scope as FakeScope | null;
  const handler = scope?.handlers.find((registered) => registered.key === "Escape");
  if (!handler) throw new Error("no Escape handler registered on the view's scope");

  return handler.func(new KeyboardEvent("keydown", { key: "Escape" }), {
    modifiers: "",
    key: "Escape",
    vkey: "Escape",
  });
}

/**
 * Typed convenience over `internals(view).timelineEl` — `internals` itself
 * returns `any`, and TypeScript disallows explicit generic type arguments
 * (e.g. `.querySelectorAll<HTMLElement>(...)`) on a call through an
 * `any`-typed value ("Untyped function calls may not accept type
 * arguments"), so callers that want `querySelectorAll<HTMLElement>` need a
 * properly-typed `HTMLElement` to call it on.
 */
export function timelineEl(view: JournalView): HTMLElement {
  return internals(view).timelineEl as HTMLElement;
}

/**
 * Replaces `win.requestAnimationFrame`/`cancelAnimationFrame` with a queue the
 * test drains explicitly via `flush()`, instead of one that fires on a real
 * timer. `openComposer`'s focus-claim loop (`JournalView.ts`'s `claimFocus`)
 * schedules itself through `contentEl.win.requestAnimationFrame`, and
 * `vi.useFakeTimers()` does not, by itself, fake `requestAnimationFrame` — it
 * is not in vitest's default `toFake` list — so without this, that loop would
 * run against a real, uncontrolled ~16ms timer even under an otherwise
 * fake-timers test, making the exact frame boundaries this is meant to pin
 * unobservable.
 *
 * `flush()` runs exactly the callbacks queued as of the call — one frame's
 * worth. A callback that itself calls `requestAnimationFrame` while
 * `flush()` is draining it (as `claimFocus` does, to watch the next frame)
 * is queued into the NEXT batch, not appended to the one currently draining
 * — the same one-frame-lookahead a real `requestAnimationFrame` provides.
 * Nothing here ever runs a scheduled callback synchronously inside the
 * `requestAnimationFrame` call itself, which a real frame never does either.
 */
export interface FakeRaf {
  /** Runs the callbacks currently queued — one frame's worth. */
  flush(): void;
  /** Restores the original `requestAnimationFrame`/`cancelAnimationFrame`. */
  restore(): void;
}

export function installFakeRaf(win: Window & typeof globalThis): FakeRaf {
  const originalRequest = win.requestAnimationFrame;
  const originalCancel = win.cancelAnimationFrame;
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  win.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  }) as typeof win.requestAnimationFrame;

  win.cancelAnimationFrame = ((id: number): void => {
    queue.delete(id);
  }) as typeof win.cancelAnimationFrame;

  return {
    flush(): void {
      // Swapped out before running anything, so a callback's own
      // `requestAnimationFrame` call (which re-enters `win.requestAnimationFrame`
      // above, not this closure) lands in the fresh map, not the one being
      // iterated.
      const due = queue;
      queue = new Map();
      for (const callback of due.values()) callback(0);
    },
    restore(): void {
      win.requestAnimationFrame = originalRequest;
      win.cancelAnimationFrame = originalCancel;
    },
  };
}

/**
 * Lets pending microtask chains (readBody, editor mounts, `enforceMountLimit`
 * unmounts, ...) settle under fake timers, without advancing real wall-clock
 * time. `JournalView`'s own async chains have no real timers in them once an
 * `IntersectionObserver` callback has fired synchronously; the only real
 * timers involved are `JournalService`'s 300ms debounce and
 * `scheduleSave`'s 500ms debounce, neither of which this fires — callers
 * advance those explicitly.
 */
export async function settle(): Promise<void> {
  const { vi } = await import("vitest");
  await vi.advanceTimersByTimeAsync(0);
}
