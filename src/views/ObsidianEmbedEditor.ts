import type { App, TFile } from "obsidian";
import { replaceBody, splitFrontmatter } from "../journal/markdownDoc";
import type { EntryEditor } from "./EntryEditor";

/**
 * The ONLY file in this plugin that uses undocumented Obsidian internals.
 *
 * It mounts a real Obsidian Markdown editor — live preview, `[[` autocomplete,
 * editor commands, embeds, theme parity — by way of the internal embed
 * registry, the same mechanism Obsidian uses for Canvas cards and callout
 * editing. See docs/editor-embed-api.md for the verified API shape (Obsidian
 * 1.8.9) and CLAUDE.md § Editing for why this exception exists.
 *
 * Every internal access is optional-chained and wrapped in try/catch. If
 * Obsidian changes shape, this editor reports failure through `isUsable()`
 * and the caller falls back to `TextareaEditor` instead of throwing.
 *
 * ## The body/document translation (read this before touching get/set)
 *
 * `editMode.get()` returns the embed's *entire* buffer, frontmatter and all,
 * and `editMode.set(value, clearHistory)` replaces that entire buffer. But
 * `EntryEditor`'s contract is body-only. The naive fix — install a body-only
 * buffer once at mount — was tried in the spike and rejected: it leaves the
 * buffer without frontmatter, so any write that slipped through would
 * destroy `created`, and the embed reloads its full-document buffer from
 * disk on an external file change (including this plugin's own writes),
 * silently turning the "body-only" buffer back into a full document with
 * frontmatter inside it.
 *
 * So instead the embed is left to keep the full document it loads for
 * itself, and every `EntryEditor` method translates at the boundary:
 *
 *   - `getValue()`      -> `splitFrontmatter(editMode.get()).body`
 *   - `setValue(body)`  -> `editMode.set(replaceBody(editMode.get(), body), false)`
 *
 * This keeps the embed's buffer in the shape it expects (nothing fights it),
 * and keeps every `EntryEditor` consumer body-only. `replaceBody` round-trips
 * correctly even when there is no frontmatter block at all (a user-stripped
 * file): `splitFrontmatter` reports an empty frontmatter string, and
 * `replaceBody` then returns the body unchanged.
 */

interface EmbedEditMode {
  get?(): string;
  set?(value: string, clearHistory: boolean): void;
  cm?: { focus?(): void };
}

interface MarkdownEmbed {
  editable?: boolean;
  editMode?: EmbedEditMode;
  showEditor?(): void;
  load?(): void;
  unload?(): void;
  onunload?(): void;
  // Hazard 1 (docs/editor-embed-api.md): the embed's own writer surface.
  // Neutralised on every instance before load() runs — see neutraliseWriter.
  save?(): void;
  requestSave?(): void;
  requestSaveFolds?(): void;
}

type EmbedCreator = (
  context: { app: App; containerEl: HTMLElement; showInline: boolean; depth: number },
  file: TFile,
  subpath: string,
) => MarkdownEmbed;

function getCreator(app: App): EmbedCreator | null {
  const registry = (
    app as unknown as { embedRegistry?: { embedByExtension?: Record<string, unknown> } }
  ).embedRegistry?.embedByExtension;

  return typeof registry?.md === "function" ? (registry.md as EmbedCreator) : null;
}

/** Names of the embed's writer methods. Replaced with no-ops before load(). */
const WRITER_METHODS = ["save", "requestSave", "requestSaveFolds"] as const;

export class ObsidianEmbedEditor implements EntryEditor {
  private embed: MarkdownEmbed | null = null;
  private containerEl: HTMLElement | null = null;
  private changeCallback: ((value: string) => void) | null = null;
  private blurCallback: (() => void) | null = null;
  private pollHandle: number | null = null;
  private usable = false;

  /**
   * Mirrors the current body on every read/write. `getValue()` falls back to
   * this after `destroy()`, same as `TextareaEditor.lastValue` — a caller
   * flushing a pending save at teardown must not see this collapse to `""`.
   */
  private lastBody = "";

  /** A setValue() that arrived before mount(); applied once mount() runs. */
  private pendingValue: string | null = null;

  constructor(private readonly app: App) {}

  /** False when the internal API did not behave as expected; the caller must fall back. */
  isUsable(): boolean {
    return this.usable;
  }

