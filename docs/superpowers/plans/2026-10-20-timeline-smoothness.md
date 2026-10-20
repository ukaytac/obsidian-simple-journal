# Timeline Smoothness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the iOS timeline from scrolling and loading by itself, by making the pager wait for real heights and a real scroll, and by keeping entry heights stable across mount, unmount and static renders.

**Architecture:** `renderStatic` reads through the cache, takes an optional known body, and holds the body's height across its swap. `mountEditor` reads before it tears the static body down; `unmountEditor` renders from the saved text. The pager awaits a page's renders before re-asking, and outside a burst only loads after `scrollTop` changed.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-20-timeline-smoothness-design.md`

**Ground rules for the implementer**

- Read `CLAUDE.md` § JournalView first. Do not change `openComposer`, `startNewEntry`, `reloadNow`'s ordering, `COMPOSER_FOCUS_CLAIM_MS`, or `MAX_BURST_PAGES`.
- Every new await is followed by the same `generation` (and, where present, `opToken`) checks the surrounding code uses. If you add an await, add the checks.
- Match the surrounding style: long doc comments that say *why*.
- Commands run from `/Users/utkuaytac/Documents/dev/obsidian-simple-journal`, on branch `perf/timeline-smoothness`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015vj5ANdwDBaoR8Phx9go7P
  ```

**Test harness facts** (`tests/journalViewHarness.ts`): `createHarness()`, `addEntry(h, date, body)`, `h.service.load()`, `await h.view.onOpen()`, `internals(view)` reaches privates, `settle()` advances fake timers by 0. Editors are `TextareaEditor`. `FakeIntersectionObserver.trigger([{ target, isIntersecting }])` fires a callback by hand; `unobserve`/`observe` do NOT fire anything by themselves. The mock `MarkdownRenderer.render` sets `el.textContent = markdown`. jsdom has no layout: `scrollHeight`, `clientHeight`, `scrollTop` and `offsetHeight` are 0 unless a test defines them with `Object.defineProperty`.

A held-read helper used below — add it once per test file that needs it:

```ts
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
```

## File map

| File | Change |
| --- | --- |
| `src/views/JournalView.ts` | `renderStatic(rendered, knownBody?)`; pager fields, gating, scroll listener, margin |
| `src/views/mountLifecycle.ts` | read-then-swap mount; unmount passes `savedBody`; `MountDeps.renderStatic` signature |
| `src/views/changeApplication.ts` | `refreshEntryContent` passes the body it read; deps signature |
| `src/views/timelineDom.ts` | `appendEntry` returns its render promise; deps signature |
| `styles.css` | `.journal-entry-body.is-pending` |
| `tests/JournalView.staticRender.test.ts` (new), `tests/JournalView.mountWindow.test.ts`, `tests/JournalView.paging.test.ts`, `tests/JournalView.changes.test.ts` | tests |
| `tests/obsidian-mock.ts` | `Component.registerDomEvent` |
| `docs/manual-testing.md` | five device checks |

---

### Task 1: `renderStatic` reads from the cache, holds its height, and marks a pending body

