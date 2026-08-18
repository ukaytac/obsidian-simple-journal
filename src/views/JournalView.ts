import {
  ButtonComponent,
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  type TFile,
  WorkspaceLeaf,
} from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type JournalEntriesPlugin from "../main";
import { compareEntries, pageAfter } from "../services/entryIndex";
import type { JournalChange } from "../services/journalService";
import { dayKey, formatDayHeader, formatMonthHeader, formatTime } from "../utils/dates";
import { decideChangeAction, type RenderedState } from "./applyChange";
import { isMeaningful, resolveComposerContent } from "./composerCommit";
import type { EntryEditor } from "./EntryEditor";
import { saveIfChanged } from "./entrySave";
import { enforceMountLimit as runEnforceMountLimit, type MountState } from "./mountWindow";
import { TextareaEditor } from "./TextareaEditor";

export const VIEW_TYPE_JOURNAL = "journal-entries-timeline";

/** Entries rendered per page. */
const PAGE_SIZE = 40;

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
}

export class JournalView extends ItemView {
  private timelineEl!: HTMLElement;
  private rendered = new Map<string, RenderedEntry>();
  /** Day-group `.journal-day-entries` containers, keyed by `dayKey`, so lookup is O(1). */
  private dayGroups = new Map<string, HTMLElement>();
  private lastRenderedMonth: string | null = null;
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
  /** Paths of entries with a mounted editor, oldest-mounted first. */
  private mountOrder: string[] = [];
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

