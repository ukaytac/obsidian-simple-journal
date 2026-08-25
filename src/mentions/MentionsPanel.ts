import { Component, debounce, MarkdownRenderer, setTooltip, type TFile } from "obsidian";
import type JournalEntriesPlugin from "../main";
import type { JournalEntry } from "../journal/entry";
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
  const resolveRef = plugin.app.metadataCache.on("resolve", () => scheduleRefresh());

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
      await MarkdownRenderer.render(plugin.app, bodies[i], bodyEl, entry.file.path, owner);
      if (destroyed || token !== renderToken) return;
    }

    const remaining = mentions.length - shown.length;
    if (remaining > 0) {
      const moreEl = container.createEl("button", {
        cls: "journal-mentions-more",
        text: `Show ${Math.min(remaining, PAGE_COUNT)} more`,
        attr: { type: "button" },
      });
      moreEl.addEventListener("click", () => {
        visibleCount += PAGE_COUNT;
        void render();
      });
    }
  }

  /**
   * Goes through `EntryRepository.readBody` rather than reading the file
   * directly, so frontmatter stripping stays in the one module that owns it.
   * A read failure renders as nothing rather than aborting the whole panel:
   * one unreadable entry must not hide the others.
   */
  async function readBody(entry: JournalEntry): Promise<string> {
    try {
      return await plugin.repository.readBody(entry.file);
    } catch (error) {
      console.error("Simple Journal: could not read an entry for the mentions panel", error);
      return "";
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
