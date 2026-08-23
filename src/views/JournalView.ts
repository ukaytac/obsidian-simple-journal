import {
  ButtonComponent,
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  setTooltip,
  type TFile,
  WorkspaceLeaf,
} from "obsidian";
import type { JournalEntry } from "../journal/entry";
import { UnsafeFrontmatterError } from "../journal/markdownDoc";
import type JournalEntriesPlugin from "../main";
import { anchorSeed, pageAfter } from "../services/entryIndex";
import type { JournalChange } from "../services/journalService";
import { formatDayHeader, formatTime } from "../utils/dates";
import type { RenderedState } from "./applyChange";
import { ChangeEntryTimeModal } from "./ChangeEntryTimeModal";
import { createChangeApplication, type ChangeApplication } from "./changeApplication";
import { isMeaningful, resolveComposerContent } from "./composerCommit";
import type { EntryEditor } from "./EntryEditor";
import {
  flushSave as flushSaveEntry,
  save as saveEntry,
  scheduleSave as scheduleSaveEntry,
  type SaveDeps,
} from "./entrySave";
import { createMountLifecycle, type MountLifecycle } from "./mountLifecycle";
import { createTimelineDom, type TimelineDom } from "./timelineDom";
import { TextareaEditor } from "./TextareaEditor";

export const VIEW_TYPE_JOURNAL = "simple-journal-timeline";

/** Entries rendered per page. */
const PAGE_SIZE = 40;

/**
 * How long `openComposer` keeps re-claiming focus for a freshly opened
 * composer. Long enough to outlast the initial mount of the loaded entries'
 * editors, each of which can take focus as Obsidian builds it; short enough
 * that it is over well before a user could deliberately click elsewhere and
 * be surprised by the caret moving back.
 */
const COMPOSER_FOCUS_CLAIM_MS = 400;

/**
 * Backstop cap on simultaneously mounted editors. The primary mechanism that
 * keeps the mounted set bounded is `mountObserver` reacting to entries
 * entering/leaving the viewport (see `installMountObserver`); this only binds
 * when more entries are simultaneously within the observed window than this
 * allows — a very tall pane, or many short entries packed into
 * `MOUNT_ROOT_MARGIN`. Lower on mobile, where memory is tighter.
 */
const MAX_MOUNTED_EDITORS = Platform.isMobile ? 25 : 60;

/**
 * How far outside the visible viewport an entry mounts a live editor / stays
 * mounted, so typing is ready slightly before the entry is actually on
 * screen rather than popping in exactly at the edge. Larger on mobile: a
 * flick scroll covers more of the pane per gesture there than a desktop
 * scroll-wheel tick does, so a small margin would otherwise show a visible
 * lag between an entry appearing and it becoming editable.
 */
const MOUNT_ROOT_MARGIN = Platform.isMobile ? "900px 0px" : "400px 0px";

/**
 * Cap on consecutive pages loaded in one burst without a genuine scroll
 * event in between (see `onSentinelVisible`). Bounds the cascade that a
 * short-entry vault can trigger — each appended page may still leave the
 * sentinel inside `rootMargin`, which would otherwise keep loading forever
 * without ever letting go of the main thread's event loop.
 */
const MAX_BURST_PAGES = 10;

/**
 * How long `confirmDelete` waits for the vault's own "delete" event (routed
 * through `JournalService`/`applyChangesNow`) to reach `removeRenderedEntry`
 * before tearing a deleted entry's rendering down directly. See
 * `confirmDelete`'s doc for why the row can't just wait indefinitely.
 */
const DELETE_FALLBACK_MS = 2000;

/** One entry as it currently exists in the DOM. */
interface RenderedEntry {
  entry: JournalEntry;
  el: HTMLElement;
  bodyEl: HTMLElement;
  /** Component that owns any MarkdownRenderer output, so it can be unloaded. */
  renderComponent: Component | null;
  /** Live editing surface for this entry, or null when it is statically rendered. */
  editor: EntryEditor | null;
  /** Debounced save timer handle. */
  saveHandle: number | null;
  /**
   * The body last known to be on disk for this entry — seeded from the file
   * read when an editor mounts, updated after every successful `save()`.
   * `save()` skips the write entirely when the value to save matches this,
   * so scrolling an unedited entry in and out of the mount window (which
   * flushes on every unmount) never rewrites its file, bumps its mtime, or
   * fires a spurious `modify` event.
   */
  savedBody: string;
  /** Whether `el` currently intersects the viewport, per `mountObserver`. */
  intersecting: boolean;
  /**
   * Absolute pixel distance between this entry's vertical centre and the
   * viewport's, as of the most recent `mountObserver` callback — fed to
   * `enforceMountLimit` (see `mountWindow.ts`'s `MountState.distance`) so an
   * eviction, when one is unavoidable, targets the entry farthest from what
   * the user is actually looking at. `0` until the first callback; harmless,
   * since that only affects tie-breaking among candidates that also haven't
   * had a callback yet (i.e. nothing has scrolled).
   */
  mountDistance: number;
  /**
   * Bumped every time `mountEditor` or `renderStatic` starts work for this
   * entry. Both capture the value at the start and re-check it after their
   * one await; a mismatch means a later operation (a mount superseding a
   * static render, or vice versa — reachable the moment an entry's
   * intersection flips again while the first is still reading the file from
   * disk) has since taken over, so the stale one bails instead of writing
   * into `bodyEl` after the newer operation already has.
   */
  opToken: number;
  /**
   * Bumped every time `save()` starts a new attempt for this entry. `save`
   * captures the value at the start and re-checks it once its (possibly
   * slow — a synced or flaky vault) `write` settles, applying `savedBody`
   * and the error marker only if this is still the most recent attempt.
   * Without this, two overlapping `save()` calls — `scheduleSave`'s timer
   * firing while an earlier write is still in flight, or a `flushSave`
   * starting a second one — can resolve out of order: an older, slow,
   * *failing* write finishing after a newer one already succeeded would
   * otherwise stomp `savedBody` back to its own stale value and raise a
   * permanent false "not saved" marker (and a permanent mount-limit pin,
   * see `mountStateOf`'s `unsaved`) over text that is, in fact, already
   * safely on disk.
   */
  saveToken: number;
  /**
   * Mobile only: handle for the delayed `scrollIntoView` that corrects for
   * the on-screen keyboard shrinking the viewport after focus (see
   * `createEntryEl`). Kept on the entry, not a closure-local variable, so
   * every path that tears this entry down or genuinely moves focus away
   * from it — `touchstart` on it, `focusout`, `removeRenderedEntry`,
   * `clearTimeline` — can cancel a still-pending correction before it fires
   * against a row the user has already left or that no longer exists.
   * Always `null` on desktop.
   */
  keyboardScrollHandle: number | null;
  /**
   * Mobile only: handle for the long-press timer that opens the entry menu
   * (the touch equivalent of `contextmenu`; see `createEntryEl`). Kept on
   * the entry for the same reason as `keyboardScrollHandle` — so a teardown
   * mid-press can cancel it instead of popping the menu for a row that's
   * being deleted or reloaded out from under it. Always `null` on desktop.
   */
  longPressHandle: number | null;
}

/**
 * What `clearTimeline` hands back about a composer (open, or claimed but not
 * yet committed — see `pendingComposerCommit`) it tore down, so
 * `reestablishComposer` can put an equivalent one back: the same text, the
 * same focus state, and — REQUIRED, so a draft that survives a reload does
 * not silently jump to a new creation time — the same `created` timestamp
 * the entry would have gotten had nothing interrupted it.
 */
interface ComposerSnapshot {
  value: string;
  hadFocus: boolean;
  created: Date;
  /**
   * Whether this composer was opened by an explicit "New journal entry"
   * request (as opposed to one `reestablishComposer` itself put back) and
   * has not yet received a single keystroke — distinct from `hadFocus`,
   * which only says where the caret happened to be at the exact instant
   * `clearTimeline` ran, not why. `reestablishComposer` uses this to keep the
   * intent behind an explicit request alive across a rebuild: a composer the
   * user just asked for, and has not typed into, still belongs to that
   * request even if something else (another entry's editor mounting, e.g.)
   * has since taken focus away from it in the interim — that is background
   * churn, not the user moving on, and `preserveExternalFocus`'s "something
   * else holds focus" guard exists to protect the latter, not the former
   * (see `openComposer`'s use of this field). Always `false` once
   * `composerHasInput` is `true`, regardless of how the composer was opened.
   */
  explicitPending: boolean;
}

