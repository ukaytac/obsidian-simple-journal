import { MarkdownView, type MarkdownViewModeType } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Shell C: the automatic footer under an ordinary note.
 *
 * ## The SECOND file in this plugin that touches Obsidian internals
 *
 * The first is `views/ObsidianEmbedEditor.ts`, and CLAUDE.md § Editing says
 * in terms that its exception "does NOT license internal API usage anywhere
 * else in the codebase". So this is not that licence being spent — it is a
 * separate exception, granted on its own merits, and it carries the same two
 * rules that make the first one safe.
 *
 * Why it is needed at all: Obsidian exposes no public API for appending
 * content to the end of a note's *content flow* — the part that scrolls with
 * the note's text. The public `view.contentEl` is the whole pane, so a panel
 * appended there is pinned to the bottom of the window while the note scrolls
 * underneath it. That is a different feature (a docked strip), and not the
 * one asked for. The only way to sit after the last paragraph, scrolling with
 * it, is Obsidian's own layout element: `.markdown-preview-sizer` in reading
 * view, `.cm-sizer` in source mode (which covers live preview and raw source
 * alike — both are CodeMirror).
 *
 * ### How narrow the exception is
 *
 * *Which* of the two to look for is decided by `MarkdownView.getMode()`, which
 * is public, documented API. Only the two class names are internal. That is
 * not merely tidier: a `MarkdownView`'s `containerEl` can hold both
 * `.markdown-source-view` and `.markdown-reading-view` at once, the inactive
 * one hidden rather than removed, so one comma-separated selector would return
 * whichever came first in document order — and in reading view that mounts the
 * footer into a pane the user cannot see. Public API decides; document order
 * does not.
 *
 * ### Rule 1 — feature detection, with a SILENT no-op fallback
 *
 * `findContentFlowEl` is allowed to return null and every caller treats that
 * as "this note gets no footer". No throw, no `Notice`, no console line. If a
 * future Obsidian renames or restructures those elements, this surface simply
 * stops appearing; no note is altered, nothing is written, and no journal
 * data is at risk.
 *
 * Deliberately quieter than the editor exception, which does show a one-time
 * notice when it falls back. That one guards the plugin's core writing
 * surface, where silence would leave the user wondering why editing feels
 * wrong. This one is an optional, off-by-default, read-only convenience: its
 * absence degrades nothing anybody depends on, and a startup notice about a
 * feature the user may never have enabled would be pure noise.
 *
 * ### Rule 2 — every DOM assumption lives in this file
 *
 * The two class names appear in exactly ONE `querySelector` call in the whole
 * codebase, in `findContentFlowEl` below — and, the mode having moved to
 * public API, they are all that is left of the assumption. Retreating from
 * this surface, or moving to a future public API, is therefore a one-file
 * change — and `tests/mentionsFooter.test.ts` pins the no-op behaviour so the
 * retreat cannot be discovered by a user instead of by the test suite.
 *
 * ### What this does NOT assume
 *
 * Nothing about the sizer's internals, its children, or its styling. The
 * footer is one plain div appended as a last child; it never reorders,
 * reads, or removes anything Obsidian put there. In live preview it is a
 * sibling of `.cm-content`, never inside it, so it is not part of the
 * editable document and cannot reach the user's text.
 *
 * The one thing it does assume is that Obsidian will not silently discard a
 * foreign child of the sizer. That is why `sync()` re-checks the container's
 * parent every time rather than trusting its own bookkeeping (see below): a
 * footer that was removed or orphaned is simply mounted again.
 */

/**
 * The single point of contact with Obsidian's layout DOM in this plugin.
 *
 * Exported only so `tests/mentionsFooter.test.ts` can pin the null case —
 * production code reaches it through `sync()`.
 */
export function findContentFlowEl(
  containerEl: HTMLElement,
  mode: MarkdownViewModeType,
): HTMLElement | null {
  return containerEl.querySelector<HTMLElement>(
    mode === "preview" ? ".markdown-preview-sizer" : ".cm-sizer",
  );
}

