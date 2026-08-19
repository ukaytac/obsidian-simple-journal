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
import { createFakeApp, installDomHelpers, WorkspaceLeaf as FakeWorkspaceLeaf } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { JournalView } from "../src/views/JournalView";
import { TextareaEditor } from "../src/views/TextareaEditor";
import type { EntryEditorFactory } from "../src/views/EntryEditor";
import type JournalEntriesPlugin from "../src/main";
import { entryFolderPath, formatCreatedProperty, formatEntryFilename } from "../src/utils/dates";

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
  const dir = entryFolderPath(harness.folder, created);
  const path = `${dir}/${formatEntryFilename(created)}${suffix}.md`;
  const content = `---\ncreated: "${formatCreatedProperty(created)}"\n---\n\n${body}`;
  return harness.app.vault.addFile(path, content) as unknown as TFile;
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