export class JournalView extends ItemView {
  private timelineEl!: HTMLElement;
  private rendered = new Map<string, RenderedEntry>();
  /**
   * Day-group `.journal-day-entries` containers, keyed by `dayKey`, so
   * lookup is O(1). Forwards to `timelineDom`, which actually owns this map
   * (see `timelineDom.ts`) — kept as a getter, rather than dropped, purely so
   * `internals(view).dayGroups` in `tests/JournalView.*.test.ts` keeps
   * reaching the real map without needing to reach through `timelineDom`
   * itself.
   */
  private get dayGroups(): Map<string, HTMLElement> {
    return this.timelineDom.dayGroups;
  }
  /**
   * Bumped every time the timeline is discarded. `renderStatic` captures it
   * before doing any async work and bails if it has since changed, so a
   * render outlived by a `reload()` (which can be triggered mid-flight by
   * `refreshJournal`, or by the view closing) never lands in a detached
   * element it no longer owns.
   */
  private generation = 0;
  private sentinelEl: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  /**
   * Watches every rendered entry's element and mounts/unmounts its editor as
   * it crosses `MOUNT_ROOT_MARGIN`. Separate from `observer` (the paging
   * sentinel), which only ever watches one element.
   */
  private mountObserver: IntersectionObserver | null = null;
  private index: JournalEntry[] = [];
  private lastLoadedPath: string | null = null;
  /**
   * When set, the timeline is anchored to this calendar day (`goToDate`):
   * paging starts at the newest entry at or before its end, and entries
   * newer than it are excluded from the timeline entirely — see
   * `reloadNow`'s `anchorSeed` seed and `insertEntryInPlace`'s
   * `anchorPosition`-based bounds check, both of which read this field.
   * `null` (the default) means "start from the newest entry," the original
   * unanchored behaviour. Survives a `reload()` on purpose: a settings
   * change or a lost-cursor re-anchor (see `nextPage`) should not silently
   * un-anchor a view the user explicitly navigated to a date in. Only
   * `goToDate` ever assigns this.
   */
  private anchorDate: Date | null = null;
  private loading = false;
  /**
   * True while `onSentinelVisible` is processing a callback that it itself
   * triggered (via `unobserve`/`observe`) to force a fresh intersection
   * check, rather than one delivered for a genuine scroll. Distinguishes the
   * two so `burstCount` only bounds the former.
   */
  private forcedReobserve = false;
  /** Consecutive pages loaded in the current forced-reobserve burst. */
  private burstCount = 0;
  /**
   * Paths of entries with a mounted editor, oldest-mounted first. `readonly`
   * deliberately: `mountLifecycle` (below) closes over this exact array once,
   * at construction, so nothing may ever replace it wholesale — only mutate
   * it in place (`clearTimeline` truncates via `.length = 0`, never
   * reassigns) — or that closure would keep acting on a detached, stale
   * array forever.
   */
  private readonly mountOrder: string[] = [];
  /** Serializes `reload()`/`onClose()`; see `enqueueTimelineMutation`. */
  private timelineMutationChain: Promise<unknown> = Promise.resolve();
  /**
   * Set once, synchronously, at the top of `onClose`. Before `JournalService`
   * existed, nothing could enqueue a timeline mutation after `onClose`: the
   * only deferred caller was `nextPage`'s `queueMicrotask`, which drains long
   * before a human closes a tab. A vault-event handler breaks that — it can
   * call `reload()` (or, via `applyChange`, mutate the timeline directly)
   * from an arbitrary async callback that can land at any time, including
   * after the view has closed. Checked at the top of `reloadNow` and
   * `applyChange` so neither can rebuild/mutate into a `timelineEl` this view
   * no longer owns, which would otherwise leak every mounted editor (and, for
   * `ObsidianEmbedEditor`, its 250ms poll) for the rest of the session.
   */
  private closed = false;
  /**
   * The uncommitted composer opened by `startNewEntry`, if one is currently
   * open. Has no file until the user types something meaningful (see
   * `onComposerInput`/`commitComposer`) — never present in `this.rendered`
   * until it does. At most one composer exists at a time.
   */
  private composer: RenderedEntry | null = null;
  /**
   * Set the instant `onComposerInput` claims `this.composer` (nulling it) for
   * a keystroke it is about to commit, and cleared the instant
   * `commitComposer`'s task actually starts running. Covers the gap between
   * those two moments — the claim is synchronous, but `commitComposer` only
   * runs once its own turn on `enqueueTimelineMutation`'s chain arrives,
   * which a reload already queued ahead of it can win. Without this,
   * `clearTimeline` running in that gap sees `this.composer === null` and
   * has no way to find this rendered entry at all: it is in neither
   * `this.composer` nor `this.rendered` (that only happens once
   * `commitComposer` finishes), so its editor/DOM would leak, undestroyed by
   * anything but the timeline's own `timelineEl.empty()`. `clearTimeline`
   * folds it into the same snapshot an ordinary open composer gets, and the
   * original `commitComposer` call — passed the generation this was claimed
   * under — recognises it has been superseded and bails before ever
   * creating a file, so re-establishing this snapshot afterwards can never
   * race it into creating a duplicate entry.
   */
  private pendingComposerCommit: RenderedEntry | null = null;
  /**
   * Whether the current composer has ever actually held focus. Read once, on
   * the next frame after `openComposer` calls `editor.focus()`: if activation
   * stole focus back before it landed at all, that retry fires once more
   * (see `openComposer`). Does NOT gate `discardEmptyComposer` — see
   * `composerHasInput` for that — because focus landing and focus being
   * abandoned are different events, and Obsidian activating the freshly
   * opened leaf routinely delivers both a focus AND a blur to a composer
   * nobody has touched yet.
   */
  private composerEverFocused = false;
  /**
   * Whether the current composer's editor has reported at least one change
   * — i.e. the user actually typed, as opposed to merely having focus pass
   * through it. Gates the blur-discard in `discardEmptyComposer`.
   *
   * REQUIRED to be this, not `composerEverFocused`: `openComposer` calls
   * `editor.focus()`, which lands (setting `composerEverFocused`) the moment
   * before Obsidian's own leaf-activation takes focus back — a blur that
   * follows THAT focus is indistinguishable, by focus history alone, from a
   * user who focused the composer and then genuinely clicked away without
   * typing anything. Gating on focus history discarded an empty composer
   * nobody had abandoned at all, the moment activation's blur arrived.
   * Gating on input received instead only ever discards a composer once the
   * user has actually put a keystroke into it — the abandonment
   * `discardEmptyComposer` exists to clean up.
   */
  private composerHasInput = false;
  /**
   * Whether the currently open composer was opened by an explicit "New
   * journal entry" request — `startNewEntry`'s own call to `openComposer`,
   * or a `reestablishComposer` call that is itself carrying that same intent
   * forward across a rebuild (see `ComposerSnapshot.explicitPending`) — as
   * opposed to one restored purely because it already held meaningful text
   * or focus for some other reason. Combined with `composerHasInput` (see
   * `ComposerSnapshot.explicitPending`'s doc) to decide whether a re-establish
   * may still claim focus even though something else currently holds it.
   * Set on every `openComposer` call, fresh or restored — never mutated
   * afterwards; whether it still "counts" as pending is always computed
   * together with `composerHasInput` at the point something needs to know.
   */
  private composerExplicitRequest = false;
  /**
   * Resolves when `onOpen`'s first `reload()` has finished. Awaited by
   * `startNewEntry` so a composer is never enqueued ahead of the load that
   * would tear it down. Starts resolved so anything reaching it before
   * `onOpen` has run does not hang — that path cannot produce a usable
   * composer anyway, since `timelineEl` does not exist yet.
   */
  private initialLoad: Promise<void> = Promise.resolve();
  /**
   * Injected into `entrySave.ts`'s `scheduleSave`/`flushSave`/`save` so that
   * pipeline can write through `EntryRepository`/`JournalService` without
   * importing either — same dependency-injection shape as `mountWindow.ts`'s
   * `stateOf`/`onEvict`. Arrow functions, not bound method references,
   * because each still needs to make its call as `this.plugin.repository.…`/
   * `this.plugin.journal.…` — a bare unbound reference to either method
   * would lose its own `this` the moment `entrySave.ts` calls it as a plain
   * function.
   */
  private readonly saveDeps: SaveDeps = {
    writeBody: (file, body) => this.plugin.repository.writeBody(file, body),
    markSelfWrite: (path) => this.plugin.journal.markSelfWrite(path),
  };
  /**
   * The bound mount/unmount pipeline (see `mountLifecycle.ts`), built once
   * and closed over `this.mountOrder` — REQUIRED to be the exact same array
   * for this entry's whole lifetime, which is why that field is `readonly`
   * (see its doc). `getGeneration`/`renderStatic`/`lookup` are the "narrow
   * shared reference" back into state this pipeline doesn't own — see that
   * module's doc for why a clean cut isn't possible here. `save: this.saveDeps`
   * is passed straight through so the pipeline calls `entrySave.ts` directly
   * rather than through a `JournalView` method that would exist only to be
   * called — a test that needs to intercept a save gates the real dependency
   * underneath `saveDeps` (e.g. `vault.process`), not a view method.
   * The `as RenderedEntry` casts are safe: every `MountEntry` this pipeline
   * is ever actually called with (`this.rendered`'s values) already IS a
   * full `RenderedEntry`; `MountEntry` only narrows the compile-time view.
   */
  private readonly mountLifecycle: MountLifecycle = createMountLifecycle(this.mountOrder, MAX_MOUNTED_EDITORS, {
    getGeneration: () => this.generation,
    readBody: (file) => this.plugin.repository.readBody(file),
    renderStatic: (target) => this.renderStatic(target as RenderedEntry),
    editorFactory: this.plugin.editorFactory,
    lookup: (path) => this.rendered.get(path),
    save: this.saveDeps,
  });
  /**
   * The bound DOM-layer pipeline (see `timelineDom.ts`), owning `dayGroups`/
   * `lastRenderedMonth` outright. `getTimelineEl`/`hasRendered`/`getRendered`/
   * `setRendered`/`renderedCount`/`renderStatic`/`observeForMount`/`getIndex`/
   * `getAnchorDate`/`hasSentinel` are the narrow accessors back into state
   * this pipeline doesn't own (storage, paging/anchor state, the mount
   * observer, static rendering) — see that module's doc. `createEntryEl` is
   * this view's own DOM/wiring for one row, also not part of this seam.
   * The `as RenderedEntry`/`as DomRenderedEntry` casts mirror
   * `mountLifecycle`'s: every `DomRenderedEntry` this pipeline is ever
   * actually called with (`this.rendered`'s values, or a fresh
   * `this.createEntryEl(...)`) already IS a full `RenderedEntry`.
   */
  private readonly timelineDom: TimelineDom = createTimelineDom({
    getTimelineEl: () => this.timelineEl,
    hasRendered: (path) => this.rendered.has(path),
    getRendered: (path) => this.rendered.get(path),
    setRendered: (path, rendered) => this.rendered.set(path, rendered as RenderedEntry),
    renderedCount: () => this.rendered.size,
    createEntryEl: (entry) => this.createEntryEl(entry),
    renderStatic: (target) => this.renderStatic(target as RenderedEntry),
    observeForMount: (el) => this.mountObserver?.observe(el),
    getIndex: () => this.index,
    getAnchorDate: () => this.anchorDate,
    hasSentinel: () => this.sentinelEl !== null,
  });
  /**
   * The bound change-application pipeline (see `changeApplication.ts`),
   * closed over `this.mountOrder` — the exact same array `mountLifecycle`
   * closes over (see that field's doc on why it must be). `isClosed`/
   * `getGeneration`/`reload` are the reload/composer seam's state this
   * pipeline doesn't own; `getRendered`/`setRendered`/`deleteRendered` are
   * `this.rendered`'s narrow read/write surface (storage is not part of this
   * seam either); `insertEntryInPlace`/`removeEmptyDayGroups` are
   * `timelineDom.ts`'s jobs; `readBody`/`renderStatic` are the repository
   * read and static-rendering fallback; `fileIdentityStillValid`,
   * `logUnsavedTextIfLost`, and `clearMobileTimers` are small helpers shared
   * with teardown paths this seam doesn't own (`clearTimeline`,
   * `confirmDelete`). `save: this.saveDeps` is passed straight through, same
   * reasoning as `mountLifecycle`'s.
   * The `as RenderedEntry`/`as ChangeEntry` casts mirror `mountLifecycle`'s/
   * `timelineDom`'s: every `ChangeEntry` this pipeline is ever actually
   * called with (`this.rendered`'s values) already IS a full `RenderedEntry`.
   */
  private readonly changeApplication: ChangeApplication = createChangeApplication(this.mountOrder, {
    isClosed: () => this.closed,
    getGeneration: () => this.generation,
    reload: () => void this.reload(),
    getRendered: (path) => this.rendered.get(path),
    setRendered: (path, rendered) => this.rendered.set(path, rendered as RenderedEntry),
    deleteRendered: (path) => void this.rendered.delete(path),
    insertEntryInPlace: (entry) => this.insertEntryInPlace(entry),
    removeEmptyDayGroups: () => this.removeEmptyDayGroups(),
    readBody: (file) => this.plugin.repository.readBody(file),
    renderStatic: (rendered) => this.renderStatic(rendered as RenderedEntry),
    fileIdentityStillValid: (file) => this.app.vault.getAbstractFileByPath(file.path) === file,
    logUnsavedTextIfLost: (rendered) => this.logUnsavedTextIfLost(rendered as RenderedEntry),
    clearMobileTimers: (rendered) => this.clearMobileTimers(rendered as RenderedEntry),
    save: this.saveDeps,
  });

  constructor(
    leaf: WorkspaceLeaf,
    protected readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);

