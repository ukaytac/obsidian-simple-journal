/**
 * The timeline's DOM layer: day-group and month-header bookkeeping, plus the
 * two insertion paths (`appendEntry` for paging, `insertEntryInPlace` for a
 * vault-event-driven insert) that both funnel through it — factored out of
 * `JournalView` so it can be exercised directly against a fabricated
 * `timelineEl`, without a full `JournalView`/`IntersectionObserver` stack.
 * Same dependency-injection shape as `mountLifecycle.ts`/`entrySave.ts`/
 * `mountWindow.ts`/`applyChange.ts`.
 *
 * This module owns `dayGroups` and `lastRenderedMonth` outright — both were
 * plain `JournalView` fields before this split, closed over here the same
 * way `mountLifecycle.ts`'s `order`/`max` are closed over by
 * `createMountLifecycle`, so every function below reads as "the day groups
 * and month tracking," not "...and here they are again as parameters."
 * `dayGroups` is still exposed on the returned object (see `TimelineDom`)
 * purely so `JournalView` can keep forwarding to it for existing test
 * reflection (`internals(view).dayGroups`) — nothing in this module reads
 * that exposure back.
 *
 * `timelineEl` itself is NOT owned here: `JournalView.onOpen` replaces it
 * wholesale on every open (a fresh `contentEl.createDiv(...)`), so a
 * reference captured once at construction would go stale the moment that
 * happens again over the view's life. `deps.getTimelineEl()` reads it fresh
 * on every call instead.
 *
 * `rendered` (the `RenderedEntry` map), `index` (the shared chronological
 * array `insertEntryInPlace` locates entries in by reference identity —
 * see its own doc), `anchorDate`, `sentinelEl`, `mountObserver`, and
 * `renderStatic` all belong to seams this module does not own (storage,
 * paging/anchor state, the mount observer, static rendering) — each reached
 * through a narrow `TimelineDomDeps` accessor rather than a raw shared
 * reference, mirroring `MountDeps` in `mountLifecycle.ts`.
 */
import type { JournalEntry } from "../journal/entry";
import { anchorPosition, compareEntries } from "../services/entryIndex";
import { compareDayKeys, dayKey, formatDayHeader, formatMonthHeader } from "../utils/dates";

/**
 * The structural slice of `JournalView.RenderedEntry` this module actually
 * reads/writes — same narrowing purpose as `mountLifecycle.ts`'s
 * `MountEntry`. `JournalView.RenderedEntry` satisfies this without any
 * changes.
 */
export interface DomRenderedEntry {
  entry: JournalEntry;
  el: HTMLElement;
}

/**
 * What this module needs injected to reach the rest of `JournalView` — the
 * timeline element itself (re-read on every call; see this file's doc), the
 * `rendered` map's narrow read/write surface, entry construction, static
 * rendering, mount observation, and the paging/anchor state
 * `insertEntryInPlace`'s bounds check consults.
 */
export interface TimelineDomDeps {
  /** `this.timelineEl` — re-read fresh every call; never cached (see doc). */
  getTimelineEl(): HTMLElement;
  /** `this.rendered.has(path)`. */
  hasRendered(path: string): boolean;
  /** `this.rendered.get(path)`. */
  getRendered(path: string): DomRenderedEntry | undefined;
  /** `this.rendered.set(path, rendered)`. */
  setRendered(path: string, rendered: DomRenderedEntry): void;
  /** `this.rendered.size`. */
  renderedCount(): number;
  /** `this.createEntryEl` — DOM/wiring for one entry row, not part of this seam. */
  createEntryEl(entry: JournalEntry): DomRenderedEntry;
  /** `this.renderStatic` — the read-only render fallback, not part of this seam. */
  renderStatic(rendered: DomRenderedEntry): Promise<void>;
  /** `this.mountObserver?.observe(el)`. */
  observeForMount(el: HTMLElement): void;
  /** `this.index` — the shared chronological array; not owned by this seam. */
  getIndex(): readonly JournalEntry[];
  /** `this.anchorDate`. */
  getAnchorDate(): Date | null;
  /** `this.sentinelEl !== null`. */
  hasSentinel(): boolean;
}

