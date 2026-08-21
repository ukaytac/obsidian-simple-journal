/**
 * The save pipeline behind one entry's live editor: debouncing writes while
 * the user types, flushing them before an editor is torn down, and the
 * disk-write decision itself — factored out of `JournalView` so it can be
 * exercised directly with a fabricated `SaveEntry`/`SaveDeps` (the same
 * dependency-injection shape `mountWindow.ts` and `applyChange.ts` use)
 * rather than only through a live `JournalView`, which needs a DOM and
 * Obsidian internals this test environment doesn't provide.
 *
 * `JournalView` keeps its own `scheduleSave`/`flushSave`/`save` methods as
 * thin wrappers over the functions below — not because the logic still lives
 * there, but because several call sites (`wireEditor`, `unmountEditor`,
 * `clearTimeline`, `confirmDelete`, `commitEntryTimeChange`,
 * `applyChangesNow`, `commitPersist`) need to reach this pipeline through
 * `this.`, and at least one test relies on being able to monkey-patch
 * `view.flushSave` directly (see `tests/JournalView.raceGuards.test.ts`) —
 * something it could not do to a free function these call sites imported
 * and called without going through the instance at all.
 */
import { Notice, type TFile } from "obsidian";

/**
 * Minimal shape `scheduleSave`/`flushSave`/`save` need from an entry's live
 * editor — `EntryEditor`'s `getValue`/`flush`, nothing else. Kept narrow
 * rather than importing the full `EntryEditor` interface so this module stays
 * exercisable with a fabricated stub.
 */
export interface SaveEditor {
  getValue(): string;
  flush(): void;
}

/**
 * The state `scheduleSave`/`flushSave`/`save` read and mutate for one entry —
 * a narrow, structural slice of `JournalView`'s private `RenderedEntry`,
 * which satisfies this without any changes, so this module can be exercised
 * directly with fabricated state (same shape as `mountWindow.ts`'s
 * `MountState`/`stateOf` and `applyChange.ts`'s `RenderedState`).
 */
export interface SaveEntry {
  /** The entry's own DOM node — only `showSaveError`/`clearSaveError` touch it. */
  el: HTMLElement;
  entry: { file: TFile };
  editor: SaveEditor | null;
  saveHandle: number | null;
  savedBody: string;
  saveToken: number;
}

/** What `scheduleSave`/`flushSave`/`save` need injected to actually reach disk. */
export interface SaveDeps {
  /** e.g. `EntryRepository.writeBody`. */
  writeBody: (file: TFile, body: string) => Promise<void>;
  /** e.g. `JournalService.markSelfWrite`. */
  markSelfWrite: (path: string) => void;
}

/**
 * Writes `value` via `write` unless it already matches `savedBody`.
 *
 * Neither `EntryEditor` implementation has a dirty check — `flush()` always
 * fires its change callback — so without this guard, every unmount
 * (including a plain scroll past an entry nobody edited, since
 * `mountObserver` flushes on every exit) would call `write` unconditionally:
 * a real mtime bump, a real vault `modify` event, a real sync upload, for
 * zero actual change. `vault.process` itself is not documented to skip an
 * identical write, so this can't be left to it.
 *
 * Never rejects: a failure from `write` is reported via `onError` rather
 * than thrown, so a caller flushing on unmount/teardown (`flushSave`, and
 * transitively `JournalView`'s `clearTimeline`/`unmountEditor`) can always
 * proceed regardless of whether the write behind it succeeded. Proper
 * user-facing failure handling is a later, dedicated task; this is only
 * about the write never being able to reject the caller's teardown.
 *
 * Returns the body now known to be on disk: `value` on a skip or a
 * successful write, or the original `savedBody` unchanged if `write` failed
 * — so a later save attempt with the same value is retried rather than
 * wrongly treated as already-saved.
 */
