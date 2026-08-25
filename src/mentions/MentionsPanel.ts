import { Component, debounce, MarkdownRenderer, setTooltip, type TFile } from "obsidian";
import type JournalEntriesPlugin from "../main";
import type { JournalEntry } from "../journal/entry";
import { normalizeBodyForRender } from "../journal/markdownDoc";
import { dayKey, formatDayHeader, formatTime } from "../utils/dates";
import { findMentions } from "./mentionQuery";

/**
 * The ONE renderer behind all three mention surfaces (the `simple-journal`
 * code block, the automatic note footer, the sidebar view). Those three are
 * shells: they obtain a container and a target file and delegate here. A
 * change to how mentions look or behave is a change to this file.
 *
 * READ-ONLY, on purpose. Entry content goes through `MarkdownRenderer`, so
 * wikilinks, embeds, inline tags and formatting all behave as they do
 * anywhere else, but nothing here writes. Editing is what the timeline is
 * for, and mounting N live embedded editors inside an arbitrary note would
 * put this plugin's most data-critical code (mount cap, debounced saves,
 * self-write suppression, save tokens) behind a code-block lifecycle nobody
 * controls. Clicking a timestamp hands the user back to the timeline instead,
 * through the same `goToDateInJournal` the calendar uses.
 */

/** Entries rendered before the user asks for more. */
const INITIAL_COUNT = 5;
/** Added per "Show more" click. */
const PAGE_COUNT = 20;
/**
 * `metadataCache`'s `resolve` fires repeatedly while a note is being typed
 * in, so coalescing is not optional here.
 */
const REFRESH_DEBOUNCE_MS = 200;

/**
 * `ok: false` rather than `""`: an empty body and an unreadable one look
 * identical downstream otherwise, and only one of them should show a failure
 * line.
 */
type BodyRead = { ok: true; text: string } | { ok: false };

export interface MentionsPanelOptions {
  plugin: JournalEntriesPlugin;
  /** Emptied and owned by the panel until `destroy()`. */
  container: HTMLElement;
  target: TFile;
  /**
   * Rendered when nothing mentions the target. Omit to render nothing at all
   * — which is what the automatic footer wants (the user did not ask for
   * anything there, so an empty panel is pure noise) and what the code block
   * does not (the user put the block there deliberately, so silence would
   * read as a bug).
   */
  emptyText?: string;
}

export interface MentionsPanel {
  render(): Promise<void>;
  destroy(): void;
}