/** The bound DOM-layer pipeline `createTimelineDom` returns. */
export interface TimelineDom {
  ensureDayGroup(date: Date, position: "append" | "prepend"): HTMLElement;
  rebuildMonthHeaders(): void;
  removeEmptyDayGroups(): void;
  insertEntryInPlace(entry: JournalEntry): void;
  appendEntry(entry: JournalEntry): void;
  renderEmptyState(anchored?: boolean): void;
  /** Clears `dayGroups`/`lastRenderedMonth`. Called by `clearTimeline`. */
  reset(): void;
  /**
   * Day-group `.journal-day-entries` containers, keyed by `dayKey`, so
   * lookup is O(1). Exposed only so `JournalView` can forward
   * `internals(view).dayGroups` for existing test reflection; nothing in
   * this module reads that exposure back.
   */
  readonly dayGroups: Map<string, HTMLElement>;
}

export function createTimelineDom(deps: TimelineDomDeps): TimelineDom {
  /** Day-group `.journal-day-entries` containers, keyed by `dayKey`. */
  const dayGroups = new Map<string, HTMLElement>();
  let lastRenderedMonth: string | null = null;

  /**
   * Returns the day group for this date, creating it — and its month header
   * when the month changes — if it does not exist yet. Looked up in the
   * `dayGroups` map rather than via `querySelector`, which would otherwise
   * re-scan an ever-growing subtree on every call.
   */
  function ensureDayGroup(date: Date, position: "append" | "prepend"): HTMLElement {
    const key = dayKey(date);
    const existing = dayGroups.get(key);
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
    dayGroups.set(key, entriesEl);

    if (position === "append") {
      if (monthKey !== lastRenderedMonth) {
        deps.getTimelineEl().createDiv({
          cls: "journal-month-header",
          text: formatMonthHeader(date),
        });
        lastRenderedMonth = monthKey;
      }
      deps.getTimelineEl().appendChild(dayEl);
    } else {
      // "prepend" is used only by `insertEntryInPlace`, for a single
      // vault-event-driven day that can land anywhere in already-loaded
      // history — unlike the "append" branch's paging order (see its own
      // doc), there is no guarantee this new day is the newest one loaded.
      // Search the already-rendered days (kept in reverse-chronological DOM
      // order as an invariant) for the first one older than this one, and
      // insert right before it; falling back to the end when none is
      // older keeps a genuinely-newest day's placement (this module's
      // previous, simpler behaviour) intact.
      const days = Array.from(deps.getTimelineEl().querySelectorAll<HTMLElement>(".journal-day"));
      const olderDay = days.find((el) => {
        const otherKey = el.dataset.day;
        return otherKey !== undefined && compareDayKeys(key, otherKey) < 0;
      });

      if (olderDay) deps.getTimelineEl().insertBefore(dayEl, olderDay);
      else deps.getTimelineEl().appendChild(dayEl);

      // Inserting a day anywhere but strictly at the end can change which
      // day is topmost per month; rebuild month headers.
      rebuildMonthHeaders();
    }

    return entriesEl;
  }

  /**
   * Month headers depend on their neighbours, so after any insertion that is
   * not a plain append they are recomputed from the day groups in the DOM.
   */
  function rebuildMonthHeaders(): void {
    for (const el of Array.from(deps.getTimelineEl().querySelectorAll(".journal-month-header"))) {
      el.remove();
    }

    let previousMonth: string | null = null;

    for (const dayEl of Array.from(deps.getTimelineEl().querySelectorAll<HTMLElement>(".journal-day"))) {
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

    lastRenderedMonth = previousMonth;
  }

  /**
   * Removes day groups that no longer hold an entry.
   *
   * The `dayGroups` map must lose the key in the same pass. Leaving it
   * behind means `ensureDayGroup` later hands back a detached container, and
   * every entry written on that day renders into nothing — visible as an
   * entry that silently fails to appear.
   */
  function removeEmptyDayGroups(): void {
    for (const dayEl of Array.from(deps.getTimelineEl().querySelectorAll<HTMLElement>(".journal-day"))) {
      if (dayEl.querySelector(".journal-entry")) continue;

      const key = dayEl.dataset.day;
      if (key) dayGroups.delete(key);
      dayEl.remove();
    }

    rebuildMonthHeaders();
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
  function appendEntry(entry: JournalEntry): void {
    if (deps.hasRendered(entry.file.path)) return;

    const group = ensureDayGroup(entry.created, "append");
    const rendered = deps.createEntryEl(entry);
    group.appendChild(rendered.el);
    deps.setRendered(entry.file.path, rendered);
    void deps.renderStatic(rendered);
    deps.observeForMount(rendered.el);
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
   * The in-range check is `position - offset >= loadedCount`, not `>`: with
   * `loadedCount` entries loaded starting at `offset` (indices
   * `offset..offset+loadedCount-1`), `offset+loadedCount` itself is the
   * first index NOT yet loaded — `pageAfter`'s next page starts there. `>`
   * would let that boundary entry (and only that one) through: this method
   * would insert it AND `appendEntry` would later insert it again as part of
   * the next page, each holding its own `RenderedEntry`/DOM node/editor for
   * the same path — one leaked indefinitely, since only the map's most
   * recent entry for that path is ever reachable to tear down.
   *
   * `offset` — `anchorPosition(index, anchorDate)` when an anchor is active,
   * `0` otherwise — is where the loaded window actually starts. Without it,
   * an anchored timeline's loaded window no longer begins at index 0, so
   * comparing a raw `position` against `loadedCount` alone would misjudge
   * entries near either edge: one just past the anchor boundary but still
   * within the loaded page would wrongly be treated as "not yet loaded" and
   * dropped until the next scroll, while one far below the loaded window
   * could wrongly be treated as "in range" and inserted twice once paging
   * actually reached it. Recomputed fresh on every call rather than cached
   * at anchor time, so it never drifts stale as entries newer than the
   * anchor are created or removed elsewhere in the same session.
   *
   * A position strictly before `offset` is newer than the anchor and must
   * never render at all, regardless of the loaded window — checked first,
   * unconditionally (not gated on `deps.hasSentinel()` like the in-range
   * check below), since exclusion here is permanent, not a paging state.
   */
  function insertEntryInPlace(entry: JournalEntry): void {
    if (deps.hasRendered(entry.file.path)) return;

    const position = deps.getIndex().indexOf(entry);
    if (position < 0) return;

    // Captured into a local, not passed inline below: `getAnchorDate()` is a
    // function call, not a plain property read, so TypeScript cannot narrow
    // a second call's `Date | null` the way it narrowed `this.anchorDate`
    // (a property) in the pre-split version — `anchorPosition` needs a
    // non-null `Date`.
    const anchorDate = deps.getAnchorDate();
    const offset = anchorDate ? anchorPosition(deps.getIndex(), anchorDate) : 0;
    if (position < offset) return;

    const loadedCount = deps.renderedCount();
    if (position - offset >= loadedCount && deps.hasSentinel()) return;

    // The empty-state message (`renderEmptyState`) is only ever present when
    // nothing is rendered yet, so this is a cheap no-op on every insert past
    // the first. Removed here rather than left for the next full reload:
    // this is the ONLY path that inserts into a timeline that was rendered
    // empty (a genuine full reload already clears everything, including this
    // element, via `clearTimeline`).
    deps.getTimelineEl().querySelector(".journal-empty")?.remove();

    const group = ensureDayGroup(entry.created, "prepend");
    const rendered = deps.createEntryEl(entry);

    // Find the first already-rendered sibling that is older than this entry.
    const siblings = Array.from(group.querySelectorAll<HTMLElement>(".journal-entry"));
    const olderSibling = siblings.find((el) => {
      const siblingEntry = deps.getRendered(el.dataset.path ?? "");
      return siblingEntry ? compareEntries(entry, siblingEntry.entry) < 0 : false;
    });

    if (olderSibling) group.insertBefore(rendered.el, olderSibling);
    else group.appendChild(rendered.el);

    deps.setRendered(entry.file.path, rendered);
    void deps.renderStatic(rendered);
    deps.observeForMount(rendered.el);
  }

  /**
   * `anchored` distinguishes a genuinely empty journal from an anchored
   * (`goToDate`) view that excludes every entry because the anchor is older
   * than everything in it — the index isn't empty in that case, so "no
   * journal entries yet" would be misleading.
   */
  function renderEmptyState(anchored = false): void {
    deps.getTimelineEl().createDiv({
      cls: "journal-empty",
      text: anchored
        ? "Nothing on or before this date."
        : "No journal entries yet. Use the + button above to write the first one.",
    });
  }

  function reset(): void {
    dayGroups.clear();
    lastRenderedMonth = null;
  }

  return {
    ensureDayGroup,
    rebuildMonthHeaders,
    removeEmptyDayGroups,
    insertEntryInPlace,
    appendEntry,
    renderEmptyState,
    reset,
    dayGroups,
  };
}
