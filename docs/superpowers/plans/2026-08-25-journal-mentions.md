# Journal Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the journal entries that mention a note, with their content, on three surfaces — a `simple-journal` code block, an optional automatic footer under notes, and an optional sidebar view.

**Architecture:** One source-blind query (`findMentions`, pure, over `metadataCache.resolvedLinks` and the existing `JournalService` index), one renderer (`createMentionsPanel`, read-only `MarkdownRenderer` output in the timeline's visual language), and three thin shells that only supply a container and a target `TFile`. The automatic footer needs Obsidian's internal `.markdown-preview-sizer` / `.cm-sizer` DOM, so it is a second, narrow, documented internals exception, confined to one file and silently inert if the element is absent.

**Tech Stack:** TypeScript, Obsidian plugin API (`registerMarkdownCodeBlockProcessor`, `MarkdownRenderChild`, `ItemView`, `MarkdownRenderer`, `resolvedLinks`), vitest + jsdom, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-25-journal-mentions-design.md`

---

## Spec corrections adopted by this plan

Two things in the spec cannot be built as written. Both are narrowed here, not dropped:

1. **Spec §3 Rule 1 / §11 tests 1–4** list "body link", "embed", "aliased link" and "frontmatter link" as separate unit tests. At the layer we own they are the same test: Obsidian collapses all four into `resolvedLinks` before we look. Unit tests assert *our* contract ("if Obsidian resolved it, we count it"); that Obsidian's `resolvedLinks` really does include frontmatter links moves to `docs/manual-testing.md`, because only a real vault can prove it. The spec's stated fallback (an explicit `cache.links` + `cache.embeds` + `cache.frontmatterLinks` scan) stays the documented remedy if that manual check ever fails.

2. **Spec §7** says the footer walks "visible `MarkdownView`s". Obsidian exposes no public visibility predicate. Since Obsidian 1.7.2 defers unloaded tabs' views, `leaf.view instanceof MarkdownView` already excludes them, which is the practical meaning of the requirement. That is what gets built.

---

## File structure

**Create**

| File | Responsibility |
| --- | --- |
| `src/mentions/mentionQuery.ts` | Pure: which entries mention a target. No DOM, no Obsidian view types. |
| `src/mentions/MentionsPanel.ts` | The one renderer. Header, day grouping, read-only entry content, "Show more", subscriptions. |
| `src/mentions/mentionsCodeBlock.ts` | Shell A: the ` ```simple-journal ` processor, its `note:` directive parser, and the recursion guard. |
| `src/mentions/MentionsView.ts` | Shell B: the sidebar `ItemView`. |
| `src/mentions/mentionsFooter.ts` | Shell C: the guarded internals exception. The *only* file that knows `.markdown-preview-sizer` / `.cm-sizer`. |
| `tests/mentionQuery.test.ts` | Unit tests for the query. |
| `tests/mentionsPanel.test.ts` | Panel rendering, empty state, paging, teardown. |
| `tests/mentionsCodeBlock.test.ts` | Directive parsing and the recursion guard. |
| `tests/mentionsFooter.test.ts` | The exception's safety test. |

**Modify**

| File | Change |
| --- | --- |
| `src/settings/settings.ts` | Two new boolean fields, both defaulting to `false`. |
| `src/settings/SettingsTab.ts` | Two toggles, on both the declarative and the legacy path. |
| `src/main.ts` | Register the view, the code block, the footer, two commands, sidebar placement, settings application, `refreshJournal` coverage. |
| `styles.css` | `.journal-mentions*` rules. |
| `tests/obsidian-mock.ts` | `FakeMetadataCache.resolvedLinks`. |
| `tests/settingsTab.test.ts` | Cover the two new toggles. |
| `CLAUDE.md` | `# Mentions`, the second internals exception, non-goals, commands. |
| `README.md` | Document the feature. |
| `docs/manual-testing.md` | The checks only a real vault can make. |

---

## Task 1: The query

**Files:**
- Create: `src/mentions/mentionQuery.ts`
- Create: `tests/mentionQuery.test.ts`
- Modify: `tests/obsidian-mock.ts` (add `resolvedLinks` to `FakeMetadataCache`)

- [ ] **Step 1: Extend the Obsidian mock**

All four additions land here, in one place, because later tasks import modules that fail to load without them.

**1a.** In `tests/obsidian-mock.ts`, inside `export class FakeMetadataCache extends FakeEvents {`, add the field directly below the existing `inlineTags` declaration:

```ts
  /**
   * Source path → destination path → link count, exactly as Obsidian's own
   * `resolvedLinks`. Obsidian folds body links, embeds, aliased links and
   * frontmatter links into this one map before a plugin ever sees them, so a
   * test seeds it directly rather than trying to model the four kinds.
   */
  resolvedLinks: Record<string, Record<string, number>> = {};

  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    return null;
  }
```

`getFirstLinkpathDest` is a stub because nothing in the test suite exercises the `note:` directive's *resolution* — `parseMentionsBlock` is tested directly, and resolution is Obsidian's job. It exists so the module type-checks against the mock.

**1b.** In `class FakeEvents`, below `trigger`, add the counterpart to `on`:

```ts
  offref(ref: FakeEventRef): void {
    ref.unregister();
  }
```

Real Obsidian's `Events.offref` is the only public way to release an `EventRef`; `MentionsPanel.destroy` uses it.

**1c.** Add a `MarkdownRenderChild` stand-in beside the existing `ItemView` class. `mentionsCodeBlock.ts` subclasses it, so the module cannot even import without it:

```ts
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}
```

**1d.** Add a `MarkdownView` stand-in beside it. `mentionsFooter.ts` uses it in an `instanceof` check, and nothing in the suite constructs one — it exists so the module loads and so the check compiles:

```ts
export class MarkdownView extends ItemView {
  file: TFile | null = null;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/mentionQuery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import { findMentions, type ResolvedLinks } from "../src/mentions/mentionQuery";

function entry(path: string, created: Date): JournalEntry {
  return { file: { path } as JournalEntry["file"], created, tags: [] };
}

/** Newest first, exactly as `JournalService`'s index is kept. */
const AUG_24 = entry("Journal/2026/08/2026-08-24-21-40-00.md", new Date(2026, 7, 24, 21, 40));
const AUG_20 = entry("Journal/2026/08/2026-08-20-17-03-00.md", new Date(2026, 7, 20, 17, 3));
const AUG_12 = entry("Journal/2026/08/2026-08-12-09-34-00.md", new Date(2026, 7, 12, 9, 34));
const INDEX = [AUG_24, AUG_20, AUG_12];

const TARGET = { path: "People/Ekin Arslan Aytaç.md" } as JournalEntry["file"];

function links(map: Record<string, Record<string, number>>): ResolvedLinks {
  return map;
}

describe("findMentions", () => {
  it("returns the entries Obsidian resolved a link from", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 1 } }),
    );
    expect(result.map((e) => e.file.path)).toEqual([AUG_24.file.path]);
  });

  it("ignores entries with no link to the target", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { "People/Someone Else.md": 1 } }),
    );
    expect(result).toEqual([]);
  });

  it("ignores an entry with no resolvedLinks record at all", () => {
    expect(findMentions(INDEX, TARGET, links({}))).toEqual([]);
  });

  it("ignores a zero count", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 0 } }),
    );
    expect(result).toEqual([]);
  });

  it("lists an entry that links twice only once", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 2 } }),
    );
    expect(result).toHaveLength(1);
  });

  it("never lists the target as a mention of itself", () => {
    const self = entry(TARGET.path, new Date(2026, 7, 25));
    const result = findMentions(
      [self, ...INDEX],
      TARGET,
      links({ [TARGET.path]: { [TARGET.path]: 1 } }),
    );
    expect(result).toEqual([]);
  });

  it("preserves the index's newest-first order", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({
        [AUG_12.file.path]: { [TARGET.path]: 1 },
        [AUG_24.file.path]: { [TARGET.path]: 1 },
        [AUG_20.file.path]: { [TARGET.path]: 1 },
      }),
    );
    expect(result.map((e) => e.file.path)).toEqual([
      AUG_24.file.path,
      AUG_20.file.path,
      AUG_12.file.path,
    ]);
  });

  it("returns nothing for an empty index", () => {
    expect(findMentions([], TARGET, links({}))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/mentionQuery.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mentions/mentionQuery"`.

- [ ] **Step 4: Write the implementation**

Create `src/mentions/mentionQuery.ts`:

```ts
import type { TFile } from "obsidian";
import type { JournalEntry } from "../journal/entry";

/**
 * The ONE place "which entries mention this note?" is answered — as
 * `entryDate.ts` is the one place an entry's chronology is resolved, and
 * `entryTags.ts` the one place its tags are.
 *
 * SOURCE-BLIND, deliberately. Obsidian folds a body `[[link]]`, an embed
 * `![[link]]`, an aliased `[[link|text]]` and a frontmatter `people: "[[link]]"`
 * into one `resolvedLinks` map before a plugin ever sees them, and its search,
 * graph and backlinks pane treat all four identically. So does this. Nothing
 * downstream may ask which kind a reference was.
 *
 * An UNRESOLVED link (`unresolvedLinks`) is not a mention: it points at no
 * file, so there is no note for the panel to be attached to. Neither is a
 * plain-text occurrence of the note's name — full-text matching is semantic
 * search by another name, and that is a documented non-goal.
 *
 * `metadataCache.getFileBacklinks` is NOT used, on purpose. It appears in
 * Obsidian's published developer docs but is absent from the installed type
 * definitions, which makes it an undocumented internal by this project's
 * standard (CLAUDE.md, "Development Principles"). It also answers the wrong,
 * vault-sized question: we only ever ask about journal entries, of which the
 * service already holds a sorted index.
 */

/** Obsidian's `metadataCache.resolvedLinks`: source path → dest path → count. */
export type ResolvedLinks = Record<string, Record<string, number>>;

/**
 * The entries that link to `target`, in the order `entries` was given.
 *
 * `entries` is expected to be `JournalService.getEntries()`, which is already
 * sorted newest → oldest, so no sorting happens here — sorting a second time
 * would be a second place for the timeline's ordering rule to drift.
 *
 * An entry linking to the target more than once appears once: `resolvedLinks`
 * carries a count, and the count is deliberately ignored.
 */
export function findMentions(
  entries: readonly JournalEntry[],
  target: TFile,
  resolvedLinks: ResolvedLinks,
): JournalEntry[] {
  const targetPath = target.path;
  const mentions: JournalEntry[] = [];

  for (const entry of entries) {
    // A journal entry that links to itself does not list itself.
    if (entry.file.path === targetPath) continue;
    const outgoing = resolvedLinks[entry.file.path];
    if (!outgoing) continue;
    if ((outgoing[targetPath] ?? 0) > 0) mentions.push(entry);
  }

  return mentions;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/mentionQuery.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/mentions/mentionQuery.ts tests/mentionQuery.test.ts tests/obsidian-mock.ts
git commit -m "feat(mentions): resolve which journal entries mention a note"
```

---

## Task 2: The panel

**Files:**
- Create: `src/mentions/MentionsPanel.ts`
- Create: `tests/mentionsPanel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mentionsPanel.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { createFakeApp, installDomHelpers } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService } from "../src/services/journalService";
import { createMentionsPanel } from "../src/mentions/MentionsPanel";
import type JournalEntriesPlugin from "../src/main";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const TARGET_PATH = "People/Ekin Arslan Aytaç.md";

interface Setup {
  app: ReturnType<typeof createFakeApp>;
  plugin: JournalEntriesPlugin;
  target: TFile;
  container: HTMLElement;
  goToDate: ReturnType<typeof vi.fn>;
}

/**
 * Seeds `count` entries on descending days, each linking to the target, and
 * wires a real `EntryRepository` + `JournalService` over the fakes — the same
 * convention `journalViewHarness.ts` uses, so these tests exercise real
 * domain code rather than the behaviour of a mock.
 */
function setup(count: number): Setup {
  const app = createFakeApp();
  const target = app.vault.addFile(TARGET_PATH, "# Ekin\n");

  for (let i = 0; i < count; i++) {
    const day = String(24 - i).padStart(2, "0");
    const path = `Journal/2026/08/2026-08-${day}-21-40-00.md`;
    app.vault.addFile(path, `---\ncreated: 2026-08-${day}T21:40:00\n---\nEntry ${i} about [[Ekin Arslan Aytaç]]`);
    app.metadataCache.resolvedLinks[path] = { [TARGET_PATH]: 1 };
  }

  const repository = new EntryRepository(app as unknown as App, () => "Journal");
  const service = new JournalService(app as unknown as App, repository);
  service.load();

  const goToDate = vi.fn();
  const plugin = {
    app,
    repository,
    journal: service,
    goToDateInJournal: goToDate,
  } as unknown as JournalEntriesPlugin;

  const container = document.body.createDiv();
  return { app, plugin, target, container, goToDate };
}

describe("createMentionsPanel", () => {
  it("renders a header, day headers and timestamps for the mentioning entries", async () => {
    const { plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.querySelector(".journal-mentions-count")?.textContent).toBe("2");
    expect(container.querySelectorAll(".journal-mentions-day")).toHaveLength(2);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(2);
    panel.destroy();
  });

  it("renders entry body text, without the frontmatter", async () => {
    const { plugin, target, container } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    const body = container.querySelector(".journal-mentions-body")?.textContent ?? "";
    expect(body).toContain("Entry 0 about [[Ekin Arslan Aytaç]]");
    expect(body).not.toContain("created:");
    panel.destroy();
  });

  it("shows the first five entries and pages the rest in", async () => {
    const { plugin, target, container } = setup(8);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(5);
    const more = container.querySelector<HTMLButtonElement>(".journal-mentions-more");
    expect(more?.textContent).toBe("Show 3 more");

    more?.click();
    // The click handler kicks off an async render; advancing by 0 with fake
    // timers flushes its microtasks without waiting on the 200 ms debounce,
    // which this path does not go through.
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(8);
    expect(container.querySelector(".journal-mentions-more")).toBeNull();
    panel.destroy();
  });

  it("opens the journal at the entry's date when its timestamp is clicked", async () => {
    const { plugin, target, container, goToDate } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    container.querySelector<HTMLButtonElement>(".journal-mentions-time")?.click();
    expect(goToDate).toHaveBeenCalledTimes(1);
    expect((goToDate.mock.calls[0][0] as Date).getDate()).toBe(24);
    panel.destroy();
  });

  it("renders the given empty text when nothing mentions the target", async () => {
    const { plugin, target, container } = setup(0);
    const panel = createMentionsPanel({
      plugin,
      container,
      target,
      emptyText: "No journal entries mention this note yet.",
    });
    await panel.render();

    expect(container.textContent).toBe("No journal entries mention this note yet.");
    expect(container.querySelector(".journal-mentions-header")).toBeNull();
    panel.destroy();
  });

  it("renders nothing at all when no empty text is given", async () => {
    const { plugin, target, container } = setup(0);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();

    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });

  it("re-renders when the metadata cache resolves a change", async () => {
    const { app, plugin, target, container } = setup(1);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    expect(container.querySelectorAll(".journal-mentions-entry")).toHaveLength(1);

    app.metadataCache.resolvedLinks["Journal/2026/08/2026-08-24-21-40-00.md"] = {};
    app.metadataCache.trigger("resolve", target);
    await vi.advanceTimersByTimeAsync(200);

    expect(container.childElementCount).toBe(0);
    panel.destroy();
  });

  it("empties the container and stops responding to changes after destroy", async () => {
    const { app, plugin, target, container } = setup(2);
    const panel = createMentionsPanel({ plugin, container, target });
    await panel.render();
    panel.destroy();

    expect(container.childElementCount).toBe(0);

    // The subscription must be gone, not merely ignored: a resolve after
    // teardown must not repopulate a detached container.
    app.metadataCache.trigger("resolve", target);
    await vi.advanceTimersByTimeAsync(200);
    expect(container.childElementCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/mentionsPanel.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mentions/MentionsPanel"`.

- [ ] **Step 3: Write the implementation**

Create `src/mentions/MentionsPanel.ts`:

```ts
import { Component, debounce, MarkdownRenderer, setTooltip, type TFile } from "obsidian";
import type JournalEntriesPlugin from "../main";
import type { JournalEntry } from "../journal/entry";
import { dayKey, formatDayHeader, formatTime } from "../utils/dates";
import { findMentions } from "./mentionQuery";

/**
 * The ONE renderer behind all three mention surfaces (the `simple-journal`
 * code block, the automatic note footer, the sidebar view). Those three are
 * shells: they obtain a container and a target file and delegate here. A
 * change to how mentions look or behave is a change to this file.
 *
 * READ-ONLY, on purpose. Entry content goes through `MarkdownRenderer`, so
 * wikilinks, embeds, inline tags and formatting all behave as they do
 * anywhere else, but nothing here writes. Editing is what the timeline is
 * for, and mounting N live embedded editors inside an arbitrary note would
 * put this plugin's most data-critical code (mount cap, debounced saves,
 * self-write suppression, save tokens) behind a code-block lifecycle nobody
 * controls. Clicking a timestamp hands the user back to the timeline instead,
 * through the same `goToDateInJournal` the calendar uses.
 */

/** Entries rendered before the user asks for more. */
const INITIAL_COUNT = 5;
/** Added per "Show more" click. */
const PAGE_COUNT = 20;
/**
 * `metadataCache`'s `resolve` fires repeatedly while a note is being typed
 * in, so coalescing is not optional here.
 */
const REFRESH_DEBOUNCE_MS = 200;

export interface MentionsPanelOptions {
  plugin: JournalEntriesPlugin;
  /** Emptied and owned by the panel until `destroy()`. */
  container: HTMLElement;
  target: TFile;
  /**
   * Rendered when nothing mentions the target. Omit to render nothing at all
   * — which is what the automatic footer wants (the user did not ask for
   * anything there, so an empty panel is pure noise) and what the code block
   * does not (the user put the block there deliberately, so silence would
   * read as a bug).
   */
  emptyText?: string;
}

export interface MentionsPanel {
  render(): Promise<void>;
  destroy(): void;
}

export function createMentionsPanel(options: MentionsPanelOptions): MentionsPanel {
  const { plugin, container, target, emptyText } = options;

  let visibleCount = INITIAL_COUNT;
  let destroyed = false;
  /**
   * Guards against an older `render()` finishing its awaits after a newer one
   * already painted — same shape as `entrySave`'s save tokens.
   */
  let renderToken = 0;
  /** Owns the current render's `MarkdownRenderer` children, so they unload. */
  let contentOwner: Component | null = null;

  const scheduleRefresh = debounce(
    () => {
      void render();
    },
    REFRESH_DEBOUNCE_MS,
    false,
  );

  const unsubscribeJournal = plugin.journal.onChange(() => scheduleRefresh());
  const resolveRef = plugin.app.metadataCache.on("resolve", () => scheduleRefresh());

  async function render(): Promise<void> {
    if (destroyed) return;
    const token = ++renderToken;

    const mentions = findMentions(
      plugin.journal.getEntries(),
      target,
      plugin.app.metadataCache.resolvedLinks,
    );
    const shown = mentions.slice(0, visibleCount);

    // Read every visible body BEFORE touching the DOM, so a slow read can
    // never leave a half-built panel on screen.
    const bodies = await Promise.all(shown.map((entry) => readBody(entry)));
    if (destroyed || token !== renderToken) return;

    contentOwner?.unload();
    contentOwner = new Component();
    contentOwner.load();

    container.empty();
    container.addClass("journal-mentions");

    if (mentions.length === 0) {
      if (emptyText) container.createDiv({ cls: "journal-mentions-empty", text: emptyText });
      return;
    }

    const headerEl = container.createDiv({ cls: "journal-mentions-header" });
    headerEl.createSpan({ cls: "journal-mentions-title", text: "Journal mentions" });
    headerEl.createSpan({ cls: "journal-mentions-count", text: String(mentions.length) });

    const listEl = container.createDiv({ cls: "journal-mentions-list" });

    let currentDay = "";
    let dayEntriesEl: HTMLElement | null = null;

    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i];
      const key = dayKey(entry.created);

      if (key !== currentDay || dayEntriesEl === null) {
        currentDay = key;
        const dayEl = listEl.createDiv({ cls: "journal-mentions-day" });
        dayEl.createDiv({ cls: "journal-day-header", text: formatDayHeader(entry.created) });
        dayEntriesEl = dayEl.createDiv({ cls: "journal-mentions-day-entries" });
      }

      const entryEl = dayEntriesEl.createDiv({ cls: "journal-mentions-entry" });

      // A real <button>, not a div+click: keyboard reachable and Enter/Space
      // activated with no extra wiring, exactly as `.journal-entry-time` and
      // the calendar's day cells are. `type="button"` keeps it inert should
      // it ever land inside a <form>.
      const timeEl = entryEl.createEl("button", {
        cls: "journal-mentions-time",
        text: formatTime(entry.created),
        attr: { type: "button" },
      });
      setTooltip(timeEl, "Open in journal");
      timeEl.addEventListener("click", () => {
        void plugin.goToDateInJournal(entry.created);
      });

      const bodyEl = entryEl.createDiv({ cls: "journal-mentions-body" });
      await MarkdownRenderer.render(
        plugin.app,
        bodies[i],
        bodyEl,
        entry.file.path,
        contentOwner,
      );
    }

    const remaining = mentions.length - shown.length;
    if (remaining > 0) {
      const moreEl = container.createEl("button", {
        cls: "journal-mentions-more",
        text: `Show ${Math.min(remaining, PAGE_COUNT)} more`,
        attr: { type: "button" },
      });
      moreEl.addEventListener("click", () => {
        visibleCount += PAGE_COUNT;
        void render();
      });
    }
  }

  /**
   * Goes through `EntryRepository.readBody` rather than reading the file
   * directly, so frontmatter stripping stays in the one module that owns it.
   * A read failure renders as nothing rather than aborting the whole panel:
   * one unreadable entry must not hide the others.
   */
  async function readBody(entry: JournalEntry): Promise<string> {
    try {
      return await plugin.repository.readBody(entry.file);
    } catch (error) {
      console.error("Simple Journal: could not read an entry for the mentions panel", error);
      return "";
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    scheduleRefresh.cancel();
    unsubscribeJournal();
    plugin.app.metadataCache.offref(resolveRef);
    contentOwner?.unload();
    contentOwner = null;
    container.empty();
    container.removeClass("journal-mentions");
  }

  return { render, destroy };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/mentionsPanel.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mentions/MentionsPanel.ts tests/mentionsPanel.test.ts
git commit -m "feat(mentions): render a read-only mentions panel"
```

---

## Task 3: Styles

**Files:**
- Modify: `styles.css` (append at the end)

- [ ] **Step 1: Append the rules**

```css
/* ── Mentions ─────────────────────────────────────────────────────────────
   The panel repeats the timeline's visual language (`.journal-day-header` is
   literally reused) so a reader does not learn a second interface. What is
   NOT reused is anything that assumes a view container: this panel lives
   inside an arbitrary note, sometimes inside the note's own text column, so
   it sets no max-width and no page padding of its own. */

.journal-mentions {
  margin-top: var(--size-4-8);
}

.journal-mentions-header {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  font-size: var(--font-ui-small);
  font-weight: var(--font-semibold);
  letter-spacing: 0.06em;
  color: var(--text-faint);
  margin-bottom: var(--size-4-2);
}

/* A hairline, not a border box: this is a writing surface, and the panel has
   to read as a continuation of the note rather than a card stuck to it. */
.journal-mentions-header::after {
  content: "";
  flex: 1;
  height: 1px;
  background-color: var(--background-modifier-border);
}

.journal-mentions-count {
  font-variant-numeric: tabular-nums;
  order: 1;
}

.journal-mentions-entry {
  margin-bottom: var(--size-4-4);
}

/* Same reset as `.journal-entry-header .journal-entry-time`: Obsidian's base
   button styling would otherwise render a filled chip where a quiet
   timestamp belongs. Two classes so a theme's later `button` rule does not
   win on load order. */
.journal-mentions-entry .journal-mentions-time,
.journal-mentions-entry .journal-mentions-time:hover,
.journal-mentions-entry .journal-mentions-time.mobile-tap {
  font-size: var(--font-ui-smaller);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  background-color: transparent;
  box-shadow: none;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}

.journal-mentions-entry .journal-mentions-time:hover,
.journal-mentions-entry .journal-mentions-time:focus-visible {
  color: var(--text-normal);
}

.journal-mentions-body > :first-child {
  margin-top: 0;
}

.journal-mentions-body > :last-child {
  margin-bottom: 0;
}

.journal-mentions-empty {
  font-size: var(--font-ui-small);
  color: var(--text-faint);
}

.journal-mentions-more,
.journal-mentions-more:hover {
  display: block;
  margin: var(--size-4-2) 0 0 auto;
  font-size: var(--font-ui-smaller);
  color: var(--text-faint);
  background-color: transparent;
  box-shadow: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.journal-mentions-more:hover,
.journal-mentions-more:focus-visible {
  color: var(--text-normal);
}

/* The recursion guard's placeholder: a `simple-journal` block that ended up
   inside a mentions panel. Inert by design — see `mentionsCodeBlock.ts`. */
.journal-mentions-nested {
  font-size: var(--font-ui-smaller);
  color: var(--text-faint);
  font-style: italic;
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "style(mentions): style the mentions panel"
```

---

## Task 4: The code block

**Files:**
- Create: `src/mentions/mentionsCodeBlock.ts`
- Create: `tests/mentionsCodeBlock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mentionsCodeBlock.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installDomHelpers } from "./obsidian-mock";
import { isInsideMentionsPanel, parseMentionsBlock } from "../src/mentions/mentionsCodeBlock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("parseMentionsBlock", () => {
  it("reads no target from an empty block", () => {
    expect(parseMentionsBlock("")).toEqual({ noteLink: null });
    expect(parseMentionsBlock("\n\n  \n")).toEqual({ noteLink: null });
  });

  it("reads a note: directive", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseMentionsBlock("\n   note:   [[Ekin]]   \n")).toEqual({ noteLink: "Ekin" });
  });

  it("uses the link target, not the alias", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç|Ekin]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("ignores anything it does not understand rather than erroring", () => {
    expect(parseMentionsBlock("sort: oldest\nlimit: 3")).toEqual({ noteLink: null });
  });
});

describe("isInsideMentionsPanel", () => {
  it("is false for a block in an ordinary note", () => {
    const el = document.body.createDiv();
    expect(isInsideMentionsPanel(el)).toBe(false);
  });

  it("is true for a block rendered inside a panel's own output", () => {
    const panel = document.body.createDiv({ cls: "journal-mentions" });
    const el = panel.createDiv({ cls: "journal-mentions-body" }).createDiv();
    expect(isInsideMentionsPanel(el)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/mentionsCodeBlock.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mentions/mentionsCodeBlock"`.

- [ ] **Step 3: Write the implementation**

Create `src/mentions/mentionsCodeBlock.ts`:

```ts
import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Shell A: the fenced block a user writes into a note.
 *
 * The language string is effectively PERMANENT once published — it lives
 * inside users' notes, exactly as the plugin id lives in their vault folder
 * and the view types live in their saved layouts. It is namespaced to the
 * plugin so it cannot collide with another plugin's processor.
 */
export const MENTIONS_BLOCK_LANGUAGE = "simple-journal";

/** What `Insert journal mentions block` writes at the cursor. */
export const MENTIONS_BLOCK_SNIPPET = "```" + MENTIONS_BLOCK_LANGUAGE + "\n```\n";

const EMPTY_TEXT = "No journal entries mention this note yet.";

const NOTE_DIRECTIVE = /^note:\s*\[\[([^\]]+)\]\]$/;

export interface MentionsBlockOptions {
  /** Linktext of an explicitly targeted note, or null for "the note I am in". */
  noteLink: string | null;
}

/**
 * Understands exactly one directive, `note: [[Some Note]]`.
 *
 * Anything else is IGNORED rather than treated as an error. A code block that
 * renders an error message in the middle of someone's note is worse than one
 * that renders the obvious default, and this block's obvious default —
 * mentions of the note it sits in — is always available.
 */
export function parseMentionsBlock(source: string): MentionsBlockOptions {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = NOTE_DIRECTIVE.exec(line);
    if (!match) continue;
    // `[[Note|Alias]]` — the target is the part before the pipe.
    const linktext = match[1].split("|")[0].trim();
    if (linktext) return { noteLink: linktext };
  }
  return { noteLink: null };
}

/**
 * The recursion guard.
 *
 * The panel renders entry markdown, and an entry may itself contain a
 * `simple-journal` block — which would render a panel, which would render
 * entry markdown, without end. Detected structurally rather than with a
 * global depth counter: `closest` asks about THIS block's actual ancestry, so
 * an unrelated block rendering concurrently in another note is never
 * mistaken for a nested one.
 */
export function isInsideMentionsPanel(el: HTMLElement): boolean {
  return el.closest(".journal-mentions") !== null;
}

/**
 * Wraps the panel so Obsidian owns its lifecycle: when the block's element
 * leaves the DOM — the note closes, or the user edits the fence — `onunload`
 * fires and every subscription the panel holds is released.
 */
class MentionsBlockChild extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private readonly panel: MentionsPanel,
  ) {
    super(containerEl);
  }

  onload(): void {
    void this.panel.render();
  }

  onunload(): void {
    this.panel.destroy();
  }
}

export function registerMentionsCodeBlock(plugin: JournalEntriesPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor(
    MENTIONS_BLOCK_LANGUAGE,
    (source, el, ctx) => {
      if (isInsideMentionsPanel(el)) {
        el.createDiv({
          cls: "journal-mentions-nested",
          text: "Journal mentions block (not expanded here).",
        });
        return;
      }

      const target = resolveTarget(plugin, source, ctx);
      if (!target) {
        el.createDiv({ cls: "journal-mentions-empty", text: EMPTY_TEXT });
        return;
      }

      const panel = createMentionsPanel({
        plugin,
        container: el,
        target,
        emptyText: EMPTY_TEXT,
      });
      ctx.addChild(new MentionsBlockChild(el, panel));
    },
  );
}

/**
 * A `note:` link that resolves to nothing falls back to the same empty state
 * as a note with no mentions — for the same reason the parser ignores what it
 * does not understand.
 */
function resolveTarget(
  plugin: JournalEntriesPlugin,
  source: string,
  ctx: MarkdownPostProcessorContext,
): TFile | null {
  const { noteLink } = parseMentionsBlock(source);

  if (noteLink) {
    return plugin.app.metadataCache.getFirstLinkpathDest(noteLink, ctx.sourcePath);
  }

  const self = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  return self instanceof TFile ? self : null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/mentionsCodeBlock.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Register the processor and the insert command in `main.ts`**

Add the import beside the existing view imports:

```ts
import { MENTIONS_BLOCK_SNIPPET, registerMentionsCodeBlock } from "./mentions/mentionsCodeBlock";
```

In `onload()`, directly after `this.addSettingTab(new JournalSettingsTab(this));`:

```ts
    // No setting gates this. A toggle that turned the processor off would
    // leave raw ```simple-journal fences visible in notes the user had
    // already written, reading as breakage. The block is opt-in per note
    // already: the way to not have one is to not write one.
    registerMentionsCodeBlock(this);
```

With the other `addCommand` calls:

```ts
    this.addCommand({
      id: "insert-mentions-block",
      name: "Insert journal mentions block",
      editorCallback: (editor) => {
        editor.replaceSelection(MENTIONS_BLOCK_SNIPPET);
      },
    });
```

`editorCallback` needs `Editor` in the `obsidian` import list in `main.ts`; add it if TypeScript asks.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/mentions/mentionsCodeBlock.ts tests/mentionsCodeBlock.test.ts src/main.ts
git commit -m "feat(mentions): add the simple-journal code block"
```

---

## Task 5: Settings

**Files:**
- Modify: `src/settings/settings.ts`
- Modify: `src/settings/SettingsTab.ts`
- Modify: `tests/settingsTab.test.ts`

- [ ] **Step 1: Add the fields**

Replace the whole of `src/settings/settings.ts`:

```ts
export interface JournalSettings {
  /** Vault-relative folder that holds journal entries. */
  journalFolder: string;
  /**
   * Show a mentions panel at the bottom of notes that journal entries link
   * to. Off by default: this is the surface that relies on Obsidian's
   * internal layout DOM (see `mentionsFooter.ts`), and nobody should end up
   * with UI appearing under their notes without having asked for it.
   */
  showMentionsUnderNotes: boolean;
  /**
   * Keep a journal mentions panel in the sidebar. Governs AUTOMATIC PLACEMENT
   * only — exactly as the calendar's placement policy does. The view type is
   * always registered (a saved layout referring to an unregistered type is a
   * broken layout), and `Open journal mentions` works regardless, because a
   * command is how you reach a thing.
   */
  mentionsSidebar: boolean;
}

export const DEFAULT_SETTINGS: JournalSettings = {
  journalFolder: "Journal",
  showMentionsUnderNotes: false,
  mentionsSidebar: false,
};
```

- [ ] **Step 2: Extend the settings tab**

In `src/settings/SettingsTab.ts`, add beside the existing `FOLDER_*` constants:

```ts
const UNDER_NOTES_KEY = "showMentionsUnderNotes";
const SIDEBAR_KEY = "mentionsSidebar";

const UNDER_NOTES_NAME = "Show mentions under notes";
const UNDER_NOTES_DESC =
  "Add a panel at the bottom of a note listing the journal entries that link to it.";
const SIDEBAR_NAME = "Mentions sidebar";
const SIDEBAR_DESC =
  "Keep a journal mentions panel in the sidebar, following the active note.";
```

Add this method to the class, below `saveAndRefresh`:

```ts
  /**
   * Unlike the folder field there is nothing to debounce here — a toggle has
   * no half-typed state — so this commits immediately and applies the change
   * to the live surfaces right away.
   */
  private setToggle(key: typeof UNDER_NOTES_KEY | typeof SIDEBAR_KEY, value: boolean): void {
    if (key === UNDER_NOTES_KEY) this.plugin.settings.showMentionsUnderNotes = value;
    else this.plugin.settings.mentionsSidebar = value;
    void this.plugin.saveSettings().then(() => this.plugin.applyMentionSettings());
  }
```

Replace `getSettingDefinitions`'s returned array so it lists all three:

```ts
    return [
      {
        name: FOLDER_NAME,
        desc: FOLDER_DESC,
        control: {
          type: "text",
          key: FOLDER_KEY,
          placeholder: DEFAULT_SETTINGS.journalFolder,
        },
      },
      {
        name: UNDER_NOTES_NAME,
        desc: UNDER_NOTES_DESC,
        control: { type: "toggle", key: UNDER_NOTES_KEY },
      },
      {
        name: SIDEBAR_NAME,
        desc: SIDEBAR_DESC,
        control: { type: "toggle", key: SIDEBAR_KEY },
      },
    ];
```

Replace `getControlValue` and `setControlValue`:

```ts
  getControlValue(key: string): unknown {
    if (key === FOLDER_KEY) return this.plugin.settings.journalFolder;
    if (key === UNDER_NOTES_KEY) return this.plugin.settings.showMentionsUnderNotes;
    if (key === SIDEBAR_KEY) return this.plugin.settings.mentionsSidebar;
    return undefined;
  }

  setControlValue(key: string, value: unknown): void {
    if (key === FOLDER_KEY) {
      this.pendingFolder = normalizeFolder(value);
      this.saveAndRefresh();
      return;
    }
    if (key === UNDER_NOTES_KEY || key === SIDEBAR_KEY) {
      this.setToggle(key, value === true);
    }
  }
```

And append to `display()`, after the existing folder `Setting`:

```ts
    new Setting(containerEl)
      .setName(UNDER_NOTES_NAME)
      .setDesc(UNDER_NOTES_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showMentionsUnderNotes)
          .onChange((value) => this.setToggle(UNDER_NOTES_KEY, value)),
      );

    new Setting(containerEl)
      .setName(SIDEBAR_NAME)
      .setDesc(SIDEBAR_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mentionsSidebar)
          .onChange((value) => this.setToggle(SIDEBAR_KEY, value)),
      );
```

- [ ] **Step 3: Harden `loadSettings`**

In `src/main.ts`'s `loadSettings`, below the existing `journalFolder` validation:

```ts
    // Same reasoning as the folder check above: `data.json` is user-editable,
    // so a non-boolean here must not reach the code that reads it.
    if (typeof this.settings.showMentionsUnderNotes !== "boolean") {
      this.settings.showMentionsUnderNotes = DEFAULT_SETTINGS.showMentionsUnderNotes;
    }
    if (typeof this.settings.mentionsSidebar !== "boolean") {
      this.settings.mentionsSidebar = DEFAULT_SETTINGS.mentionsSidebar;
    }
```

- [ ] **Step 4: Add the tests**

`tests/settingsTab.test.ts` already has a `setup()` helper and a `FakePlugin` interface. Extend both rather than adding a second pair.

Change the interface:

```ts
interface FakePlugin {
  app: unknown;
  settings: {
    journalFolder: string;
    showMentionsUnderNotes: boolean;
    mentionsSidebar: boolean;
  };
  saveSettings: () => Promise<void>;
  refreshJournal: () => void;
  applyMentionSettings: () => void;
}
```

Change `setup()`'s plugin literal to match, adding `applyMentionSettings` to the returned object as well:

```ts
function setup(initialFolder = DEFAULT_SETTINGS.journalFolder) {
  const saveSettings = vi.fn(() => Promise.resolve());
  const refreshJournal = vi.fn();
  const applyMentionSettings = vi.fn();
  const plugin: FakePlugin = {
    app: {},
    settings: {
      journalFolder: initialFolder,
      showMentionsUnderNotes: false,
      mentionsSidebar: false,
    },
    saveSettings,
    refreshJournal,
    applyMentionSettings,
  };
  // The tab only ever touches app/settings/saveSettings/refreshJournal/
  // applyMentionSettings.
  const tab = new JournalSettingsTab(plugin as never);
  return { tab, plugin, saveSettings, refreshJournal, applyMentionSettings };
}
```

Then append:

```ts
describe("mentions toggles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares all three settings, so Obsidian's settings search indexes them", () => {
    const { tab } = setup();
    expect(tab.getSettingDefinitions().map((d) => (d as { name: string }).name)).toEqual([
      "Journal folder",
      "Show mentions under notes",
      "Mentions sidebar",
    ]);
  });

  it("reads a toggle's current value", () => {
    const { tab, plugin } = setup();
    plugin.settings.mentionsSidebar = true;
    expect(tab.getControlValue("mentionsSidebar")).toBe(true);
  });

  /**
   * The folder field is debounced because a half-typed value must never reach
   * `plugin.settings`. A toggle has no half-typed state, so it commits at
   * once — asserted here without advancing any timer, which is the whole
   * distinction.
   */
  it("commits a toggle immediately, with no debounce", () => {
    const { tab, plugin, saveSettings } = setup();
    tab.setControlValue("showMentionsUnderNotes", true);
    expect(plugin.settings.showMentionsUnderNotes).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("applies the change to the live surfaces after saving", async () => {
    const { tab, applyMentionSettings } = setup();
    tab.setControlValue("mentionsSidebar", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(applyMentionSettings).toHaveBeenCalledTimes(1);
  });

  it("coerces a non-boolean control value rather than storing it", () => {
    const { tab, plugin } = setup();
    tab.setControlValue("mentionsSidebar", "yes");
    expect(plugin.settings.mentionsSidebar).toBe(false);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/settingsTab.test.ts`
Expected: PASS. `applyMentionSettings` does not exist on the real plugin yet; it is added in Task 6, and the stub above keeps this task's tests green in the meantime.

- [ ] **Step 6: Commit**

```bash
git add src/settings/settings.ts src/settings/SettingsTab.ts src/main.ts tests/settingsTab.test.ts
git commit -m "feat(mentions): add the two mentions settings"
```

---

## Task 6: The sidebar view

**Files:**
- Create: `src/mentions/MentionsView.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write the view**

Create `src/mentions/MentionsView.ts`:

```ts
import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Fixed forever, for the same reason the journal and calendar view types are:
 * a saved workspace layout refers to it.
 */
export const VIEW_TYPE_MENTIONS = "simple-journal-mentions";

/**
 * Shell B: the sidebar. A thin Obsidian shell around `MentionsPanel` — it
 * owns which file is being shown and nothing else.
 *
 * Unlike the automatic footer, it does not exclude journal entries: the user
 * opened this panel deliberately, and it costs nothing to answer honestly for
 * whatever file is active. Recursion is not a concern here either, because no
 * note ever renders this view inside itself.
 */
export class MentionsView extends ItemView {
  private panel: MentionsPanel | null = null;
  private shownPath: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MENTIONS;
  }

  getDisplayText(): string {
    return "Journal mentions";
  }

  getIcon(): string {
    return "quote";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("journal-mentions-view");

    // `registerEvent` ties the unsubscribe to this view's own Component
    // lifecycle — the same reasoning behind `CalendarView.onOpen`'s
    // `this.register` — so it fires even along a teardown path that skips
    // `onClose`, and a later event can never reach a detached DOM.
    this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));

    this.refresh();
  }

  async onClose(): Promise<void> {
    this.teardownPanel();
    this.contentEl.empty();
  }

  /** Public so `main.ts`'s `refreshJournal` can drive it, as it does the calendar. */
  refresh(): void {
    const file = this.app.workspace.getActiveFile();

    if (!(file instanceof TFile)) {
      this.teardownPanel();
      this.contentEl.createDiv({
        cls: "journal-mentions-empty",
        text: "Open a note to see the journal entries that mention it.",
      });
      return;
    }

    // Rebuilding for a file already on screen would drop the user's expanded
    // "Show more" state for no reason.
    if (this.panel && this.shownPath === file.path) return;

    this.teardownPanel();
    this.shownPath = file.path;
    this.panel = createMentionsPanel({
      plugin: this.plugin,
      container: this.contentEl.createDiv(),
      target: file,
      emptyText: "No journal entries mention this note yet.",
    });
    void this.panel.render();
  }

  private teardownPanel(): void {
    this.panel?.destroy();
    this.panel = null;
    this.shownPath = null;
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Register the view, the command, and placement in `main.ts`**

Add the import:

```ts
import { MentionsView, VIEW_TYPE_MENTIONS } from "./mentions/MentionsView";
```

In `onload()`, beside the other `registerView` calls:

```ts
    this.registerView(VIEW_TYPE_MENTIONS, (leaf) => new MentionsView(leaf, this));
```

With the other commands:

```ts
    // Works whether or not `mentionsSidebar` is on: that setting governs
    // automatic placement, and a command is how you reach a thing.
    this.addCommand({
      id: "open-journal-mentions",
      name: "Open journal mentions",
      callback: () => {
        void this.openMentions();
      },
    });
```

Extend the existing `onLayoutReady` line:

```ts
    this.app.workspace.onLayoutReady(() => {
      void this.ensureCalendarLeaf();
      void this.applyMentionSettings();
    });
```

Add the methods, next to `openCalendar` / `ensureCalendarLeaf`:

```ts
  /**
   * Opens (or reveals) the mentions sidebar. Mirrors `openCalendar`: an
   * existing leaf anywhere is reused, and the command path activates and
   * reveals because the user asked for it explicitly.
   */
  async openMentions(): Promise<MentionsView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;

    if (!existing[0]) {
      await leaf.setViewState({ type: VIEW_TYPE_MENTIONS, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);

    return leaf.view instanceof MentionsView ? leaf.view : null;
  }

  /**
   * Brings both optional mention surfaces into line with the current
   * settings. Called on layout-ready and after either toggle changes, so
   * turning one on takes effect without a reload — and turning one off
   * actually removes it rather than leaving it until the next restart.
   */
  applyMentionSettings(): void {
    if (this.settings.mentionsSidebar) void this.ensureMentionsLeaf();
    else this.detachMentionsLeaves();

    this.mentionsFooter?.sync();
  }

  /**
   * Places a mentions leaf in the right sidebar if none exists anywhere.
   * Identical policy to `ensureCalendarLeaf` — including never stealing
   * focus (`active: false`) and never revealing the sidebar — except that it
   * is gated on a setting, because unlike the calendar this surface is
   * opt-in.
   */
  private async ensureMentionsLeaf(): Promise<void> {
    try {
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS).length > 0) return;

      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) return;

      await rightLeaf.setViewState({ type: VIEW_TYPE_MENTIONS, active: false });
    } catch (error) {
      console.error("Simple Journal: could not place the mentions panel in the sidebar", error);
    }
  }

  /** Turning the setting off must remove the panel, not merely stop re-placing it. */
  private detachMentionsLeaves(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS)) {
      leaf.detach();
    }
  }
```

Extend `refreshJournal`, after the existing calendar loop — for the same reason that loop exists (`rebuild()` bypasses the `onChange` batching the panel subscribes to):

```ts
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MENTIONS)) {
      const view = leaf.view;
      if (view instanceof MentionsView) view.refresh();
    }
```

`this.mentionsFooter` does not exist yet; it arrives in Task 7. Until then, declare it on the class as:

```ts
  private mentionsFooter: { sync(): void; destroy(): void } | null = null;
```

- [ ] **Step 3: Type-check and run the suite**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mentions/MentionsView.ts src/main.ts
git commit -m "feat(mentions): add the mentions sidebar view"
```

---

## Task 7: The automatic footer (the guarded exception)

**Files:**
- Create: `src/mentions/mentionsFooter.ts`
- Create: `tests/mentionsFooter.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mentionsFooter.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installDomHelpers } from "./obsidian-mock";
import { findContentFlowEl } from "../src/mentions/mentionsFooter";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * THE SAFETY TEST FOR THIS PLUGIN'S SECOND INTERNALS EXCEPTION.
 *
 * `mentionsFooter.ts` is the only file that knows Obsidian's internal
 * `.markdown-preview-sizer` / `.cm-sizer` layout elements. If a future
 * Obsidian renames or removes them, this feature must DISAPPEAR — silently,
 * with no throw, no notice and no console noise, and with nothing altered in
 * anybody's note. Do not delete these tests.
 */
