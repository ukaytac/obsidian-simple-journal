// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle, tagEntry } from "./journalViewHarness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Dispatches a real input event with `inputType` set, as a live editor produces. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
}

function composerTextarea(view: ReturnType<typeof createHarness>["view"]): HTMLTextAreaElement {
  const textarea = internals(view).composer?.bodyEl.querySelector("textarea");
  if (!textarea) throw new Error("no composer textarea mounted");
  return textarea as HTMLTextAreaElement;
}

describe("JournalView composer lifecycle", () => {
  it("opens an uncommitted composer at the top of today, with no file created yet", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();

    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();
    expect(h.app.vault.files.size).toBe(0);

    const composerEl = internals(h.view).timelineEl.querySelector(".journal-entry-composer") as HTMLElement | null;
    expect(composerEl).toBeTruthy();
    // No entry yet to act on: both affordances start disabled/hidden (see
    // `createEntryEl`'s doc), and `commitComposer` is what turns them on.
    expect(composerEl!.querySelector<HTMLButtonElement>(".journal-entry-time")!.disabled).toBe(true);
    expect(
      composerEl!.querySelector(".journal-entry-actions")!.classList.contains("journal-entry-actions-pending"),
    ).toBe(true);
  });

  it("the very first meaningful keystroke commits a real, titleless Markdown file", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    typeInto(composerTextarea(h.view), "First thought of the day");
    await settle();
    await settle();

    expect(h.app.vault.files.size).toBe(1);
    const [path] = h.app.vault.files.keys();
    expect(h.app.vault.contents.get(path)).toContain("First thought of the day");
    // No `# Heading` was injected — CLAUDE.md's "no titles" requirement.
    expect(h.app.vault.contents.get(path)).not.toMatch(/^#/m);

    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).rendered.has(path)).toBe(true);
    const rowEl = internals(h.view).timelineEl.querySelector(`[data-path="${path}"]`);
    expect(rowEl?.classList.contains("journal-entry-composer")).toBe(false);
  });

  it("abandoning a composer after typing something non-meaningful removes it and creates no file", async () => {
    // Whitespace, deliberately: `isMeaningful` ("value.trim().length > 0")
    // never treats it as real content, so this exercises input-then-blur
    // without ever crossing `onComposerInput`'s commit threshold — typing
    // genuinely meaningful text instead would commit a real file on that
    // very keystroke (Lazy Creation has no "clear it back out" undo once
    // that happens), which is a different scenario from the one
    // `discardEmptyComposer` exists for. A blur alone (see the test below)
    // is not abandonment; abandonment is specifically "the user put a
    // keystroke in here, then left with nothing worth keeping" (see
    // `composerHasInput`'s doc).
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    const textarea = composerTextarea(h.view);
    typeInto(textarea, "   ");
    typeInto(textarea, "");
    textarea.blur();
    await settle();

    expect(internals(h.view).composer).toBeNull();
    expect(h.app.vault.files.size).toBe(0);
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeNull();
  });

  it("abandoning an empty composer into an otherwise-empty scoped timeline keeps naming the scope", async () => {
    // Regression test: `discardEmptyComposer` used to call `renderEmptyState()`
    // with no arguments, which always renders the generic "no journal entries
    // yet" message — wrong here on two counts: the journal is not empty (a
    // tag scope is excluding everything), and that is exactly the situation
    // the scoped message exists to explain.
    //
    // The composer is opened BEFORE scoping, then carried through the scope's
    // reload by `reestablishComposer`: since Task 13, `startNewEntry` clears
    // an active scope (see its doc) exactly as it already cleared an active
    // anchor, so scoping first would unscope the view again on the very next
    // `startNewEntry` and there would be nothing left to blame.
    const h = createHarness();
    const other = addEntry(h, new Date(2026, 7, 12, 9, 0, 0));
    tagEntry(h, other, ["work"]);
    h.service.load();
    await h.view.onOpen();

    await h.view.startNewEntry();
    await h.view.setTagScope("therapy");

    const textarea = composerTextarea(h.view);
    typeInto(textarea, "   ");
    typeInto(textarea, "");
    textarea.blur();
    await settle();

    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-empty")?.textContent).toBe(
      "No entries tagged #therapy.",
    );
  });

  it("abandoning an empty composer into an anchored, unscoped timeline blames the anchor", async () => {
    // The other half of `discardEmptyComposer`'s `(this.anchorDate !== null,
    // this.tagScope)`. The scoped half is covered above; without this one,
    // passing `anchorDate` at all could be dropped and only the generic "no
    // journal entries yet" message would ever be asserted.
    //
    // The composer is opened BEFORE anchoring, then carried through the
    // anchor's reload by `reestablishComposer`: `startNewEntry` clears an
    // active anchor (see its doc), so anchoring first would un-anchor the
    // view again and there would be nothing to blame.
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 12, 9, 0, 0));
    h.service.load();
    await h.view.onOpen();

    await h.view.startNewEntry();
    // Older than the only entry, so the anchor excludes it and the timeline
    // holds nothing but the composer.
    await h.view.goToDate(new Date(2026, 7, 10, 23, 59, 59));

    const textarea = composerTextarea(h.view);
    typeInto(textarea, "   ");
    typeInto(textarea, "");
    textarea.blur();
    await settle();

    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-empty")?.textContent).toBe(
      "Nothing on or before this date.",
    );
  });

  it("a blur that never received any input does not discard the composer, even after a genuine focus", async () => {
    // The real-world bug this pins: `openComposer` itself calls
    // `editor.focus()` synchronously as part of `startNewEntry()`, so by the
    // time it returns here, focus has genuinely landed on the composer at
    // least once — `composerEverFocused` is true. In a real Obsidian window,
    // activating the freshly opened leaf then routinely takes that focus
    // back immediately afterward, firing exactly the blur dispatched below,
    // before the user has typed a single character. Gating the discard on
    // `composerEverFocused` (an earlier fix for a related but distinct bug)
    // discarded the composer right here, on activation churn nobody asked
    // for; gating on `composerHasInput` does not, since nothing was ever
    // typed. Without this gate, `discardEmptyComposer` would run and this
    // assertion would fail.
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();
    expect(internals(h.view).composerEverFocused).toBe(true);
    expect(internals(h.view).composerHasInput).toBe(false);

    composerTextarea(h.view).dispatchEvent(new FocusEvent("blur"));
    await settle();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });

  /**
   * Pins the fix for the "composer bug": `clearTimeline` (run by every
   * `reload()`, including one triggered by something entirely unrelated to
   * the composer — a settings change, a folder-rename `"reload"` change, or
   * `onOpen`'s own first `reload()` landing after `startNewEntry` already
   * opened one) used to unconditionally destroy an open, uncommitted
   * composer. `reloadNow` now snapshots it via `clearTimeline`'s return
   * value and re-establishes it afterwards (`reestablishComposer`), so an
   * unrelated background reload can no longer silently sweep it away.
   */
  it("a reload triggered by something unrelated does not discard an open, empty composer", async () => {
    const h = createHarness();
    addEntry(h, new Date(2026, 7, 1, 9, 0, 0), "pre-existing entry");
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();

    // A reload triggered for a reason that has nothing to do with the
    // composer itself (e.g. the settings tab's debounced `refreshJournal`).
    await h.view.reload();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });

  /**
   * Reproduces the user's actual reported path as faithfully as this harness
   * can: "journal not open, `New journal entry` hotkey pressed from another
   * note." `main.ts`'s `newEntry()` is `await this.openJournal(); await
   * view.startNewEntry();`, and `openJournal()`'s doc already flags the
   * hazard under test — `setViewState` resolving does not guarantee
   * `JournalView.onOpen()` has run, let alone finished (`initialLoad`'s doc
   * says the same from the other side).
   *
   * This harness cannot drive that literally: `obsidian-mock.ts`'s `Plugin`
   * is an empty stub with no `getLeaf`, and while its `FakeWorkspace`/
   * `WorkspaceLeaf` do now carry `setViewState`/`revealLeaf` (added for the
   * mentions sidebar's tests), `setViewState` there only records a view
   * state — it builds no view, precisely because doing so faithfully would
   * mean guessing at real Obsidian's closed-source leaf-opening scheduling
   * — exactly the kind
   * of unverified assumption behind the two already-wrong fixes this bug
   * survived (Context7's official API docs describe only that `setViewState`
   * "resolves when the view state has been updated" and `onOpen()` "resolves
   * when the opening process is complete," and say nothing about exact
   * timing or re-invocation), so this deliberately does not go through
   * `main.ts`.
   *
   * Instead it exercises the one adjacent fact the codebase already commits
   * to in its own comments — `JournalView.onOpen can run more than once over
   * a view's life` (see the ribbon "+" action's registration comment) — by
   * calling `onOpen()` a second time after a composer is already open, the
   * same way Obsidian re-invoking it on this instance would. This is a
   * genuine, independently-reachable trigger for the same `clearTimeline`
   * defect the test above pins, not a restatement of it; it is NOT proof
   * that a second `onOpen()` call is what the user's own trace would show —
   * only that if the timing hazard `openJournal`'s doc describes manifests
   * as *any* extra reload landing after `startNewEntry` succeeds (a second
   * `onOpen`, a deferred-leaf hydration, a revealLeaf-triggered refresh —
   * this harness cannot distinguish between them), the fix below is what
   * makes the composer survive it regardless of which one it is.
   */
  it("a composer survives onOpen running again over the view's life", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    expect(internals(h.view).composer).not.toBeNull();

    // Obsidian re-invoking onOpen() on the same view instance later in its
    // life — not a reload the plugin itself chose to trigger.
    await h.view.onOpen();

    expect(internals(h.view).composer).not.toBeNull();
    expect(internals(h.view).timelineEl.querySelector(".journal-entry-composer")).toBeTruthy();
  });

  /**
   * A composer surviving a reload is only half the fix: if it held
   * meaningful text, leaving it re-established but still fileless would just
   * trade "destroyed outright" for "sits uncommitted indefinitely, kept
   * alive only for as long as some later reload happens to re-snapshot it"
   * (`TextareaEditor.mount`'s `initialValue` deliberately does not fire the
   * change callback `onComposerInput` listens on, so nothing else would ever
   * commit it). `reestablishComposer` commits it immediately instead.
   *
   * Reaches a still-open, not-yet-claimed composer holding meaningful text
   * via `editor.setValue` (which — same as `initialValue` above — does not
   * fire the change callback) rather than a real keystroke: a real keystroke
   * claims (`this.composer = null`) synchronously the instant its content
   * becomes meaningful, so `this.composer` itself can only ever hold
   * meaningful, uncommitted text via a path that sets it without going
   * through that claim — `commitComposer`'s own createEntry-failure retry
   * (`this.composer = rendered` with the same still-meaningful text still in
   * it) is the real one; `setValue` reaches the same state directly.
   */
  it("a reload commits a still-open composer's meaningful text instead of leaving it stranded, keeping its original creation time", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    const composer = internals(h.view).composer;
    const originalCreated = new Date(composer.entry.created.getTime());
    composer.editor.setValue("a draft that should survive a reload");

    await h.view.reload();

    expect(h.app.vault.files.size).toBe(1);
    const [path] = h.app.vault.files.keys();
    expect(h.app.vault.contents.get(path)).toContain("a draft that should survive a reload");

    // Committed, not left as a bare composer.
    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).rendered.has(path)).toBe(true);

    // REQUIRED: a draft that survives a reload must not jump to a new
    // creation time just because rebuilding the timeline happened to open
    // its replacement composer at a slightly later `new Date()`.
    const created = internals(h.view).rendered.get(path).entry.created as Date;
    expect(created.getTime()).toBe(originalCreated.getTime());
  });

  /**
   * Closes the "commit-window hole": `onComposerInput` claims `this.composer`
   * (nulling it) synchronously the instant a keystroke is meaningful, but
   * `commitComposer` itself only runs once its own turn on
   * `enqueueTimelineMutation`'s chain arrives — a reload already sitting in
   * that queue runs first. Before `pendingComposerCommit`, `clearTimeline`
   * had no way to find this claimed-but-not-yet-committed entry at all (it
   * is in neither `this.composer` nor `this.rendered`), leaking its
   * editor/DOM; and the original, now-superseded `commitComposer` call could
   * still go on to create a duplicate file once it finally ran, unaware a
   * reload had already happened.
   *
   * `reload()`'s own enqueue (registering a chain slot; not yet actually
   * running `reloadNow`) happens first, then the keystroke's claim+enqueue —
   * exactly reproducing "a reload already queued, a keystroke claims the
   * composer before that reload's turn arrives" without needing any
   * artificial delay.
   */
  it("a reload landing while a composer's first commit is still queued neither leaks nor loses it", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    const textarea = composerTextarea(h.view);
    const originalCreated = new Date(internals(h.view).composer.entry.created.getTime());

    const reloadPromise = h.view.reload();
    typeInto(textarea, "typed while a reload was already queued");

    await reloadPromise;

    // `reloadPromise` settling only means slot A (the reload, including its
    // own reestablish-and-commit) finished — chain-serialized behind it,
    // slot B (the original claim's own, now-superseded `commitComposer`
    // call) is merely *scheduled* at this point, not yet run: resolving the
    // chain link slot B waits on is itself a further microtask hop past
    // `reloadPromise`'s own resolution. Without settling past that hop,
    // this file count would read as 1 regardless of whether the
    // `claimedGeneration` bail below works at all — asserting here would
    // pin nothing.
    await settle();
    await settle();

    // Exactly one file: the original claim's own `commitComposer` call has
    // now actually run (flushed by the settles above) and must have
    // recognised it was superseded, not created a second one.
    expect(h.app.vault.files.size).toBe(1);
    const [path] = h.app.vault.files.keys();
    expect(h.app.vault.contents.get(path)).toContain("typed while a reload was already queued");

    expect(internals(h.view).composer).toBeNull();
    expect(internals(h.view).rendered.has(path)).toBe(true);
    expect(internals(h.view).pendingComposerCommit).toBeNull();

    const created = internals(h.view).rendered.get(path).entry.created as Date;
    expect(created.getTime()).toBe(originalCreated.getTime());
  });

  /**
   * Reproduces the user's reported symptom directly at the mechanism
   * `reloadNow` exercises — `clearTimeline` then `reestablishComposer`, in
   * that exact order — rather than through the full `reload()`/`onOpen()`
   * pipeline: nothing in that pipeline exposes a controllable async gap
   * between the moment `clearTimeline` snapshots the composer's focus state
   * and the moment `reestablishComposer` re-checks focus before deciding
   * whether to restore it, so orchestrating the race deterministically means
   * driving both steps directly through `internals`. This is the same two
   * calls `reloadNow` makes, in the same order — a faithful reproduction of
   * the mechanism, not a literal end-to-end `reload()`/second-`onOpen()`
   * trigger.
   *
   * This harness's fallback `TextareaEditor` has no CodeMirror instance to
   * stand in for the `.cm-content` the user's real diagnostic trace found
   * holding focus, so a plain `<textarea>` appended straight to
   * `document.body` plays that role instead — something else, unrelated to
   * the composer, that genuinely owns focus by the time the re-establish
   * runs. That substitution is faithful enough to prove the *mechanism*
   * (`preserveExternalFocus`'s "something else holds focus" check firing even
   * though the composer itself was never abandoned) — it does not, and
   * cannot, prove that a real embedded Markdown editor is what wins the race
   * in the live app; only a real vault trace can show that.
   */
  it("REPRO: an explicit, never-typed-into composer loses the caret to whatever else holds focus once it is re-established", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    const composerBefore = internals(h.view).composer;
    expect(composerBefore).not.toBeNull();
    expect(composerBefore.editor.hasFocus()).toBe(true);
    expect(internals(h.view).composerHasInput).toBe(false);

    // `clearTimeline` snapshots the composer's focus state while it still
    // genuinely has it — mirroring the real trace, where the composer was
    // focused at the moment the reload started.
    const snapshot = await internals(h.view).clearTimeline();
    expect(snapshot).not.toBeNull();
    expect(snapshot.hadFocus).toBe(true);

    // Stand-in for "something else holds focus" by the time the rebuild's
    // own awaits (flushing saves, loading a page) have let it happen — see
    // this test's doc above for how faithful this substitution is.
    const stealer = document.createElement("textarea");
    document.body.appendChild(stealer);
    stealer.focus();
    expect(document.activeElement).toBe(stealer);

    await internals(h.view).reestablishComposer(snapshot);

    const composerAfter = internals(h.view).composer;
    expect(composerAfter).not.toBeNull();
    // The bug: an explicit, never-typed-into "New journal entry" request
    // does not keep the caret across a reload that lands before the user's
    // first keystroke.
    expect(composerAfter.editor.hasFocus()).toBe(true);
  });

  /**
   * The case `preserveExternalFocus` exists to protect, and which the fix
   * above must not weaken: once the user has genuinely typed something into
   * the composer, a re-establish must not yank focus away from wherever the
   * user has since, deliberately, moved it.
   */
  it("does not yank focus back into a re-established composer that has been typed in and whose focus is genuinely elsewhere", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    // Whitespace only, deliberately (see the "abandoning" test above):
    // `composerHasInput` is set on any change, meaningful or not, without
    // crossing the commit threshold — so the composer is still open, still
    // uncommitted, but has genuinely been typed into.
    typeInto(composerTextarea(h.view), "   ");
    expect(internals(h.view).composerHasInput).toBe(true);
    expect(internals(h.view).composer).not.toBeNull();

    const snapshot = await internals(h.view).clearTimeline();
    expect(snapshot).not.toBeNull();
    expect(snapshot.explicitPending).toBe(false);

    // The user has since moved focus elsewhere, deliberately.
    const stealer = document.createElement("textarea");
    document.body.appendChild(stealer);
    stealer.focus();

    await internals(h.view).reestablishComposer(snapshot);

    const composerAfter = internals(h.view).composer;
    expect(composerAfter).not.toBeNull();
    expect(composerAfter.editor.hasFocus()).toBe(false);
    expect(document.activeElement).toBe(stealer);
  });

  /**
   * Regression test for the staleness `commitComposer`'s own comment now
   * documents: it builds `rendered.entry` with `tags: []` because the
   * metadata cache hasn't indexed the just-created file yet, and nothing
   * ever replaces that object afterwards — the vault "create" event's
   * "added" change resolves to an insert, and `insertEntryInPlace`
   * early-returns because this path is already rendered. So
   * `rendered.entry.tags` stays `[]` even once the cache catches up.
   * `commitEntryTimeChange` must not carry that staleness into the index by
   * trusting `rendered.entry.tags`; it re-resolves from the cache instead.
   */
  it("a time correction on a freshly committed entry picks up its real tags, not the stale [] left by commit", async () => {
    const h = createHarness();
    h.service.load();
    await h.view.onOpen();
    await h.view.startNewEntry();

    typeInto(composerTextarea(h.view), "Thinking about #work today");
    await settle();
    await settle();

    const [path] = h.app.vault.files.keys();
    const rendered = internals(h.view).rendered.get(path);
    const file = rendered.entry.file;

    // Confirms the premise this test guards against: the composer really
    // did leave the rendered copy stale.
    expect(rendered.entry.tags).toEqual([]);

    // The metadata cache catching up moments later, same as it would for a
    // real inline #tag once Obsidian re-parses the new file. `created` is
    // required (with any value) by `setEntryCreated`'s own frontmatter
    // cross-check, not by anything this test cares about.
    h.app.metadataCache.frontmatter.set(path, { created: "placeholder" });
    h.app.metadataCache.inlineTags.set(path, ["work"]);

    await internals(h.view).commitEntryTimeChange(rendered, file, new Date(2026, 6, 1, 9, 0, 0));
    await settle();

    const indexed = h.service.getEntries().find((e: { file: { path: string } }) => e.file.path === file.path);
    expect(indexed?.tags).toEqual(["work"]);
  });
});