**Files:**
- Modify: `src/views/JournalView.ts` (`renderStatic`, around line 1928, and the three `renderStatic:` deps lambdas around lines 420, 445, 483)
- Modify: `src/views/timelineDom.ts`, `src/views/mountLifecycle.ts`, `src/views/changeApplication.ts` (the `renderStatic` member of each deps interface)
- Modify: `src/views/changeApplication.ts` (`refreshEntryContent`)
- Modify: `styles.css`
- Test: `tests/JournalView.staticRender.test.ts` (new), `tests/JournalView.changes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/JournalView.staticRender.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("JournalView static rendering", () => {
  it("reads entry bodies through the cached read, never the uncached one", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    const cached = vi.spyOn(h.repository, "readBodyCached");
    const uncached = vi.spyOn(h.repository, "readBody");

    await h.view.onOpen();
    await settle();

    expect(cached).toHaveBeenCalledTimes(1);
    expect(uncached).not.toHaveBeenCalled();
  });

  it("marks a body pending until its first render lands, then clears the mark", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });

    await h.view.onOpen();
    await settle();
    const bodyEl = internals(h.view).rendered.get(a.path).bodyEl as HTMLElement;
    expect(bodyEl.classList.contains("is-pending")).toBe(true);

    gate.release();
    await settle();

    expect(bodyEl.classList.contains("is-pending")).toBe(false);
    expect(bodyEl.textContent).toContain("alpha body");
  });

  it("leaves no min-height behind after a render", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const rendered = internals(h.view).rendered.get(a.path);
    Object.defineProperty(rendered.bodyEl, "offsetHeight", { configurable: true, value: 120 });

    await internals(h.view).renderStatic(rendered);

    expect((rendered.bodyEl as HTMLElement).style.minHeight).toBe("");
  });

  it("renders a known body without reading the file at all", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const rendered = internals(h.view).rendered.get(a.path);
    const cached = vi.spyOn(h.repository, "readBodyCached");
    const uncached = vi.spyOn(h.repository, "readBody");

    await internals(h.view).renderStatic(rendered, "known text");

    expect(cached).not.toHaveBeenCalled();
    expect(uncached).not.toHaveBeenCalled();
    expect((rendered.bodyEl as HTMLElement).textContent).toContain("known text");
  });
});
```

