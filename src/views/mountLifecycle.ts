/**
 * The editor mount/unmount lifecycle for one entry: turning its static
 * rendering into a live editor when it nears the viewport, tearing that
 * editor back down when it leaves, wiring the callbacks every editor needs
 * regardless of implementation, and enforcing the backstop cap on how many
 * can be mounted at once — factored out of `JournalView` so it can be
 * exercised with a fabricated `MountEntry`/`MountDeps`, the same
 * dependency-injection shape `entrySave.ts` and `mountWindow.ts` use.
 *
 * This is NOT as clean a cut as `entrySave.ts`: the `generation` guard on
 * `mountEditor`/`unmountEditor` is only meaningful relative to
 * `JournalView`'s own teardown counter (bumped by `clearTimeline`, which
 * belongs to the reload/composer seam, not this one), and falling back to
 * static rendering when an entry is no longer intersecting is
 * `JournalView.renderStatic`'s job, not this module's. Both cross back into
 * the view via `MountDeps.getGeneration`/`MountDeps.renderStatic` rather than
 * this module owning either outright — a narrow shared reference instead of
 * a clean cut, same as `MountDeps.lookup` standing in for `this.rendered`
 * (storage for `RenderedEntry` itself is not part of this seam either).
 *
 * `JournalView` keeps its own `mountEditor`/`unmountEditor`/`wireEditor`/
 * `mountUsableEditor`/`replaceWithFallback`/`enforceMountLimit`/
 * `mountStateOf`/`ensureMountOrderContains` methods as thin wrappers over the
 * functions below, exactly like `entrySave.ts`'s wrappers — so every existing
 * call site (`installMountObserver`, `createEntryEl`'s `remountOnInteraction`,
 * `handleDeleteFallback`, `commitComposer`, `tests/JournalView.*.test.ts`'s
 * `internals(view).mountEditor(...)` reflection) keeps calling `this.…`
 * completely unchanged.
 */
import { Notice, type Component, type TFile } from "obsidian";
import type { EntryEditor, EntryEditorFactory } from "./EntryEditor";
import { enforceMountLimit as pickAndEvict, type MountState } from "./mountWindow";
import { TextareaEditor } from "./TextareaEditor";

/**
 * The state `mountEditor`/`unmountEditor`/`wireEditor` read and mutate for
 * one entry — a narrow, structural slice of `JournalView`'s private
 * `RenderedEntry`, which satisfies this without any changes, so this module
 * can be exercised directly with fabricated state (same shape as
 * `entrySave.ts`'s `SaveEntry` and `mountWindow.ts`'s `MountState`).
 */
export interface MountEntry {
  entry: { file: TFile };
  bodyEl: HTMLElement;
  /** Component that owns any MarkdownRenderer output, so it can be unloaded. */
  renderComponent: Component | null;
  editor: EntryEditor | null;
  savedBody: string;
  intersecting: boolean;
  mountDistance: number;
  opToken: number;
}

/**
 * What the mount lifecycle needs injected to reach the rest of `JournalView`
 * — the generation counter and rendered-entry lookup it does not own, the
 * repository read it needs no more of than this, and the save/dirty
 * primitives `entrySave.ts` already owns.
 */
export interface MountDeps {
  /** `JournalView.generation`, owned by the reload/composer seam. */
  getGeneration(): number;
  /** `EntryRepository.readBody`. */
  readBody(file: TFile): Promise<string>;
  /** `JournalView.renderStatic` — the static-rendering fallback, not part of this seam. */
  renderStatic(target: MountEntry): Promise<void>;
  editorFactory: EntryEditorFactory;
  /** `JournalView.scheduleSave` (see `entrySave.ts`). */
  scheduleSave(target: MountEntry, value: string): void;
  /** `JournalView.flushSave` (see `entrySave.ts`). */
  flushSave(target: MountEntry): Promise<void>;
  /** `JournalView.isDirty`. */
  isDirty(target: MountEntry): boolean;
  /** `this.rendered.get(path)` — storage for `RenderedEntry` is not part of this seam. */
  lookup(path: string): MountEntry | undefined;
}

/**
 * Ensures `path` is present in `order` — a no-op if it already is. Called
 * wherever `unmountEditor` declines to unmount an editor that remains
 * legitimately mounted (still focused, or back on screen), so it stays
 * visible to `enforceMountLimit`'s cap even when the decline happens on a
 * path `enforceMountLimit` itself already spliced out before calling in (see
 * `mountWindow.ts`'s eviction contract).
 */
