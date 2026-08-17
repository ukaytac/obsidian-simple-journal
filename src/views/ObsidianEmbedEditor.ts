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
 * destroy `created`, and the embed reloading its full-document buffer from
 * disk (see "self-reload" below) would silently turn the "body-only" buffer
 * back into a full document with frontmatter inside it.
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
 *
 * ## Self-reload: why onFileChanged is neutralised too
 *
 * While this editor is mounted, its buffer is authoritative — this plugin
 * already owns synchronisation with the rest of the vault (the view calls
 * `setValue()` when an external change arrives and the editor doesn't have
 * focus). If the embed also reloads itself from disk on its own file-changed
 * hook, the two mechanisms race: this plugin's debounced write of an older
 * keystroke lands, the vault emits `modify`, the embed reloads to that
 * (older) content, and a live poll tick sees the reload as a "new" edit and
 * reports it — silently discarding whatever the user typed in between, mid
 * sentence. So `onFileChanged` is neutralised the same way and in the same
 * place as the writer methods below. `loadFile` is deliberately left alone:
 * `load()` needs it for the *initial* read.
 *
 * Whether the embed actually performs such a reload while dirty isn't
 * measurable without a running Obsidian, so a second, independent guard
 * (`recentEmissions` in `startPolling`) also treats a reappearing old body as
 * an echo rather than a real edit — belt and braces, not conditional on the
 * first guard holding.
 */

interface EmbedEditMode {
  get?(): string;
  set?(value: string, clearHistory: boolean): void;
  cm?: { focus?(): void; requestMeasure?(): void };
}

interface MarkdownEmbed {
  editable?: boolean;
  editMode?: EmbedEditMode;
  showEditor?(): void;
  load?(): void;
  unload?(): void;
  onunload?(): void;
  // Hazard 1 (docs/editor-embed-api.md): the embed's own writer surface, and
  // its self-reload hook. All neutralised on every instance before load()
  // runs — see neutraliseInternalCallbacks.
  save?(): void;
  requestSave?(): void;
  requestSaveFolds?(): void;
  onFileChanged?(...args: unknown[]): unknown;
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

/**
 * Replaces one of the embed's own methods with a no-op on this instance
 * only (not its prototype, so nothing else that shares the `md` embed class
 * is affected). Two details matter here, both found only by reasoning about
 * Obsidian's own code, not by running it:
 *
 * - `requestSave` is very likely a `Debouncer` function object carrying its
 *   own `.cancel()`/`.run()`, not a plain function. If some other internal
 *   path still holds a reference to what it believes is the original and
 *   calls `.cancel()` on it — e.g. from the embed's own unload path, which
 *   this file's try/catch only wraps around `unload()`/`onunload()`
 *   themselves — a bare `() => {}` would throw there instead. Copying the
 *   original's own properties onto the replacement keeps that surface intact.
 * - `save()` returns a Promise in the real API; a replacement that returns
 *   `undefined` breaks any internal `save().then(...)` the same way.
 */
function neutralise(record: Record<string, unknown>, name: string, asyncReturn = false): void {
  const original = record[name];
  if (typeof original !== "function") return;
  const noop = asyncReturn ? (() => Promise.resolve()) : (() => {});
  Object.assign(noop, original);
  record[name] = noop;
}

/**
 * Bound on `recentEmissions` (see `startPolling`). A handful of in-flight,
 * not-yet-written keystroke bursts is all that can realistically be pending
 * at once; this just keeps the array from growing without limit over a long
 * editing session.
 */
const RECENT_EMISSIONS_LIMIT = 8;

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

