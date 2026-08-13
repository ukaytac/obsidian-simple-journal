import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type JournalEntriesPlugin from "../main";
import { dayKey, formatDayHeader, formatMonthHeader, formatTime } from "../utils/dates";

export const VIEW_TYPE_JOURNAL = "journal-entries-timeline";

/** Entries rendered per `reload()`. Interim bound until the paging task lands. */
const INITIAL_PAGE_SIZE = 200;

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

  /**
   * Discards and rebuilds the whole timeline.
   *
   * Interim: bounded to the newest `INITIAL_PAGE_SIZE` entries via
   * `getEntries({ limit })` rather than `listEntries()`, so this stays cheap
   * on a large vault. The paging task supersedes this with incremental
   * loading of older entries.
   */
  async reload(): Promise<void> {
    this.clearTimeline();

    const entries = this.plugin.repository.getEntries({ limit: INITIAL_PAGE_SIZE });
    for (const entry of entries) {
      this.appendEntry(entry);
    }

    if (entries.length === 0) this.renderEmptyState();
  }

  private clearTimeline(): void {
    this.generation++;
    for (const rendered of this.rendered.values()) {
      rendered.renderComponent?.unload();
    }
    this.rendered.clear();
    this.dayGroups.clear();
    this.lastRenderedMonth = null;
    this.timelineEl.empty();
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

    rendered.renderComponent?.unload();
    rendered.bodyEl.empty();

    const component = new Component();
    component.load();
    rendered.renderComponent = component;

    // A reload() (this view's own, or one triggered concurrently by
    // main.ts's refreshJournal) may already have discarded this entry's
    // element by the time control returns here. Bail rather than kick off
    // vault I/O whose result would only be thrown away.
    if (generation !== this.generation) return;

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