  constructor(
    leaf: WorkspaceLeaf,
    protected readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);
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
    await this.reload();
  }

  async onClose(): Promise<void> {
    // Set synchronously, before anything else: a vault-event handler firing
    // between now and the actual teardown below must see this immediately,
    // not after an await hands control back to it first.
    this.closed = true;
    await this.enqueueTimelineMutation(() => this.clearTimeline());
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

    await this.clearTimeline();

    this.index = this.plugin.journal.getEntries();
    this.lastLoadedPath = null;
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
      return;
    }

    await this.loadNextPage();
    this.installSentinel();
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
   */
  private async clearTimeline(): Promise<void> {
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
    if (this.composer) {
      // Not committing it here on the way out: creating a file during
      // teardown is a worse failure mode than losing an unsent draft, and
      // committing only on meaningful input (CLAUDE.md's Lazy Creation) is a
      // product rule, not merely this method's default. Best this can do is
      // leave the same console trace every other unavoidable-discard path
      // now leaves — see `logUnsavedTextIfLost`'s doc on why it also covers
      // this case.
      this.logUnsavedTextIfLost(this.composer);
      this.composer.editor?.destroy();
      this.composer = null;
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
      rendered.editor?.destroy();
      rendered.editor = null;
      rendered.renderComponent?.unload();
    }

    this.rendered.clear();
    this.dayGroups.clear();
    this.mountOrder = [];
    this.lastRenderedMonth = null;
    this.timelineEl.empty();
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
    // IntersectionObserver — hence the cast.
    const win = sentinelEl.win as Window & typeof globalThis;

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
        // Start loading before the sentinel is actually on screen.
        rootMargin: "600px 0px",
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
    const win = this.timelineEl.win as Window & typeof globalThis;

    this.mountObserver = new win.IntersectionObserver(
      (entries) => {
        for (const observerEntry of entries) {
          const path = (observerEntry.target as HTMLElement).dataset.path;
          if (!path) continue;

          const rendered = this.rendered.get(path);
          if (!rendered) continue;

          rendered.intersecting = observerEntry.isIntersecting;

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

  private renderEmptyState(): void {
    this.timelineEl.createDiv({
      cls: "journal-empty",
      text: "No journal entries yet. Run “New journal entry” to write the first one.",
    });
  }

  /**
   * Appends an entry below everything currently rendered. Rendered
   * statically and handed to `mountObserver`, not mounted directly:
   * `observe()` delivers an immediate callback with the entry's current
   * intersection state, which mounts a live editor right away for whatever
   * is already on screen and leaves everything else — most of a 40-entry
   * page, in the common case — statically rendered until it actually nears
   * the viewport. `mountEditor`/`renderStatic`'s shared `opToken` resolves the
   * race this creates when that immediate callback fires before this
   * static render has finished reading the file.
   *
   * Guards against a path already in `rendered`: reachable when a page
   * boundary and an `insertEntryInPlace`-driven insert (an "added"/"moved"/
   * "content" change for an entry just past the loaded window) land on the
   * very same entry — without this, `appendEntry` would silently overwrite
   * the map's entry for that path with a second `RenderedEntry`/DOM node
   * while the first stays in the DOM, still `observe()`d, its editor (if
   * mounted) never destroyed: a leaked editor, and for `ObsidianEmbedEditor`
   * a leaked 250ms poll, for the rest of the session.
   */
  private appendEntry(entry: JournalEntry): void {
    if (this.rendered.has(entry.file.path)) return;

    const group = this.ensureDayGroup(entry.created, "append");
    const rendered = this.createEntryEl(entry);
    group.appendChild(rendered.el);
    this.rendered.set(entry.file.path, rendered);
    void this.renderStatic(rendered);
    this.mountObserver?.observe(rendered.el);
  }

  /**
   * Returns the day group for this date, creating it — and its month header
   * when the month changes — if it does not exist yet. Looked up in the
   * `dayGroups` map rather than via `querySelector`, which would otherwise
   * re-scan an ever-growing subtree on every call.
   */
  private ensureDayGroup(date: Date, position: "append" | "prepend"): HTMLElement {
    const key = dayKey(date);
    const existing = this.dayGroups.get(key);
    if (existing) return existing;

    // Derived from dayKey (zero-padded "YYYY-MM") so this always matches the
    // month key rebuildMonthHeaders computes from the same dayKey string —
    // using getMonth() here instead would produce an unpadded, zero-based
    // value ("2026-7") that never equals rebuildMonthHeaders's ("2026-08").
    const monthKey = key.slice(0, 7);

    const dayEl = createDiv({ cls: "journal-day" });
    dayEl.dataset.day = key;
    dayEl.createDiv({ cls: "journal-day-header", text: formatDayHeader(date) });
    const entriesEl = dayEl.createDiv({ cls: "journal-day-entries" });
    this.dayGroups.set(key, entriesEl);

    if (position === "append") {
      if (monthKey !== this.lastRenderedMonth) {
        this.timelineEl.createDiv({
          cls: "journal-month-header",
          text: formatMonthHeader(date),
        });
        this.lastRenderedMonth = monthKey;
      }
      this.timelineEl.appendChild(dayEl);
    } else {
      this.timelineEl.prepend(dayEl);
      // Prepending can introduce a new topmost month; rebuild month headers.
      this.rebuildMonthHeaders();
    }

    return entriesEl;
  }

  /**
   * Month headers depend on their neighbours, so after any insertion that is
   * not a plain append they are recomputed from the day groups in the DOM.
   */
  private rebuildMonthHeaders(): void {
    for (const el of Array.from(this.timelineEl.querySelectorAll(".journal-month-header"))) {
      el.remove();
    }

    let previousMonth: string | null = null;

    for (const dayEl of Array.from(this.timelineEl.querySelectorAll<HTMLElement>(".journal-day"))) {
      const day = dayEl.dataset.day;
      if (!day) continue;

      // Same "YYYY-MM" slice ensureDayGroup uses, so the two paths agree.
      const monthKey = day.slice(0, 7);
      if (monthKey === previousMonth) continue;

      const [year, month] = monthKey.split("-");
      const header = createDiv({
        cls: "journal-month-header",
        text: formatMonthHeader(new Date(Number(year), Number(month) - 1, 1)),
      });
      dayEl.parentElement?.insertBefore(header, dayEl);
      previousMonth = monthKey;
    }

    this.lastRenderedMonth = previousMonth;
  }

  private createEntryEl(entry: JournalEntry): RenderedEntry {
    const el = createDiv({ cls: "journal-entry" });
    // `entry.file` is null for an uncommitted composer (see `openComposer`);
    // `data-path` is simply left unset until `commitComposer` gives it a
    // real file. Every other caller always has a real file here.
    if (entry.file) el.dataset.path = entry.file.path;

    const headerEl = el.createDiv({ cls: "journal-entry-header" });
    headerEl.createSpan({ cls: "journal-entry-time", text: formatTime(entry.created) });

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
      opToken: 0,
      saveToken: 0,
    };

    button.onClick((event) => this.showEntryMenu(rendered, event));

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
          // `writeText` rejects when the document isn't focused or clipboard
          // permission is denied — reported honestly rather than assuming
          // success, since the alternative is telling the user their link
          // copied when it didn't.
          navigator.clipboard.writeText(link).then(
            () => new Notice("Link copied"),
            (error) => {
              console.error("Journal Entries: could not copy the entry link", error);
              new Notice("Journal Entries: could not copy the link. See the developer console for details.");
            },
          );
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
      console.error("Journal Entries: could not delete entry", error);
      new Notice("Journal Entries: could not delete the entry.");
      return;
    }
    if (!confirmed) return;

    if (rendered.saveHandle !== null) {
      window.clearTimeout(rendered.saveHandle);
      rendered.saveHandle = null;
    }
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
      new Notice("Journal Entries: could not delete the entry.");
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
   * the primary mount trigger, not `appendEntry` (see its doc).
   *
   * Guards against a concurrent `clearTimeline()` (a reload, or the view
   * closing) the same way `renderStatic` does: `generation` is captured
   * before the only await, and checked after it, so a mount that resumes
   * into a timeline this instance no longer owns bails before touching the
   * DOM or `mountOrder` rather than mounting an editor nothing will ever
   * unmount. Also bumps/checks `rendered.opToken`, same reasoning as
   * `renderStatic`: this can race a concurrent static render (the one
   * `appendEntry` starts) or another mount attempt, and the loser must not
   * write into `bodyEl` after the winner already has. Also re-checks
   * `rendered.intersecting` after the await, for the symmetric reason
   * `unmountEditor` does: the entry may have left the margin again while
   * this was reading the file.
   */
  private async mountEditor(rendered: RenderedEntry): Promise<void> {
    if (rendered.editor) return;
    const generation = this.generation;
    const token = ++rendered.opToken;

    rendered.renderComponent?.unload();
    rendered.renderComponent = null;
    rendered.bodyEl.empty();
    rendered.bodyEl.style.removeProperty("min-height");

    const body = await this.plugin.repository.readBody(rendered.entry.file);
    if (generation !== this.generation) return;
    if (token !== rendered.opToken) return;
    if (rendered.editor) return;

    if (!rendered.intersecting) {
      // Left MOUNT_ROOT_MARGIN while this was reading the file. The
      // observer's exit transition already fired and called unmountEditor,
      // which no-opped (rendered.editor was still null) — no further
      // callback arrives until another transition, so without this check an
      // entry that's now off-screen would mount a live editor anyway (and
      // stay mounted indefinitely, invisible to any future scroll-driven
      // unmount). Restore static rendering instead of leaving bodyEl blank
      // (already cleared above).
      void this.renderStatic(rendered);
      return;
    }

    const editor = this.mountUsableEditor(rendered, body);

    // Seeded from the editor's own getValue(), not the raw disk read
    // (`body`): getValue() goes through whatever normalization the editor
    // applies on load (e.g. ObsidianEmbedEditor's CodeMirror document
    // normalizes CRLF to \n), and save()'s later dirty-check compares
    // against this exact same code path. Seeding from `body` instead would
    // compare two independently-sourced strings that can differ even when
    // nothing changed — a CRLF-line-ending file would then rewrite (and
    // silently reformat) on every unmount, reinstating the spurious-write
    // bug this field exists to prevent.
    rendered.savedBody = editor.getValue();

    rendered.editor = editor;
    this.mountOrder.push(rendered.entry.file.path);

    this.enforceMountLimit();
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
  private wireEditor(rendered: RenderedEntry, editor: EntryEditor): void {
    editor.onChange((value) => this.scheduleSave(rendered, value));

    // REQUIRED. An embedded editor can also fail *after* a successful mount —
    // its file is deleted, or the internal API changes shape under it. When
    // that happens it stops reporting changes, and without this the user goes
    // on typing into a surface whose text is never committed.
    editor.onUnusable(() => void this.replaceWithFallback(rendered));

    editor.onBlur(() => {
      if (!rendered.intersecting) void this.unmountEditor(rendered);
    });
  }

  /**
   * Mounts the configured editor, and if it reports that it failed — the
   * internal API changed shape on this Obsidian version — replaces it with the
   * textarea fallback for this entry. The journal stays editable either way.
   */
  private mountUsableEditor(rendered: RenderedEntry, body: string): EntryEditor {
    const editor = this.plugin.editorFactory.create();
    this.wireEditor(rendered, editor);

    editor.mount(rendered.bodyEl, rendered.entry.file, body);

    if (editor.isUsable?.() === false) {
      console.error(
        "Journal Entries: embedded editor was unusable; falling back to plain text for",
        rendered.entry.file.path,
      );
      editor.destroy();
      rendered.bodyEl.empty();

      const fallback = new TextareaEditor();
      this.wireEditor(rendered, fallback);
      fallback.mount(rendered.bodyEl, rendered.entry.file, body);
      return fallback;
    }

    return editor;
  }

  /**
   * Swaps a failed embedded editor for the plain-text fallback, preserving
   * whatever text it still holds. `getValue()` stays truthful after `destroy()`,
   * so nothing the user typed is lost across the swap.
   */
  private async replaceWithFallback(rendered: RenderedEntry): Promise<void> {
    const failed = rendered.editor;
    if (!failed) return;

    const text = failed.getValue();
    failed.destroy();
    rendered.bodyEl.empty();

    const fallback = new TextareaEditor();
    this.wireEditor(rendered, fallback);
    fallback.mount(rendered.bodyEl, rendered.entry.file, text);
    rendered.editor = fallback;

    new Notice("Journal Entries: switched this entry to plain text editing.");
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
      "Journal Entries: discarding unsaved text for",
      rendered.entry.file?.path ?? "(uncommitted composer)",
      "— recover it from this line before it is lost:",
      rendered.editor?.getValue(),
    );
  }

  /**
   * Resolves a path's current mount state for `mountWindow`'s pure selection
   * logic — the only bridge between that DOM/Obsidian-free module and this
   * view's actual `rendered` map.
   *
   * `unsaved` mirrors `unmountEditor`'s own decline check (see its doc): a
   * dirty editor is one `enforceMountLimit` must never pick as an eviction
   * victim. Without this, the cap would splice the path out of `mountOrder`
   * and call `unmountEditor` anyway, which would then decline and re-add it
   * via `ensureMountOrderContains` — correct in isolation, but only after
   * `flushSave` ran a real (possibly failing) write for no reason, and only
   * by chance before some other mount pushed the count over the cap again in
   * the meantime. Excluding it here, at selection time, avoids that churn
   * entirely rather than merely surviving it.
   */
  private mountStateOf(path: string): MountState | undefined {
    const rendered = this.rendered.get(path);
    if (!rendered?.editor) return undefined;

    return {
      mounted: true,
      focused: rendered.editor.hasFocus(),
      intersecting: rendered.intersecting,
      unsaved: this.isDirty(rendered),
    };
  }

  /**
   * Backstop for when more entries are simultaneously within
   * `MOUNT_ROOT_MARGIN` than `MAX_MOUNTED_EDITORS` allows. The primary
   * mount/unmount mechanism is `mountObserver`; this only runs after a mount
   * that pushes the count over the cap. Selection and the termination
   * guarantee live in `mountWindow.ts`, exercised directly there with
   * fabricated state; this just supplies the live lookup and the actual
   * (async) unmount.
   */
  private enforceMountLimit(): void {
    runEnforceMountLimit(
      this.mountOrder,
      MAX_MOUNTED_EDITORS,
      (path) => this.mountStateOf(path),
      (path) => {
        const rendered = this.rendered.get(path);
        if (rendered) void this.unmountEditor(rendered);
      },
    );
  }

  /**
   * Ensures `path` is present in `mountOrder` — a no-op if it already is.
   * Called wherever `unmountEditor` declines to unmount an editor that
   * remains legitimately mounted (still focused, or back on screen), so it
   * stays visible to `enforceMountLimit`'s cap even when the decline happens
   * on a path `enforceMountLimit` itself already spliced out before calling
   * in (see `mountWindow.ts`'s eviction contract).
   */
  private ensureMountOrderContains(path: string): void {
    if (!this.mountOrder.includes(path)) this.mountOrder.push(path);
  }

  /**
   * Flushes pending edits, destroys the editor, and restores static
   * rendering. Never unmounts a focused editor: `mountObserver` calls this
   * unconditionally the moment an entry leaves `MOUNT_ROOT_MARGIN`, and
   * ripping the keyboard focus out from under the user mid-sentence just
   * because they scrolled would be worse than leaving one editor mounted
   * past the margin. `wireEditor`'s `onBlur` callback gives that entry a
   * second chance to unmount once the user actually clicks away.
   */
  private async unmountEditor(rendered: RenderedEntry): Promise<void> {
    if (!rendered.editor) return;

    if (rendered.editor.hasFocus()) {
      // Still legitimately mounted — keep it tracked. Reachable when this is
      // called directly by mountObserver's exit callback (which never
      // pre-removes `mountOrder`) as well as, in principle, via
      // enforceMountLimit (which does): pickEvictionCandidate already
      // excludes focused entries at selection time, so this path shouldn't
      // fire from there, but re-adding is a harmless no-op if it somehow did.
      this.ensureMountOrderContains(rendered.entry.file.path);
      return;
    }

    // Captured before the awaits below. If a concurrent clearTimeline()
    // lands while the flush is in flight, it has already flushed, destroyed,
    // and nulled every editor (including this one) and emptied the timeline
    // itself — bail rather than redundantly destroy an already-destroyed
    // editor and render static Markdown into a bodyEl that no longer belongs
    // to any visible timeline. mountOrder itself is stale/replaced by then,
    // so no ensureMountOrderContains call is needed on this path.
    const generation = this.generation;

    try {
      await this.flushSave(rendered);
    } catch (error) {
      // save() itself never rejects; this only guards against a future
      // change reintroducing a throw here (e.g. editor.flush() itself). The
      // destroy/restore-static sequence below must still run regardless —
      // an editor left mounted because of a failed flush would keep polling
      // (ObsidianEmbedEditor) or holding DOM (either editor) forever, on top
      // of whatever the failed flush already lost.
      console.error("Journal Entries: failed to flush a pending save before unmounting", error);
    }
    if (generation !== this.generation) return;

    if (rendered.intersecting) {
      // Re-entered MOUNT_ROOT_MARGIN while the flush was in flight.
      // mountEditor's own guard (`if (rendered.editor) return`) already saw
      // this editor still set and no-opped, so no other code path will
      // remount it — leave it mounted rather than destroying a now-visible
      // entry's live editor out from under the user. Keep it tracked in
      // mountOrder for the same reason as the focused case above.
      this.ensureMountOrderContains(rendered.entry.file.path);
      return;
    }

    if (this.isDirty(rendered)) {
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
      // This can pin an entry past `MAX_MOUNTED_EDITORS` if its write keeps
      // failing — accepted: `mountStateOf`'s `unsaved` field already tells
      // `pickEvictionCandidate` never to select such an entry as a victim in
      // the first place, so this is a rare fallback for this path being
      // reached some other way, not the primary defense. Losing the user's
      // words is worse than one extra live editor.
      this.ensureMountOrderContains(rendered.entry.file.path);
      return;
    }

    // Freeze the height across the swap so the scroll position does not shift.
    const height = rendered.bodyEl.offsetHeight;
    rendered.bodyEl.style.minHeight = `${height}px`;

    rendered.editor?.destroy();
    rendered.editor = null;

    const index = this.mountOrder.indexOf(rendered.entry.file.path);
    if (index >= 0) this.mountOrder.splice(index, 1);

    await this.renderStatic(rendered);
    rendered.bodyEl.style.removeProperty("min-height");
  }

  /** Debounces writes so typing does not hit the disk on every keystroke. */
  private scheduleSave(rendered: RenderedEntry, value: string): void {
    if (rendered.saveHandle !== null) window.clearTimeout(rendered.saveHandle);

    rendered.saveHandle = window.setTimeout(() => {
      rendered.saveHandle = null;
      void this.save(rendered, value);
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
  private async flushSave(rendered: RenderedEntry): Promise<void> {
    rendered.editor?.flush();

    if (rendered.saveHandle === null) return;
    window.clearTimeout(rendered.saveHandle);
    rendered.saveHandle = null;

    if (!rendered.editor) return;
    await this.save(rendered, rendered.editor.getValue());
  }

  /**
   * Writes `value` to disk unless it already matches `rendered.savedBody`,
   * and never rejects. The dirty check and the never-reject shape are both
   * in `saveIfChanged` — kept as a small, dependency-injected pure function
   * (same shape as `mountWindow.ts`'s `stateOf`/`onEvict`) so both are
   * covered by `tests/entrySave.test.ts` directly, without needing a live
   * `JournalView`.
   *
   * `markSelfWrite` is called from inside the `write` callback — i.e. only
   * when `saveIfChanged` has actually decided a write is happening — rather
   * than unconditionally before calling `saveIfChanged`. Marking it
   * unconditionally would also mark the (very common) no-op case where
   * scrolling an unedited entry in and out of the mount window flushes
   * nothing: that mark would then never be consumed by a real `modify`/
   * `changed` event (none is coming) and would sit in `JournalService` for
   * its full TTL, able to wrongly swallow a genuinely external edit to the
   * same path that happens to land in that window.
   */
  private async save(rendered: RenderedEntry, value: string): Promise<void> {
    // See `saveToken`'s doc: two `save()` calls for the same entry can
    // overlap (a `scheduleSave` timer firing while an earlier write is still
    // in flight, or a `flushSave` starting a second one), and can then
    // settle out of order. Captured before the only await below, so it
    // identifies THIS call uniquely; only the call whose token still matches
    // `rendered.saveToken` when it settles is the most recent one, and only
    // that one is allowed to touch `savedBody` or the marker.
    const token = ++rendered.saveToken;

    const result = await saveIfChanged(
      value,
      rendered.savedBody,
      (v) => {
        this.plugin.journal.markSelfWrite(rendered.entry.file.path);
        return this.plugin.repository.writeBody(rendered.entry.file, v);
      },
      (error) => {
        console.error("Journal Entries: failed to save an entry", rendered.entry.file.path, error);
        new Notice(
          `Journal Entries: failed to save "${rendered.entry.file.path}". See the developer console for details.`,
        );
        // REQUIRED: an older, failing write must not raise a marker after a
        // newer write for this same entry has already been issued (and
        // possibly already succeeded) — see `saveToken`'s doc.
        if (token === rendered.saveToken) this.showSaveError(rendered);
      },
    );

    // REQUIRED, same reasoning: an older attempt resolving after a newer one
    // must not stomp `savedBody` back to its own now-stale result.
    if (token !== rendered.saveToken) return;
    rendered.savedBody = result;

    // `savedBody` now equals `value` on both a successful write and a
    // no-op skip (value already matched disk) — the only case it does NOT
    // equal `value` is a failed write, where `saveIfChanged` hands back the
    // unchanged original. Clearing here on the skip path too is correct, not
    // just harmless: it covers the entry being edited back to the last
    // known-good text after a prior failure, which never re-enters `write`
    // (value === savedBody), but is genuinely no longer "unsaved".
    if (rendered.savedBody === value) this.clearSaveError(rendered);
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
   * already last among the header's children (see `createEntryEl`) — a plain
   * append would land the marker to the right of the (auto-margined, always
   * right-aligned) actions button instead of next to the timestamp.
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
  private showSaveError(rendered: RenderedEntry): void {
    if (rendered.el.querySelector(".journal-entry-error")) return;

    const header = rendered.el.querySelector(".journal-entry-header");
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
  private clearSaveError(rendered: RenderedEntry): void {
    rendered.el.querySelector(".journal-entry-error")?.remove();
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
   * The actual body of `applyChanges`, run only inside
   * `enqueueTimelineMutation`. Applies one batch of index changes from
   * `JournalService` to the DOM.
   *
   * `generation` is captured once and re-checked after every `await` in the
   * loop below, exactly like `renderStatic`/`mountEditor`/`reloadNow`: even
   * though `reload()` cannot itself run concurrently with this (both go
   * through the same serialized chain), a scroll-driven `unmountEditor`
   * that flushes and destroys this exact editor is NOT serialized behind
   * that chain, so this still needs its own defense against acting on state
   * a concurrent operation has since torn down.
   *
   * Day-group cleanup (`removeEmptyDayGroups`) is deferred to the end of
   * the whole batch, not run per removal: it does two full-timeline
   * `querySelectorAll`s plus a complete `rebuildMonthHeaders`, and a sync
   * burst can remove on the order of a hundred entries in one batch —
   * running it per removal would make that work scale with the burst size
   * instead of staying flat.
   */
  private async applyChangesNow(changes: JournalChange[]): Promise<void> {
    // REQUIRED guard: see `closed`'s doc. `JournalService`'s vault-event
    // listeners can fire between `onClose` setting this and the view
    // actually finishing teardown (or, in principle, right after — nothing
    // upstream promises event delivery stops the instant `onClose` starts).
    if (this.closed) return;
    const generation = this.generation;
    let dayGroupsDirty = false;

    for (const change of changes) {
      if (this.closed || generation !== this.generation) return;

      if (change.kind === "reload") {
        // Always the sole entry in its batch (see JournalChange's doc);
        // `reload()` itself enqueues onto the same chain this task is
        // already running inside, so it runs right after this task
        // resolves rather than reentrantly — fire it and stop.
        void this.reload();
        return;
      }

      if (change.kind === "removed") {
        const rendered = this.rendered.get(change.path);
        const action = decideChangeAction(change, this.renderedStateFor(rendered));
        if (action.type !== "remove") continue;

        if (action.flush && rendered) {
          await this.flushSave(rendered);
          if (this.closed || generation !== this.generation) return;

          if (this.isDirty(rendered)) {
            // The flush did not reach disk (the write is still failing) even
            // though the file itself is still there, just elsewhere (a
            // rename or a move out of the journal folder, not a genuine
            // delete — `action.flush` is only true when `fileStillExists`).
            // Tearing this rendering down now would destroy the editor and
            // replace the on-screen text with the stale `savedBody`, the
            // same loss `unmountEditor`'s decline exists to prevent.
            //
            // A plain decline is not enough here, unlike the "reposition"
            // branch below: `change.path` is only the STALE key this
            // rendering happens to still be filed under in `this.rendered`
            // (Obsidian mutates the renamed `TFile` in place, so `rendered`
            // already IS the current file — only our own bookkeeping is
            // behind). A rename always pairs this "removed" with a same-batch
            // upsert for the file's new path (see
            // `JournalService.applyRenameSource`); if this rendering is left
            // keyed at the old path, that paired upsert finds nothing at the
            // new path and inserts a SECOND, independent rendering — two live
            // editors bound to the same `TFile`, both polling, both able to
            // write, fighting over the same file. That is worse than the
            // loss this decline exists to prevent, not merely "briefly
            // wrong" — so re-key instead of just leaving it behind.
            //
            // Guarded on the destination being free: `this.rendered.set`
            // would otherwise silently overwrite whatever is ALREADY
            // rendered at `newPath` — reachable within one debounce window
            // if a different entry at that exact path is deleted while this
            // rename lands first. That victim's DOM node and (if mounted)
            // its still-polling editor would then be orphaned — unreachable
            // from `this.rendered`, so nothing could ever tear it down; it
            // would keep running for the rest of the session. Falling
            // through to the existing removal path when occupied is safe:
            // it still logs this entry's text before it's dropped, rather
            // than silently destroying the other row.
            const newPath = rendered.entry.file.path;
            if (!this.rendered.has(newPath)) {
              this.rendered.delete(change.path);
              this.rendered.set(newPath, rendered);
              const mountIndex = this.mountOrder.indexOf(change.path);
              if (mountIndex >= 0) this.mountOrder[mountIndex] = newPath;
              rendered.el.dataset.path = newPath;
              // `dayGroups` is untouched: a rename/move changes neither
              // `entry.created` nor which day group this element already
              // sits in, only the path bookkeeping above.
              //
              // With `this.rendered` now correctly keyed at `newPath`, the
              // paired upsert due later in this SAME batch finds
              // `state.exists === true` and either no-ops (dirty, per
              // `decideChangeAction`'s "content" case) or hits the
              // "reposition" branch below — either way, no duplicate. For a
              // move OUT of the journal folder there is no companion upsert
              // at all (see `JournalService.flush`'s "not an entry" branch),
              // so this re-keyed row simply stays, still holding the user's
              // text and still marked, until a write succeeds — the correct
              // outcome: dropping it would discard exactly the text this
              // whole decline exists to protect.
              continue;
            }
          }
        }
        if (this.removeRenderedEntry(change.path)) dayGroupsDirty = true;
        continue;
      }

      // Remaining kinds ("added" | "content" | "moved") all carry `entry`.
      const path = change.entry.file.path;
      const rendered = this.rendered.get(path);
      const action = decideChangeAction(change, this.renderedStateFor(rendered));

      switch (action.type) {
        case "noop":
          break;

        case "insert":
          this.insertEntryInPlace(change.entry);
          break;

        case "refresh":
          if (rendered) {
            await this.refreshEntryContent(rendered);
            if (this.closed || generation !== this.generation) return;
          }
          break;

        case "reposition":
          if (action.flush && rendered) {
            await this.flushSave(rendered);
            if (this.closed || generation !== this.generation) return;

            if (this.isDirty(rendered)) {
              // Same reasoning as the "removed" branch above: the write is
              // still failing, so tearing the current rendering down and
              // re-inserting a fresh one from disk would discard exactly the
              // text the "not saved" marker promises is still safe. Leave
              // this entry at its old position, still marked, until a write
              // actually succeeds — a briefly wrong position is a far
              // smaller harm than losing what the user wrote.
              //
              // Unlike the "removed" branch, this is NOT at risk of becoming
              // a duplicate row: "reposition" only fires when the file's
              // PATH is unchanged (its `created` changed from elsewhere —
              // e.g. a Properties-pane edit — with no rename involved), so
              // `rendered` stays reachable at the same map key regardless —
              // there is no stale bookkeeping for a paired change to trip
              // over, so no re-key is needed here.
              //
              // KNOWN LIMITATION, deliberately left as-is: nothing re-runs
              // this once a later write succeeds — the row keeps its stale
              // day-group placement and its stale `.created` until the next
              // full `reload()`. A save()-success-triggered re-trigger would
              // need to safely re-enter `enqueueTimelineMutation`'s
              // serialized chain from a callback that runs completely
              // outside it today, plus re-validate `this.rendered` hasn't
              // changed by the time it runs — not a few-line fix, and (unlike
              // the "removed" branch's duplicate-editor risk) the harm here
              // is only a stale position, not two editors fighting over one
              // file — acceptable for the MVP.
              break;
            }
          }
          if (this.removeRenderedEntry(path)) dayGroupsDirty = true;
          this.insertEntryInPlace(change.entry);
          break;

        case "remove":
        case "reloadView":
          // Unreachable for "added"/"content"/"moved" — decideChangeAction
          // only returns these for "removed"/"reload", both handled above.
          break;
      }
    }

    if (dayGroupsDirty) this.removeEmptyDayGroups();
  }

  /**
   * Resolves one path's state for `decideChangeAction`'s pure selection
   * logic — the only bridge between that DOM/Obsidian-free module and this
   * view's actual `rendered` map, mirroring `mountStateOf`'s role for
   * `mountWindow.ts`.
   *
   * `fileStillExists` compares by IDENTITY (`===`), not merely by path: a
   * delete-then-recreate at the same path within one debounce window would
   * otherwise read as "still exists" (something resolves at that path) and
   * flush this stale editor's held text into the NEW, unrelated file.
   *
   * `dirty` compares the editor's current value against `savedBody`
   * directly, not `rendered.saveHandle !== null`: a debounce timer being
   * armed doesn't mean the value it will eventually save is actually
   * different from disk (a type-then-revert within the 500ms window still
   * leaves a timer armed over an unchanged value), and a timer being
   * disarmed doesn't mean nothing needs protecting (`scheduleSave` clears
   * `saveHandle` the instant its timeout fires, before the write it kicks
   * off has even resolved — so a write that's still in flight, or one that
   * already failed, both read as "no pending save" despite the editor still
   * holding text `savedBody` doesn't match). `false` when nothing is
   * mounted: a statically-rendered entry has no live editor to be dirty.
   */
  private renderedStateFor(rendered: RenderedEntry | undefined): RenderedState {
    if (!rendered) {
      return { exists: false, focused: false, dirty: false, fileStillExists: false };
    }

    return {
      exists: true,
      focused: rendered.editor?.hasFocus() ?? false,
      dirty: this.isDirty(rendered),
      fileStillExists:
        this.app.vault.getAbstractFileByPath(rendered.entry.file.path) === rendered.entry.file,
    };
  }

  /**
   * Tears down one rendered entry's editor/DOM and forgets it. Used for a
   * genuine deletion, the stale old-path half of a rename, and — after an
   * explicit flush that confirmed the entry is no longer dirty — as half of
   * repositioning a "moved" entry (see `applyChangesNow`'s "removed"/
   * "reposition" handling, both of which bail before reaching this call if
   * the flush left the entry still dirty). This method itself never flushes,
   * so it stays safe to call unconditionally even when the underlying file
   * is genuinely gone.
   *
   * A genuine deletion is the one path here that can still reach a dirty
   * entry: `applyChangesNow` never flushes before deleting (`action.flush`
   * is only true when the file still exists elsewhere), so any edit still
   * inside the debounce window, or already failed, is discarded for real —
   * there is no file left to write it to. `logUnsavedTextIfLost` gives the
   * user a last chance to recover that text from the developer console
   * before it goes.
   *
   * Returns whether anything was actually removed. Deliberately does NOT
   * call `removeEmptyDayGroups` itself — see `applyChangesNow`'s doc — the
   * caller batches that once per flush using this return value.
   */
  private removeRenderedEntry(path: string): boolean {
    const rendered = this.rendered.get(path);
    if (!rendered) return false;

    if (rendered.saveHandle !== null) window.clearTimeout(rendered.saveHandle);
    this.logUnsavedTextIfLost(rendered);
    rendered.editor?.destroy();
    rendered.renderComponent?.unload();
    rendered.el.remove();

    this.rendered.delete(path);
    const mountIndex = this.mountOrder.indexOf(path);
    if (mountIndex >= 0) this.mountOrder.splice(mountIndex, 1);

    return true;
  }

  /**
   * Removes day groups that no longer hold an entry.
   *
   * The `dayGroups` map must lose the key in the same pass. Leaving it
   * behind means `ensureDayGroup` later hands back a detached container, and
   * every entry written on that day renders into nothing — visible as an
   * entry that silently fails to appear.
   */
  private removeEmptyDayGroups(): void {
    for (const dayEl of Array.from(this.timelineEl.querySelectorAll<HTMLElement>(".journal-day"))) {
      if (dayEl.querySelector(".journal-entry")) continue;

      const key = dayEl.dataset.day;
      if (key) this.dayGroups.delete(key);
      dayEl.remove();
    }

    this.rebuildMonthHeaders();
  }

  /**
   * Inserts an entry at its correct reverse-chronological position, but only
   * if it belongs inside the range currently loaded. Entries older than
   * everything loaded are left to normal paging (they'll appear once the
   * user scrolls that far, `pageAfter` reading them out of the same shared
   * index this just inserted into).
   *
   * Rendered statically and handed to `mountObserver`, exactly like
   * `appendEntry` — not mounted directly. `mountEditor` bails to a static
   * render whenever `rendered.intersecting` is false, and that flag is only
   * ever set by `mountObserver`'s own callback; mounting here directly
   * without first `observe()`-ing the element would leave `intersecting`
   * stuck at its `false` default forever, so `mountEditor` would always bail,
   * and the entry would never become eligible for the viewport-driven
   * unmount that keeps the mounted set bounded.
   *
   * The in-range check is `position >= loadedCount`, not `>`: with
   * `loadedCount` entries loaded (indices `0..loadedCount-1`), `loadedCount`
   * itself is the first index NOT yet loaded — `pageAfter`'s next page
   * starts there. `>` would let that boundary entry (and only that one)
   * through: this method would insert it AND `appendEntry` would later
   * insert it again as part of the next page, each holding its own
   * `RenderedEntry`/DOM node/editor for the same path — one leaked
   * indefinitely, since only the map's most recent entry for that path is
   * ever reachable to tear down.
   */
  private insertEntryInPlace(entry: JournalEntry): void {
    if (this.rendered.has(entry.file.path)) return;

    const position = this.index.indexOf(entry);
    const loadedCount = this.rendered.size;
    if (position < 0) return;
    if (position >= loadedCount && this.sentinelEl) return;

    // The empty-state message (`renderEmptyState`) is only ever present when
    // nothing is rendered yet, so this is a cheap no-op on every insert past
    // the first. Removed here rather than left for the next full reload:
    // this is the ONLY path that inserts into a timeline that was rendered
    // empty (a genuine full reload already clears everything, including this
    // element, via `clearTimeline`).
    this.timelineEl.querySelector(".journal-empty")?.remove();

    const group = this.ensureDayGroup(entry.created, "prepend");
    const rendered = this.createEntryEl(entry);

    // Find the first already-rendered sibling that is older than this entry.
    const siblings = Array.from(group.querySelectorAll<HTMLElement>(".journal-entry"));
    const olderSibling = siblings.find((el) => {
      const siblingEntry = this.rendered.get(el.dataset.path ?? "");
      return siblingEntry ? compareEntries(entry, siblingEntry.entry) < 0 : false;
    });

    if (olderSibling) group.insertBefore(rendered.el, olderSibling);
    else group.appendChild(rendered.el);

    this.rendered.set(entry.file.path, rendered);
    void this.renderStatic(rendered);
    this.mountObserver?.observe(rendered.el);
  }

  /**
   * Reloads one entry's text from disk without remounting its editor. Used
   * when an entry changes from another pane while this view has it
   * statically rendered or mounted-but-unfocused (`applyChange`'s "content"
   * case already skips a focused editor entirely).
   *
   * REQUIRED: `savedBody` must be updated in the same breath as `setValue`,
   * seeded from `editor.getValue()` rather than from `body`. `save()` skips
   * the write when the value to save matches `savedBody`; install the
   * external body without advancing `savedBody` and the next flush (e.g. the
   * next time this entry scrolls out of the mount window) sees a difference,
   * writes the external content straight back, and re-fires `modify` — the
   * reload loop this whole design exists to prevent. Seeding from
   * `getValue()` rather than `body` matters for the same reason
   * `mountEditor` does: the editor may normalize line endings on load (e.g.
   * CRLF -> LF), so the value stored here must come from the same code path
   * the dirty-check in `save()` reads back, not from the raw disk read.
   */
  private async refreshEntryContent(rendered: RenderedEntry): Promise<void> {
    const body = await this.plugin.repository.readBody(rendered.entry.file);

    if (rendered.editor) {
      if (rendered.editor.getValue() === body) return;
      rendered.editor.setValue(body);
      rendered.savedBody = rendered.editor.getValue();
      return;
    }

    await this.renderStatic(rendered);
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
   */
  async startNewEntry(): Promise<void> {
    if (this.composer) {
      this.composer.editor?.focus();
      this.scrollToTop();
      return;
    }

    await this.enqueueTimelineMutation(() => this.openComposer());
  }

  private async openComposer(): Promise<void> {
    if (this.closed) return;

    if (this.composer) {
      // A concurrent invocation (see startNewEntry's doc) already opened one.
      this.composer.editor?.focus();
      this.scrollToTop();
      return;
    }

    const now = new Date();

    // Same reasoning as insertEntryInPlace: the empty-state message is only
    // ever present when nothing is rendered yet, and this is the only other
    // path (besides that one) that can insert into a timeline rendered empty.
    this.timelineEl.querySelector(".journal-empty")?.remove();

    // Reuses ensureDayGroup rather than a separate "ensure today" helper:
    // today's group is just the day group for `now`, prepended like any
    // other freshly-appearing newest day, and ensureDayGroup already
    // populates/reads the `dayGroups` map correctly (a hand-rolled duplicate
    // of that logic would be one more place for the two to drift apart).
    const group = this.ensureDayGroup(now, "prepend");

    const placeholder: JournalEntry = {
      // No file yet. Nothing reads `file` before commitComposer runs —
      // createEntryEl leaves `data-path` unset for exactly this case.
      file: null as unknown as JournalEntry["file"],
      created: now,
    };

    const rendered = this.createEntryEl(placeholder);
    rendered.el.addClass("journal-entry-composer");
    group.prepend(rendered.el);

    // Always a plain textarea, never `this.plugin.editorFactory.create()`:
    // the embedded editor needs a real TFile to hand the embed registry, and
    // this entry doesn't have one yet. See commitComposer for the swap once
    // it does.
    const editor = new TextareaEditor();
    editor.onChange((value) => void this.onComposerInput(rendered, value));
    editor.onBlur(() => this.discardEmptyComposer(rendered));
    editor.mount(rendered.bodyEl, null, "");

    rendered.editor = editor;
    this.composer = rendered;

    this.scrollToTop();
    editor.focus();
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

    this.composer = null;
    await this.enqueueTimelineMutation(() => this.commitComposer(rendered));
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
   */
  private async commitComposer(rendered: RenderedEntry): Promise<void> {
    if (this.closed) return;
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
      console.error("Journal Entries: could not create entry", error);
      new Notice("Journal Entries: could not create the entry file. Your text is still here.");
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

    rendered.entry = { file, created };
    rendered.el.dataset.path = file.path;
    rendered.el.removeClass("journal-entry-composer");
    // Reveal the actions button now that there's a file for it to act on
    // (see createEntryEl's doc on why it starts hidden for the composer).
    rendered.el.querySelector<HTMLElement>(".journal-entry-actions")?.removeClass("journal-entry-actions-pending");
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

    editor.focus("end");
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
}