Append to `tests/JournalView.changes.test.ts` (reuse that file's imports; add `vi` if missing):

```ts
describe("external change to a statically rendered entry", () => {
  it("re-renders from the one uncached read it already made", async () => {
    const h = createHarness();
    const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "before");
    h.service.load();
    await h.view.onOpen();
    await settle();
    const cached = vi.spyOn(h.repository, "readBodyCached");
    const uncached = vi.spyOn(h.repository, "readBody");

    h.app.vault.contents.set(a.path, "after");
    h.app.vault.trigger("modify", a);
    vi.advanceTimersByTime(300);
    await settle();

    expect(uncached).toHaveBeenCalledTimes(1);
    expect(cached).not.toHaveBeenCalled();
    expect(internals(h.view).rendered.get(a.path).bodyEl.textContent).toContain("after");
  });
});
```

If `JournalView.changes.test.ts` builds entries differently, follow its conventions; the assertion is what matters: one `readBody`, zero `readBodyCached`, the new text on screen.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/JournalView.staticRender.test.ts tests/JournalView.changes.test.ts`
Expected: FAIL — the static render uses `readBody`, never adds `is-pending`, ignores a second argument, and the external refresh reads twice.

- [ ] **Step 3: Widen the `renderStatic` dependency signatures**

In each of the three deps interfaces, change the member to accept the optional body:

- `src/views/timelineDom.ts`: `renderStatic(rendered: DomRenderedEntry, knownBody?: string): Promise<void>;`
- `src/views/mountLifecycle.ts`: `renderStatic(target: MountEntry, knownBody?: string): Promise<void>;`
- `src/views/changeApplication.ts`: `renderStatic(rendered: ChangeEntry, knownBody?: string): Promise<void>;`

Extend each one's doc line with: "`knownBody`, when given, is rendered as is and nothing is read."

In `src/views/JournalView.ts`, change the three lambdas to forward it:

```ts
    renderStatic: (target, knownBody) => this.renderStatic(target as RenderedEntry, knownBody),
```

(use each lambda's own parameter name — `target` or `rendered` — as it is today).

- [ ] **Step 4: Rewrite `renderStatic`**

Replace the body of `private async renderStatic(rendered: RenderedEntry): Promise<void>` (keep and extend its doc comment) with:

```ts
  private async renderStatic(rendered: RenderedEntry, knownBody?: string): Promise<void> {
    const generation = this.generation;
    if (generation !== this.generation) return;
    const token = ++rendered.opToken;
    const bodyEl = rendered.bodyEl;

    // A body that has never shown anything gets a placeholder height until it
    // does (see `.journal-entry-body.is-pending` in styles.css). Without it a
    // fresh page is forty bare headers tall, and the pager's sentinel sits far
    // higher than it will once the bodies arrive.
    if (rendered.renderComponent === null && bodyEl.childElementCount === 0) {
      bodyEl.addClass("is-pending");
    }

    // Cached: this only displays, and nothing read here is ever written back.
    // The editor's baseline keeps coming from the uncached `readBody` in
    // `mountEditor`, which is what the save path's dirty check relies on.
    const body = knownBody ?? (await this.plugin.repository.readBodyCached(rendered.entry.file));
    // Re-check both: a reload may have landed while reading (generation), or
    // `mountEditor` / a newer render may have taken this entry over (opToken).
    // Nothing has been touched yet, so bailing leaves whatever is on screen.
    if (generation !== this.generation) return;
    if (token !== rendered.opToken) return;

    // Read first, swap second, and hold the height across the swap: emptying
    // the body collapses it to nothing until the render lands, and on iOS —
    // no scroll anchoring — every collapse above the viewport moves the text
    // the user is reading.
    const height = bodyEl.offsetHeight;
    if (height > 0) bodyEl.style.minHeight = `${height}px`;

    rendered.renderComponent?.unload();
    bodyEl.empty();
    const component = new Component();
    component.load();
    rendered.renderComponent = component;

    try {
      // `body` is already separator-free (EntryRepository's job). Shared with
      // the mentions panel (see `normalizeBodyForRender`).
      await MarkdownRenderer.render(
        this.app,
        normalizeBodyForRender(body),
        bodyEl,
        rendered.entry.file.path,
        component,
      );
    } finally {
      // Only the operation that still owns the body clears its marks; one that
      // superseded this has already set them the way it needs them.
      if (token === rendered.opToken) {
        bodyEl.style.removeProperty("min-height");
        bodyEl.removeClass("is-pending");
      }
    }
  }
```

Delete the old comment block about bailing "WITHOUT unloading the `component` just created" — the component is now created only after the guards, so there is nothing to leak.

- [ ] **Step 5: `refreshEntryContent` renders the body it already read**

In `src/views/changeApplication.ts`, `refreshEntryContent`, change the last line from `await deps.renderStatic(rendered);` to:

```ts
    // The uncached read above is the one that saw the external change; render
    // exactly that, rather than reading a second time through the cache.
    await deps.renderStatic(rendered, body);
```

- [ ] **Step 6: The placeholder style**

In `styles.css`, directly after the `.journal-entry-body` rule (around line 214), add:

```css
/* A body whose first render has not landed yet. Roughly three lines, so the
   timeline is close to its real height before the bodies arrive and the
   pager's sentinel is not pulled into view by forty empty rows. Removed by
   `renderStatic` the moment the render lands. */
.journal-entry-body.is-pending {
  min-height: 4.5em;
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/JournalView.staticRender.test.ts tests/JournalView.changes.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS. If a pre-existing test spied on `readBody` to observe a *static* render, it pinned the old read; switch its spy to `readBodyCached` and say so in the commit message. Do not touch a test that observes `readBody` for a mount or an external change.

- [ ] **Step 8: Commit**

```bash
git add src/views/JournalView.ts src/views/timelineDom.ts src/views/mountLifecycle.ts src/views/changeApplication.ts styles.css tests/JournalView.staticRender.test.ts tests/JournalView.changes.test.ts
git commit -m "perf: static renders read from the cache and hold their height"
```

---

### Task 2: Mount reads before it swaps; unmount renders from the saved text

**Files:**
- Modify: `src/views/mountLifecycle.ts` (`mountEditor` around line 280, `unmountEditor` around line 450)
- Test: `tests/JournalView.mountWindow.test.ts`

- [ ] **Step 1: Write the failing tests**

Add the `deferred` helper to `tests/JournalView.mountWindow.test.ts` and append, inside the main describe:

```ts
  describe("heights across a mount and an unmount", () => {
    it("keeps the static body on screen while the editor's read is in flight", async () => {
      const h = createHarness();
      const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
      h.service.load();
      await h.view.onOpen();
      await settle();
      const rendered = internals(h.view).rendered.get(a.path);
      const gate = deferred();
      const real = h.repository.readBody.bind(h.repository);
      vi.spyOn(h.repository, "readBody").mockImplementation(async (file) => {
        await gate.promise;
        return real(file);
      });

      (internals(h.view).mountObserver as FakeIntersectionObserver).trigger([
        { target: rendered.el, isIntersecting: true },
      ]);
      await settle();
      expect(rendered.bodyEl.textContent).toContain("alpha body");
      expect(rendered.bodyEl.querySelector("textarea")).toBeNull();

      gate.release();
      await settle();
      expect(rendered.editor).not.toBeNull();
    });

    it("leaves the static body alone when the entry leaves the margin mid-read", async () => {
      const h = createHarness();
      const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
      h.service.load();
      await h.view.onOpen();
      await settle();
      const rendered = internals(h.view).rendered.get(a.path);
      const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
      const gate = deferred();
      const real = h.repository.readBody.bind(h.repository);
      vi.spyOn(h.repository, "readBody").mockImplementation(async (file) => {
        await gate.promise;
        return real(file);
      });
      const cached = vi.spyOn(h.repository, "readBodyCached");

      mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
      await settle();
      mountObserver.trigger([{ target: rendered.el, isIntersecting: false }]);
      gate.release();
      await settle();

      expect(rendered.editor).toBeNull();
      expect(rendered.bodyEl.textContent).toContain("alpha body");
      expect(cached).not.toHaveBeenCalled();
    });

    it("renders the saved text on unmount without reading the file", async () => {
      const h = createHarness();
      const a = addEntry(h, new Date(2026, 7, 12, 9, 0, 0), "alpha body");
      h.service.load();
      await h.view.onOpen();
      await settle();
      const rendered = internals(h.view).rendered.get(a.path);
      const mountObserver = internals(h.view).mountObserver as FakeIntersectionObserver;
      mountObserver.trigger([{ target: rendered.el, isIntersecting: true }]);
      await settle();
      const cached = vi.spyOn(h.repository, "readBodyCached");
      const uncached = vi.spyOn(h.repository, "readBody");

      mountObserver.trigger([{ target: rendered.el, isIntersecting: false }]);
      await settle();

      expect(rendered.editor).toBeNull();
      expect(cached).not.toHaveBeenCalled();
      expect(uncached).not.toHaveBeenCalled();
      expect(rendered.bodyEl.textContent).toContain("alpha body");
    });
  });
```

Add `vi.restoreAllMocks();` to this file's `afterEach` if it is not there.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/JournalView.mountWindow.test.ts -t "heights across"`
Expected: FAIL — the body is emptied before the read, the "left mid-read" branch re-renders through a read, and unmount re-reads.

- [ ] **Step 3: Rewrite the start of `mountEditor`**

Replace, in `mountEditor`, everything from `const token = ++target.opToken;` down to (and including) the `if (!target.intersecting) { … return; }` block with:

```ts
    const token = ++target.opToken;

    // Read first, swap second. The static body stays on screen for the whole
    // read: emptying it first left the entry zero pixels tall for a bridge
    // round-trip on iOS, and with no scroll anchoring there every such
    // collapse above the viewport moved the text being read.
    const body = await deps.readBody(target.entry.file);
    if (generation !== deps.getGeneration()) return;
    if (token !== target.opToken) return;
    if (target.editor) return;

    if (!target.intersecting) {
      // Left MOUNT_ROOT_MARGIN while this was reading the file. The
      // observer's exit transition already fired and called unmountEditor,
      // which no-opped (target.editor was still null), and no further
      // callback arrives until another transition — so this must not mount.
      // The static body is untouched and still showing; only a row whose
      // first static render this mount pre-empted (bumping opToken above)
      // has nothing on screen, and gets the text just read.
      if (target.renderComponent === null) void deps.renderStatic(target, body);
      return;
    }

    target.renderComponent?.unload();
    target.renderComponent = null;
    target.bodyEl.empty();
    target.bodyEl.style.removeProperty("min-height");
    target.bodyEl.removeClass("is-pending");
```

Everything after it (`const editor = mountUsableEditor(target, body);` onwards) is unchanged. Update the function's doc comment: the sentence describing it clearing the body before reading now says it reads first and swaps in one synchronous step.

- [ ] **Step 4: Unmount renders `savedBody`**

In `unmountEditor`, replace:

```ts
    await deps.renderStatic(target);
    target.bodyEl.style.removeProperty("min-height");
```

with:

```ts
    // `isDirty` just returned false, so the editor's text equals `savedBody`,
    // which is what disk holds. Rendering it directly skips a read and its
    // wait — the gap in which the frozen height above was all that kept the
    // row from collapsing.
    await deps.renderStatic(target, target.savedBody);
    target.bodyEl.style.removeProperty("min-height");
```

Also update the comment in the dirty-check branch that says "falling back to `renderStatic`'s disk read" to "falling back to a static render of the last saved body".

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/JournalView.mountWindow.test.ts tests/JournalView.raceGuards.test.ts tests/JournalView.rekeyRace.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/mountLifecycle.ts tests/JournalView.mountWindow.test.ts
git commit -m "perf: mounting reads before it swaps, unmounting renders the saved text"
```

---

### Task 3: The pager waits for a page's bodies before re-asking

**Files:**
- Modify: `src/views/timelineDom.ts` (`appendEntry`, around line 236)
- Modify: `src/views/JournalView.ts` (`appendEntry` wrapper ~1226, `loadNextPage` ~940, `onSentinelVisible` ~1099, a new field)
- Test: `tests/JournalView.paging.test.ts`

- [ ] **Step 1: Write the failing test**

Add the `deferred` helper to `tests/JournalView.paging.test.ts` and append inside `describe("JournalView paging", …)`:

```ts
  it("does not re-ask the sentinel until the new page's bodies have rendered", async () => {
    const h = createHarness();
    seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 100);
    h.service.load();
    await h.view.onOpen();
    await settle();

    const gate = deferred();
    const real = h.repository.readBodyCached.bind(h.repository);
    vi.spyOn(h.repository, "readBodyCached").mockImplementation(async (file) => {
      await gate.promise;
      return real(file);
    });
    const observer = internals(h.view).observer as FakeIntersectionObserver;
    const reobserve = vi.spyOn(observer, "observe");

    observer.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
    await settle();
    expect(internals(h.view).rendered.size).toBe(80);
    expect(reobserve).not.toHaveBeenCalled();

    gate.release();
    await settle();
    expect(reobserve).toHaveBeenCalledTimes(1);
  });
```

Add `vi.restoreAllMocks();` to this file's `afterEach`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/JournalView.paging.test.ts -t "re-ask the sentinel"`
Expected: FAIL — the re-observe happens straight after the append.

- [ ] **Step 3: `appendEntry` returns its render**

In `src/views/timelineDom.ts`, change `appendEntry` to return the promise, and its interface entry (if the module exports an interface for its returned functions) to `appendEntry(entry: JournalEntry): Promise<void>;`:

```ts
  function appendEntry(entry: JournalEntry): Promise<void> {
    if (deps.hasRendered(entry.file.path)) return Promise.resolve();

    const group = ensureDayGroup(entry.created, "append");
    const rendered = deps.createEntryEl(entry);
    group.appendChild(rendered.el);
    deps.setRendered(entry.file.path, rendered);
    const renderedStatic = deps.renderStatic(rendered);
    deps.observeForMount(rendered.el);
    return renderedStatic;
  }
```

Add one sentence to its doc: "Returns the static render it starts, so the pager can wait for real heights (see `JournalView.onSentinelVisible`)."

In `src/views/JournalView.ts`:

```ts
  private appendEntry(entry: JournalEntry): Promise<void> {
    return this.timelineDom.appendEntry(entry);
  }
```

- [ ] **Step 4: `loadNextPage` records the page's renders**

Add a field next to `burstCount`:

```ts
  /**
   * The static renders of the page `loadNextPage` appended last.
   * `onSentinelVisible` waits for them before re-asking the sentinel, so the
   * question "is it still in range?" is answered against real heights rather
   * than a page of empty rows.
   */
  private lastPageRendered: Promise<unknown> = Promise.resolve();
```

In `loadNextPage`, replace the append loop:

```ts
      for (const entry of page) {
        if (generation !== this.generation) return "exhausted";
        this.appendEntry(entry);
      }
```

with:

```ts
      const renders: Promise<void>[] = [];
      for (const entry of page) {
        if (generation !== this.generation) return "exhausted";
        renders.push(this.appendEntry(entry));
      }
      this.lastPageRendered = Promise.allSettled(renders);
```

- [ ] **Step 5: `onSentinelVisible` waits before the forced re-observe**

In `onSentinelVisible`, just before `if (this.burstCount >= MAX_BURST_PAGES) {`, insert:

```ts
    // Re-asking straight after the append measured forty empty rows and
    // loaded another page, and another — the iOS "scrolls by itself" bug.
    // The renders settle (allSettled), so a failed read only ends the wait.
    await this.lastPageRendered;
    if (generation !== this.generation) return;
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/JournalView.paging.test.ts`
Expected: PASS, including the pre-existing paging tests (they call `settle()`, which lets the renders finish).

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/views/timelineDom.ts src/views/JournalView.ts tests/JournalView.paging.test.ts
git commit -m "fix: the pager waits for a page's bodies before re-asking the sentinel"
```

---

### Task 4: A new burst needs a real scroll

**Files:**
- Modify: `src/views/JournalView.ts` (new fields, `installSentinel`, the sentinel observer callback, `onSentinelVisible`, `onOpen`)
- Test: `tests/JournalView.paging.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("JournalView paging", …)`:

```ts
  describe("a new burst needs a real scroll", () => {
    /** Gives the scroll container a size, so it overflows like a real one. */
    function overflowing(view: ReturnType<typeof createHarness>["view"], scrollTop = 0): HTMLElement {
      const el = internals(view).contentEl as HTMLElement;
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 5000 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
      Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: scrollTop });
      return el;
    }

    async function openWithTwoPages() {
      const h = createHarness();
      seedHourly(h, new Date(2026, 7, 12, 0, 0, 0), 200);
      h.service.load();
      await h.view.onOpen();
      await settle();
      const contentEl = overflowing(h.view);
      const observer = internals(h.view).observer as FakeIntersectionObserver;
      const sentinelEl = internals(h.view).sentinelEl as HTMLElement;
      // The first callback after a reload is always allowed.
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();
      // The forced re-observe found it out of range: the burst ends.
      observer.trigger([{ target: sentinelEl, isIntersecting: false }]);
      await settle();
      expect(internals(h.view).rendered.size).toBe(80);
      return { h, contentEl, observer, sentinelEl };
    }

    it("ignores a re-entry nobody scrolled for", async () => {
      const { h, observer, sentinelEl } = await openWithTwoPages();

      // Heights changed and carried the sentinel back into range.
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });

    it("loads on the next scroll once one happens", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      contentEl.scrollTop = 400;
      contentEl.dispatchEvent(new Event("scroll"));
      await settle();

      expect(internals(h.view).rendered.size).toBe(120);
    });

    it("a scroll after the sentinel left again loads nothing", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();
      observer.trigger([{ target: sentinelEl, isIntersecting: false }]);
      await settle();

      contentEl.scrollTop = 400;
      contentEl.dispatchEvent(new Event("scroll"));
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });

    it("loads without a scroll when the content does not fill the pane", async () => {
      const { h, contentEl, observer, sentinelEl } = await openWithTwoPages();
      Object.defineProperty(contentEl, "scrollHeight", { configurable: true, value: 600 });

      observer.trigger([{ target: sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(120);
    });

    it("a reload allows the first callback again", async () => {
      const { h } = await openWithTwoPages();
      await h.view.reload();
      await settle();
      overflowing(h.view);
      const observer = internals(h.view).observer as FakeIntersectionObserver;

      observer.trigger([{ target: internals(h.view).sentinelEl, isIntersecting: true }]);
      await settle();

      expect(internals(h.view).rendered.size).toBe(80);
    });
  });
```

If `h.view.reload` is not the public name of the reload entry point, use the one `refreshJournal` in `src/main.ts` calls.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/JournalView.paging.test.ts -t "real scroll"`
Expected: FAIL on "ignores a re-entry nobody scrolled for" (it loads today) and "loads on the next scroll" (nothing listens for scroll). The other three may already pass; they guard the change.

- [ ] **Step 3: Fields**

Next to `lastPageRendered`, add:

```ts
  /**
   * `contentEl.scrollTop` when the last page finished loading, or null right
   * after a reload. Outside a burst, a sentinel that comes back into range is
   * only believed if this changed — see `mayStartBurst`.
   */
  private scrollTopAtLastLoad: number | null = null;
  /** The sentinel's last reported intersection, for the scroll listener. */
  private sentinelIntersecting = false;
  /** A load `mayStartBurst` held back until the user next scrolls. */
  private loadWaitingForScroll = false;
  /** `onSentinelVisible` is between its start and its end. */
  private sentinelLoadInFlight = false;
```

- [ ] **Step 4: Reset them with the sentinel**

In `installSentinel`, next to `this.forcedReobserve = false; this.burstCount = 0;`, add:

```ts
    this.scrollTopAtLastLoad = null;
    this.sentinelIntersecting = false;
    this.loadWaitingForScroll = false;
```

and the same three lines in `teardownSentinel` next to its existing resets.

- [ ] **Step 5: Gate the observer callback**

Replace the observer callback body:

```ts
        const isBurstContinuation = this.forcedReobserve;
        this.forcedReobserve = false;

        if (!entries.some((e) => e.isIntersecting)) return;
        void this.onSentinelVisible(isBurstContinuation);
```

with (keep the existing comment above it):

```ts
        const isBurstContinuation = this.forcedReobserve;
        this.forcedReobserve = false;

        this.sentinelIntersecting = entries.some((e) => e.isIntersecting);
        if (!this.sentinelIntersecting) {
          this.loadWaitingForScroll = false;
          return;
        }
        if (!isBurstContinuation) {
          // A load already running ends with its own forced re-observe, which
          // asks this question again with settled heights.
          if (this.sentinelLoadInFlight) return;
          if (!this.mayStartBurst()) {
            this.loadWaitingForScroll = true;
            return;
          }
        }
        void this.onSentinelVisible(isBurstContinuation);
```

- [ ] **Step 6: `mayStartBurst` and the scroll handler**

Add next to `onSentinelVisible`:

```ts
  /**
   * Whether a sentinel that came back into range outside a burst may start
   * one. Heights changing — a body filling in, an editor mounting — move the
   * sentinel without anyone scrolling; on iOS that read as a user scroll and
   * started a fresh ten-page burst with no finger on the screen.
   *
   * So: only when the user actually scrolled since the last load, or right
   * after a reload, or when the content does not even fill the pane (there is
   * nothing to scroll, and refusing would stall loading for good).
   * Programmatic scrolls (a calendar jump) change `scrollTop` too, and pass.
   */
  private mayStartBurst(): boolean {
    if (this.scrollTopAtLastLoad === null) return true;
    const el = this.contentEl;
    if (el.scrollHeight <= el.clientHeight) return true;
    return el.scrollTop !== this.scrollTopAtLastLoad;
  }

  /** Runs the load `mayStartBurst` held back, on the first scroll that counts. */
  private onTimelineScroll(): void {
    if (!this.loadWaitingForScroll || !this.sentinelIntersecting) return;
    if (this.sentinelLoadInFlight) return;
    if (!this.mayStartBurst()) return;
    this.loadWaitingForScroll = false;
    void this.onSentinelVisible(false);
  }
```

In `onOpen`, where the view's other DOM listeners are registered (search for the first `this.registerDomEvent(` in `onOpen`; if there is none, put it right after `contentEl` is set up), add:

```ts
    // Passive: this only reads `scrollTop`, and must never delay a scroll.
    this.registerDomEvent(this.contentEl, "scroll", () => this.onTimelineScroll(), { passive: true });
```

`registerDomEvent` is real `Component` API, but `tests/obsidian-mock.ts`'s `Component` does not have it yet. Add it there, matching the real contract (listener attached now, removed on `unload()`), following how that class already implements `register`/`registerEvent`:

```ts
  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: (evt: Event) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback as EventListener, options);
    this.register(() => el.removeEventListener(type, callback as EventListener, options));
  }
```

If the mock `Component` has no `register(cb)` to hang the removal on, use whatever list it keeps for `registerEvent` cleanup.

- [ ] **Step 7: Mark the load in flight, and remember where it ended**

In `onSentinelVisible`:

1. At the very top, after `const generation = this.generation;`, set `this.sentinelLoadInFlight = true;` and wrap the rest of the body in `try { … } finally { if (generation === this.generation) this.sentinelLoadInFlight = false; }`. On a generation change `installSentinel` already reset state for the new timeline, so a stale call must not clear the new one's flag — reset `this.sentinelLoadInFlight = false;` in `installSentinel` and `teardownSentinel` too.
2. Right after the `await this.lastPageRendered;` + generation check added in Task 3, add:

```ts
    this.scrollTopAtLastLoad = this.contentEl.scrollTop;
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/JournalView.paging.test.ts tests/JournalView.raceGuards.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS. Pre-existing tests run with jsdom's zero sizes, where `scrollHeight <= clientHeight` holds, so they are allowed exactly as before.

- [ ] **Step 9: Commit**

```bash
git add src/views/JournalView.ts tests/JournalView.paging.test.ts
git commit -m "fix: outside a burst, the pager loads only after a real scroll"
```

---

### Task 5: A smaller mobile margin for the sentinel

**Files:**
- Modify: `src/views/JournalView.ts` (the sentinel observer's `rootMargin`, around line 1080)

- [ ] **Step 1: Change it**

Replace:

```ts
        // Start loading before the sentinel is actually on screen. Mobile
        // scrolls more slowly and repaints later, so start earlier there.
        rootMargin: Platform.isMobile ? "1200px 0px" : "600px 0px",
```

with:

```ts
        // Start loading before the sentinel is actually on screen. Mobile
        // starts a little earlier, but only by about one phone screen: at
        // 1200px a freshly appended page of short rows still sat inside the
        // margin, which is half of how the iOS timeline came to load — and
        // scroll — by itself.
        rootMargin: Platform.isMobile ? "800px 0px" : "600px 0px",
```

- [ ] **Step 2: Verify and commit**

Run: `npm test` — Expected: PASS.

```bash
git add src/views/JournalView.ts
git commit -m "perf: the mobile sentinel margin is one screen, not one and a half"
```

---

### Task 6: Verify, document, hand to the device

**Files:**
- Modify: `docs/manual-testing.md`, `docs/superpowers/specs/2026-10-20-timeline-smoothness-design.md`

- [ ] **Step 1: Full verification**

```bash
npm run build
npm test
npm run test:tz
npm run lint
```

Expected: all four succeed. Fix anything that fails before continuing.

- [ ] **Step 2: Add the device checks**

In `docs/manual-testing.md`, directly after the "Index and background work" section, add:

```markdown
## Timeline smoothness on iOS — needs the phone

Open, because the timeline-smoothness pass (spec
`docs/superpowers/specs/2026-10-20-timeline-smoothness-design.md`) exists for a
bug only a device showed: the journal scrolling, and loading, by itself. The
unit tests prove the pager asks the right questions; only the phone can say
the answers come out right.

- [ ] **1. Hands off.** Open the journal and leave the screen alone for ten
      seconds: nothing scrolls, and older entries do not keep loading.
- [ ] **2. Slow scroll.** Scroll down slowly and continuously: pages keep
      arriving, and loading never stalls.
- [ ] **3. Flick and stop.** Flick hard, then stop: the text does not jump
      after it stops.
- [ ] **4. Tap to edit.** Tap an entry: the text does not move while its editor
      opens.
- [ ] **5. New entry.** Run **New journal entry**: the composer opens with the
      caret in it, exactly as before.
```

- [ ] **Step 3: Mark the spec implemented**

Change its `**Status:**` line to `**Status:** approved, implemented — awaiting the device check`.

- [ ] **Step 4: Commit**

```bash
git add docs/manual-testing.md docs/superpowers/specs/2026-10-20-timeline-smoothness-design.md
git commit -m "docs: device checks for timeline smoothness"
```

- [ ] **Step 5: Hand to the user**

Run `npm run build`, then tell the user to sync the build to the phone (`npm run sync`, or however they normally get it there) and run checks 1–5. If check 1 fails, gather what they see before changing anything.