    // In the tab header, next to the view's own menu — the same place
    // Obsidian's built-in views put their actions. Registered here rather than
    // in onOpen because onOpen can run more than once over a view's life and
    // each call would add another icon.
    this.addAction("plus", "New journal entry", () => {
      void this.startNewEntry();
    });
  }

  getViewType(): string {
    return VIEW_TYPE_JOURNAL;
  }

  getDisplayText(): string {
    return "Journal";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("journal-view");
    this.timelineEl = this.contentEl.createDiv({ cls: "journal-timeline" });
    // ItemView.register runs this unsubscribe when the view closes, so no
    // change can reach `applyChange` once torn down, short of the race
    // `closed` itself guards against.
    this.register(this.plugin.journal.onChange((changes) => this.applyChanges(changes)));

    // Recorded so `startNewEntry` can wait for it. `setViewState` does not
    // guarantee this method has run, let alone finished, by the time it
    // resolves — so "open the journal, then start an entry" could otherwise
    // enqueue the composer *before* this first reload, and `clearTimeline`
    // would then tear the composer down as part of building the timeline the
    // composer was supposed to sit on top of.
    this.initialLoad = this.reload();
    await this.initialLoad;
  }

  async onClose(): Promise<void> {
    // Set synchronously, before anything else: a vault-event handler firing
    // between now and the actual teardown below must see this immediately,
    // not after an await hands control back to it first.
    this.closed = true;
    const composerSnapshot = await this.enqueueTimelineMutation(() => this.clearTimeline());

    // Unlike `reloadNow`, there is no fresh timeline to put a composer back
    // into — the view is genuinely going away. This is the one path where an
    // open, uncommitted composer is really, finally lost, so it gets the same
    // last-resort log `reestablishComposer` leaves when closing beats it to
    // the punch instead.
    if (composerSnapshot) this.logLostComposerDraft(composerSnapshot.value);

    this.contentEl.empty();
  }

  /** Discards and rebuilds the timeline, rendering only the first page. */
  async reload(): Promise<void> {
    return this.enqueueTimelineMutation(() => this.reloadNow());
  }

  /**
   * Serializes every call that tears down or rebuilds the timeline —
   * `reload()` and `onClose()` — behind one chain, so two can never
   * interleave. `generation` alone doesn't close this: a caller could
   * capture it after its own `await this.clearTimeline()` and bail on
   * mismatch, but `clearTimeline`'s own destroy-and-clear sequence
   * (`rendered.clear()`, `dayGroups.clear()`, `timelineEl.empty()`, …) has no
   * such guard on the synchronous work that follows *its* await — two
   * overlapping `clearTimeline` calls would still each unconditionally
   * clear/rebuild the same shared maps and DOM, regardless of what either
   * caller checks afterwards. Concretely reachable via the settings tab's
   * debounced `refreshJournal` (which calls `reload()`) landing while
   * `clearTimeline`'s flush is in flight, or `nextPage`'s
   * `queueMicrotask(() => void this.reload())` re-anchor firing during
   * another in-flight reload.
   *
   * The stored chain (`this.timelineMutationChain`) itself never rejects —
   * `task` is used as both the fulfillment and rejection handler on the
   * previous link — so one call's failure can never wedge every later call
   * behind a permanently-rejected promise. The promise returned to THIS
   * call's own caller still carries this call's real outcome.
   */
  private enqueueTimelineMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.timelineMutationChain.then(task, task);
    this.timelineMutationChain = result.catch(() => undefined);
    return result;
  }

  /**
   * The actual body of `reload()`, run only inside `enqueueTimelineMutation`.
   *
   * Both observers are installed BEFORE the empty-index check, not only in
   * the non-empty branch. An empty journal is not a dead end: the very next
   * thing to happen to it is normally the first entry ever being created
   * (Task 15's composer, or an "added" change from `JournalService` for a
   * file created by hand) arriving via `insertEntryInPlace`, and that path
   * has no other route to `mountObserver`/`sentinelEl` — it never calls
   * `installMountObserver`/`installSentinel` itself. Skipping this here
   * left `mountObserver` null, so `insertEntryInPlace`'s
   * `this.mountObserver?.observe(...)` silently no-op'd, `intersecting`
   * stayed stuck at its `false` default forever, and `mountEditor` bailed to
   * static on every attempt — a new user's very first journal entry would
   * render as permanently dead static text.
   */
  private async reloadNow(): Promise<void> {
    // REQUIRED guard: see `closed`'s doc. A vault-event-triggered reload can
    // land after the view has already closed; bail before touching anything
    // rather than rebuild a timeline nothing will ever tear back down.
    if (this.closed) return;

    const composerSnapshot = await this.clearTimeline();

    this.index = this.plugin.journal.getEntries();
    // With no anchor this is `null` — page one, exactly as before. With an
    // anchor, seed the cursor with the entry immediately before where the
    // anchored day starts, so the very first `loadNextPage()` yields the
    // anchor's page rather than the newest entries in the whole journal.
    this.lastLoadedPath = this.anchorDate ? anchorSeed(this.index, this.anchorDate) : null;
    this.installMountObserver();

    if (this.index.length === 0) {
      this.renderEmptyState();
      // Still installed even though there's nothing to page yet: the
      // sentinel's own initial IntersectionObserver callback finds the
      // first page empty and tears itself back down immediately (see
      // `onSentinelVisible`), which is the correct end state here anyway —
      // this only matters so a *later* full reload isn't the sole way back
      // into a paging-capable state.
      this.installSentinel();
      await this.reestablishComposer(composerSnapshot);
      return;
    }

    await this.loadNextPage();

    // The index itself isn't empty, but an anchor older than every entry in
    // it excludes all of them (see `anchorPosition`'s doc) — the first page
    // then loads nothing. Distinct from the `index.length === 0` branch
    // above: that one never calls `loadNextPage` at all, this one already
    // did and it legitimately came back with nothing to show.
    if (this.rendered.size === 0) this.renderEmptyState(this.anchorDate !== null);

    this.installSentinel();
    await this.reestablishComposer(composerSnapshot);
  }

  /**
   * Puts a composer `clearTimeline` just tore down back onto the freshly
   * rebuilt timeline, with the same (possibly empty) text, the same focus
   * state, and the same `created` it had — restoring exactly what the
   * rebuild disturbed rather than upgrading a background composer into a
   * focus-stealing one, downgrading a focused one into a silent background
   * reappearance, or letting a draft that survived a reload jump to a new
   * creation time. If the text was meaningful, commits it immediately —
   * `commitComposer` is already safe to call directly here (see below) — so
   * it does not go on sitting in a fileless composer indefinitely, kept
   * alive only for as long as some later reload happens to re-snapshot it.
   *
   * A no-op when `snapshot` is `null` (nothing was open or pending). When
   * the view closed while the rebuild above was in flight, there is nothing
   * left to put a composer into — building one now would either be dead
   * work (`onClose`'s own queued `clearTimeline` would just tear it straight
   * back down) or, worse, outlive `contentEl.empty()` and leak — so this
   * logs the same last-resort loss `onClose` itself would have logged had
   * the composer still existed for its own `clearTimeline` to find, since
   * that is exactly what closing mid-rebuild prevents.
   *
   * Calls `openComposer`/`commitComposer` directly rather than through
   * `enqueueTimelineMutation`: this already runs inside the one task that
   * chain is currently executing (`reloadNow`, itself always reached via
   * `enqueueTimelineMutation`), so re-enqueueing would only delay this to
   * "after the task now running finishes" — i.e. after itself.
   */
  private async reestablishComposer(snapshot: ComposerSnapshot | null): Promise<void> {
    if (snapshot === null) return;

    if (this.closed) {
      this.logLostComposerDraft(snapshot.value);
      return;
    }

    await this.openComposer({
      initialValue: snapshot.value,
      // An explicit, never-typed-into request still wants the caret even if
      // it had already lost focus to background churn (another entry's
      // editor mounting, e.g.) by the exact instant `clearTimeline` ran —
      // `hadFocus` alone would otherwise treat that churn the same as the
      // user genuinely having moved on. See `explicitPending`'s doc.
      focus: snapshot.hadFocus || snapshot.explicitPending,
      preserveExternalFocus: true,
      created: snapshot.created,
      explicitRequest: snapshot.explicitPending,
    });

    // Closed while `openComposer`'s own promise settled: it never awaits
    // anything real, but even an immediately-resolved promise still yields
    // one microtask turn, which is enough for `onClose` to have landed in
    // between. Leave the composer it just built exactly where it is —
    // `onClose`'s own queued `clearTimeline()` will find it via the ordinary
    // `this.composer` branch, snapshot it, and log it as usual. Claiming it
    // here first and then bailing inside `commitComposer`'s own `closed`
    // check would instead orphan it: reachable by neither `this.composer`
    // nor `this.rendered`, the same hole `pendingComposerCommit` exists to
    // close for the other claim path.
    if (this.closed || !this.composer) return;

    if (isMeaningful(snapshot.value)) {
      const rendered = this.composer;
      const claimedGeneration = this.generation;
      // Whether `openComposer` actually ended up focusing this composer —
      // not `snapshot.hadFocus` on its own, which `preserveExternalFocus`
      // above may have overridden if something else claimed focus while the
      // rebuild's awaits were in flight. `commitComposer`'s own trailing
      // focus call has no such guard, so without threading this through it
      // would grab focus back regardless — on exactly the path
      // `preserveExternalFocus` exists to cover.
      const shouldFocus = rendered.editor?.hasFocus() ?? false;
      this.composer = null;
      await this.commitComposer(rendered, claimedGeneration, shouldFocus);
    }
  }

  /**
   * Last-resort log for composer text that is genuinely, unrecoverably about
   * to be lost — no fresh timeline left to put it back into. Quiet for an
   * empty composer, which is the overwhelmingly common case (CLAUDE.md's
   * Lazy Creation): most composers never hold meaningful text at all.
   */
  private logLostComposerDraft(value: string): void {
    if (!isMeaningful(value)) return;
    console.error(
      "Simple Journal: discarding unsaved text for (uncommitted composer) — recover it from this line before it is lost:",
      value,
    );
  }

  /**
   * Discards the current timeline. Bumps `generation` before doing any async
   * work (flushing), same reasoning as `renderStatic`/`loadNextPage`: any
   * mount or unmount from the outgoing generation that resumes after this
   * point sees the change and bails rather than touching a timeline this
   * method is in the middle of tearing down.
   *
   * Every pending save is flushed — via `flushSave`, which itself calls
   * `editor.flush()` before reading the value — before any editor is
   * destroyed. Without this, an edit still sitting inside the 500ms debounce
   * window when the view closes (or a reload/settings change tears the
   * timeline down) would never reach disk.
   *
   * `Promise.allSettled`, not `Promise.all`: `save()` itself never rejects,
   * but a flush's synchronous `editor.flush()` call could in principle throw
   * before reaching it. `Promise.all` would then reject this whole method,
   * skipping the destroy loop, `rendered.clear()`, and `timelineEl.empty()`
   * below entirely — leaving every editor mounted (an `ObsidianEmbedEditor`'s
   * 250ms poll still running against soon-to-be-detached DOM) and `onClose`/
   * `reload` themselves rejecting. `allSettled` guarantees every flush is
   * given the chance to finish, successfully or not, before teardown
   * proceeds regardless.
   *
   * Returns a snapshot of the composer that was open when this ran — or of
   * one already claimed for commit but not yet actually committed (see
   * `pendingComposerCommit`) — or `null` if neither was the case.
   * `reloadNow` uses it to re-establish (and, if it held meaningful text,
   * commit) the composer once the fresh timeline is built via
   * `reestablishComposer` — a rebuild (the settings tab's debounced
   * `refreshJournal`, a folder-rename `"reload"` change, or `onOpen`'s own
   * first `reload()` landing after `startNewEntry` already opened one — see
   * `startNewEntry`'s doc) should not be able to silently sweep away a
   * composer the user has open. `onClose` gets the same snapshot back but
   * only ever logs it: the view itself is going away, so there is nothing
   * left to re-establish it into.
   */
  private async clearTimeline(): Promise<ComposerSnapshot | null> {
    this.teardownSentinel();
    this.teardownMountObserver();

    // An open, uncommitted composer has no entry in `this.rendered` for the
    // flush-and-destroy loop below to reach. Without this, a reload (or the
    // view closing) while the composer is still open would leak its
    // TextareaEditor and DOM, and leave `this.composer` pointing at a
    // detached element for the rest of the session. Done synchronously,
    // before the loop's only await, so `discardEmptyComposer`/
    // `commitComposer` — which both re-check `this.composer === rendered` —
    // see this as already torn down regardless of when they happen to run.
    //
    // Not committing it here on the way out: creating a file during teardown
    // is a worse failure mode than losing an unsent draft, and committing
    // only on meaningful input (CLAUDE.md's Lazy Creation) is a product
    // rule, not merely this method's default. The snapshot below is what
    // lets the caller put the same (possibly meaningful, possibly empty)
    // text back into a fresh composer instead, without ever writing a file
    // here.
    let composerSnapshot: ComposerSnapshot | null = null;
    if (this.composer) {
      composerSnapshot = {
        value: this.composer.editor?.getValue() ?? "",
        hadFocus: this.composer.editor?.hasFocus() ?? false,
        created: this.composer.entry.created,
        explicitPending: this.composerExplicitRequest && !this.composerHasInput,
      };

      this.clearMobileTimers(this.composer);
      this.composer.editor?.destroy();
      this.composer = null;
    } else if (this.pendingComposerCommit) {
      // A keystroke had already claimed the composer (`this.composer`
      // nulled, `commitComposer` enqueued) before this reload's own turn on
      // the mutation chain arrived — see `pendingComposerCommit`'s doc. That
      // queued `commitComposer` call is still behind this one; passed the
      // generation this was claimed under, it will recognise once it does
      // run that a reload has since happened and bail before creating a
      // file, so folding this into the same snapshot an ordinary open
      // composer gets (rather than just logging it lost) cannot race it
      // into a duplicate entry. Read live, not the value from whenever the
      // keystroke landed: the still-mounted textarea keeps accepting input
      // (even though nothing is currently listening for meaningful ones)
      // until the `destroy()` below.
      const pending = this.pendingComposerCommit;
      composerSnapshot = {
        value: pending.editor?.getValue() ?? "",
        hadFocus: pending.editor?.hasFocus() ?? false,
        created: pending.entry.created,
        // A claim in flight only ever happens once a keystroke has already
        // made the text meaningful (see `onComposerInput`) — always past
        // `composerHasInput`, so this is always `false` here. Spelled out
        // rather than hardcoded so this stays correct if that ever changes.
        explicitPending: this.composerExplicitRequest && !this.composerHasInput,
      };

      this.clearMobileTimers(pending);
      pending.editor?.destroy();
      this.pendingComposerCommit = null;
    }

    this.generation++;

    const renderedEntries = Array.from(this.rendered.values());
    await Promise.allSettled(renderedEntries.map((rendered) => this.flushSave(rendered)));

    for (const rendered of renderedEntries) {
      // Unlike `unmountEditor`'s decline, there is no option to keep this
      // entry mounted instead: the timeline itself is genuinely coming down
      // (view close, reload, a settings change). If the flush above still
      // left this dirty (the write is still failing), the text is about to
      // be discarded for real — log it before destroying so the developer
      // console is the last available place to recover it from.
      this.logUnsavedTextIfLost(rendered);
      this.clearMobileTimers(rendered);
      rendered.editor?.destroy();
      rendered.editor = null;
      rendered.renderComponent?.unload();
    }

    this.rendered.clear();
    // Clears `dayGroups`/`lastRenderedMonth`, both owned by `timelineDom`
    // (see `timelineDom.ts`) since the DOM-layer split.
    this.timelineDom.reset();
    // Truncated in place, never reassigned — `mountOrder` is `readonly`
    // precisely so this stays true; see its doc.
    this.mountOrder.length = 0;
    this.timelineEl.empty();

    return composerSnapshot;
  }

  /**
   * Appends the next page below what is already rendered.
   *
   * `"busy"` and `"exhausted"` must stay distinct: a caller that reads
   * `"busy"` as `"exhausted"` would tear down the sentinel/observer on a
   * load that is merely in flight, killing infinite scroll for the rest of
   * the view's life. Unreachable today (see the guard below), but the
   * distinction matters the moment this gains a real await.
   */
  private async loadNextPage(): Promise<"loaded" | "exhausted" | "busy"> {
    // No-op today: everything below runs synchronously (no `await` in this
    // try block), so JS's run-to-completion semantics already serialize
    // calls before this guard would ever see `loading === true`. Kept
    // anyway — the moment this gains a real await (e.g. Task 13 mounting an
    // editor on the append path), concurrent callers become possible and
    // this guard becomes load-bearing.
    if (this.loading) return "busy";
    this.loading = true;
    // Captured before any work, mirroring renderStatic: a concurrent
    // reload() bumps this. Checked below, before the mutation that commits
    // this page as loaded, so a reload() landing mid-call (impossible today
    // with no await in this function, but not once Task 13 adds one to the
    // append path) can't resume into a cleared timeline and leave paging
    // anchored on a page that was appended nowhere real.
    const generation = this.generation;

    try {
      const page = this.nextPage();
      if (page.length === 0) return "exhausted";

      for (const entry of page) {
        if (generation !== this.generation) return "exhausted";
        this.appendEntry(entry);
      }

      if (generation !== this.generation) return "exhausted";

      this.lastLoadedPath = page[page.length - 1].file.path;
      return "loaded";
    } finally {
      this.loading = false;
    }
  }

  /**
   * The next page below what is rendered.
   *
   * `pageAfter` returns null when its cursor is no longer in the index — the
   * cursor entry was deleted or renamed since it was recorded. Re-anchor on the
   * oldest rendered entry that still exists, rather than silently handing back
   * page one and re-appending entries that are already on screen.
   */
  private nextPage(): JournalEntry[] {
    if (this.lastLoadedPath === null) {
      return pageAfter(this.index, null, PAGE_SIZE) ?? [];
    }

    const direct = pageAfter(this.index, this.lastLoadedPath, PAGE_SIZE);
    if (direct !== null) return direct;

    // The cursor is gone. Re-anchor on whichever currently-rendered entry
    // sits furthest down `this.index` — by definition the oldest
    // still-present rendered entry — rather than relying on `this.rendered`'s
    // insertion order. Insertion order happens to be newest-first today
    // because only `appendEntry` ever populates it, but Task 14 can insert a
    // newer entry into the map after older ones are already there (a vault
    // change re-inserting an entry at its correct position), which would
    // break an order-based re-anchor silently.
    let furthestPath: string | null = null;
    let furthestIndex = -1;

    for (const path of this.rendered.keys()) {
      const index = this.index.findIndex((e) => e.file.path === path);
      if (index > furthestIndex) {
        furthestIndex = index;
        furthestPath = path;
      }
    }

    if (furthestPath !== null) {
      const page = pageAfter(this.index, furthestPath, PAGE_SIZE);
      if (page !== null) {
        this.lastLoadedPath = furthestPath;
        return page;
      }
    }

    // Nothing currently rendered survives in the index — e.g. the journal
    // folder itself was renamed while scrolled down, which mutates every
    // live TFile.path in place, so every rendered path and every cursor
    // misses at once. Appending page one here would land it below the stale
    // nodes, which are still in the DOM and still in `this.rendered`
    // (removing them is a later task) — rebuild the whole timeline instead.
    //
    // Deferred rather than called directly: this method runs inside
    // loadNextPage's locked section (`this.loading` is still true), and
    // reload() itself awaits loadNextPage() to load page one. Calling
    // reload() synchronously here would reenter that lock, see "busy", skip
    // loading page one, and install a sentinel over an empty timeline.
    // queueMicrotask defers it until after this call (and its `finally`,
    // which clears the lock) has returned.
    queueMicrotask(() => void this.reload());
    return [];
  }

  /**
   * Watches an element at the bottom of the timeline. Because older entries are
   * appended below, the content above them never moves and scroll position is
   * preserved without any manual correction.
   */
  private installSentinel(): void {
    // Never leave a previous observer connected. Two overlapping reloads would
    // otherwise orphan the first sentinel, and its observer would keep firing
    // against a timeline it no longer owns. Reachable once Task 13 puts a real
    // await inside loadNextPage.
    this.teardownSentinel();

    const sentinelEl = this.timelineEl.createDiv({ cls: "journal-sentinel" });
    this.sentinelEl = sentinelEl;
    this.forcedReobserve = false;
    this.burstCount = 0;

    // Constructed from the sentinel's own window rather than the plugin's
    // global scope, so this still works when the leaf has been dragged into
    // an Obsidian popout window — a separate browsing context with its own
    // IntersectionObserver realm. In the main window `sentinelEl.win ===
    // window`, so this is behaviour-identical there. `win` is typed as a
    // bare `Window`, which doesn't carry constructor globals like
    // IntersectionObserver — hence the cast naming it.
    const win = sentinelEl.win as Window & { IntersectionObserver: typeof IntersectionObserver };

    this.observer = new win.IntersectionObserver(
      (entries) => {
        // Cleared here, unconditionally, whenever the callback fires — not
        // inside onSentinelVisible. A forced re-observe (see below) can come
        // back non-intersecting, in which case onSentinelVisible is never
        // called; clearing the flag only on the path that calls it would
        // leave it stuck true, corrupting the burst count on the next
        // genuine scroll.
        const isBurstContinuation = this.forcedReobserve;
        this.forcedReobserve = false;

        if (!entries.some((e) => e.isIntersecting)) return;
        void this.onSentinelVisible(isBurstContinuation);
      },
      {
        root: this.contentEl,
        // Start loading before the sentinel is actually on screen. Mobile
        // scrolls more slowly and repaints later, so start earlier there.
        rootMargin: Platform.isMobile ? "1200px 0px" : "600px 0px",
      },
    );

    this.observer.observe(sentinelEl);
  }

  /**
   * With the observer's default threshold ([0]), the callback only fires on
   * an enter/exit transition. An appended page that still leaves the
   * sentinel inside `rootMargin` (easy with PAGE_SIZE short entries) stays
   * continuously intersecting, so no further transition ever occurs and
   * loading silently stalls. `unobserve`/`observe` below forces a fresh
   * delivery, re-evaluating the sentinel's current state — if it is still
   * intersecting the next page loads immediately, cascading until the
   * sentinel is genuinely off-screen, the index is exhausted, or
   * `MAX_BURST_PAGES` is hit.
   */
  private async onSentinelVisible(isBurstContinuation: boolean): Promise<void> {
    const generation = this.generation;
    this.burstCount = isBurstContinuation ? this.burstCount + 1 : 1;

    const result = await this.loadNextPage();
    // A concurrent reload() (e.g. from the settings tab's debounced
    // refreshJournal, or the rebuild `nextPage` queues on a lost cursor) may
    // have already torn down this observer/sentinel and installed new ones
    // while loadNextPage was in flight. this.sentinelEl and this.observer
    // are instance fields, not a captured snapshot, so touching them here
    // without this check could re-append or disconnect state that belongs
    // to the new generation, not this one.
    if (generation !== this.generation) return;

    // "busy" means a load was already in flight when this call started —
    // not that paging is exhausted. Reading it as exhausted would tear down
    // a perfectly live observer/sentinel out from under an in-flight load.
    // Unreachable today (loadNextPage's guard never trips without a real
    // await inside it), but do nothing here rather than assume either
    // outcome.
    if (result === "busy") return;

    if (result === "exhausted") {
      this.teardownSentinel();
      return;
    }

    // Keep the sentinel below the newly appended entries.
    if (this.sentinelEl) this.timelineEl.appendChild(this.sentinelEl);

    if (this.burstCount >= MAX_BURST_PAGES) {
      // Bound hit: stop forcing further checks. The sentinel is still
      // observed, so a genuine scroll (a real transition, not one we forced)
      // resumes the cascade.
      return;
    }

    if (this.observer && this.sentinelEl) {
      this.forcedReobserve = true;
      this.observer.unobserve(this.sentinelEl);
      this.observer.observe(this.sentinelEl);
    }
  }

  private teardownSentinel(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.sentinelEl?.remove();
    this.sentinelEl = null;
    this.forcedReobserve = false;
    this.burstCount = 0;
  }

  /**
   * Installs the observer that drives the editor mount window. Every
   * rendered entry is `observe()`d as it is appended (see `appendEntry`);
   * this only needs to construct the observer itself once per timeline.
   *
   * An entry crossing into `MOUNT_ROOT_MARGIN` mounts a live editor; crossing
   * back out unmounts it (flushing first) and restores static rendering.
   * This is the primary bound on mounted editors — `MAX_MOUNTED_EDITORS` in
   * `enforceMountLimit` is only a backstop for when more entries are
   * simultaneously within the margin than that allows.
   */
  private installMountObserver(): void {
    this.teardownMountObserver();

    // Constructed from the timeline's own window, same reasoning as
    // installSentinel: this must keep working if the leaf is in a popout.
    const win = this.timelineEl.win as Window & { IntersectionObserver: typeof IntersectionObserver };

    this.mountObserver = new win.IntersectionObserver(
      (entries) => {
        // One read of the (unexpanded, i.e. NOT widened by
        // MOUNT_ROOT_MARGIN) viewport rect per callback, not per entry —
        // `enforceMountLimit`'s distance-based eviction (see
        // `mountWindow.ts`) needs a common centre to measure every entry
        // against. `boundingClientRect` on each `observerEntry` below is
        // already computed by the browser as part of the intersection
        // observation itself, so this is the only extra layout read this
        // callback performs.
        const rootRect = this.contentEl.getBoundingClientRect();
        const rootCenter = rootRect.top + rootRect.height / 2;

        for (const observerEntry of entries) {
          const path = (observerEntry.target as HTMLElement).dataset.path;
          if (!path) continue;

          const rendered = this.rendered.get(path);
          if (!rendered) continue;

          rendered.intersecting = observerEntry.isIntersecting;
          const rect = observerEntry.boundingClientRect;
          rendered.mountDistance = Math.abs(rect.top + rect.height / 2 - rootCenter);

          if (observerEntry.isIntersecting) {
            void this.mountEditor(rendered);
          } else {
            void this.unmountEditor(rendered);
          }
        }
      },
      {
        root: this.contentEl,
        rootMargin: MOUNT_ROOT_MARGIN,
      },
    );
  }

  private teardownMountObserver(): void {
    this.mountObserver?.disconnect();
    this.mountObserver = null;
  }

  /**
   * See `renderEmptyState` in `timelineDom.ts` for what this actually does
   * and why; this wrapper exists only so calls go through `this.` — same
   * reasoning as `mountEditor`'s doc in `mountLifecycle.ts`.
   */
  private renderEmptyState(anchored = false): void {
    this.timelineDom.renderEmptyState(anchored);
  }

  /**
   * See `appendEntry` in `timelineDom.ts` for what this actually does and
   * why; this wrapper exists only so calls go through `this.` (see
   * `renderEmptyState`'s doc above).
   */
  private appendEntry(entry: JournalEntry): void {
    this.timelineDom.appendEntry(entry);
  }

  /**
   * See `ensureDayGroup` in `timelineDom.ts` for what this actually does and
   * why; this wrapper exists only so calls go through `this.` (see
   * `renderEmptyState`'s doc above).
   */
  private ensureDayGroup(date: Date, position: "append" | "prepend"): HTMLElement {
    return this.timelineDom.ensureDayGroup(date, position);
  }

  /**
   * See `rebuildMonthHeaders` in `timelineDom.ts` for what this actually
   * does and why; this wrapper exists only so calls go through `this.` (see
   * `renderEmptyState`'s doc above).
   */
  private rebuildMonthHeaders(): void {
    this.timelineDom.rebuildMonthHeaders();
  }

  private createEntryEl(entry: JournalEntry): RenderedEntry {
    const el = createDiv({ cls: "journal-entry" });
    // `entry.file` is null for an uncommitted composer (see `openComposer`);
    // `data-path` is simply left unset until `commitComposer` gives it a
    // real file. Every other caller always has a real file here.
    if (entry.file) el.dataset.path = entry.file.path;

    const headerEl = el.createDiv({ cls: "journal-entry-header" });
    // A real <button>, not a span+click: it needs no extra wiring to be
    // reachable by keyboard and to activate on Enter/Space, and disabling it
    // (below, for the composer) removes it from the tab order for free
    // instead of a hand-rolled tabindex/aria-disabled combination.
    // `type="button"` only to keep it inert if this element ever ends up
    // inside a <form> — there isn't one today, but nothing here guarantees
    // that stays true.
    const timeButton = headerEl.createEl("button", {
      cls: "journal-entry-time",
      text: formatTime(entry.created),
      attr: { type: "button" },
    });
    // The composer (see the `data-path` comment above) has no file to
    // correct yet — disabled both keeps it out of the tab order (so keyboard
    // navigation doesn't land on a dead control) and blocks the click, same
    // intent as `journal-entry-actions-pending` for the actions button just
    // below. `commitComposer` re-enables it the moment the entry gets a file.
    if (!entry.file) timeButton.disabled = true;

    // Hidden until hover/focus (see styles.css) — the timeline is a writing
    // surface, not a dashboard, so nothing but the timestamp is visible at rest.
    const actionsEl = headerEl.createDiv({ cls: "journal-entry-actions" });
    // The uncommitted composer has no file yet — showEntryMenu no-ops for it
    // (see its doc), so the button would otherwise sit there tooltipped and
    // dead. Hidden here; commitComposer unhides it in the same breath it
    // gives the entry a real file.
    if (!entry.file) actionsEl.addClass("journal-entry-actions-pending");
    const button = new ButtonComponent(actionsEl)
      .setIcon("more-horizontal")
      .setTooltip("Entry actions")
      .setClass("clickable-icon");
    button.buttonEl.addClass("journal-entry-menu-button");

    // markdown-rendered matches Obsidian's own preview scope, so lists,
    // code fences, blockquotes, tables and callouts pick up its styling
    // (and whatever a theme layers on top of it) instead of browser defaults.
    const bodyEl = el.createDiv({ cls: "journal-entry-body markdown-rendered" });

    const rendered: RenderedEntry = {
      entry,
      el,
      bodyEl,
      renderComponent: null,
      editor: null,
      saveHandle: null,
      // Overwritten with the real on-disk body the moment an editor mounts
      // (see mountEditor); "" here is never observable as a save decision
      // since nothing can trigger a save before that happens.
      savedBody: "",
      intersecting: false,
      mountDistance: 0,
      opToken: 0,
      saveToken: 0,
      keyboardScrollHandle: null,
      longPressHandle: null,
    };

    // Recovery path for an entry left statically rendered while still
    // intersecting — reachable after `enforceMountLimit` evicts it (distance-
    // based eviction makes this rare, not impossible) or, in principle, any
    // other future path that unmounts without the entry actually leaving
    // `MOUNT_ROOT_MARGIN`. `mountEditor` is otherwise only ever called from
    // `mountObserver`'s enter TRANSITION, which has already fired and won't
    // fire again until the entry leaves and re-enters — without this, such a
    // row looks editable but silently swallows every click and keystroke
    // until the user scrolls it out of the margin and back in. No thrash
    // risk: this only acts when `rendered.editor` is null, and mounting sets
    // it, so a second interaction before the first mount resolves is a no-op
    // (see `mountEditor`'s own guard).
    const remountOnInteraction = (): void => {
      if (rendered.editor || !rendered.intersecting) return;
      void this.mountEditor(rendered).then(() => rendered.editor?.focus());
    };
    bodyEl.addEventListener("pointerdown", remountOnInteraction);
    bodyEl.addEventListener("focusin", remountOnInteraction);

    button.onClick((event) => this.showEntryMenu(rendered, event));

    // Same code path as the "Change entry time" menu item below, so the two
    // affordances can never diverge — `changeEntryTime` already no-ops for
    // the composer (no file), which is belt-and-suspenders here since
    // `disabled` above already keeps this click from firing in that case.
    // The visible text is only the bare time ("14:22"), which reads as
    // nothing more than a label to a screen reader; the tooltip doubles as
    // the accessible name and folds the time back in (`aria-label` replaces
    // rather than supplements visible text) so it still identifies which
    // entry this is, not just that the control exists.
    timeButton.addEventListener("click", () => this.changeEntryTime(rendered));
    setTooltip(timeButton, `Change entry time (${formatTime(entry.created)})`);

    // Bound on the entry element, not the body: `.journal-entry-body` holds
    // the live editor (or its static rendering), and — while an editor is
    // actually mounted — its own context menu (spell-check suggestions, the
    // editor's paste items) must reach the user untouched. Only the chrome
    // around it (the header, the padding outside the body) opens the
    // entry-actions menu on right-click.
    //
    // `instanceof Element`, not `HTMLElement`: an SVG target (embedded SVG,
    // rendered Mermaid output) is an `Element` but not an `HTMLElement`, and
    // `closest()` is on `Element` — the narrower check let an SVG click
    // inside the body fall through to `preventDefault` and our own menu.
    //
    // The bail is also gated on `rendered.editor !== null`: a
    // statically-rendered entry (no live editor) has no editor menu to
    // protect, so a right-click on its text should still open the entry
    // menu rather than falling through to the generic Electron menu.
    el.addEventListener("contextmenu", (event) => {
      const insideBody = event.target instanceof Element && event.target.closest(".journal-entry-body");
      if (insideBody && rendered.editor !== null) return;
      event.preventDefault();
      this.showEntryMenu(rendered, event);
    });

    if (Platform.isMobile) {
      // The on-screen keyboard shrinks the viewport after focus; scroll the
      // focused entry back into view once that has happened. Bound once here
      // (rather than in mountEditor, which runs again every time this entry
      // re-enters the mount window) since `bodyEl` is the same node for this
      // RenderedEntry's whole lifetime — binding on every mount would stack a
      // fresh listener on top of every previous one, each still reachable
      // through the very node that never got replaced.
      //
      // KNOWN LIMITATION: `scrollIntoView({block: "nearest"})` is a no-op
      // once `rendered.el` already spans the scrollport — exactly the case
      // for an entry taller than the screen, where the caret can still sit
      // under the keyboard after this "corrects" nothing. Fixing that
      // properly means scrolling to the caret (or the visible viewport
      // edge), not the entry element — which for the embedded editor means
      // reaching into CM6 for a coordinate, and for either editor means
      // knowing that `window.visualViewport`'s `resize` event actually fires
      // on keyboard open inside Obsidian's mobile shell, on both iOS and
      // Android, which cannot be confirmed without a device. Building that
      // on a guess risks the same outcome as the embedded editor's deleted
      // self-reload guard (see ObsidianEmbedEditor's "Self-reload" doc) — a
      // heuristic over behaviour this file cannot observe. Left as a
      // documented gap rather than machinery over an assumption; see
      // `docs/manual-testing.md`'s mobile section for the device check.
      rendered.bodyEl.addEventListener("focusin", () => {
        if (rendered.keyboardScrollHandle !== null) window.clearTimeout(rendered.keyboardScrollHandle);
        rendered.keyboardScrollHandle = window.setTimeout(() => {
          rendered.keyboardScrollHandle = null;
          rendered.el.scrollIntoView({ block: "nearest" });
        }, 300);
      });

      // A blur that actually leaves the entry body cancels the pending
      // correction above — the keyboard closing (or focus moving to a
      // different entry, which mounts its own timer) makes scrolling back to
      // THIS entry wrong, not merely unnecessary. Mirrors
      // `ObsidianEmbedEditor`'s own focusout guard: only a `relatedTarget`
      // outside `bodyEl` counts as a real blur, not CM6 shifting focus
      // between its own internal nodes.
      rendered.bodyEl.addEventListener("focusout", (event) => {
        const related = event.relatedTarget as Node | null;
        if (related && rendered.bodyEl.contains(related)) return;
        if (rendered.keyboardScrollHandle !== null) {
          window.clearTimeout(rendered.keyboardScrollHandle);
          rendered.keyboardScrollHandle = null;
        }
      });

      // `contextmenu` does not fire from a tap on iOS, so a long-press on
      // the entry's own chrome is the touch equivalent of the desktop
      // right-click above. Bails immediately on a touch that starts inside
      // `.journal-entry-body`: that surface is an editing surface first, and
      // a long-press there is the editor's own text-selection gesture, not a
      // request for this menu. Also bails inside `.journal-entry-actions` and
      // `.journal-entry-time`: both already open something on tap (this same
      // menu, and the time editor, respectively), and without this a
      // long-press on either would open the menu at 500ms and the touch's own
      // `touchend`-driven `click` would then fire right after.
      //
      // `instanceof Element`, not `HTMLElement`, matching the `contextmenu`
      // handler above and for the same reason: an SVG target (a Mermaid
      // diagram, an embedded SVG) is an `Element` but not an `HTMLElement`,
      // and `closest()` is on `Element` — the narrower check would let a
      // long-press on SVG content inside the body skip the bail.
      el.addEventListener("touchstart", (event) => {
        // A new touch on this entry — whether it turns out to be a scroll, a
        // selection, or a long-press — means the user is now actively
        // gesturing here, not passively waiting for the keyboard-open
        // correction above to fire. Without this, focusing this entry and
        // then immediately flick-scrolling away (well within the 300ms
        // window) gets yanked back to it a moment later.
        if (rendered.keyboardScrollHandle !== null) {
          window.clearTimeout(rendered.keyboardScrollHandle);
          rendered.keyboardScrollHandle = null;
        }

        const target = event.target;
        if (target instanceof Element && target.closest(".journal-entry-body, .journal-entry-actions, .journal-entry-time")) {
          return;
        }

        if (rendered.longPressHandle !== null) window.clearTimeout(rendered.longPressHandle);
        rendered.longPressHandle = window.setTimeout(() => {
          rendered.longPressHandle = null;
          const touch = event.touches[0];
          if (!touch) return;
          this.showEntryMenu(
            rendered,
            new MouseEvent("contextmenu", { clientX: touch.clientX, clientY: touch.clientY }),
          );
        }, 500);
      });

      // Any of these means the touch was a scroll, a drag, or otherwise not
      // a stationary press — cancel before the timer fires.
      const cancelPress = () => {
        if (rendered.longPressHandle !== null) window.clearTimeout(rendered.longPressHandle);
        rendered.longPressHandle = null;
      };

      el.addEventListener("touchend", cancelPress);
      el.addEventListener("touchmove", cancelPress);
      el.addEventListener("touchcancel", cancelPress);
    }

    return rendered;
  }

  /**
   * Builds and shows the entry-actions menu, from either the hover button or
   * a right-click on the entry's own chrome (see `createEntryEl`).
   *
   * Bails silently for the uncommitted composer (`rendered.entry.file` is
   * null until `commitComposer` gives it a real file) — there is no source
   * note to open, no link to copy, and nothing to delete yet.
   */
  private showEntryMenu(rendered: RenderedEntry, event: MouseEvent): void {
    const file = rendered.entry.file;
    if (!file) return;

    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("Open source note")
        .setIcon("file-text")
        .onClick(() => {
          void this.app.workspace.getLeaf("tab").openFile(file);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle("Copy link to entry")
        .setIcon("link")
        .onClick(() => {
          // `sourcePath` is the note the link will be pasted into — unknowable
          // here, since this runs from the timeline, not from any particular
          // note. "" (vault root) is the only value available; there is no
          // universally-correct one. Under "Shortest path when possible" this
          // still resolves from anywhere, since entry basenames are unique
          // (timestamp filenames); under "Relative path to file" the same
          // link would break if pasted into a note outside the journal root.
          const link = this.app.fileManager.generateMarkdownLink(file, "");
          // The plugin's only clipboard use, and it is write-only: it never
          // calls readText, so it cannot see what the user copied from
          // anywhere else. What it writes is a link this plugin just
          // generated — never the entry's text, and nothing the user did not
          // ask for by choosing "Copy link to entry". Obsidian exposes no
          // clipboard API of its own, so the web platform's is the only route.
          //
          // `writeText` rejects when the document isn't focused or clipboard
          // permission is denied — reported honestly rather than assuming
          // success, since the alternative is telling the user their link
          // copied when it didn't.
          navigator.clipboard.writeText(link).then(
            () => new Notice("Link copied"),
            (error) => {
              console.error("Simple Journal: could not copy the entry link", error);
              new Notice("Could not copy the link. See the developer console for details.");
            },
          );
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle("Change entry time")
        .setIcon("clock")
        .onClick(() => {
          this.changeEntryTime(rendered);
        }),
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Delete entry")
        .setIcon("trash")
        .onClick(() => {
          void this.confirmDelete(rendered);
        }),
    );

    menu.showAtMouseEvent(event);
  }

  /**
   * Opens `ChangeEntryTimeModal` prefilled with this entry's currently
   * resolved timestamp, and on confirmation writes the new value to the
   * entry's `created` property, then moves the file to match via
   * `EntryRepository.renameEntryToMatch` — see `commitEntryTimeChange`'s doc
   * for why the write and the move happen in that order, and for a
   * conventionally-named file only.
   *
   * Any pending debounced body edit is flushed first, exactly like
   * `confirmDelete` flushes before deleting: without it, this write and a
   * still-pending body save could race against the same file.
   *
   * Also bails if `file` no longer exists in the vault — same identity
   * check `handleDeleteFallback` uses. Both callers reach this through a
   * control that's still enabled/focusable during the window between a
   * deletion being confirmed (`is-deleting`'s `pointer-events: none` blocks
   * a click, but not `Enter` on a still-focused, still-tabbable button) and
   * the vault event that actually tears the row down; this covers that race
   * for the timestamp button as well as the pre-existing one for the "..."
   * menu, and incidentally covers a file vanishing for any other external
   * reason too.
   */
  private changeEntryTime(rendered: RenderedEntry): void {
    const file = rendered.entry.file;
    if (!file) return;
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;

    new ChangeEntryTimeModal(this.app, rendered.entry.created, (value) => {
      void this.commitEntryTimeChange(rendered, file, value);
    }).open();
  }

  /**
   * The write behind `changeEntryTime`, plus making sure the corrected
   * entry is actually visible afterward — never left silently repositioned
   * out of the loaded window or past an active anchor, which is exactly
   * what CLAUDE.md's "never risk data loss... fail visibly" spirit forbids
   * for something the user just deliberately did.
   *
   * `EntryRepository.setEntryCreated`'s write reaches `JournalService`
   * through the ordinary vault/metadata-cache event path eventually, but
   * that path is both debounced (`JournalService`'s `DEBOUNCE_MS`) and at
   * the mercy of `metadataCache` having already re-parsed the file — neither
   * guaranteed by the time this write's own promise resolves.
   * `JournalService.applyKnownEntry` sidesteps both: this caller already
   * knows the exact resulting entry (it just wrote it), so the index is
   * corrected immediately regardless of that timing. The later real event
   * for the same write is harmless once it does arrive — `applyUpsert`
   * finds the entry already matches and reports "content", not a second
   * "moved" (see `applyKnownEntry`'s own doc).
   *
   * The resulting change is run through the exact same `applyChangesNow`
   * reposition/insert logic every other change goes through — preserving,
   * in particular, `repositionIsNoOp`'s "leave a same-position editor
   * mounted" optimization, so the common case (a correction of a few
   * minutes, still the same day) never pays for a teardown at all. Only if
   * that still leaves the entry unrendered — outside the loaded window, or
   * excluded by an active anchor (`insertEntryInPlace`'s bounds checks) —
   * does this try a plain, unanchored `reload()` (unless already anchored),
   * and only after THAT still fails to reach it does it fall back to
   * `goToDate(value)`, which is guaranteed to make it visible but does so by
   * hiding every entry newer than `value` — see this method's closing
   * comment for why an anchored jump is a last resort, not the first
   * attempt. A jump is only announced when it actually happens; an in-place
   * move or a plain reload that already reached the entry needs no
   * explanation.
   *
   * `EntryRepository.setEntryCreated` can throw `UnsafeFrontmatterError`
   * when the entry's frontmatter isn't safe to edit surgically (see its
   * doc) — reported with a distinct, actionable Notice rather than the
   * generic write-failure one, since the fix here is for the user to edit
   * `created` in the source note themselves, not to retry.
   *
   * The move — `EntryRepository.renameEntryToMatch`, which keeps this
   * entry's filename honest with its (just-written) `created` value — only
   * happens AFTER the reposition above, never before. `applyKnownEntry`/
   * `applyChangesNow` look up this entry's existing rendering by its
   * CURRENT path; renaming first would change `file.path` out from under
   * that lookup (`this.rendered` is still keyed at the OLD path — nothing
   * has re-keyed it yet) and read as nothing rendered there, inserting a
   * second, duplicate row alongside the one already on screen. Renaming
   * after leaves that lookup untouched.
   *
   * If the rename actually moved the file, `this.rendered` is re-keyed
   * IMMEDIATELY via `reKeyRenderedEntry`, right here — not left for the
   * real vault "rename" event this call triggers, which `JournalService`
   * only gets to ~300ms later (its own debounce). Left to that path, the
   * eventual "removed"(old path)/upsert(new path) pair would — whenever the
   * row isn't dirty, the common case — tear the current rendering down and
   * reinsert a fresh one from disk (`applyChangesNow`'s "removed"
   * handling), destroying the very editor `repositionIsNoOp`'s fast path
   * above just went out of its way to keep mounted: caret, focus, and (for
   * the embedded editor) CM6 undo history would all be lost on every time
   * change, including the smallest same-day correction. Re-keying here
   * instead makes the eventual real event redundant before it ever fires —
   * `applyChangesNow` finds the row already at the new path and, per
   * `decideChangeAction`, either no-ops (focused/dirty) or does a harmless
   * content refresh, never a teardown.
   *
   * Deliberately NOT done via `JournalService.markSelfWrite`: that
   * suppresses a "modify"/"changed" event for a write whose value the
   * editor already reflects (see `setEntryCreated`'s doc on why it does
   * NOT use this for the same reason in reverse) — it has nothing to do
   * with "rename" events, which `JournalService`'s rename handler doesn't
   * consult it for at all. Extending that handler to special-case a
   * self-caused rename would mean touching the exact machinery an EXTERNAL
   * rename also relies on, for no benefit: this view already knows both
   * paths and can fix its own bookkeeping directly, leaving
   * `JournalService` — and every external-rename path through it —
   * completely untouched.
   *
   * `reKeyRenderedEntry` can decline (destination already occupied by an
   * unrelated entry racing in during the rename's own await) — `visiblePath`
   * is then left pointing at wherever the row actually still lives, which
   * `reKeyRenderedEntry`'s own doc covers. The exact interleaving of
   * Obsidian's real "rename" event relative to this synchronous re-key
   * cannot be fully confirmed without a live Obsidian instance; what's
   * verified here is that `JournalService`'s own debounce (a real 300ms
   * timer) guarantees the event's processing happens well after this
   * function has already returned, so the ordering this relies on holds
   * regardless of exactly when Obsidian dispatches "rename" relative to
   * `renameFile`'s promise resolving.
   *
   * `visiblePath` tracks whichever path this entry's rendering ACTUALLY
   * lives under, not `file.path`: after a successful re-key it's updated to
   * the new path; if the rename was a no-op, failed, or the re-key declined,
   * it stays as originally captured. The fallback visibility check below
   * reads this, not `file.path` directly — `file.path` mutates in place the
   * instant the rename succeeds, which would otherwise make an already-
   * visible (just re-keyed) row look "not yet rendered" and wrongly trigger
   * a `goToDate` jump.
   *
   * A failed move is reported with its own Notice and left alone: the
   * `created` write already succeeded and the entry is already correctly
   * positioned, so this is a purely cosmetic (if self-contradicting)
   * mismatch between the file's name and its content, not a data-loss risk
   * worth rolling anything back over.
   */
  private async commitEntryTimeChange(rendered: RenderedEntry, file: TFile, value: Date): Promise<void> {
    await this.flushSave(rendered);
    if (this.closed) return;

    try {
      await this.plugin.repository.setEntryCreated(file, value);
    } catch (error) {
      console.error("Simple Journal: could not change the entry's time", file.path, error);
      new Notice(
        error instanceof UnsafeFrontmatterError
          ? "This entry's frontmatter is too complex to edit safely here. Change \"created\" in the source note instead."
          : "Could not change the entry's time. See the developer console for details.",
      );
      return;
    }

    if (this.closed) return;

    const change = this.plugin.journal.applyKnownEntry({
      file,
      created: value,
      tags: rendered.entry.tags,
    });
    await this.enqueueTimelineMutation(() => this.applyChangesNow([change]));

    if (this.closed) return;
    let visiblePath = file.path;

    try {
      await this.plugin.repository.renameEntryToMatch(file, value);
    } catch (error) {
      console.error("Simple Journal: could not rename the entry to match its new time", file.path, error);
      new Notice(
        "The entry's time was changed, but its file could not be renamed to match. See the developer console for details.",
      );
    }

    if (this.closed) return;

    if (file.path !== visiblePath && this.reKeyRenderedEntry(visiblePath, file.path)) {
      visiblePath = file.path;
    }

    // Both keys, deliberately. The row can already sit at either one, and
    // which depends on timing we do not control: if Obsidian dispatches its
    // "rename" early and `renameFile` then spends longer than the service's
    // debounce rewriting links — the very case that API exists for —
    // JournalService flushes during the await above and re-inserts the row at
    // the new path itself, so the re-key finds nothing to move. Checking only
    // one key jumps the view and announces a move for an entry already on
    // screen. Checking both makes this independent of the dispatch order.
    if (this.rendered.has(visiblePath) || this.rendered.has(file.path)) return;

    // Still unrendered so far only means `insertEntryInPlace`'s loaded-window
    // bounds check declined — typically because this correction pushed the
    // entry to (or past) the edge of what happens to be rendered right now,
    // while a paging sentinel is still mounted (it stays mounted until the
    // user has actually scrolled to genuine exhaustion, not merely until the
    // first page happens to already hold everything — see `reloadNow`'s
    // unconditional `installSentinel()` call). That decline says nothing
    // about whether the entry would fit on an ordinary, UNANCHORED reload —
    // jumping straight to `goToDate` treats every decline as "this is deep
    // history," when most are really "the first page just hadn't been
    // re-measured yet."
    //
    // `goToDate` anchors the timeline to `value` (see its own doc), which
    // HIDES every entry newer than it — for a correction that only moved
    // this entry a month or two, that discards the user's entire recent
    // timeline just to surface the one row that moved, and reads exactly
    // like "the entry jumped above everything" rather than "the entry
    // settled into its correct, later position." A plain `reload()` — same
    // newest-first first page, no anchor — often already reaches the
    // correction without hiding anything at all, so it is tried first.
    // Skipped when an anchor is already active: that is a deliberate user
    // choice (a prior "Go to date") this correction should not silently
    // clear.
    if (this.anchorDate === null) {
      await this.reload();
      if (this.closed) return;
      if (this.rendered.has(file.path)) return;
    }

    await this.goToDate(value);
    new Notice(`Moved entry to ${formatDayHeader(value)}, ${formatTime(value)}`);
  }

  /**
   * Confirms, then deletes an entry's underlying file via
   * `FileManager.promptForDeletion` — Obsidian's own delete dialog, which
   * both respects the user's "Confirm file deletion" setting and performs
   * the trash itself (according to their configured trash behaviour) the
   * moment it resolves `true`. Preferred over a hand-rolled `window.confirm`
   * + `trashFile`: the native dialog is unthemed and, being a blocking
   * native call, freezes every timer in the renderer while it's open —
   * including the very debounce this method needs to flush.
   *
   * Any pending edit is flushed BEFORE prompting, not after: by the time
   * `promptForDeletion` resolves `true` the file is already trashed, so
   * flushing afterward would write into a file that has just moved (or, on
   * the OS-trash setting, no longer exists at all) instead of the file the
   * trash actually receives.
   *
   * Only the parts of teardown that can't safely wait are done here: the
   * (already-flushed) debounce timer is cancelled, an `is-deleting` class
   * dims the row and blocks further interaction with it, and the editor is
   * destroyed so it stops holding/polling a file that's about to disappear
   * out from under it. The rest — unobserving the element, removing it from
   * `mountOrder`, dropping the `dayGroups` key if this was the day's last
   * entry, and tearing the DOM node itself down — is deliberately left to
   * `applyChangesNow`'s normal "removed" handling, which runs once the
   * vault's own `delete` event reaches `JournalService` and arrives back
   * here as a `JournalChange`, calling `removeRenderedEntry`. Doing that
   * teardown a second time here, ahead of the event, would race the version
   * the event handling itself already does correctly.
   *
   * That event is not guaranteed to arrive promptly (or, in principle, at
   * all) — meanwhile `el` is still `observe()`d by `mountObserver`, so an
   * intersection flip could otherwise call `mountEditor` on a path whose
   * file no longer exists. The `setTimeout` below bounds how long a deleted
   * entry can sit as a dimmed, inert row; see `handleDeleteFallback` for what
   * it actually does once that bound is hit.
   */
  private async confirmDelete(rendered: RenderedEntry): Promise<void> {
    const file = rendered.entry.file;
    if (!file) return;

    await this.flushSave(rendered);

    let confirmed: boolean;
    try {
      confirmed = await this.app.fileManager.promptForDeletion(file);
    } catch (error) {
      console.error("Simple Journal: could not delete entry", error);
      new Notice("Could not delete the entry.");
      return;
    }
    if (!confirmed) return;

    if (rendered.saveHandle !== null) {
      window.clearTimeout(rendered.saveHandle);
      rendered.saveHandle = null;
    }
    // Deletion is confirmed and the row is about to sit dimmed and inert
    // (below) until the vault event or the fallback tears it down for real
    // — a still-armed long-press timer popping the actions menu open on it
    // in the meantime, or a keyboard-scroll correction firing for it, would
    // both be acting on a row that's already gone.
    this.clearMobileTimers(rendered);
    rendered.el.addClass("is-deleting");
    // The flush above may have failed (the write was already failing before
    // the user opened this menu at all) — a user confirming "Delete entry"
    // is deliberately discarding the FILE, but very likely still believes
    // their last edit was saved. Without this, that's the one path where a
    // failed save leaves no trace anywhere once the row is gone.
    this.logUnsavedTextIfLost(rendered);
    rendered.editor?.destroy();
    rendered.editor = null;

    window.setTimeout(() => {
      void this.enqueueTimelineMutation(() => this.handleDeleteFallback(file, rendered));
    }, DELETE_FALLBACK_MS);
  }

  /**
   * Runs `DELETE_FALLBACK_MS` after a confirmed deletion, enqueued onto the
   * same serialized chain as every other timeline mutation (`reload()`,
   * `applyChanges()`) rather than acting immediately — this is a timeline
   * mutation like any other, and bypassing the chain would contradict the
   * invariant documented at `applyChanges`, even though no concrete
   * interleaving with a genuine wrong outcome was found.
   *
   * `this.rendered.get(file.path) !== rendered` covers two cases alike: the
   * vault's own "delete" event already reached `removeRenderedEntry` for
   * this path (the common, successful case), or a *different* entry has
   * since been created at the same path — checked by identity so neither is
   * mistaken for "still pending."
   *
   * Before removing anything, the file's continued existence is checked
   * directly (again by identity, same reasoning as `renderedStateFor`'s
   * `fileStillExists`). `promptForDeletion` resolving `true` only means the
   * user confirmed — its own doc covers the prompt and the boolean, not
   * that the trash necessarily succeeded afterward (system trash disabled,
   * permissions, or, undocumented, a version where it turns out to only
   * prompt). If the file survived, removing the row anyway would make the
   * timeline silently misrepresent the vault until the next reload — instead
   * this restores the entry (drops `is-deleting`, remounts its editor) and
   * tells the user deletion failed.
   */
  private async handleDeleteFallback(file: TFile, rendered: RenderedEntry): Promise<void> {
    if (this.closed) return;
    if (this.rendered.get(file.path) !== rendered) return;

    if (this.app.vault.getAbstractFileByPath(file.path) === file) {
      rendered.el.removeClass("is-deleting");
      new Notice("Could not delete the entry.");
      void this.mountEditor(rendered);
      return;
    }

    if (this.removeRenderedEntry(file.path)) this.removeEmptyDayGroups();
  }

  /**
   * Read-only rendering of an entry, used when no editor is mounted for it.
   *
   * Bumps and re-checks `rendered.opToken` around its one await, same
   * reasoning as `mountEditor`: `appendEntry` calls this and hands the entry
   * to `mountObserver` in the same breath, and the observer's immediate
   * callback can fire — and call `mountEditor` — before this has finished
   * reading the file. Without the token check, this could then render stale
   * static Markdown into `bodyEl` after `mountEditor` already mounted a live
   * editor into it.
   */
  private async renderStatic(rendered: RenderedEntry): Promise<void> {
    const generation = this.generation;
    // Bail before creating any Component if a reload() already ran (e.g. a
    // future caller that awaits renderStatic before this resumes). Checked
    // here, first, so a bail can never leave a loaded Component attached to
    // a RenderedEntry that this.rendered no longer references — nothing
    // downstream would unload it.
    if (generation !== this.generation) return;
    const token = ++rendered.opToken;

    rendered.renderComponent?.unload();
    rendered.bodyEl.empty();

    const component = new Component();
    component.load();
    rendered.renderComponent = component;

    const body = await this.plugin.repository.readBody(rendered.entry.file);
    // Re-check both: the reload may have landed while readBody was in
    // flight (generation), or mountEditor may have taken over this entry in
    // the meantime (opToken) — either way, bail rather than render into a
    // bodyEl this operation no longer owns.
    //
    // Note this bails WITHOUT unloading the `component` just created above —
    // safe only because whatever superseded it already unloaded
    // `rendered.renderComponent` first: `clearTimeline`'s own destroy loop
    // (the generation-mismatch case) does this synchronously before it ever
    // awaits anything, and `mountEditor` (the opToken-mismatch case) unloads
    // it synchronously before its own await, i.e. before this line could ever
    // run. A future caller that awaits something before superseding this one
    // would leak that Component instead of this bail catching it.
    if (generation !== this.generation) return;
    if (token !== rendered.opToken) return;

    // `body` is already separator-free (EntryRepository.readBody's job).
    // This only trims EXTRA leading blank lines a user's own content might
    // have, and trailing whitespace — not indentation on the first real
    // content line — unlike a plain trim(), which would also eat a leading
    // indented code block.
    const strippedBody = body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");

    await MarkdownRenderer.render(
      this.app,
      strippedBody,
      rendered.bodyEl,
      rendered.entry.file.path,
      component,
    );
  }

  /**
   * Turns an entry into a live editor and enforces the mount cap. Called by
   * `mountObserver` whenever an entry enters `MOUNT_ROOT_MARGIN` — this is
   * the primary mount trigger, not `appendEntry` (see its doc). The actual
   * logic — including the `generation`/`opToken` guards around its one await
   * — lives in `mountLifecycle.ts`, exercised directly there with fabricated
   * state; this wrapper exists only so every call site (`installMountObserver`,
   * `createEntryEl`'s `remountOnInteraction`, `handleDeleteFallback`, and
   * `tests/JournalView.raceGuards.test.ts`'s reflection) keeps reaching it
   * through `this.`.
   */
  private async mountEditor(rendered: RenderedEntry): Promise<void> {
    await this.mountLifecycle.mountEditor(rendered);
  }

  /**
   * Mounts the configured editor, falling back to plain text if it reports
   * itself unusable. See `mountUsableEditor` in `mountLifecycle.ts`; this
   * wrapper exists only so calls go through `this.` (see `mountEditor`'s
   * doc) — including `commitComposer`'s own call, which mounts the real
   * editor once a composer's file is created.
   */
  private mountUsableEditor(rendered: RenderedEntry, body: string): EntryEditor {
    return this.mountLifecycle.mountUsableEditor(rendered, body);
  }

  /**
   * Whether `rendered`'s live editor currently holds text that hasn't
   * reached disk — its value differs from `savedBody`, the body last
   * confirmed written. Shared by `renderedStateFor` (decideChangeAction's
   * "is there something worth flushing" check), `mountStateOf`
   * (`pickEvictionCandidate`'s "never evict this" check), and
   * `unmountEditor` (its own "never discard this" check) so all three use
   * the same definition of "dirty" rather than three that could drift apart.
   */
  private isDirty(rendered: RenderedEntry): boolean {
    return rendered.editor ? rendered.editor.getValue() !== rendered.savedBody : false;
  }

  /**
   * Logs `rendered`'s current text via `console.error` if it is still dirty
   * (see `isDirty`) — a no-op otherwise, since most torn-down entries have
   * nothing pending to lose. Called immediately before a caller destroys
   * this entry's editor on a path that, unlike `unmountEditor`'s decline,
   * has no option to keep it mounted instead: the timeline itself is coming
   * down (`clearTimeline`), the underlying file is genuinely gone
   * (`removeRenderedEntry`), or the user just confirmed deleting it
   * themselves (`confirmDelete`) — very possibly believing their last edit
   * had already saved. Logging the actual unsaved body — not just the path —
   * is the last recovery path available to the user in any of these cases.
   *
   * Also used, unmodified, for the uncommitted composer (see `clearTimeline`):
   * its `savedBody` never leaves `""`, so this reduces to "holds any text at
   * all" there — close enough to `isMeaningful` for a last-resort log, and
   * `rendered.entry.file` being null already falls through to the label
   * below rather than needing a separate composer-specific message.
   */
  private logUnsavedTextIfLost(rendered: RenderedEntry): void {
    if (!this.isDirty(rendered)) return;

    console.error(
      "Simple Journal: discarding unsaved text for",
      rendered.entry.file?.path ?? "(uncommitted composer)",
      "— recover it from this line before it is lost:",
      rendered.editor?.getValue(),
    );
  }

  /**
   * Cancels this entry's pending mobile-only timers — the keyboard-visibility
   * scroll and the long-press menu (see `createEntryEl`) — if either is
   * armed. A no-op on desktop, where both fields stay `null` forever.
   *
   * Called from every path that tears an entry's DOM/editor down, or is
   * about to: `clearTimeline` (both the composer special-case and the normal
   * loop), `removeRenderedEntry`, `confirmDelete`, and
   * `discardEmptyComposer`. Without this, either timer can fire minutes
   * later against a row that's already gone — `scrollIntoView` on a detached
   * element, or `showEntryMenu` reopening the actions menu (and reaching for
   * `rendered.entry.file`, possibly already trashed) for an entry the user
   * just deleted or that a reload already discarded.
   */
  private clearMobileTimers(rendered: RenderedEntry): void {
    if (rendered.keyboardScrollHandle !== null) {
      window.clearTimeout(rendered.keyboardScrollHandle);
      rendered.keyboardScrollHandle = null;
    }
    if (rendered.longPressHandle !== null) {
      window.clearTimeout(rendered.longPressHandle);
      rendered.longPressHandle = null;
    }
  }

  /**
   * Backstop for when more entries are simultaneously within
   * `MOUNT_ROOT_MARGIN` than `MAX_MOUNTED_EDITORS` allows. See
   * `enforceMountLimit` in `mountLifecycle.ts`; this wrapper exists only so
   * `commitComposer` — the one caller left outside this module, once its own
   * newly-mounted editor joins the pool — can reach it through `this.`.
   */
  private enforceMountLimit(): void {
    this.mountLifecycle.enforceMountLimit();
  }

  /**
   * Flushes pending edits, destroys the editor, and restores static
   * rendering. See `unmountEditor` in `mountLifecycle.ts` for what this
   * actually does and why (the focused/intersecting/dirty declines,
   * `evict`'s meaning, the `generation` guard around its flush); this
   * wrapper exists only so calls go through `this.` — `installMountObserver`'s
   * exit-transition callback and `tests/JournalView.raceGuards.test.ts`'s
   * reflection (see `mountEditor`'s doc). Every call `mountLifecycle.ts`
   * makes to its own internal `unmountEditor` (from `wireEditor`'s `onBlur`,
   * or `enforceMountLimit`'s eviction) bypasses this wrapper entirely —
   * those are calls within the module, not back into the view.
   */
  private async unmountEditor(rendered: RenderedEntry, opts: { evict?: boolean } = {}): Promise<void> {
    await this.mountLifecycle.unmountEditor(rendered, opts);
  }

  /**
   * Debounces writes so typing does not hit the disk on every keystroke.
   * The actual save pipeline lives in `entrySave.ts`, exercised directly
   * there with fabricated state; this just supplies the live `SaveDeps`.
   * Kept as an instance method — rather than called directly as a free
   * function from every call site below — solely so
   * `tests/JournalView.raceGuards.test.ts` can monkey-patch `view.flushSave`
   * and have every internal caller (`confirmDelete`, `clearTimeline`, …)
   * observe the patched version through `this.`. `mountLifecycle.ts` does
   * NOT go through this wrapper — it takes `SaveDeps` directly — so patching
   * this method no longer affects `unmountEditor`'s own flush; a test that
   * needs to intercept that gates the real dependency underneath `saveDeps`
   * instead (see `tests/JournalView.raceGuards.test.ts`).
   */
  private scheduleSave(rendered: RenderedEntry, value: string): void {
    scheduleSaveEntry(rendered, value, this.saveDeps);
  }

  /**
   * Writes any pending edit immediately. See `flushSave` in `entrySave.ts`
   * for what this actually does and why; this wrapper exists only so calls
   * go through `this.` (see `scheduleSave`'s doc).
   */
  private async flushSave(rendered: RenderedEntry): Promise<void> {
    await flushSaveEntry(rendered, this.saveDeps);
  }

  /**
   * Writes `value` to disk unless it already matches `rendered.savedBody`.
   * See `save` in `entrySave.ts` for what this actually does and why; this
   * wrapper exists only so calls go through `this.` (see `scheduleSave`'s
   * doc).
   */
  private async save(rendered: RenderedEntry, value: string): Promise<void> {
    await saveEntry(rendered, value, this.saveDeps);
  }

  /**
   * Entry point registered with `JournalService.onChange`. Enqueues the
   * whole batch onto the same serialized chain as `reload()`/`onClose()`
   * (see `enqueueTimelineMutation`) rather than acting immediately: this
   * callback can fire from an arbitrary vault-event-driven async callback,
   * and without serialization a concurrent `reload()` (e.g. the settings
   * tab's debounced `refreshJournal`) could clear and rebuild the timeline
   * while `applyChangesNow` is mid-`await`, after which its remaining work
   * would mutate the NEW generation's DOM/maps — silently dropping an
   * entry, or resurrecting a day group the reload already removed — until
   * the next reload happened to paper over it.
   */
  private applyChanges(changes: JournalChange[]): void {
    void this.enqueueTimelineMutation(() => this.applyChangesNow(changes));
  }

  /**
   * The actual body of `applyChanges`. See `applyChangesNow` in
   * `changeApplication.ts` for what this actually does and why; this
   * wrapper exists only so calls go through `this.` — `commitEntryTimeChange`'s
   * own direct call, and `tests/JournalView.*.test.ts`'s
   * `internals(view).applyChangesNow(...)` reflection (see `mountEditor`'s
   * doc in `mountLifecycle.ts` for the general reasoning).
   */
  private async applyChangesNow(changes: JournalChange[]): Promise<void> {
    await this.changeApplication.applyChangesNow(changes);
  }

  /**
   * See `reKeyRenderedEntry` in `changeApplication.ts` for what this
   * actually does and why; this wrapper exists only so calls go through
   * `this.` — `commitEntryTimeChange`'s own direct call, and
   * `tests/JournalView.rekeyRace.test.ts`'s reflection (see `mountEditor`'s
   * doc).
   */
  private reKeyRenderedEntry(oldPath: string, newPath: string): boolean {
    return this.changeApplication.reKeyRenderedEntry(oldPath, newPath);
  }

  /**
   * See `renderedStateFor` in `changeApplication.ts` for what this actually
   * does and why; this wrapper exists only so calls go through `this.` —
   * `tests/JournalView.*.test.ts`'s `internals(view).renderedStateFor(...)`
   * reflection (see `mountEditor`'s doc).
   */
  private renderedStateFor(rendered: RenderedEntry | undefined): RenderedState {
    return this.changeApplication.renderedStateFor(rendered);
  }

  /**
   * See `removeRenderedEntry` in `changeApplication.ts` for what this
   * actually does and why; this wrapper exists only so calls go through
   * `this.` — `handleDeleteFallback`'s own direct call (see `mountEditor`'s
   * doc).
   */
  private removeRenderedEntry(path: string): boolean {
    return this.changeApplication.removeRenderedEntry(path);
  }

  /**
   * See `removeEmptyDayGroups` in `timelineDom.ts` for what this actually
   * does and why; this wrapper exists only so calls go through `this.` (see
   * `renderEmptyState`'s doc above).
   */
  private removeEmptyDayGroups(): void {
    this.timelineDom.removeEmptyDayGroups();
  }

  /**
   * See `insertEntryInPlace` in `timelineDom.ts` for what this actually does
   * and why — including the `this.index.indexOf(entry)` reference-identity
   * lookup, which depends on `applyUpsert` (`journalService.ts`) always
   * handing back the exact object already living in `this.index`; this
   * wrapper exists only so calls go through `this.` (see `renderEmptyState`'s
   * doc above).
   */
  private insertEntryInPlace(entry: JournalEntry): void {
    this.timelineDom.insertEntryInPlace(entry);
  }

  /**
   * An editor mounted or updated while its tab is hidden cannot measure its
   * own height — a hidden element reports `scrollHeight` 0 — so it flags
   * itself and waits for this. Obsidian calls `onResize()` (`@since 0.9.7`)
   * when a leaf becomes visible, and also on width changes, which re-wrap
   * text; every mounted editor is re-measured either way.
   */
  onResize(): void {
    for (const rendered of this.rendered.values()) {
      rendered.editor?.remeasure();
    }
  }

  /**
   * Opens an empty composer at the top of today's entries and focuses it —
   * or, if one is already open, just refocuses it. No file is created until
   * the user types something meaningful (see `onComposerInput`).
   *
   * The synchronous check above `enqueueTimelineMutation` is only a
   * fast path for the common case (an existing composer, typing already in
   * progress): `openComposer` re-checks the same condition itself once its
   * turn in the chain actually arrives, which is what actually matters for
   * correctness — two "New journal entry" invocations landing before either
   * has run still only ever open one composer, because the second
   * `openComposer` runs strictly after the first (same serialized chain as
   * every other timeline mutation) and finds `this.composer` already set.
   *
   * REQUIRED, per CLAUDE.md's "Creating a New Entry": if the timeline is
   * anchored to a past date (`goToDate`), this must move the user back to
   * today before opening the composer — otherwise the anchor stays set, and
   * the very next `reload()` for any unrelated reason (a settings change, a
   * lost-cursor re-anchor in `nextPage`, anything) would exclude the entry
   * just written, since it is newer than the stale anchor. The file itself
   * would still be safe on disk, but it would silently vanish from the
   * timeline with no explanation — worse than the anchor merely being
   * inconvenient.
   *
   * Only reached when no composer is open yet — the fast-path return above
   * guards this, and `goToDate`/`reload()` never runs (an already-open
   * composer is never torn down) just because this command fires again
   * while one is up.
   */
  async startNewEntry(): Promise<void> {
    // The first load has to finish before a composer is worth opening. When
    // this is reached straight out of `openJournal` — the hotkey pressed from
    // some other note — `onOpen`'s reload may not be on the mutation chain
    // yet, and a composer enqueued ahead of it used to be destroyed by that
    // reload's `clearTimeline`. `reloadNow` now re-establishes a composer
    // that was open when it started (see `reestablishComposer`), so even if
    // that race is lost this composer survives the reload instead of
    // silently vanishing.
    await this.initialLoad;

    if (this.closed) return;

    if (this.composer) {
      this.composer.editor?.focus();
      this.scrollToTop();
      return;
    }

    if (this.anchorDate !== null) {
      await this.goToDate(null);
    }

    await this.enqueueTimelineMutation(() => this.openComposer());
  }

  /**
   * `initialValue`/`focus`/`preserveExternalFocus`/`created`/`explicitRequest`
   * are used only by `reestablishComposer`, to put a composer a reload just
   * tore down (or a keystroke had already claimed but not yet committed)
   * back with the text, focus state, creation time, and explicit-request
   * status it had. `startNewEntry` always calls this with the defaults — an
   * empty, focused composer created now, for a genuinely new entry the user
   * just explicitly asked for, which always takes focus regardless of
   * `preserveExternalFocus`.
   */
  private async openComposer(
    options: {
      initialValue?: string;
      focus?: boolean;
      preserveExternalFocus?: boolean;
      created?: Date;
      /**
       * Whether this composer is opened for (or on behalf of) an explicit
       * "New journal entry" request that has not yet been typed into — see
       * `ComposerSnapshot.explicitPending`. Defaults to `true`: an ordinary
       * `startNewEntry` call, with no options, is exactly that request.
       * `reestablishComposer` passes the snapshot's own value instead, so
       * the intent survives however many rebuilds happen before the first
       * keystroke.
       */
      explicitRequest?: boolean;
    } = {},
  ): Promise<void> {
    if (this.closed) return;

    if (this.composer) {
      // A concurrent invocation (see startNewEntry's doc) already opened one.
      this.composer.editor?.focus();
      this.scrollToTop();
      return;
    }

    const {
      initialValue = "",
      focus = true,
      preserveExternalFocus = false,
      created = new Date(),
      explicitRequest = true,
    } = options;

    // Same reasoning as insertEntryInPlace: the empty-state message is only
    // ever present when nothing is rendered yet, and this is the only other
    // path (besides that one) that can insert into a timeline rendered empty.
    this.timelineEl.querySelector(".journal-empty")?.remove();

    // Reuses ensureDayGroup rather than a separate "ensure today" helper:
    // today's group is just the day group for `created`, prepended like any
    // other freshly-appearing newest day, and ensureDayGroup already
    // populates/reads the `dayGroups` map correctly (a hand-rolled duplicate
    // of that logic would be one more place for the two to drift apart).
    const group = this.ensureDayGroup(created, "prepend");

    const placeholder: JournalEntry = {
      // No file yet. Nothing reads `file` before commitComposer runs —
      // createEntryEl leaves `data-path` unset for exactly this case.
      file: null as unknown as JournalEntry["file"],
      created,
      // No file, so nothing has been indexed: an uncommitted composer has no
      // tags even if its draft text already contains a `#tag`.
      tags: [],
    };

    const rendered = this.createEntryEl(placeholder);
    rendered.el.addClass("journal-entry-composer");
    group.prepend(rendered.el);

    // Always a plain textarea, never `this.plugin.editorFactory.create()`:
    // the embedded editor needs a real TFile to hand the embed registry, and
    // this entry doesn't have one yet. See commitComposer for the swap once
    // it does.
    const editor = new TextareaEditor();
    editor.onChange((value) => {
      // Set unconditionally, on every change, including one that clears the
      // composer straight back to empty — `discardEmptyComposer`'s gate only
      // needs to know a keystroke happened at some point, not what it left
      // behind (its own `isMeaningful` check already covers the latter).
      // NOT fired for `initialValue` at mount, nor for a `setValue` — only a
      // real edit reaches this callback (see `EntryEditor.mount`'s doc),
      // which is exactly "the user typed" rather than "this editor changed
      // for any reason."
      this.composerHasInput = true;
      void this.onComposerInput(rendered, value);
    });
    editor.onBlur(() => this.discardEmptyComposer(rendered));

    // Arms the blur-discard's gate. A blur that arrives before any input is
    // not the user abandoning the composer — it is focus churn, which
    // happens when this runs as part of opening the view: Obsidian activates
    // the new leaf and takes focus back after we asked for it, delivering a
    // focus AND a blur to a composer nobody has touched yet. Without this
    // gate, the composer is created and destroyed in the same breath and the
    // command looks like it merely opened the journal.
    this.composerEverFocused = false;
    this.composerHasInput = false;
    this.composerExplicitRequest = explicitRequest;
    rendered.bodyEl.addEventListener("focusin", () => {
      this.composerEverFocused = true;
    });

    editor.mount(rendered.bodyEl, null, initialValue);

    rendered.editor = editor;
    this.composer = rendered;

    // `focus` is false only when `reestablishComposer` is putting an
    // unfocused composer back after a reload — restoring exactly the state
    // the rebuild disturbed, not upgrading a background composer into one
    // that steals focus from whatever the user is actually doing elsewhere.
    if (!focus) return;

    // `preserveExternalFocus` (only set by `reestablishComposer`, and only
    // when the composer it is restoring *did* have focus before the
    // rebuild) additionally checks that focus is still exactly where the
    // rebuild's own teardown would have left it — nothing else has claimed
    // it since. The rebuild's several awaits (flushing saves, loading a
    // page) are real time the user can spend clicking into an entirely
    // different pane; blindly refocusing afterwards would yank them back
    // out of it. `startNewEntry`'s own explicit "New journal entry"
    // invocation never sets this, and always takes focus.
    if (preserveExternalFocus) {
      const activeEl = this.contentEl.doc.activeElement;
      const somethingElseFocused = activeEl !== null && activeEl !== this.contentEl.doc.body;
      // An explicit "New journal entry" request that has not been typed
      // into yet keeps its claim on the caret even across a rebuild that
      // lands before the user's first keystroke — `preserveExternalFocus`
      // exists to protect a composer the user has genuinely moved away
      // from (see `ComposerSnapshot.explicitPending`'s doc), which is a
      // different situation from one nobody has touched at all.
      if (somethingElseFocused && !explicitRequest) return;
    }

    this.scrollToTop();
    editor.focus();

    // Opening the journal to capture an entry activates a freshly created leaf,
    // and Obsidian takes focus for itself somewhere after `revealLeaf` has
    // already resolved — so the `focus()` above lands and is then taken away,
    // leaving the composer visible with the caret somewhere else entirely.
    //
    // The condition has to be "is it focused right now", not "was it ever
    // focused": the earlier version asked the latter, so a focus that landed
    // and was immediately stolen looked like success and no retry ran. That is
    // the same wrong question that made the blur-discard fire — see
    // `discardEmptyComposer`.
    //
    // Bounded by a deadline rather than a frame count, because the competitor
    // is not only leaf activation. A diagnostic run put the caret in a
    // `.cm-content` — a CodeMirror instance — while the composer sat visible
    // and unfocused, and the most likely owner is one of the timeline's own
    // embedded editors: `ObsidianEmbedEditor.mount` calls the embed's
    // `showEditor()`, and Obsidian focuses the editor it builds. Those mount
    // one per loaded entry, fire-and-forget, so how many frames they span is
    // not ours to predict and a fixed attempt count can simply run out.
    //
    // Each attempt re-checks, so the retries stop the moment focus is
    // genuinely ours; input stops them too, so this can never fight a user who
    // clicked away and started typing somewhere else. The deadline is what
    // stops it fighting anything else indefinitely.
    //
    // contentEl.win, not the global window: in a popout leaf the view lives in
    // its own window, and that is the one whose frames matter here.
    const deadline = Date.now() + COMPOSER_FOCUS_CLAIM_MS;
    // Mutable, not the original `rendered`/`editor` consts: a reload landing
    // mid-claim (`clearTimeline` then `reestablishComposer`, both reachable
    // while this loop is still inside its deadline) tears this exact
    // `rendered` down and builds a new one. Without following that
    // replacement, the check below would see `this.composer !== rendered`
    // forever and this loop would just stop — silently losing the claim
    // rather than either winning it or genuinely being superseded. A fresh
    // composer built while `explicitRequest` is still pending already starts
    // its own claim loop from `editor.focus()` above in that same call, so
    // this hand-off is only ever load-bearing for the cases that loop didn't
    // start one for itself (e.g. it was suppressed by `preserveExternalFocus`
    // for a genuinely-abandoned composer, in which case following it below
    // finds `this.composerHasInput` true, or the composer, and bails
    // immediately anyway).
    let claimedRendered = rendered;
    let claimedEditor: EntryEditor = editor;
    const claimFocus = () => {
      if (this.closed) return;
      const current = this.composer;
      if (current === null) return;
      if (current !== claimedRendered) {
        if (!current.editor) return;
        claimedRendered = current;
        claimedEditor = current.editor;
      }

      // Input is the only success condition. Holding focus right now is not:
      // tracing showed the composer *does* receive focus on the first frame —
      // `editorHasFocus: true`, `activeTag: 'TEXTAREA'` — and something takes
      // it away afterwards, by which point an earlier version of this loop had
      // already stopped watching precisely because focus was ours. So keep
      // watching until the deadline and re-take it whenever it is lost.
      if (this.composerHasInput) return;

      if (!claimedEditor.hasFocus()) {
        claimedEditor.focus();
      }

      if (Date.now() < deadline) this.contentEl.win.requestAnimationFrame(claimFocus);
    };

    this.contentEl.win.requestAnimationFrame(claimFocus);
  }

  /**
   * Fires on every keystroke in the composer's placeholder textarea. Creates
   * the entry file the first time it holds meaningful content, then hands
   * the composer over to the real editor.
   *
   * `this.composer` is claimed (set to null) synchronously, before any
   * `await` — including `enqueueTimelineMutation`'s own — so a second fast
   * keystroke's own call to this method (a separate invocation; this one is
   * merely suspended, not blocking the event loop) sees the branch below
   * instead of re-entering here and starting a second create.
   */
  private async onComposerInput(rendered: RenderedEntry, value: string): Promise<void> {
    if (this.composer !== rendered) {
      // Either commitComposer is still in flight for this entry, or it
      // already finished. Once it finishes, wireEditor rewires this
      // entry's onChange to scheduleSave directly — this method is never
      // called again for it, and destroy() also means the OLD textarea's
      // listener (the only thing that could still call this) is gone. So
      // this branch is only actually reachable during the in-flight window,
      // where `rendered.entry.file` is still the placeholder: scheduling a
      // save against it would crash once the debounce fires. Nothing is
      // lost by skipping it — the composer's own (still-mounted) textarea
      // already holds this keystroke, and commitComposer reads it fresh,
      // straight from that textarea, the moment it actually runs.
      if (rendered.entry.file) this.scheduleSave(rendered, value);
      return;
    }

    if (!isMeaningful(value)) return;

    // Captured before the claim below, and passed all the way through to
    // `commitComposer`: it is the generation this composer is being claimed
    // under, not whatever `this.generation` happens to read once
    // `commitComposer`'s task actually gets its turn. See
    // `pendingComposerCommit`'s doc — a reload can land, and finish, in the
    // gap between this claim and that turn arriving, without `this.generation`
    // itself giving `commitComposer` any way to tell the difference.
    const claimedGeneration = this.generation;
    this.composer = null;
    this.pendingComposerCommit = rendered;
    await this.enqueueTimelineMutation(() => this.commitComposer(rendered, claimedGeneration));
  }

  /**
   * Creates the Markdown file for a composer that just received meaningful
   * content, then swaps its placeholder textarea for the real editor —
   * reusing `mountUsableEditor`, the same embed-or-fallback logic
   * `replaceWithFallback` uses for the opposite direction of swap, seeded
   * with whatever text is currently held rather than a snapshot from
   * further back, so nothing typed during the create is lost. Runs inside
   * `enqueueTimelineMutation`, like every other timeline mutation, and
   * respects `closed`/`generation` at each await the same way they do.
   *
   * Two different callers, two different meanings for `claimedGeneration`.
   * `onComposerInput` passes the generation live at the moment its keystroke
   * claimed `this.composer` — strictly *before* this task's own turn on the
   * mutation chain, so it can differ from `this.generation` right here at
   * entry if a reload's `clearTimeline` ran (and, via
   * `pendingComposerCommit`, already handled this same rendered entry —
   * possibly re-establishing and re-committing it under a fresh one) in that
   * gap. Bailing on a mismatch here, before ever touching the repository, is
   * what makes that re-establishment race-free instead of racing this call
   * into creating a duplicate entry. `reestablishComposer` instead passes
   * the generation it just claimed under in the same synchronous stretch —
   * trivially equal to `this.generation` right now — since that call is not
   * separated from this one by any chain turn to lose a race across.
   *
   * `focus` (default `true`, the ordinary keystroke-triggered case, where
   * the user is actively typing and should keep the caret) lets
   * `reestablishComposer` suppress the trailing `editor.focus("end")` below
   * the same way `openComposer`'s `preserveExternalFocus` suppresses its
   * own focus call — otherwise a re-established *meaningful* draft would
   * grab focus back regardless of whether anything else had since claimed
   * it, defeating that guard on exactly the path it exists to cover.
   */
  private async commitComposer(rendered: RenderedEntry, claimedGeneration: number, focus = true): Promise<void> {
    if (this.pendingComposerCommit === rendered) this.pendingComposerCommit = null;

    if (this.closed) {
      // The view closed in the gap between `onComposerInput` claiming this
      // (nulling `this.composer`, before this task's own turn on the
      // mutation chain) and this task actually starting. `pendingComposerCommit`
      // is exactly for a *reload* landing in that gap — `clearTimeline`'s own
      // handling of it (just cleared above) folds the text into a snapshot
      // `reestablishComposer` goes on to restore, commit, or log. Closing the
      // tab instead ends the gap with nothing left to catch it: `onClose`'s
      // own `clearTimeline` call, queued behind this one, finds neither
      // `this.composer` nor `this.pendingComposerCommit` to work with. This
      // is the one place left that still knows the text existed.
      this.logLostComposerDraft(rendered.editor?.getValue() ?? "");
      return;
    }

    // A reload — not a close — landed in that same gap instead: already
    // handled, silently, by whatever `clearTimeline` and `reestablishComposer`
    // did with the snapshot they captured for this exact rendered entry (see
    // the doc above). Logging here too would double-report it.
    if (claimedGeneration !== this.generation) return;

    const generation = this.generation;
    const created = rendered.entry.created;
    const valueAtCreate = rendered.editor?.getValue() ?? "";

    // Re-check meaningfulness: this task was only just enqueued onto the
    // timeline-mutation chain by the keystroke that triggered it, and may
    // have sat behind another in-flight mutation (a reload, an applyChanges
    // batch) for a little while before actually running. The user can have
    // deleted everything typed in the meantime — committing an empty file
    // here would violate "Lazy Creation" just as much as committing one for
    // a composer that was never touched at all.
    if (!isMeaningful(valueAtCreate)) {
      if (!this.closed && generation === this.generation && this.composer === null) {
        this.composer = rendered;
      }
      return;
    }

    let file: TFile;
    try {
      file = await this.plugin.repository.createEntry(created, valueAtCreate);
    } catch (error) {
      console.error("Simple Journal: could not create entry", error);
      new Notice("Could not create the entry file. Your text is still here.");
      // Let the user retry on the next keystroke — the composer (and
      // whatever it holds) is untouched. Only reclaim it if nothing else
      // has since torn the timeline down or opened a different one.
      if (!this.closed && generation === this.generation && this.composer === null) {
        this.composer = rendered;
      }
      return;
    }

    // Marked immediately on success, before any further bookkeeping — not
    // only before a later body write — so the metadata cache's post-create
    // "changed" event (fired once it parses the new file's frontmatter)
    // doesn't race the index update below and queue a redundant upsert.
    this.plugin.journal.markSelfWrite(file.path);

    if (this.closed || generation !== this.generation) {
      // The timeline was torn down (or reloaded) while the create was in
      // flight; clearTimeline already destroyed this composer. The file
      // itself is a perfectly ordinary entry now, with nothing referencing
      // it from this (defunct) view — the next reload's listEntries() picks
      // it up normally, same as any entry created by hand.
      return;
    }

    // `[]`, not a fresh resolve: the file was created a moment ago and the
    // metadata cache has not indexed it yet. The `changed` event it will fire
    // arrives as a "content" change, and `applyUpsert` fills the real tags in
    // then (see `journalService.ts`).
    rendered.entry = { file, created, tags: [] };
    rendered.el.dataset.path = file.path;
    rendered.el.removeClass("journal-entry-composer");
    // Reveal the actions button now that there's a file for it to act on
    // (see createEntryEl's doc on why it starts hidden for the composer).
    rendered.el.querySelector<HTMLElement>(".journal-entry-actions")?.removeClass("journal-entry-actions-pending");
    // Same moment: the timestamp button was disabled for the exact same
    // reason (see createEntryEl) and is now correctable too.
    const timeButton = rendered.el.querySelector<HTMLButtonElement>(".journal-entry-time");
    if (timeButton) timeButton.disabled = false;
    this.rendered.set(file.path, rendered);
    // savedBody starts matching exactly what createEntry just wrote;
    // resolveComposerContent's own persist (only invoked if typing outran
    // the create) brings it up to date, succeed or fail, before anything
    // reads it further.
    rendered.savedBody = valueAtCreate;

    // Delegates the "did a keystroke land while I was awaiting something?"
    // sequencing to a pure, independently-tested function (composerCommit.ts):
    // a keystroke can land in the composer's still-mounted textarea both
    // while createEntry() was in flight above AND while commitPersist below
    // is — re-reading only once, before the first await, is exactly the bug
    // where a fast typist's last few characters get seeded stale into the
    // real editor and then flushed right back out over what was just
    // written.
    const plan = await resolveComposerContent(
      valueAtCreate,
      () => rendered.editor?.getValue() ?? valueAtCreate,
      (value) => this.commitPersist(rendered, value),
    );
    if (this.closed || generation !== this.generation) return;

    // A keystroke landing during that persist takes onComposerInput's
    // "ordinary edit" branch (rendered.entry.file is already set by then)
    // and arms rendered.saveHandle over a value `plan.seed` already
    // supersedes — discard it; mounting below with `plan.seed` and, if
    // `plan.needsSave`, scheduling a fresh save for it is what actually
    // persists it now.
    if (rendered.saveHandle !== null) {
      window.clearTimeout(rendered.saveHandle);
      rendered.saveHandle = null;
    }

    const oldEditor = rendered.editor;
    rendered.editor = null;
    oldEditor?.destroy();
    rendered.bodyEl.empty();

    // Seeded from `plan.seed` (in memory), not a fresh disk read: the
    // visible editor must never show less than what the user actually
    // typed, regardless of what made it to disk.
    const editor = this.mountUsableEditor(rendered, plan.seed);
    rendered.editor = editor;
    // Known true: this is the composer, which startNewEntry always scrolls
    // to. Nothing else sets this for a fresh mount outside mountEditor's own
    // observer-driven path, which this deliberately bypasses (see below).
    rendered.intersecting = true;

    if (plan.needsSave) {
      this.scheduleSave(rendered, plan.seed);
    } else {
      // Nothing pending: normalize `savedBody` through the same code path
      // `mountEditor` uses (`editor.getValue()`, not the raw string) — the
      // two must agree by construction, not by the coincidence that a plain
      // textarea's value happens not to need normalizing.
      rendered.savedBody = editor.getValue();
    }

    this.mountOrder.push(file.path);
    this.enforceMountLimit();
    // Joins the mount window normally from here on, so a later scroll past
    // it (and back) is handled exactly like any other entry.
    this.mountObserver?.observe(rendered.el);

    if (focus) editor.focus("end");
  }

  /**
   * `resolveComposerContent`'s `persist` dependency: writes `value` via the
   * ordinary `save()` path (so it goes through the same self-write marking
   * and error handling/Notice as every other save) and reports back what's
   * now actually confirmed on disk — `value` on success, unchanged on
   * failure — mirroring `saveIfChanged`'s own return contract, which
   * `save()` already implements via `rendered.savedBody`.
   */
  private async commitPersist(rendered: RenderedEntry, value: string): Promise<string> {
    await this.save(rendered, value);
    return rendered.savedBody;
  }

  /**
   * Removes an abandoned empty composer. Only ever applies before the file
   * exists — a committed entry is never auto-deleted, however empty it
   * becomes; deletion is always an explicit user action (see CLAUDE.md's
   * "Lazy Creation").
   */
  private discardEmptyComposer(rendered: RenderedEntry): void {
    if (this.composer !== rendered) return;
    if (isMeaningful(rendered.editor?.getValue() ?? "")) return;

    // See `composerHasInput`'s doc: only a blur that follows the user
    // actually typing something means they moved away. A blur that arrives
    // having never received input — including one that follows a focus, if
    // that focus was activation churn rather than the user's own click —
    // discards a composer nobody has touched, which is worse than leaving
    // an untouched one open.
    if (!this.composerHasInput) return;

    this.clearMobileTimers(rendered);
    rendered.editor?.destroy();
    rendered.el.remove();
    this.composer = null;
    this.removeEmptyDayGroups();

    // removeEmptyDayGroups() can leave the timeline completely empty (this
    // was the only entry in the only rendered day group) — reload()'s own
    // empty-state message only ever renders on a fresh load, so without
    // this, abandoning the very first entry in an otherwise-empty journal
    // would leave a blank pane with no way back to the message short of a
    // manual reload.
    if (this.rendered.size === 0) this.renderEmptyState();
  }

  scrollToTop(): void {
    // Instant, not smooth: this can be invoked ("Go to today") from deep in
    // a long timeline, where an animated scroll would traverse the entire
    // height and ignores prefers-reduced-motion.
    this.contentEl.scrollTo({ top: 0 });
  }

  /**
   * Anchors the timeline to `date`, or clears the anchor when `date` is
   * `null`.
   *
   * With a date, this reloads so that paging starts at the newest entry at
   * or before the end of that calendar day — that entry lands at the top of
   * the timeline, with older entries below it exactly as in an unanchored
   * timeline. Entries newer than the anchor are simply not rendered (see
   * `anchorSeed`/`anchorPosition` in `entryIndex.ts`, and
   * `insertEntryInPlace`'s anchor-aware bounds check for how a later vault
   * event respects the same exclusion). If the anchored day itself has no
   * entries, this naturally lands on the nearest older entry instead of a
   * dead end — the user asked to go to a point in time, not to a specific
   * entry that may not exist.
   *
   * With `null`, this clears the anchor and reloads from the newest entry,
   * identical to the pre-anchor `reload()` behaviour.
   *
   * Goes through the same serialized `reload()`/`enqueueTimelineMutation`
   * chain as every other timeline rebuild — no separate locking needed here.
   * Scrolls to the top afterward so the anchor's newest entry (or, cleared,
   * the journal's newest entry) is actually visible rather than leaving the
   * viewport wherever it happened to be before this ran.
   *
   * There is no command wired to a non-null date yet — a future date picker
   * is the intended caller for that. `null` is already exercised: `goToToday`
   * uses it to clear a stale anchor, and `startNewEntry` uses it so capturing
   * a new entry while anchored to past history moves back to today first
   * (see its doc).
   */
  async goToDate(date: Date | null): Promise<void> {
    this.anchorDate = date;
    await this.reload();
    this.scrollToTop();
  }

  /**
   * Moves to the newest entry, clearing any active anchor first. A plain
   * `scrollToTop()` only moves the viewport within whatever is currently
   * loaded — if the timeline is anchored to a past date (`goToDate`), the
   * newest entry may not even be loaded, so scrolling alone would leave a
   * user anchored to, say, last year exactly where they were. Only reloads
   * (via `goToDate(null)`) when an anchor is actually active, so the common
   * case — already unanchored, just scrolled down — stays a cheap scroll.
   */
  async goToToday(): Promise<void> {
    if (this.anchorDate === null) {
      this.scrollToTop();
      return;
    }

    await this.goToDate(null);
  }
}
