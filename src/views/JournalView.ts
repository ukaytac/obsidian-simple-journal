import { Component, ItemView, MarkdownRenderer, Notice, Platform, WorkspaceLeaf } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type JournalEntriesPlugin from "../main";
import { compareEntries, pageAfter } from "../services/entryIndex";
import type { JournalChange } from "../services/journalService";
import { dayKey, formatDayHeader, formatMonthHeader, formatTime } from "../utils/dates";
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
    this.register(this.plugin.journal.onChange((change) => void this.applyChange(change)));
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

  /** The actual body of `reload()`, run only inside `enqueueTimelineMutation`. */
  private async reloadNow(): Promise<void> {
    // REQUIRED guard: see `closed`'s doc. A vault-event-triggered reload can
    // land after the view has already closed; bail before touching anything
    // rather than rebuild a timeline nothing will ever tear back down.
    if (this.closed) return;

    await this.clearTimeline();

    this.index = this.plugin.journal.getEntries();
    this.lastLoadedPath = null;

    if (this.index.length === 0) {
      this.renderEmptyState();
      return;
    }

    this.installMountObserver();
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
    this.generation++;

    const renderedEntries = Array.from(this.rendered.values());
    await Promise.allSettled(renderedEntries.map((rendered) => this.flushSave(rendered)));

    for (const rendered of renderedEntries) {
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
   */
  private appendEntry(entry: JournalEntry): void {
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
    el.dataset.path = entry.file.path;

    const headerEl = el.createDiv({ cls: "journal-entry-header" });
    headerEl.createSpan({ cls: "journal-entry-time", text: formatTime(entry.created) });

    // markdown-rendered matches Obsidian's own preview scope, so lists,
    // code fences, blockquotes, tables and callouts pick up its styling
    // (and whatever a theme layers on top of it) instead of browser defaults.
    const bodyEl = el.createDiv({ cls: "journal-entry-body markdown-rendered" });

    return {
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
    };
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
   * Resolves a path's current mount state for `mountWindow`'s pure selection
   * logic — the only bridge between that DOM/Obsidian-free module and this
   * view's actual `rendered` map.
   */
  private mountStateOf(path: string): MountState | undefined {
    const rendered = this.rendered.get(path);
    if (!rendered?.editor) return undefined;

    return {
      mounted: true,
      focused: rendered.editor.hasFocus(),
      intersecting: rendered.intersecting,
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
    rendered.savedBody = await saveIfChanged(
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
      },
    );
  }

  /**
   * Applies one index change from `JournalService` to the DOM, if it affects
   * a loaded entry. Registered in `onOpen` via `this.register(...)`, so
   * `ItemView` unsubscribes it automatically when the view closes.
   */
  private async applyChange(change: JournalChange): Promise<void> {
    // REQUIRED guard: see `closed`'s doc. `JournalService`'s vault-event
    // listeners can fire between `onClose` setting this and the view
    // actually finishing teardown (or, in principle, right after — nothing
    // upstream promises event delivery stops the instant `onClose` starts).
    if (this.closed) return;

    switch (change.kind) {
      case "removed": {
        const rendered = this.rendered.get(change.path);
        // `change.path` can be a genuine deletion OR the OLD half of a
        // rename (`JournalService.applyRenameSource` emits "removed"
        // unconditionally for that path, precisely so this stale rendering
        // gets cleaned up — see its doc). The two need different treatment:
        // a true deletion has nothing left to flush to; a rename's old path
        // still has the same file, just at a new path, reachable through
        // `rendered.entry.file` (Obsidian mutates that TFile in place, so
        // its `.path` already reads the NEW location by the time this
        // runs). Distinguish them by asking the vault whether that file
        // still resolves anywhere at all, rather than by path.
        if (rendered && this.app.vault.getAbstractFileByPath(rendered.entry.file.path)) {
          // Still exists somewhere — flush before tearing down, so an edit
          // that was mid-debounce at the moment of the rename/move isn't
          // lost. A genuine deletion skips this: the file is truly gone,
          // and attempting to write to it would just surface a confusing
          // "failed to save" notice for an intentional deletion.
          await this.flushSave(rendered);
          if (this.closed) return;
        }
        this.removeRenderedEntry(change.path);
        break;
      }

      case "content": {
        const rendered = this.rendered.get(change.entry.file.path);
        if (!rendered) {
          // Nothing rendered under this exact path yet — reachable right
          // after a rename with an unchanged `created` time: the OLD
          // rendering was already torn down by this same flush batch's
          // "removed" (see above), but this entry's `.file.path` is a path
          // nothing has ever been rendered at. Fall back to the same
          // insert-if-in-range logic "added"/"moved" already use, or the
          // entry would silently vanish from the timeline until the next
          // full reload.
          this.insertEntryInPlace(change.entry);
          return;
        }
        // Never clobber what the user is typing.
        if (rendered.editor?.hasFocus()) return;
        void this.refreshEntryContent(rendered);
        break;
      }

      case "moved": {
        const path = change.entry.file.path;
        const rendered = this.rendered.get(path);
        // The file itself still exists — unlike a genuine "removed",
        // silently discarding a pending edit here would lose real text for
        // no reason. Flush it to disk (under whichever path
        // `rendered.entry.file` now resolves to) before tearing the old
        // rendering down, so a `created` property edited in another pane
        // while this entry is mid-edit repositions it without losing the
        // in-flight keystrokes.
        if (rendered) await this.flushSave(rendered);
        if (this.closed) return;
        this.removeRenderedEntry(path);
        this.insertEntryInPlace(change.entry);
        break;
      }

      case "added": {
        this.insertEntryInPlace(change.entry);
        break;
      }
    }
  }

  /**
   * Tears down one rendered entry's editor/DOM and forgets it. Used for a
   * genuine deletion, the stale old-path half of a rename, and — after an
   * explicit flush — as half of repositioning a "moved" entry. Any pending
   * edit worth keeping has already been flushed by the caller (`applyChange`)
   * before this runs; this method itself never flushes, so it stays safe to
   * call unconditionally even when the underlying file is genuinely gone.
   */
  private removeRenderedEntry(path: string): void {
    const rendered = this.rendered.get(path);
    if (!rendered) return;

    if (rendered.saveHandle !== null) window.clearTimeout(rendered.saveHandle);
    rendered.editor?.destroy();
    rendered.renderComponent?.unload();
    rendered.el.remove();

    this.rendered.delete(path);
    const mountIndex = this.mountOrder.indexOf(path);
    if (mountIndex >= 0) this.mountOrder.splice(mountIndex, 1);

    this.removeEmptyDayGroups();
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
   */
  private insertEntryInPlace(entry: JournalEntry): void {
    if (this.rendered.has(entry.file.path)) return;

    const position = this.index.indexOf(entry);
    const loadedCount = this.rendered.size;
    if (position < 0) return;
    if (position > loadedCount && this.sentinelEl) return;

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

  /** Replaced with real behaviour in Task 15. */
  async startNewEntry(): Promise<void> {
    this.scrollToTop();
  }

  scrollToTop(): void {
    // Instant, not smooth: this can be invoked ("Go to today") from deep in
    // a long timeline, where an animated scroll would traverse the entire
    // height and ignores prefers-reduced-motion.
    this.contentEl.scrollTo({ top: 0 });
  }
}