export function ensureMountOrderContains(order: string[], path: string): void {
  if (!order.includes(path)) order.push(path);
}

/**
 * Resolves one path's current mount state for `mountWindow.ts`'s pure
 * selection logic. `target` is already the resolved `MountEntry` (or
 * `undefined`) — the path lookup itself is `MountDeps.lookup`, called by
 * `JournalView.mountStateOf` before this runs, since storage for
 * `RenderedEntry` is not part of this seam.
 *
 * `unsaved` mirrors `unmountEditor`'s own decline check (see its doc): a
 * dirty editor is one `enforceMountLimit` must never pick as an eviction
 * victim. Without this, the cap would splice the path out of `order` and
 * call `unmountEditor` anyway, which would then decline and re-add it via
 * `ensureMountOrderContains` — correct in isolation, but only after
 * `flushSave` ran a real (possibly failing) write for no reason, and only by
 * chance before some other mount pushed the count over the cap again in the
 * meantime. Excluding it here, at selection time, avoids that churn entirely
 * rather than merely surviving it.
 *
 * `distance` is `target.mountDistance`, last computed by `mountObserver`'s
 * callback — see that field's doc on `JournalView.RenderedEntry`.
 */
export function mountStateOf(
  target: MountEntry | undefined,
  isDirty: (target: MountEntry) => boolean,
): MountState | undefined {
  if (!target?.editor) return undefined;

  return {
    mounted: true,
    focused: target.editor.hasFocus(),
    intersecting: target.intersecting,
    unsaved: isDirty(target),
    distance: target.mountDistance,
  };
}

/**
 * Backstop for when more entries are simultaneously within
 * `MOUNT_ROOT_MARGIN` than `max` allows. The primary mount/unmount mechanism
 * is `mountObserver`; this only runs after a mount that pushes the count
 * over the cap. Selection and the termination guarantee live in
 * `mountWindow.ts`, exercised directly there with fabricated state; this
 * just supplies the live lookup and the actual (async) unmount.
 */
export function enforceMountLimit(order: string[], max: number, deps: MountDeps): void {
  pickAndEvict(
    order,
    max,
    (path) => mountStateOf(deps.lookup(path), deps.isDirty),
    (path) => {
      const target = deps.lookup(path);
      if (target) void unmountEditor(target, order, deps, { evict: true });
    },
  );
}

/**
 * Wires the callbacks every editor needs, regardless of which
 * implementation it is or when it was created (primary, mount-time
 * fallback, or a later `replaceWithFallback` swap) — kept in one place so
 * none of the three call sites can drift out of sync with each other.
 *
 * `onBlur` unmounts the editor once it is both unfocused and already
 * outside the viewport: `mountObserver` skips unmounting a focused editor
 * (see `unmountEditor`) so a scroll-driven blur never rips the keyboard
 * out from under the user mid-sentence, but that means the entry needs a
 * second chance to unmount once the user actually does click away —
 * otherwise an entry the user typed in and then scrolled past stays
 * mounted for the rest of the session.
 */
export function wireEditor(
  target: MountEntry,
  editor: EntryEditor,
  order: string[],
  max: number,
  deps: MountDeps,
): void {
  editor.onChange((value) => deps.scheduleSave(target, value));

  // REQUIRED. An embedded editor can also fail *after* a successful mount —
  // its file is deleted, or the internal API changes shape under it. When
  // that happens it stops reporting changes, and without this the user goes
  // on typing into a surface whose text is never committed.
  editor.onUnusable(() => void replaceWithFallback(target, order, max, deps));

  editor.onBlur(() => {
    if (!target.intersecting) void unmountEditor(target, order, deps);
  });
}

/**
 * Mounts the configured editor, and if it reports that it failed — the
 * internal API changed shape on this Obsidian version — replaces it with the
 * textarea fallback for this entry. The journal stays editable either way.
 */
export function mountUsableEditor(
  target: MountEntry,
  body: string,
  order: string[],
  max: number,
  deps: MountDeps,
): EntryEditor {
  const editor = deps.editorFactory.create();
  wireEditor(target, editor, order, max, deps);

  editor.mount(target.bodyEl, target.entry.file, body);

  if (editor.isUsable?.() === false) {
    console.error(
      "Journal Entries: embedded editor was unusable; falling back to plain text for",
      target.entry.file.path,
    );
    editor.destroy();
    target.bodyEl.empty();

    const fallback = new TextareaEditor();
    wireEditor(target, fallback, order, max, deps);
    fallback.mount(target.bodyEl, target.entry.file, body);
    return fallback;
  }

  return editor;
}