  /**
   * The frontmatter block exactly as it stood at mount/last-load. If the
   * user breaks it (e.g. deletes the closing `---`), `splitFrontmatter` on
   * the resulting document reports empty frontmatter and treats the entire
   * document as "body" — reporting that through onChange would eventually
   * have `EntryRepository.writeBody` paste the now-unparsed frontmatter
   * lines into the body as a second, disk-visible frontmatter-looking block
   * (created/mood/etc. survive, since `replaceBody` still preserves the
   * real frontmatter ahead of it, but it's still visible corruption). Used
   * by `readBody` to detect this and fall back rather than propagate it.
   */
  private mountedFrontmatter: string | null = null;

  /**
   * Bodies this editor has itself emitted through onChange recently, oldest
   * first. Belt-and-braces against the self-reload race described in this
   * file's top comment: if a poll tick observes a body that matches one of
   * these rather than genuinely new text, it's treated as a stale echo of a
   * write that raced ahead of further typing, not a real edit.
   */
  private recentEmissions: string[] = [];

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
    this.mountedFrontmatter = null;

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

    // Held outside the try, not read from `this.embed`: `this.embed` is
    // only assigned once mount fully succeeds below, so a throw from
    // load()/showEditor() — after construction but before that assignment —
    // would otherwise leave the catch block's `if (this.embed)` false and
    // leak a fully loaded embed. Its Component would keep whatever vault
    // and metadata handlers it registered running against now-detached DOM
    // for the rest of the session.
    let embed: MarkdownEmbed | null = null;