export function createMentionsPanel(options: MentionsPanelOptions): MentionsPanel {
  const { plugin, container, target, emptyText } = options;

  let visibleCount = INITIAL_COUNT;
  let destroyed = false;
  /**
   * Guards against an older `render()` finishing its awaits after a newer one
   * already painted — same shape as `entrySave`'s save tokens. Checked after
   * every await, not only the first: each `MarkdownRenderer.render` below is
   * another point at which a newer render can take over the container, and a
   * loser that kept going would append a second "Show more" button to it.
   */
  let renderToken = 0;
  /** Owns the current render's `MarkdownRenderer` children, so they unload. */
  let contentOwner: Component | null = null;

  const scheduleRefresh = debounce(
    () => {
      void render();
    },
    REFRESH_DEBOUNCE_MS,
    false,
  );

  const unsubscribeJournal = plugin.journal.onChange(() => scheduleRefresh());
  /**
   * Filtered to journal entries, unlike `CalendarView`'s equivalent
   * subscription. `resolve` fires for EVERY file the vault re-resolves —
   * including the note this panel is sitting in, on every keystroke — and
   * the debounce above fires on a trailing edge every 200 ms of a sustained
   * burst, not once at the end of it. The calendar can afford to skip the
   * check because its reaction is two binary searches; this one is a read
   * plus a full `MarkdownRenderer` pass per visible entry, so typing in the
   * host note would rebuild the whole panel five times a second.
   */
  const resolveRef = plugin.app.metadataCache.on("resolve", (file) => {
    if (!plugin.repository.isEntryFile(file)) return;
    scheduleRefresh();
  });

  async function render(): Promise<void> {
    if (destroyed) return;
    const token = ++renderToken;

    const mentions = findMentions(
      plugin.journal.getEntries(),
      target,
      plugin.app.metadataCache.resolvedLinks,
    );
    const shown = mentions.slice(0, visibleCount);

    // Read every visible body BEFORE touching the DOM, so a slow read can
    // never leave a half-built panel on screen.
    const bodies = await Promise.all(shown.map((entry) => readBody(entry)));
    if (destroyed || token !== renderToken) return;

    contentOwner?.unload();
    const owner = new Component();
    contentOwner = owner;
    owner.load();

    container.empty();
    // Claimed before it is known whether there is anything to show, and
    // deliberately never given back on the empty path — `.journal-mentions:empty`
    // in styles.css hides a childless panel, and it also covers the case a
    // later `addClass` could not: a re-render going from "has mentions" to
    // "none", where the class is already on the element from the previous
    // pass.
    container.addClass("journal-mentions");

    if (mentions.length === 0) {
      if (emptyText) container.createDiv({ cls: "journal-mentions-empty", text: emptyText });
      return;
    }

    const headerEl = container.createDiv({ cls: "journal-mentions-header" });
    headerEl.createSpan({ cls: "journal-mentions-title", text: "Journal mentions" });
    headerEl.createSpan({ cls: "journal-mentions-count", text: String(mentions.length) });

    const listEl = container.createDiv({ cls: "journal-mentions-list" });

    let currentDay = "";
    let dayEntriesEl: HTMLElement | null = null;

    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i];
      const key = dayKey(entry.created);

      if (key !== currentDay || dayEntriesEl === null) {
        currentDay = key;
        const dayEl = listEl.createDiv({ cls: "journal-mentions-day" });
        // The timeline's own day-header class, not a `journal-mentions-*` one:
        // a day header means the same thing in both surfaces and must look
        // identical, so a theme (or a later change here) restyling one cannot
        // leave the other behind.
        dayEl.createDiv({ cls: "journal-day-header", text: formatDayHeader(entry.created) });
        dayEntriesEl = dayEl.createDiv({ cls: "journal-mentions-day-entries" });
      }

      const entryEl = dayEntriesEl.createDiv({ cls: "journal-mentions-entry" });

      // A real <button>, not a div+click: keyboard reachable and Enter/Space
      // activated with no extra wiring, exactly as `.journal-entry-time` and
      // the calendar's day cells are. `type="button"` keeps it inert should
      // it ever land inside a <form>.
      const timeEl = entryEl.createEl("button", {
        cls: "journal-mentions-time",
        text: formatTime(entry.created),
        attr: { type: "button" },
      });
      setTooltip(timeEl, "Open in journal");
      timeEl.addEventListener("click", () => {
        void plugin.goToDateInJournal(entry.created);
      });

      const bodyEl = entryEl.createDiv({ cls: "journal-mentions-body" });
      const body = bodies[i];

      if (!body.ok) {
        showFailure(bodyEl, "could not be read");
        continue;
      }

      try {
        await MarkdownRenderer.render(
          plugin.app,
          normalizeBodyForRender(body.text),
          bodyEl,
          entry.file.path,
          owner,
        );
        if (destroyed || token !== renderToken) return;
      } catch (error) {
        // A post-processor from any other plugin can throw in here. Left
        // unguarded, that abandons the panel half-built — no "Show more", no
        // way back — and escapes the `void render()` call sites as an
        // unhandled rejection. Same rule the read failure above follows: one
        // bad entry must not hide the others.
        console.error("Simple Journal: could not render an entry in the mentions panel", error);
        if (destroyed || token !== renderToken) return;
        bodyEl.empty();
        showFailure(bodyEl, "could not be rendered");
      }
    }

    const remaining = mentions.length - shown.length;
    if (remaining > 0) {
      const moreEl = container.createEl("button", {
        cls: "journal-mentions-more",
        text: `Show ${Math.min(remaining, PAGE_COUNT)} more`,
        attr: { type: "button" },
      });
      // Re-renders from scratch rather than appending the new page, so every
      // already-visible body is read and rendered again — quadratic in the
      // number of clicks. Kept because incremental appending would have to
      // reproduce the day-grouping state (`currentDay`/`dayEntriesEl`) across
      // calls, and the growth is bounded by explicit user clicks on a
      // read-only surface. Revisit only if the day grouping is extracted into
      // something that can be resumed, or if a page ever arrives without a
      // click behind it.
      moreEl.addEventListener("click", () => {
        visibleCount += PAGE_COUNT;
        void render();
      });
    }
  }

  /**
   * Fails visibly, in the DOM, rather than only in the console — the same
   * bar `entrySave.ts`'s `.journal-entry-error` marker sets for a failed
   * write, and the reason a failed read must not silently render as an empty
   * body: that is indistinguishable from an entry the user genuinely left
   * empty.
   */
  function showFailure(bodyEl: HTMLElement, what: string): void {
    bodyEl.createDiv({
      cls: "journal-mentions-error",
      text: `This entry ${what}.`,
      attr: { role: "status" },
    });
  }

  /**
   * Goes through the repository rather than reading the file directly, so
   * frontmatter stripping stays in the one module that owns it. `readBodyCached`,
   * not `readBody`: this surface never writes, so a disk round trip per
   * visible entry per refresh buys nothing.
   *
   * A read failure is reported, not thrown: one unreadable entry must not
   * hide the others.
   */
  async function readBody(entry: JournalEntry): Promise<BodyRead> {
    try {
      return { ok: true, text: await plugin.repository.readBodyCached(entry.file) };
    } catch (error) {
      console.error("Simple Journal: could not read an entry for the mentions panel", error);
      return { ok: false };
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    scheduleRefresh.cancel();
    unsubscribeJournal();
    plugin.app.metadataCache.offref(resolveRef);
    contentOwner?.unload();
    contentOwner = null;
    container.empty();
    container.removeClass("journal-mentions");
  }

  return { render, destroy };
}
