import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type JournalEntriesPlugin from "../main";
import { pageAfter } from "../services/entryIndex";
import { dayKey, formatDayHeader, formatMonthHeader, formatTime } from "../utils/dates";

export const VIEW_TYPE_JOURNAL = "journal-entries-timeline";

/** Entries rendered per page. */
const PAGE_SIZE = 40;

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
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.clearTimeline();
    this.contentEl.empty();
  }

  /** Discards and rebuilds the timeline, rendering only the first page. */
  async reload(): Promise<void> {
    this.clearTimeline();

    this.index = this.plugin.repository.listEntries();
    this.lastLoadedPath = null;

    if (this.index.length === 0) {
      this.renderEmptyState();
      return;
    }

    await this.loadNextPage();
    this.installSentinel();
  }

  private clearTimeline(): void {
    this.teardownSentinel();
    this.generation++;
    for (const rendered of this.rendered.values()) {
      rendered.renderComponent?.unload();
    }
    this.rendered.clear();
    this.dayGroups.clear();
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

  private renderEmptyState(): void {
    this.timelineEl.createDiv({
      cls: "journal-empty",
      text: "No journal entries yet. Run “New journal entry” to write the first one.",
    });
  }

  /** Appends an entry below everything currently rendered. */
  private appendEntry(entry: JournalEntry): void {
    const group = this.ensureDayGroup(entry.created, "append");
    const el = this.createEntryEl(entry);
    group.appendChild(el.el);
    this.rendered.set(entry.file.path, el);
    void this.renderStatic(el);
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

    return { entry, el, bodyEl, renderComponent: null };
  }

  /** Read-only rendering of an entry, used when no editor is mounted for it. */
  private async renderStatic(rendered: RenderedEntry): Promise<void> {
    const generation = this.generation;
    // Bail before creating any Component if a reload() already ran (e.g. a
    // future caller that awaits renderStatic before this resumes). Checked
    // here, first, so a bail can never leave a loaded Component attached to
    // a RenderedEntry that this.rendered no longer references — nothing
    // downstream would unload it.
    if (generation !== this.generation) return;

    rendered.renderComponent?.unload();
    rendered.bodyEl.empty();

    const component = new Component();
    component.load();
    rendered.renderComponent = component;

    const body = await this.plugin.repository.readBody(rendered.entry.file);
    // Re-check: the reload may instead have landed while readBody was in
    // flight. Bail rather than render into a detached bodyEl that no
    // longer belongs to the visible timeline.
    if (generation !== this.generation) return;

    // Strips only the blank line Task 3's create template leaves after the
    // frontmatter, not indentation on the first real content line — unlike
    // a plain trim(), which would also eat a leading indented code block.
    const strippedBody = body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");

    await MarkdownRenderer.render(
      this.app,
      strippedBody,
      rendered.bodyEl,
      rendered.entry.file.path,
      component,
    );
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
