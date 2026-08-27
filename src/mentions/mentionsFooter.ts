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
 * A null has two causes, though, and `watch()` below separates them: the
 * element may be gone for good, or it may merely not have been built yet —
 * switching a pane into reading view fires the workspace event *before*
 * Obsidian builds the pane. Watching for it settles which one it was without
 * touching the promise above: a watcher that never fires is indistinguishable
 * from no watcher at all.
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

  /**
   * Views whose content flow has not been built yet, each with the observer
   * waiting for it. Keyed the same way as `mounted`, and disjoint from it:
   * mounting disconnects, so no view is ever in both.
   */
  const watching = new Map<MarkdownView, MutationObserver>();

  /**
   * Waits for a view's content flow to appear, rather than guessing when.
   *
   * Switching a pane into reading view fires `layout-change` *before*
   * Obsidian has built `.markdown-preview-sizer`, so the `sync()` that event
   * drives looks for an element that does not exist yet and — correctly, per
   * rule 1 — mounts nothing. Nothing then re-triggered, so the note kept no
   * footer until some unrelated workspace event happened to fire: the first
   * switch into reading view showed no panel, a later visit did. Reported
   * from a real vault; the suite could not have found it, because a test
   * builds the sizer before it calls `sync()`.
   *
   * The alternative, and the reason it was rejected: a timed retry — a
   * `setTimeout`, one or two animation frames, a short poll. Each is a guess
   * at Obsidian's own render timing, and a guess of exactly that shape has
   * already cost this codebase days (the focus race in
   * `docs/manual-testing.md`, and the still-unverified mobile timings in
   * CLAUDE.md § Target Platforms). A guess is also unfalsifiable here: too
   * short and the bug survives on a slow vault, too long and the panel
   * visibly pops in. Watching has no timing to be wrong about. It fires when
   * the element exists, whenever that is, and terminates itself then.
   *
   * And it does not weaken rule 1. If the element never appears — because a
   * future Obsidian renamed it — the observer simply never fires: still no
   * throw, no notice, no console line, nothing written. Watching can turn
   * "not built yet" into "built"; it cannot turn "absent" into anything.
   */
  function watch(view: MarkdownView): void {
    if (watching.has(view)) return;
    // Built from the view's own window so this still works for a leaf dragged
    // into an Obsidian popout, which is a separate browsing context — the
    // same reason `JournalView` builds its IntersectionObservers from
    // `el.win`. In the main window `win === window`, so this is
    // behaviour-identical there. `Window` is not typed with constructor
    // globals, hence the cast naming the one being reached for.
    const win = view.containerEl.win as Window & { MutationObserver: typeof MutationObserver };
    const observer = new win.MutationObserver(() => {
      // One `querySelector` per batch of Obsidian's render mutations, and
      // nothing at all until the element is really there. Disconnecting is
      // deliberately left to `sync()`, which re-decides the whole question
      // anyway and may conclude this view should still be waiting (the mode
      // moved again, the note is now a journal entry) — a callback that
      // disconnected first would have to re-derive all of that itself.
      if (!findContentFlowEl(view.containerEl, view.getMode())) return;
      sync();
    });
    observer.observe(view.containerEl, { childList: true, subtree: true });
    watching.set(view, observer);
  }

  function unwatch(view: MarkdownView): void {
    watching.get(view)?.disconnect();
    watching.delete(view);
  }

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
        // Nothing to wait for: this view must never have a footer, whatever
        // it builds next.
        unwatch(view);
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
      // Rule 1: no element, no footer, no complaint — and a watch, in case
      // the element is one Obsidian has not finished building rather than one
      // that is gone.
      if (!flowEl) {
        watch(view);
        continue;
      }

      // Before the mount, not after: the footer's own writes land inside the
      // subtree being observed, and a watcher still connected here would wake
      // on them.
      unwatch(view);
      const container = flowEl.createDiv({ cls: FOOTER_CLASS });
      // No `emptyText`: the user did not ask for anything here, so a note
      // with no mentions must render nothing at all. The panel still mounts,
      // so a mention added later appears without waiting for a relayout, and
      // `.journal-mentions:empty` collapses the container meanwhile.
      //
      // `collapsible`, and this is the only shell that asks: this is the
      // panel that arrives unasked under someone's note, so it is the one
      // that has to offer a way out from under it. The state it toggles is
      // one vault-wide boolean read live by every panel, so a footer mounted
      // here after a collapse elsewhere comes up collapsed on its own.
      const panel = createMentionsPanel({ plugin, container, target: file, collapsible: true });
      mounted.set(view, { path: file.path, container, panel });
      void panel.render();
    }

    // Whatever is left is a view that has gone away since the last sync — a
    // closed tab, a detached leaf. Its DOM is beyond reach by now, but its
    // panel still holds vault subscriptions, and those are this plugin's to
    // release.
    for (const view of [...mounted.keys(), ...watching.keys()]) {
      if (seen.has(view)) continue;
      unmount(view);
      // A watch on a view that has gone is the same leak in a different
      // currency: no DOM, but a live subscription to a detached tree that
      // would otherwise be held until the plugin unloads.
      unwatch(view);
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

  /** Everything this shell has out there: both the footers and the waiting. */
  function unmountAll(): void {
    for (const view of [...mounted.keys()]) unmount(view);
    for (const view of [...watching.keys()]) unwatch(view);
  }

  // `destroy` is literally `unmountAll`, and deliberately leaves nothing
  // latched: there is no state to tear down beyond the footers themselves,
  // and a `destroyed` flag would only add a second way for a caller holding a
  // stale reference to be surprised. `main.ts` drops its reference instead,
  // which is the honest way to make it terminal.
  return { sync, destroy: unmountAll };
}