export async function saveIfChanged(
  value: string,
  savedBody: string,
  write: (value: string) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<string> {
  if (value === savedBody) return savedBody;

  try {
    await write(value);
    return value;
  } catch (error) {
    onError(error);
    return savedBody;
  }
}

/** Debounces writes so typing does not hit the disk on every keystroke. */
export function scheduleSave(target: SaveEntry, value: string, deps: SaveDeps): void {
  if (target.saveHandle !== null) window.clearTimeout(target.saveHandle);

  target.saveHandle = window.setTimeout(() => {
    target.saveHandle = null;
    void save(target, value, deps);
  }, 500);
}

/**
 * Writes any pending edit immediately. Called before an editor is destroyed
 * and when the view closes, so nothing sitting inside the debounce window is
 * lost. `editor.flush()` commits what the editor holds; `getValue()` stays
 * truthful even after `destroy()`, so this cannot write an empty body over
 * real text.
 *
 * Bails without calling `save()` if there is no editor at all — a state
 * believed unreachable today (every `destroy()` is preceded synchronously
 * by a `flushSave` that nulls `saveHandle`, and nothing else can interleave
 * with that synchronous sequence), but `?? ""` here would not merely be a
 * redundant fallback if it ever were reached: with `savedBody` now holding
 * the entry's real text, `""` reads as a genuine (and different) value,
 * and `save()` would write the entry empty instead of leaving it alone.
 */
export async function flushSave(target: SaveEntry, deps: SaveDeps): Promise<void> {
  target.editor?.flush();

  if (target.saveHandle === null) return;
  window.clearTimeout(target.saveHandle);
  target.saveHandle = null;

  if (!target.editor) return;
  await save(target, target.editor.getValue(), deps);
}

/**
 * Writes `value` to disk unless it already matches `target.savedBody`, and
 * never rejects. The dirty check and the never-reject shape live in
 * `saveIfChanged`, called below — kept as its own small function (same shape
 * as `mountWindow.ts`'s `stateOf`/`onEvict`) so it stays covered directly by
 * `tests/entrySave.test.ts`, independent of this function's own extra
 * bookkeeping (`saveToken`, the error marker).
 *
 * `deps.markSelfWrite` is called from inside the `write` callback — i.e.
 * only when `saveIfChanged` has actually decided a write is happening —
 * rather than unconditionally before calling `saveIfChanged`. Marking it
 * unconditionally would also mark the (very common) no-op case where
 * scrolling an unedited entry in and out of the mount window flushes
 * nothing: that mark would then never be consumed by a real `modify`/
 * `changed` event (none is coming) and would sit in `JournalService` for
 * its full TTL, able to wrongly swallow a genuinely external edit to the
 * same path that happens to land in that window.
 */
export async function save(target: SaveEntry, value: string, deps: SaveDeps): Promise<void> {
  // See `saveToken`'s doc on `JournalView.RenderedEntry`: two `save()` calls
  // for the same entry can overlap (a `scheduleSave` timer firing while an
  // earlier write is still in flight, or a `flushSave` starting a second
  // one), and can then settle out of order. Captured before the only await
  // below, so it identifies THIS call uniquely; only the call whose token
  // still matches `target.saveToken` when it settles is the most recent one,
  // and only that one is allowed to touch `savedBody` or the marker.
  const token = ++target.saveToken;

  const result = await saveIfChanged(
    value,
    target.savedBody,
    (v) => {
      deps.markSelfWrite(target.entry.file.path);
      return deps.writeBody(target.entry.file, v);
    },
    (error) => {
      console.error("Simple Journal: failed to save an entry", target.entry.file.path, error);
      new Notice(
        `Failed to save "${target.entry.file.path}". See the developer console for details.`,
      );
      // REQUIRED: an older, failing write must not raise a marker after a
      // newer write for this same entry has already been issued (and
      // possibly already succeeded) — see `saveToken`'s doc.
      if (token === target.saveToken) showSaveError(target);
    },
  );

  // REQUIRED, same reasoning: an older attempt resolving after a newer one
  // must not stomp `savedBody` back to its own now-stale result.
  if (token !== target.saveToken) return;
  target.savedBody = result;

  // `savedBody` now equals `value` on both a successful write and a
  // no-op skip (value already matched disk) — the only case it does NOT
  // equal `value` is a failed write, where `saveIfChanged` hands back the
  // unchanged original. Clearing here on the skip path too is correct, not
  // just harmless: it covers the entry being edited back to the last
  // known-good text after a prior failure, which never re-enters `write`
  // (value === savedBody), but is genuinely no longer "unsaved".
  if (target.savedBody === value) clearSaveError(target);
}

/**
 * Marks the entry as unsaved next to its timestamp. The editor keeps the
 * text — nothing is lost — and the next successful (or no-op, see `save`)
 * write clears the marker. Guarded against a duplicate: `save` can call
 * this repeatedly (every retried failure) for the same still-broken entry.
 *
 * `role="status"` (implicit `aria-live="polite"`) so assistive tech
 * announces it the moment it appears, since nothing moves focus here.
 * Inserted before `.journal-entry-actions`, not appended to the header:
 * `createSpan`/`createDiv` always append, and the actions element is
 * already last among the header's children (see `JournalView.createEntryEl`)
 * — a plain append would land the marker to the right of the
 * (auto-margined, always right-aligned) actions button instead of next to
 * the timestamp.
 *
 * Nothing here retries the write on a timer. Once shown, this marker only
 * clears the next time `save()` actually runs again for this entry — the
 * user typing more (a fresh `scheduleSave`), or this entry crossing
 * `MOUNT_ROOT_MARGIN` again (a `flushSave` via `unmountEditor`, or the
 * reposition/removed paths in `applyChangesNow`). A write that starts
 * failing and is then never touched again by either of those can leave
 * this marker showing indefinitely, outliving the actual failure once
 * whatever caused it (e.g. a permissions problem) is fixed. Acceptable for
 * the MVP: building an automatic retry timer is a deliberately deferred
 * scope decision, not an oversight.
 */
export function showSaveError(target: SaveEntry): void {
  if (target.el.querySelector(".journal-entry-error")) return;

  const header = target.el.querySelector(".journal-entry-header");
  if (!header) return;

  const marker = createSpan({
    cls: "journal-entry-error",
    text: "not saved",
    attr: {
      role: "status",
      "aria-label": "This entry could not be written to disk. See the developer console.",
    },
  });

  const actions = header.querySelector(".journal-entry-actions");
  if (actions) header.insertBefore(marker, actions);
  else header.appendChild(marker);
}

/** Removes the failure marker `showSaveError` added, if present. */
export function clearSaveError(target: SaveEntry): void {
  target.el.querySelector(".journal-entry-error")?.remove();
}