/**
 * Swaps a failed embedded editor for the plain-text fallback, preserving
 * whatever text it still holds. `getValue()` stays truthful after `destroy()`,
 * so nothing the user typed is lost across the swap.
 */
export async function replaceWithFallback(
  target: MountEntry,
  order: string[],
  max: number,
  deps: MountDeps,
): Promise<void> {
  const failed = target.editor;
  if (!failed) return;

  const text = failed.getValue();
  failed.destroy();
  target.bodyEl.empty();

  const fallback = new TextareaEditor();
  wireEditor(target, fallback, order, max, deps);
  fallback.mount(target.bodyEl, target.entry.file, text);
  target.editor = fallback;

  new Notice("Journal Entries: switched this entry to plain text editing.");
}

/**
 * Turns an entry into a live editor and enforces the mount cap. Called by
 * `mountObserver` whenever an entry enters `MOUNT_ROOT_MARGIN` — this is
 * the primary mount trigger, not `appendEntry` (see its doc on
 * `JournalView`).
 *
 * Guards against a concurrent `clearTimeline()` (a reload, or the view
 * closing) the same way `renderStatic` does: `deps.getGeneration()` is
 * captured before the only await, and checked after it, so a mount that
 * resumes into a timeline this instance no longer owns bails before touching
 * the DOM or `order` rather than mounting an editor nothing will ever
 * unmount. Also bumps/checks `target.opToken`, same reasoning as
 * `renderStatic`: this can race a concurrent static render (the one
 * `appendEntry` starts) or another mount attempt, and the loser must not
 * write into `bodyEl` after the winner already has. Also re-checks
 * `target.intersecting` after the await, for the symmetric reason
 * `unmountEditor` does: the entry may have left the margin again while
 * this was reading the file.
 */
export async function mountEditor(target: MountEntry, order: string[], max: number, deps: MountDeps): Promise<void> {
  if (target.editor) return;
  const generation = deps.getGeneration();
  const token = ++target.opToken;

  target.renderComponent?.unload();
  target.renderComponent = null;
  target.bodyEl.empty();
  target.bodyEl.style.removeProperty("min-height");

  const body = await deps.readBody(target.entry.file);
  if (generation !== deps.getGeneration()) return;
  if (token !== target.opToken) return;
  if (target.editor) return;

  if (!target.intersecting) {
    // Left MOUNT_ROOT_MARGIN while this was reading the file. The
    // observer's exit transition already fired and called unmountEditor,
    // which no-opped (target.editor was still null) — no further callback
    // arrives until another transition, so without this check an entry
    // that's now off-screen would mount a live editor anyway (and stay
    // mounted indefinitely, invisible to any future scroll-driven unmount).
    // Restore static rendering instead of leaving bodyEl blank (already
    // cleared above).
    void deps.renderStatic(target);
    return;
  }

  const editor = mountUsableEditor(target, body, order, max, deps);

  // Seeded from the editor's own getValue(), not the raw disk read
  // (`body`): getValue() goes through whatever normalization the editor
  // applies on load (e.g. ObsidianEmbedEditor's CodeMirror document
  // normalizes CRLF to \n), and save()'s later dirty-check compares
  // against this exact same code path. Seeding from `body` instead would
  // compare two independently-sourced strings that can differ even when
  // nothing changed — a CRLF-line-ending file would then rewrite (and
  // silently reformat) on every unmount, reinstating the spurious-write
  // bug this field exists to prevent.
  target.savedBody = editor.getValue();

  target.editor = editor;
  order.push(target.entry.file.path);

  enforceMountLimit(order, max, deps);
}

/**
 * Flushes pending edits, destroys the editor, and restores static
 * rendering. Never unmounts a focused editor: `mountObserver` calls this
 * unconditionally the moment an entry leaves `MOUNT_ROOT_MARGIN`, and
 * ripping the keyboard focus out from under the user mid-sentence just
 * because they scrolled would be worse than leaving one editor mounted
 * past the margin. `wireEditor`'s `onBlur` callback gives that entry a
 * second chance to unmount once the user actually clicks away.
 *
 * `evict`, when true, marks this call as an `enforceMountLimit` eviction
 * rather than the ordinary viewport-driven unmount `mountObserver` fires on
 * every exit transition. The two mean different things by "still
 * intersecting": for the ordinary path it means "re-entered
 * `MOUNT_ROOT_MARGIN` while the flush was in flight, decline" (see below).
 * For an eviction it means nothing of the sort — `pickEvictionCandidate`
 * already chose this exact path as its fallback specifically *because*
 * every candidate was intersecting (see `mountWindow.ts`), so declining on
 * that same fact here would silently undo every eviction and leave the cap
 * unenforced, which is the bug this parameter fixes. `evict` never
 * bypasses the focused or dirty declines — those stay absolute regardless
 * of why this was called, since losing focus or unsaved text is worse than
 * one editor over the cap.
 */
