import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from "obsidian";
import type JournalEntriesPlugin from "../main";
import { createMentionsPanel, type MentionsPanel } from "./MentionsPanel";

/**
 * Shell A: the fenced block a user writes into a note.
 *
 * The language string is effectively PERMANENT once published — it lives
 * inside users' notes, exactly as the plugin id lives in their vault folder
 * and the view types live in their saved layouts. It is namespaced to the
 * plugin so it cannot collide with another plugin's processor.
 */
export const MENTIONS_BLOCK_LANGUAGE = "simple-journal";

/** What `Insert journal mentions block` writes at the cursor. */
export const MENTIONS_BLOCK_SNIPPET = "```" + MENTIONS_BLOCK_LANGUAGE + "\n```\n";

const EMPTY_TEXT = "No journal entries mention this note yet.";

const NOTE_DIRECTIVE = /^note:\s*\[\[([^\]]+)\]\]$/;

export interface MentionsBlockOptions {
  /** Linktext of an explicitly targeted note, or null for "the note I am in". */
  noteLink: string | null;
}

/**
 * Understands exactly one directive, `note: [[Some Note]]`.
 *
 * Anything else is IGNORED rather than treated as an error. A code block that
 * renders an error message in the middle of someone's note is worse than one
 * that renders the obvious default, and this block's obvious default —
 * mentions of the note it sits in — is always available.
 */
export function parseMentionsBlock(source: string): MentionsBlockOptions {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = NOTE_DIRECTIVE.exec(line);
    if (!match) continue;
    // `[[Note|Alias]]` — the target is the part before the pipe.
    const linktext = match[1].split("|")[0].trim();
    if (linktext) return { noteLink: linktext };
  }
  return { noteLink: null };
}

/**
 * The recursion guard.
 *
 * The panel renders entry markdown, and an entry may itself contain a
 * `simple-journal` block — which would render a panel, which would render
 * entry markdown, without end. Detected structurally rather than with a
 * global depth counter: `closest` asks about THIS block's actual ancestry, so
 * an unrelated block rendering concurrently in another note is never
 * mistaken for a nested one.
 */
export function isInsideMentionsPanel(el: HTMLElement): boolean {
  return el.closest(".journal-mentions") !== null;
}

/**
 * Wraps the panel so Obsidian owns its lifecycle: when the block's element
 * leaves the DOM — the note closes, or the user edits the fence — `onunload`
 * fires and every subscription the panel holds is released.
 */
class MentionsBlockChild extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private readonly panel: MentionsPanel,
  ) {
    super(containerEl);
  }

  onload(): void {
    void this.panel.render();
  }

  onunload(): void {
    this.panel.destroy();
  }
}

export function registerMentionsCodeBlock(plugin: JournalEntriesPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor(MENTIONS_BLOCK_LANGUAGE, (source, el, ctx) => {
    if (isInsideMentionsPanel(el)) {
      el.createDiv({
        cls: "journal-mentions-nested",
        text: "Journal mentions block (not expanded here).",
      });
      return;
    }

    const target = resolveTarget(plugin, source, ctx);
    if (!target) {
      el.createDiv({ cls: "journal-mentions-empty", text: EMPTY_TEXT });
      return;
    }

    const panel = createMentionsPanel({
      plugin,
      container: el,
      target,
      emptyText: EMPTY_TEXT,
    });
    ctx.addChild(new MentionsBlockChild(el, panel));
  });
}

/**
 * A `note:` link that resolves to nothing falls back to the same empty state
 * as a note with no mentions — for the same reason the parser ignores what it
 * does not understand.
 */
function resolveTarget(
  plugin: JournalEntriesPlugin,
  source: string,
  ctx: MarkdownPostProcessorContext,
): TFile | null {
  const { noteLink } = parseMentionsBlock(source);

  if (noteLink) {
    return plugin.app.metadataCache.getFirstLinkpathDest(noteLink, ctx.sourcePath);
  }

  const self = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  return self instanceof TFile ? self : null;
}