describe("findContentFlowEl", () => {
  it("finds the reading-view sizer", () => {
    const view = document.body.createDiv();
    const sizer = view.createDiv({ cls: "markdown-preview-sizer" });
    expect(findContentFlowEl(view)).toBe(sizer);
  });

  it("finds the live-preview sizer", () => {
    const view = document.body.createDiv();
    const sizer = view.createDiv({ cls: "cm-sizer" });
    expect(findContentFlowEl(view)).toBe(sizer);
  });

  it("returns null — and does not throw — when neither is present", () => {
    const view = document.body.createDiv();
    view.createDiv({ cls: "some-future-obsidian-layout" });
    expect(findContentFlowEl(view)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/mentionsFooter.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mentions/mentionsFooter"`.

- [ ] **Step 3: Write the implementation**

Create `src/mentions/mentionsFooter.ts`:

```ts
import { MarkdownView, TFile } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Shell C — and this plugin's SECOND documented exception to the rule against
 * undocumented Obsidian internals. See CLAUDE.md, "# Mentions".
 *
 * WHY IT IS NEEDED. Obsidian exposes no public API for appending content to
 * the end of a note's CONTENT FLOW — the part that scrolls with the note.
 * Appending to the public `view.contentEl` puts the panel below the scroll
 * container, pinned to the bottom of the pane, which is not the same feature.
 * The only way to sit at the end of the content is to inject into Obsidian's
 * own layout elements: `.markdown-preview-sizer` in reading view and
 * `.cm-sizer` in live preview.
 *
 * WHAT MAKES IT SAFE. The same two rules as the editor exception in
 * `ObsidianEmbedEditor.ts`:
 *
 *   1. FEATURE DETECTION WITH SILENT FALLBACK IS MANDATORY. If
 *      `findContentFlowEl` returns null, this module does nothing at all — no
 *      throw, no notice, no console noise. Should Obsidian change that
 *      structure, the feature disappears; no note is altered and no journal
 *      data is at risk. Unlike the editor exception, no one-time notice is
 *      shown either: this surface is optional and off by default, so its
 *      absence degrades nothing the user depends on.
 *
 *   2. ALL DOM ASSUMPTIONS LIVE HERE. The two class names appear in exactly
 *      one `querySelector` call in this codebase. Retreating from this
 *      surface permanently, or moving to a future public API, is a one-file
 *      change.
 *
 * This licenses nothing else. Neither does the editor exception license this
 * one — it was granted separately, on its own merits.
 */

/** The class names. The ONLY place in the codebase that names them. */
const CONTENT_FLOW_SELECTOR = ".markdown-preview-sizer, .cm-sizer";

/**
 * The scrolling content element of a Markdown view, or null if this Obsidian
 * does not have one where we expect it. Exported for the safety test above.
 */
export function findContentFlowEl(containerEl: HTMLElement): HTMLElement | null {
  return containerEl.querySelector<HTMLElement>(CONTENT_FLOW_SELECTOR);
}

interface Mount {
  el: HTMLElement;
  panel: MentionsPanel;
  path: string;
}

export interface MentionsFooter {
  sync(): void;
  destroy(): void;
}

export function createMentionsFooter(plugin: JournalEntriesPlugin): MentionsFooter {
  /** Keyed by the view's containerEl, which is stable for a view's lifetime. */
  const mounts = new Map<HTMLElement, Mount>();

  function sync(): void {
    if (!plugin.settings.showMentionsUnderNotes) {
      unmountAll();
      return;
    }

    const live = new Set<HTMLElement>();

    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      // Since 1.7.2 Obsidian defers an unloaded tab's view, so a background
      // tab is not a `MarkdownView` and is skipped here for free. That is the
      // practical meaning of "visible views only" — Obsidian exposes no
      // public visibility predicate.
      if (!(view instanceof MarkdownView)) continue;

      const containerEl = view.containerEl;
      live.add(containerEl);

      const file = view.file;
      if (!(file instanceof TFile) || plugin.repository.isEntryFile(file)) {
        // A journal entry's own timeline already shows this, and rendering
        // entries inside an entry invites the recursion the code block has to
        // guard against.
        unmount(containerEl);
        continue;
      }

      const existing = mounts.get(containerEl);
      if (existing && existing.path === file.path) continue;
      unmount(containerEl);

      const hostEl = findContentFlowEl(containerEl);
      // RULE 1. Nothing more happens, ever, for this view.
      if (!hostEl) continue;

      const el = hostEl.createDiv({ cls: "journal-mentions-footer" });
      const panel = createMentionsPanel({ plugin, container: el, target: file });
      mounts.set(containerEl, { el, panel, path: file.path });
      void panel.render();
    }

    // A view that has gone away since the last sync — its tab was closed, or
    // its leaf was detached — leaves a mount behind that nothing will ever
    // reach again.
    for (const containerEl of [...mounts.keys()]) {
      if (!live.has(containerEl)) unmount(containerEl);
    }
  }

  function unmount(containerEl: HTMLElement): void {
    const mount = mounts.get(containerEl);
    if (!mount) return;
    mount.panel.destroy();
    mount.el.remove();
    mounts.delete(containerEl);
  }

  function unmountAll(): void {
    for (const containerEl of [...mounts.keys()]) unmount(containerEl);
  }

  return { sync, destroy: unmountAll };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/mentionsFooter.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into `main.ts`**

Add the import:

```ts
import { createMentionsFooter, type MentionsFooter } from "./mentions/mentionsFooter";
```

Change the placeholder field added in Task 6 to:

```ts
  private mentionsFooter: MentionsFooter | null = null;
```

In `onload()`, after `registerMentionsCodeBlock(this);`:

```ts
    this.mentionsFooter = createMentionsFooter(this);
    // Both events, not one: `active-leaf-change` covers switching tabs and
    // `layout-change` covers splitting, closing, and switching between
    // reading and live preview (which replaces the sizer element wholesale).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.mentionsFooter?.sync()),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.mentionsFooter?.sync()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.mentionsFooter?.sync()));
```

And in `onunload()`, replacing the current comment-only body:

```ts
  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically,
    // but the footer is a DOM node this plugin put inside somebody else's
    // view — nothing else will take it back out.
    this.mentionsFooter?.destroy();
    this.mentionsFooter = null;
  }
```

- [ ] **Step 6: Type-check and run the full suite**

Run: `npx tsc --noEmit --skipLibCheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mentions/mentionsFooter.ts tests/mentionsFooter.test.ts src/main.ts
git commit -m "feat(mentions): show mentions under notes, behind a guarded exception"
```

---

## Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/manual-testing.md`

- [ ] **Step 1: Add `# Mentions` to `CLAUDE.md`**

Insert a new section after `# Tags` and before `# Navigation`:

```markdown
---

# Mentions

A journal entry has no title. Inside the timeline that costs nothing — the
timestamp identifies the entry and the content is right there. Outside it,
the cost is real: Obsidian's backlinks pane lists a backlink by filename, and
this plugin's filenames are `2026-08-12-14-17-03`. A person note linked from
twenty entries shows twenty identical-looking timestamps and a snippet each.

So the plugin shows the entries themselves, with their content, in the
journal's own reverse-chronological shape, on the note they are about.

## Rule 1 — One query, source-blind

`mentions/mentionQuery.ts` is the one place "which entries mention this note?"
is answered, exactly as `entryDate.ts` owns chronology and `entryTags.ts` owns
tags. It draws no distinction between a body `[[link]]`, an embed, an aliased
link and a frontmatter `people: "[[link]]"` — Obsidian folds all four into
`resolvedLinks` before a plugin sees them, and treats them identically in
search, the graph and the backlinks pane. Nothing downstream may ask which
kind a reference was.

An unresolved link is not a mention. Neither is a plain-text occurrence of the
note's name: full-text matching is semantic search by another name.

Only journal entries are searched, never the vault. `getFileBacklinks` is
deliberately unused — it is absent from the installed type definitions, and it
answers the wrong, vault-sized question.

## Rule 2 — One renderer, three shells

`mentions/MentionsPanel.ts` renders. The code block, the note footer and the
sidebar view only supply a container and a target file. Three surfaces are not
three features, and a change to how mentions look is a change to one file.

## Rule 3 — Read-only

The panel renders entry content through `MarkdownRenderer` and never writes.
Clicking a timestamp hands the user back to the timeline via
`goToDateInJournal` — the same path the calendar uses.

Editing is what the timeline is for. Mounting live embedded editors inside an
arbitrary note would put the most data-critical code in this plugin behind a
code-block lifecycle nothing controls.

## The surfaces

`` ```simple-journal `` — a fenced block the user writes into a note. Empty
body means "the note I am in"; `note: [[Other]]` targets another. The language
string is permanent: it lives inside users' notes. **No setting gates it** — a
toggle would leave raw fences visible in notes already written, reading as
breakage, and the block is opt-in per note already.

The **sidebar** (`simple-journal-mentions`, fixed forever) follows the active
file. Its setting governs automatic placement only, exactly as the calendar's
policy does; the view type is always registered, and `Open journal mentions`
works regardless.

The **note footer** is off by default and is the internals exception below.

## The second internals exception

Obsidian exposes no public API for appending to a note's content flow.
Appending to the public `view.contentEl` pins the panel to the bottom of the
pane instead of the end of the note. The only way in is Obsidian's own layout
elements: `.markdown-preview-sizer` and `.cm-sizer`.

This is a deliberate, documented exception, granted on its own merits — the
editor exception under **Editing** explicitly licenses nothing else, and
neither does this one. Two rules make it safe, the same two:

1. **Feature detection with silent fallback is mandatory.** If the element is
   absent, `mentionsFooter.ts` does nothing at all: no throw, no notice, no
   console noise. The feature disappears; no note is altered. No one-time
   notice either — this surface is optional and off by default, so its absence
   degrades nothing the user depends on.
2. **All DOM assumptions live in `mentions/mentionsFooter.ts`.** The two class
   names appear in exactly one `querySelector` in the codebase. Retreating
   permanently, or moving to a future public API, is a one-file change.

`tests/mentionsFooter.test.ts` pins rule 1. It must not be deleted.
```

- [ ] **Step 2: Extend `# Navigation`'s command list in `CLAUDE.md`**

Under "Also implemented", add:

```text
Open journal mentions
Insert journal mentions block
```

- [ ] **Step 3: Extend `# Non-Goals` in `CLAUDE.md`**

Add:

```markdown
* filtering mentions by tag or by date range
* querying more than one note's mentions at a time
* a sort-order option for the mentions panel
* editing an entry from inside a mentions panel
* a "new entry mentioning this note" button
* counting plain-text occurrences as mentions
* replacing or modifying Obsidian's own backlinks pane
```

- [ ] **Step 4: Document the feature in `README.md`**

Add this section after the tags section, matching the surrounding heading level:

```markdown
## Mentions

Link a note from a journal entry — `[[Ekin Arslan Aytaç]]`, an embed, or a
frontmatter property like `people: "[[Ekin Arslan Aytaç]]"` — and you can read
those entries, in full, from that note.

Write this block anywhere in the note (the **Insert journal mentions block**
command does it for you):

    ```simple-journal
    ```

It lists every journal entry that links to the note it sits in, newest first,
grouped by day, with the entry's actual text rather than its filename. Add
`note: [[Some Other Note]]` inside the block to point it somewhere else.

Two optional settings put the same panel elsewhere:

- **Show mentions under notes** — appends it to the bottom of any note journal
  entries link to. Off by default.
- **Mentions sidebar** — keeps a panel in the sidebar that follows whatever
  note you are reading. Off by default; **Open journal mentions** opens it
  either way.

The panel is read-only. Click an entry's timestamp to jump to it in the
timeline, where you can edit it. A mention means a real link: a note whose name
merely appears as text is not one.
```

- [ ] **Step 5: Add the manual checks to `docs/manual-testing.md`**

```markdown
## Mentions

These are the checks only a real vault can make.

1. **Frontmatter links count.** Give a note `people: "[[Ekin Arslan Aytaç]]"`
   in its frontmatter and nothing in its body. It must appear in Ekin's
   mentions panel. This pins the one assumption `mentionQuery.ts` makes about
   Obsidian that no unit test can prove: that `resolvedLinks` includes
   frontmatter links. If this fails, the documented remedy is the explicit
   `cache.links` + `cache.embeds` + `cache.frontmatterLinks` scan.
2. **Embeds and aliases count.** `![[Ekin Arslan Aytaç]]` and
   `[[Ekin Arslan Aytaç|Ekin]]` both appear.
3. **The footer survives a view switch.** Turn on "Show mentions under notes",
   open a mentioned note, and switch between live preview and reading view
   several times. The panel appears in both, exactly once, at the end of the
   note's content, and scrolls with it.
4. **The footer is absent on journal entries.** Open an entry as a normal note.
   No panel.
5. **Turning the setting off removes it immediately**, without a reload.
6. **The sidebar follows the active note**, and turning `Mentions sidebar` off
   closes it rather than leaving it until restart.
7. **A nested block does not recurse.** Write a `simple-journal` block inside a
   journal entry, then view a note that entry mentions. The panel shows the
   entry with an inert placeholder where its block is, and Obsidian does not
   hang.
8. **Mobile.** UNVERIFIED, like the rest of this plugin's mobile code — see
   `CLAUDE.md`'s `# Target Platforms`. The footer's sizer lookup in particular
   has never run on a device.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/manual-testing.md
git commit -m "docs: document journal mentions and its internals exception"
```

---

## Task 9: Verification

**Files:** none

- [ ] **Step 1: Full type check and build**

Run: `npm run build`
Expected: no type errors, `main.js` written.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass, including the four new files.

- [ ] **Step 3: Timezone run**

Run: `npm run test:tz`
Expected: all tests pass. The panel groups by `dayKey` and formats with
`formatDayHeader`/`formatTime`, all of which are timezone-sensitive.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit anything the above changed**

```bash
git status
```

Expected: clean. If `npm run build` regenerated `main.js` and that file is
tracked, commit it:

```bash
git add main.js
git commit -m "build: rebuild for journal mentions"
```

- [ ] **Step 6: Manual pass**

Run `npm run sync` to install into the test vault, then work through the
"Mentions" section of `docs/manual-testing.md`. Item 1 is the one that can
send the design back to its documented fallback; do it first.