/** The footer's own container class; `MentionsPanel` adds `.journal-mentions` to it. */
const FOOTER_CLASS = "journal-mentions-footer";

interface MountedFooter {
  /** Guards against a rebuild when the view is still showing the same note. */
  path: string;
  container: HTMLElement;
  panel: MentionsPanel;
}

export interface MentionsFooter {
  sync(): void;
  destroy(): void;
}

export function createMentionsFooter(plugin: JournalEntriesPlugin): MentionsFooter {
  /**
   * Keyed by view rather than by leaf or by path: the view is what owns the
   * DOM this plugin wrote into, and it is the thing whose disappearance has
   * to be noticed. A `Map`, not a `WeakMap`, because the sweep at the end of
   * `sync()` has to be able to enumerate what is still mounted — and the
   * entries are removed there anyway, so nothing is retained past its view.
   */
  const mounted = new Map<MarkdownView, MountedFooter>();

  function sync(): void {
    if (!plugin.settings.showMentionsUnderNotes) {
      unmountAll();
      return;
    }

    const seen = new Set<MarkdownView>();

    for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      // Since Obsidian 1.7.2 an unloaded background tab's view is *deferred*
      // and is not a `MarkdownView` at all. That is the practical meaning of
      // "visible views only" here: Obsidian exposes no public visibility
      // predicate, and this check keeps the footer off panes that have no
      // rendered content flow to mount into in the first place. A leaf that
      // later loads for real fires `layout-change`, which brings us back.
      if (!(view instanceof MarkdownView)) continue;
      seen.add(view);

      const file = view.file;
      // A journal entry's own timeline already shows this, and rendering
      // entries inside an entry invites exactly the recursion
      // `mentionsCodeBlock.ts` guards against.
      if (!file || plugin.repository.isEntryFile(file)) {
        unmount(view);
        continue;
      }

      const flowEl = findContentFlowEl(view.containerEl, view.getMode());
      const existing = mounted.get(view);

      // The parent check is not redundant with the path check. Switching
      // between reading view and live preview moves the note's content flow
      // to the other mode's sizer while the file stays put, so a path-only
      // guard would short-circuit and leave the note's visible pane with no
      // footer until it was closed and reopened.
      if (existing && existing.path === file.path && existing.container.parentElement === flowEl) {
        continue;
      }

      unmount(view);
      // Rule 1: no element, no footer, no complaint.
      if (!flowEl) continue;

      const container = flowEl.createDiv({ cls: FOOTER_CLASS });
      // No `emptyText`: the user did not ask for anything here, so a note
      // with no mentions must render nothing at all. The panel still mounts,
      // so a mention added later appears without waiting for a relayout, and
      // `.journal-mentions:empty` collapses the container meanwhile.
      const panel = createMentionsPanel({ plugin, container, target: file });
      mounted.set(view, { path: file.path, container, panel });
      void panel.render();
    }

    // Whatever is left is a view that has gone away since the last sync — a
    // closed tab, a detached leaf. Its DOM is beyond reach by now, but its
    // panel still holds vault subscriptions, and those are this plugin's to
    // release.
    for (const view of [...mounted.keys()]) {
      if (!seen.has(view)) unmount(view);
    }
  }

  function unmount(view: MarkdownView): void {
    const footer = mounted.get(view);
    if (!footer) return;
    mounted.delete(view);
    // `destroy()` empties the container and drops the panel's subscriptions;
    // removing the container itself is this shell's job, because this shell
    // is what put it in somebody else's view.
    footer.panel.destroy();
    footer.container.remove();
  }

  function unmountAll(): void {
    for (const view of [...mounted.keys()]) unmount(view);
  }

  // `destroy` is literally `unmountAll`, and deliberately leaves nothing
  // latched: there is no state to tear down beyond the footers themselves,
  // and a `destroyed` flag would only add a second way for a caller holding a
  // stale reference to be surprised. `main.ts` drops its reference instead,
  // which is the honest way to make it terminal.
  return { sync, destroy: unmountAll };
}