export async function unmountEditor(
  target: MountEntry,
  order: string[],
  deps: MountDeps,
  opts: { evict?: boolean } = {},
): Promise<void> {
  if (!target.editor) return;
  const path = target.entry.file.path;

  if (target.editor.hasFocus()) {
    // Still legitimately mounted — keep it tracked. Reachable when this is
    // called directly by mountObserver's exit callback (which never
    // pre-removes `order`) as well as, in principle, via enforceMountLimit
    // (which does): pickEvictionCandidate already excludes focused entries
    // at selection time, so this path shouldn't fire from there, but
    // re-adding is a harmless no-op if it somehow did.
    ensureMountOrderContains(order, path);
    return;
  }

  // Captured before the awaits below. If a concurrent clearTimeline()
  // lands while the flush is in flight, it has already flushed, destroyed,
  // and nulled every editor (including this one) and emptied the timeline
  // itself — bail rather than redundantly destroy an already-destroyed
  // editor and render static Markdown into a bodyEl that no longer belongs
  // to any visible timeline. `order` itself is stale/replaced by then, so
  // no ensureMountOrderContains call is needed on this path.
  const generation = deps.getGeneration();

  try {
    await deps.flushSave(target);
  } catch (error) {
    // save() itself never rejects; this only guards against a future
    // change reintroducing a throw here (e.g. editor.flush() itself). The
    // destroy/restore-static sequence below must still run regardless —
    // an editor left mounted because of a failed flush would keep polling
    // (ObsidianEmbedEditor) or holding DOM (either editor) forever, on top
    // of whatever the failed flush already lost.
    console.error("Journal Entries: failed to flush a pending save before unmounting", error);
  }
  if (generation !== deps.getGeneration()) return;

  if (target.editor.hasFocus()) {
    // Re-checked, not just assumed still true from the check at the top
    // of this method: focus can arrive during the `flushSave` await above
    // (the user clicked into this exact entry while its flush was in
    // flight) that check ran before. Absolute regardless of `opts.evict`,
    // same reasoning as the check at the top — losing focus mid-sentence
    // is worse than one editor over the cap either way.
    ensureMountOrderContains(order, path);
    return;
  }

  if (target.intersecting && !opts.evict) {
    // Re-entered MOUNT_ROOT_MARGIN while the flush was in flight.
    // mountEditor's own guard (`if (target.editor) return`) already saw
    // this editor still set and no-opped, so no other code path will
    // remount it — leave it mounted rather than destroying a now-visible
    // entry's live editor out from under the user. Keep it tracked in
    // `order` for the same reason as the focused case above.
    ensureMountOrderContains(order, path);
    return;
  }

  if (deps.isDirty(target)) {
    // The flush above did not get this text onto disk — almost always
    // because `saveIfChanged`'s write failed and `save()` is showing the
    // "not saved" marker (see `showSaveError`), though this also covers the
    // (currently unreachable) case of a fresh edit racing the flush.
    // Destroying the editor and falling back to `renderStatic`'s disk read
    // would silently replace the on-screen text with the last known-good
    // (and now stale) saved body — exactly the loss the marker promises
    // hasn't happened. Decline the unmount and keep the editor live so the
    // user can keep editing/retrying; a later unmount attempt (another
    // scroll past this entry) retries the flush, and once a write actually
    // succeeds this stops being dirty and unmounts/evicts normally.
    //
    // This can pin an entry past `max` if its write keeps failing —
    // accepted: `mountStateOf`'s `unsaved` field already tells
    // `pickEvictionCandidate` never to select such an entry as a victim in
    // the first place, so this is a rare fallback for this path being
    // reached some other way, not the primary defense. Losing the user's
    // words is worse than one extra live editor.
    ensureMountOrderContains(order, path);
    return;
  }

  // Freeze the height across the swap so the scroll position does not shift.
  const height = target.bodyEl.offsetHeight;
  target.bodyEl.style.minHeight = `${height}px`;

  target.editor?.destroy();
  target.editor = null;

  const index = order.indexOf(path);
  if (index >= 0) order.splice(index, 1);

  await deps.renderStatic(target);
  target.bodyEl.style.removeProperty("min-height");
}