  mount(el: HTMLElement, file: TFile | null, initialValue: string): void {
    // Idempotent, per the interface contract: a second mount() discards
    // whatever this instance already holds, without flushing it — that is
    // the caller's job if it cares about the text (see flush()'s doc).
    if (this.embed || this.containerEl) this.discardCurrentEmbed();

    this.usable = false;

    const creator = getCreator(this.app);
    if (!creator || !file) {
      // Nothing to embed — no file yet (an uncommitted composer) or the
      // internal API isn't there at all. Leave `el` untouched so the caller
      // can mount TextareaEditor into it instead.
      this.lastBody = this.pendingValue ?? initialValue;
      this.pendingValue = null;
      return;
    }

    this.containerEl = el.createDiv({ cls: "journal-entry-embed" });

    try {
      const embed = creator(
        { app: this.app, containerEl: this.containerEl, showInline: true, depth: 0 },
        file,
        "",
      );

      // Hazard 1: neutralise the embed's writer BEFORE load() runs anything
      // that might call it. This plugin writes through
      // EntryRepository.writeBody (vault.process + replaceBody), which is
      // what guarantees a user's arbitrary frontmatter survives byte for
      // byte. The spike measured that the embed does not autosave on its
      // own and that unload() doesn't flush — but that is a measured
      // behaviour of one Obsidian version, not a contract a future release
      // is bound by. A write that slipped through here would bypass
      // writeBody's guarantee entirely, so the writer methods are replaced
      // with no-ops on this instance rather than trusted to stay inert.
      this.neutraliseWriter(embed);

      embed.editable = true;
      // Order matters (docs/editor-embed-api.md): editMode does not exist
      // until showEditor() runs, and showEditor() must run after load().
      embed.load?.();
      embed.showEditor?.();

      if (typeof embed.editMode?.get !== "function" || typeof embed.editMode?.set !== "function") {
        this.teardownEmbed(embed);
        this.containerEl.remove();
        this.containerEl = null;
        return;
      }

      this.embed = embed;
      this.usable = true;

      // The embed loads the file itself, so its buffer already holds the
      // right content — do NOT blindly setValue(initialValue) here, which
      // would force a document replace (and a CM6 selection reset) on every
      // mount even when nothing needs correcting. Only overwrite the body
      // if what the embed actually loaded differs from what the caller
      // expects (e.g. a setValue() buffered while this entry was still
      // being constructed, or the caller seeding content the file on disk
      // doesn't have yet).
      const seedValue = this.pendingValue ?? initialValue;
      this.pendingValue = null;

      const loadedBody = this.readBody();
      if (loadedBody !== seedValue) {
        this.writeBody(seedValue);
        this.lastBody = seedValue;
      } else {
        this.lastBody = loadedBody;
      }

      this.startPolling();
      // No removeEventListener on destroy: this listener is reachable only
      // from this now-detached, dereferenced containerEl, so it's collected
      // with it (same reasoning as TextareaEditor's input/focus listeners).
      this.containerEl.addEventListener("focusout", () => this.blurCallback?.());
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to mount", error);
      this.usable = false;
      if (this.embed) this.teardownEmbed(this.embed);
      this.embed = null;
      this.containerEl?.remove();
      this.containerEl = null;
    }
  }

  /**
   * Hazard 1: replaces the embed's writer methods with no-ops on this
   * instance only (not its prototype), so nothing else that shares the
   * `md` embed class is affected. A no-op, not a delete, because other
   * internal code may still call these unconditionally.
   */
  private neutraliseWriter(embed: MarkdownEmbed): void {
    const record = embed as unknown as Record<string, unknown>;
    const noop = (): void => {};
    for (const name of WRITER_METHODS) {
      if (typeof record[name] === "function") record[name] = noop;
    }
  }

  /** Raw editMode.get() output — the whole document, frontmatter included. */
  private readRaw(): string | null {
    try {
      return this.embed?.editMode?.get?.() ?? null;
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to read", error);
      return null;
    }
  }

  private readBody(): string {
    const raw = this.readRaw();
    if (raw === null) return this.lastBody;
    return splitFrontmatter(raw).body;
  }

  /** Translates a body-only value into a full-document set(), per the boundary contract above. */
  private writeBody(body: string): void {
    try {
      const raw = this.embed?.editMode?.get?.() ?? "";
      this.embed?.editMode?.set?.(replaceBody(raw, body), false);
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to write", error);
    }
  }