    try {
      embed = creator(
        { app: this.app, containerEl: this.containerEl, showInline: true, depth: 0 },
        file,
        "",
      );

      // Hazard 1: neutralise the embed's writer and self-reload hooks
      // BEFORE load() runs anything that might call them. See this file's
      // top comment for the self-reload race, and `neutralise`'s doc for
      // why a bare `() => {}` isn't safe here.
      this.neutraliseInternalCallbacks(embed);

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

      const loadedRaw = this.readRaw();
      if (!this.usable || loadedRaw === null) {
        // readRaw() already found the embed broken (get() threw, or
        // returned something that isn't a string) and flipped `usable`
        // false; tear fully down rather than leave a half-mounted embed
        // around for the caller to find via isUsable().
        this.discardCurrentEmbed();
        return;
      }

      const { frontmatter, body: loadedBody } = splitFrontmatter(loadedRaw);
      this.mountedFrontmatter = frontmatter;

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

      if (loadedBody !== seedValue) {
        this.writeBody(seedValue);
        this.lastBody = seedValue;
      } else {
        this.lastBody = loadedBody;
      }
      this.recordEmission(this.lastBody);

      this.tagEditorPane();
      this.startPolling();
      // No removeEventListener on destroy: this listener is reachable only
      // from this now-detached, dereferenced containerEl, so it's collected
      // with it (same reasoning as TextareaEditor's input/focus listeners).
      this.containerEl.addEventListener("focusout", (event) => {
        // focusout bubbles for ANY focus change inside the container, not
        // just one that leaves it — CM6's own in-editor search panel,
        // clicking a widget. With lazy creation, treating every one of
        // those as "this editor lost focus" would let a blur-driven discard
        // of an empty composer fire while the user is still there. Only the
        // case where the new target is outside the container entirely
        // counts as a real blur.
        const related = (event as FocusEvent).relatedTarget as Node | null;
        if (related && this.containerEl?.contains(related)) return;
        this.blurCallback?.();
      });
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to mount", error);
      this.usable = false;
      if (embed) this.teardownEmbed(embed);
      this.embed = null;
      this.containerEl?.remove();
      this.containerEl = null;
    }
  }

  private neutraliseInternalCallbacks(embed: MarkdownEmbed): void {
    const record = embed as unknown as Record<string, unknown>;
    neutralise(record, "save", true);
    neutralise(record, "requestSave");
    neutralise(record, "requestSaveFolds");
    neutralise(record, "onFileChanged");
  }

  /**
   * Marks this editor unusable and stops polling. Called the moment
   * `readRaw()` observes the embed behaving unexpectedly — file deleted
   * while mounted, or any shape change after mount — so the caller's
   * `isUsable()` check (normally only meaningful right after `mount()`)
   * also catches a *later* failure, rather than leaving the user typing
   * into an editor whose text can never be read back out.
   */
  private markUnusable(): void {
    if (!this.usable) return;
    this.usable = false;
    this.stopPolling();
  }

  /** Raw editMode.get() output — the whole document, frontmatter included. */
  private readRaw(): string | null {
    try {
      const raw = this.embed?.editMode?.get?.();
      if (typeof raw !== "string") {
        this.markUnusable();
        return null;
      }
      return raw;
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to read", error);
      this.markUnusable();
      return null;
    }
  }

  private readBody(): string {
    const raw = this.readRaw();
    if (raw === null) return this.lastBody;

    const { frontmatter, body } = splitFrontmatter(raw);
    if (this.mountedFrontmatter !== null && frontmatter !== this.mountedFrontmatter) {
      // See mountedFrontmatter's doc: the user broke the frontmatter
      // delimiter. Fall back to the last known-good body instead of
      // reporting this one — it self-heals the moment the delimiter is
      // restored, and never reaches EntryRepository.writeBody in the
      // meantime.
      return this.lastBody;
    }
    return body;
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

  private recordEmission(body: string): void {
    this.recentEmissions.push(body);
    if (this.recentEmissions.length > RECENT_EMISSIONS_LIMIT) this.recentEmissions.shift();
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
      // A null read either means nothing changed relevantly or that
      // readRaw() just flipped this editor unusable and stopped polling —
      // either way, nothing to process this tick.
      if (raw === null || raw === lastRaw) return;
      lastRaw = raw;

      const body = this.readBody();
      if (body === this.lastBody) return;

      if (this.recentEmissions.includes(body)) {
        // Belt-and-braces (see this file's top comment): this body is one
        // WE emitted before, not new text — a stale echo of a write that
        // raced ahead of further typing. this.lastBody is by construction
        // newer than anything in recentEmissions, so restore it in the
        // buffer if the user is still here to lose keystrokes to it;
        // otherwise just drop the echo without disturbing an unfocused
        // buffer.
        if (this.hasFocus()) {
          this.writeBody(this.lastBody);
          lastRaw = this.readRaw() ?? lastRaw;
        }
        return;
      }

      this.lastBody = body;
      this.recordEmission(body);
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
    this.recordEmission(value);
    this.changeCallback?.(value);
  }

  /**
   * The embed manages its own CM6 layout for most cases, but a resize that
   * happened while this leaf was hidden (e.g. a background tab) needs an
   * explicit remeasure once it's visible again — CM6's own
   * `requestMeasure()` is the public hook for exactly that.
   */
  remeasure(): void {
    try {
      this.embed?.editMode?.cm?.requestMeasure?.();
    } catch (error) {
      console.error("Journal Entries: embedded editor failed to remeasure", error);
    }
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
    this.mountedFrontmatter = null;
    this.recentEmissions = [];
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

  /**
   * Tags whichever `.markdown-embed-content` pane actually contains the CM6
   * editor with a class the CSS keys off, so the "hide the preview pane,
   * show the editor pane" rule doesn't depend on `:has()` support — some
   * embedded webviews Obsidian can run on may not have it, which would
   * otherwise leave BOTH panes hidden while isUsable() still reports true.
   * Called once right after showEditor() and once more on the next tick as
   * a safety net, in case the CM6 DOM is constructed asynchronously on some
   * version rather than synchronously as the spike observed.
   */
  private tagEditorPane(): void {
    const tag = (): void => {
      const container = this.containerEl;
      if (!container) return;
      for (const pane of Array.from(container.querySelectorAll(".markdown-embed-content"))) {
        if (pane.querySelector(".cm-editor")) pane.classList.add("journal-entry-embed-editor-pane");
      }
    };

    tag();
    window.setTimeout(tag, 0);
  }
}
