import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type JournalEntriesPlugin from "../main";
import { dayKey, formatDayHeader, formatMonthHeader, formatTime } from "../utils/dates";

export const VIEW_TYPE_JOURNAL = "journal-entries-timeline";

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
  private lastRenderedMonth: string | null = null;

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

  /** Discards and rebuilds the whole timeline. */
  async reload(): Promise<void> {
    this.clearTimeline();

    const entries = this.plugin.repository.listEntries();
    for (const entry of entries) {
      this.appendEntry(entry);
    }

    if (entries.length === 0) this.renderEmptyState();
  }

  private clearTimeline(): void {
    for (const rendered of this.rendered.values()) {
      rendered.renderComponent?.unload();
    }
    this.rendered.clear();
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
   * when the month changes — if it does not exist yet.
   */
  private ensureDayGroup(date: Date, position: "append" | "prepend"): HTMLElement {
    const key = dayKey(date);
    const existing = this.timelineEl.querySelector<HTMLElement>(
      `.journal-day[data-day="${key}"] .journal-day-entries`,
    );
    if (existing) return existing;

    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;

    const dayEl = createDiv({ cls: "journal-day" });
    dayEl.dataset.day = key;
    dayEl.createDiv({ cls: "journal-day-header", text: formatDayHeader(date) });
    const entriesEl = dayEl.createDiv({ cls: "journal-day-entries" });

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

      const [year, month] = day.split("-");
      const monthKey = `${year}-${month}`;
      if (monthKey === previousMonth) continue;

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

    const bodyEl = el.createDiv({ cls: "journal-entry-body" });

    return { entry, el, bodyEl, renderComponent: null };
  }

  /** Read-only rendering of an entry, used when no editor is mounted for it. */
  private async renderStatic(rendered: RenderedEntry): Promise<void> {
    rendered.renderComponent?.unload();
    rendered.bodyEl.empty();

    const component = new Component();
    component.load();
    rendered.renderComponent = component;

    const body = await this.plugin.repository.readBody(rendered.entry.file);

    await MarkdownRenderer.render(
      this.app,
      body.trim(),
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
    this.contentEl.scrollTo({ top: 0, behavior: "smooth" });
  }
}