  /**
   * The spike found no change callback on the embed (docs/editor-embed-api.md).
   * `editMode` has an `onUpdate` on its prototype, but hooking it would mean
   * monkey-patching a method CM6 itself wires into the editor at
   * construction time — there's no way to verify, without a live Obsidian
   * window, whether replacing it post-construction is ever actually invoked,
   * or whether it silently breaks live preview's own use of the same hook.
   * Given that risk, this polls instead, exactly as the plan describes: a
   * string read on an interval, with an early-out once the raw document is
   * unchanged, so most ticks cost one string comparison.
   */
  private startPolling(): void {
    let lastRaw = this.readRaw() ?? "";

    this.pollHandle = window.setInterval(() => {
      const raw = this.readRaw();
      if (raw === null || raw === lastRaw) return;
      lastRaw = raw;

      const body = splitFrontmatter(raw).body;
      if (body === this.lastBody) return;
      this.lastBody = body;
      this.changeCallback?.(body);
    }, 250);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  getValue(): string {
    // Stays truthful after destroy(): readBody() falls back to lastBody once
    // embed is gone, and destroy() itself refreshes lastBody before clearing
    // embed, so a caller flushing a pending save at teardown never sees this
    // collapse to "".
    return this.embed ? this.readBody() : this.lastBody;
  }

  setValue(value: string): void {
    this.lastBody = value;
    if (!this.embed) {
      // mount() hasn't run yet (or already tore down); buffer instead of
      // silently dropping it, same contract as TextareaEditor.
      this.pendingValue = value;
      return;
    }
    this.writeBody(value);
  }

  focus(): void {
    try {
      this.embed?.editMode?.cm?.focus?.();
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to focus", error);
    }
  }

  hasFocus(): boolean {
    // The embed exposes several internally-focusable elements (the CM6
    // content DOM, its gutters, etc.), not one single input — so rather than
    // trust a specific internal focus flag whose cross-window behaviour is
    // unverified (docs/editor-embed-api.md: popout windows weren't tested),
    // this checks containment against the container's OWN document. Same
    // principle TextareaEditor uses via `.doc`: in a popout window
    // (Workspace.moveLeafToPopout) each leaf has its own document, and the
    // global `document.activeElement` would just be the main window's body.
    const container = this.containerEl;
    if (!container) return false;
    const activeElement = container.doc.activeElement;
    return activeElement !== null && container.contains(activeElement);
  }

  onChange(callback: (value: string) => void): void {
    this.changeCallback = callback;
  }

  onBlur(callback: () => void): void {
    this.blurCallback = callback;
  }

  flush(): void {
    // Mirrors TextareaEditor.flush(): before a first successful mount (or
    // after mount() found no usable embed), lastBody is just its ""
    // initializer unless a setValue() buffered something real — committing
    // it here would let a "flush all" write an empty entry over real text
    // that simply hasn't been mounted yet. Callers invoke this before
    // destroy(), never after, so this.embed being cleared by destroy() is
    // not a case this needs to distinguish from "never mounted".
    if (!this.embed && this.pendingValue === null) return;
    const value = this.getValue();
    this.lastBody = value;
    this.changeCallback?.(value);
  }

  /** The embed manages its own CM6 layout/measurement; nothing to redo here. */
  remeasure(): void {
    // Intentional no-op.
  }

  destroy(): void {
    // Capture the truth before the embed goes away — getValue() falls back
    // to this once `embed` is null, and readBody() itself would otherwise
    // fall back to a possibly-stale lastBody. Polling is stopped as part of
    // discardCurrentEmbed() below, after this read.
    this.lastBody = this.getValue();
    this.discardCurrentEmbed();
    this.changeCallback = null;
    this.blurCallback = null;
  }

  /**
   * Tears down whatever embed/container this instance currently holds,
   * without flushing (no onChange call) and without touching lastBody,
   * pendingValue, or the registered callbacks — used by both destroy() and
   * a remount's discard-without-flush step, which differ only in whether
   * those are cleared afterwards.
   */
  private discardCurrentEmbed(): void {
    this.stopPolling();
    const embed = this.embed;
    this.embed = null;
    this.usable = false;
    if (embed) this.teardownEmbed(embed);
    this.containerEl?.remove();
    this.containerEl = null;
  }

  private teardownEmbed(embed: MarkdownEmbed): void {
    try {
      embed.unload?.();
      embed.onunload?.();
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to unload", error);
    }
  }
}
