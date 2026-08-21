import { ExtraButtonComponent, ItemView, type WorkspaceLeaf } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { buildMonthGrid, entryDaysInMonth, WEEKDAY_HEADER } from "./calendarGrid";
import { dayKey } from "../utils/dates";

export const VIEW_TYPE_CALENDAR = "simple-journal-calendar";

/**
 * Month calendar sidebar. A thin DOM/Obsidian shell around the pure grid math
 * in `calendarGrid.ts` — this class owns rendering, month navigation state,
 * and the `JournalService` subscription; it contains no date-grid logic of
 * its own.
 *
 * Same writing-surface restraint as `JournalView` (CLAUDE.md's "Main Journal
 * View" and "Product Philosophy"): no borders, cards, or shadows, and every
 * color/metric comes from an Obsidian CSS variable (see `styles.css`).
 */
export class CalendarView extends ItemView {
  private headerEl!: HTMLElement;
  private gridEl!: HTMLElement;
  /** The month currently displayed. Always normalized to the 1st of the month. */
  private displayedMonth: Date;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: JournalEntriesPlugin,
  ) {
    super(leaf);
    const now = new Date();
    this.displayedMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR;
  }

  getDisplayText(): string {
    return "Calendar";
  }

  getIcon(): string {
    return "calendar";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("journal-calendar-view");

    this.headerEl = this.contentEl.createDiv({ cls: "journal-calendar-header" });
    this.gridEl = this.contentEl.createDiv({ cls: "journal-calendar-grid" });

    // Re-render on every vault change batch. `entryDaysInMonth`'s two binary
    // searches keep this cheap regardless of index size or which month is
    // currently displayed — no need to inspect `changes` to decide whether
    // the displayed month is actually affected. `this.register` (same
    // pattern as `JournalView.onOpen`) ties the unsubscribe to this view's
    // own Component lifecycle, so it fires on close even along a teardown
    // path that skips `onClose` for some reason, and a change arriving after
    // that can never reach a detached DOM.
    this.register(this.plugin.journal.onChange(() => this.render()));

    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /**
   * Re-renders for the currently displayed month. Public so `main.ts`'s
   * `refreshJournal` (triggered by a Journal folder setting change) can
   * refresh this view directly — that path replaces `JournalService`'s index
   * via `rebuild()` without going through the normal `onChange` batching this
   * view otherwise relies on.
   */
  refresh(): void {
    this.render();
  }

  /** Rebuilds the header and grid for `this.displayedMonth`. */
  private render(): void {
    this.renderHeader();
    this.renderGrid();
  }

  private renderHeader(): void {
    this.headerEl.empty();

    const titleEl = this.headerEl.createDiv({ cls: "journal-calendar-title" });
    titleEl.createSpan({
      cls: "journal-calendar-month-name",
      text: this.displayedMonth.toLocaleDateString("en-US", { month: "long" }),
    });
    titleEl.createSpan({
      cls: "journal-calendar-year",
      text: String(this.displayedMonth.getFullYear()),
    });

    const navEl = this.headerEl.createDiv({ cls: "journal-calendar-nav" });
    new ExtraButtonComponent(navEl)
      .setIcon("chevron-left")
      .setTooltip("Previous month")
      .onClick(() => this.stepMonth(-1));
    new ExtraButtonComponent(navEl)
      .setIcon("chevron-right")
      .setTooltip("Next month")
      .onClick(() => this.stepMonth(1));
  }

  private renderGrid(): void {
    this.gridEl.empty();

    const weekdayRowEl = this.gridEl.createDiv({ cls: "journal-calendar-weekdays" });
    for (const label of WEEKDAY_HEADER) {
      weekdayRowEl.createDiv({ cls: "journal-calendar-weekday", text: label });
    }

    const year = this.displayedMonth.getFullYear();
    const month = this.displayedMonth.getMonth();
    const cells = buildMonthGrid(year, month);
    // `getEntries()` returns the live index; reading it fresh on every
    // render (rather than caching it) means an in-flight vault change is
    // always reflected without a separate cache-invalidation path.
    const entryDays = entryDaysInMonth(this.plugin.journal.getEntries(), year, month);
    const todayKey = dayKey(new Date());

    const daysEl = this.gridEl.createDiv({ cls: "journal-calendar-days" });

    for (const cell of cells) {
      if (cell === null) {
        daysEl.createDiv({ cls: "journal-calendar-day journal-calendar-day-blank" });
        continue;
      }

      const key = dayKey(cell);
      const hasEntries = entryDays.has(key);
      const isToday = key === todayKey;

      // A real <button>, not a div+click: it needs no extra wiring to be
      // reachable by keyboard and to activate on Enter/Space, and `disabled`
      // below both blocks the click and removes it from the tab order for
      // free — the same reasoning as `.journal-entry-time` in JournalView's
      // `createEntryEl`. The dot marks which days hold something; landing on
      // a dotless day two months into the past (see goToDateInJournal) broke
      // that affordance, so a day with no entries is disabled rather than
      // merely styled as empty. `type="button"` only to keep it inert if
      // this element ever ends up inside a <form>.
      const dayEl = daysEl.createEl("button", {
        cls: "journal-calendar-day",
        attr: { type: "button" },
      });
      if (isToday) dayEl.addClass("is-today");
      if (!hasEntries) {
        dayEl.addClass("is-empty");
        dayEl.disabled = true;
      }

      // `aria-current="date"` marks today's position in the grid the same
      // way a real date picker would, independent of `disabled` — it is
      // orientation information ("this is today"), not a statement about
      // clickability, so it applies even when today has no entries yet.
      if (isToday) dayEl.setAttribute("aria-current", "date");

      // A bare day number reads to a screen reader as just "12, button" —
      // no month, no year, no sense of what activating it does. Both enabled
      // and disabled cells are labelled: the tab order skips the disabled
      // ones, but VoiceOver and NVDA still read them in browse and rotor
      // mode, where "19, button, unavailable" is just as uninformative.
      //
      // Neither label claims an entry count: `entryDaysInMonth` returns a Set
      // of day keys and knows only that a day has *something*, not how many.
      //
      // Set directly via `aria-label` rather than `setTooltip` (contrast the
      // `.journal-entry-time` pattern in JournalView): that button's tooltip
      // is itself a useful discoverability hint for a single control, but a
      // hover tooltip firing on every one of up to 31 grid buttons would be
      // exactly the "visible chrome" this fix is meant to avoid adding.
      const fullDate = cell.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      dayEl.setAttribute(
        "aria-label",
        hasEntries ? `${fullDate}, has entries. Open in journal.` : `${fullDate}, no entries.`,
      );

      dayEl.createDiv({ cls: "journal-calendar-day-number", text: String(cell.getDate()) });
      // Always present, not conditionally created — an entryless day's dot
      // is hidden via CSS (`visibility: hidden`, not `display: none`) so it
      // still reserves its layout space. Without that, rows mixing days
      // with and without entries would vertically misalign the day numbers
      // against each other.
      const dotEl = dayEl.createDiv({ cls: "journal-calendar-day-dot" });
      if (!hasEntries) dotEl.addClass("journal-calendar-day-dot-hidden");

      dayEl.addEventListener("click", () => {
        void this.plugin.goToDateInJournal(cell);
      });
    }
  }

  private stepMonth(delta: number): void {
    this.displayedMonth = new Date(
      this.displayedMonth.getFullYear(),
      this.displayedMonth.getMonth() + delta,
      1,
    );
    this.render();
  }
}
