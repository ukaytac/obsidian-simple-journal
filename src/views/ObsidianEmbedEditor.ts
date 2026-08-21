import type { App, TFile } from "obsidian";
import { preserveSeparator, replaceBody, splitFrontmatter, stripSeparator } from "../journal/markdownDoc";
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
 * `EntryEditor`'s contract is body-only — and, matching `EntryRepository`'s
 * convention, body-only means *without* the blank-line separator between the
 * frontmatter block and the text either: `getValue()`/`setValue()`/`mount()`'s
 * `initialValue` and every `onChange` report all exclude it, exactly like
 * `EntryRepository.readBody`/`writeBody`. JournalView passes values between
 * the two with no translation of its own, so this editor and the repository
 * must agree on the shape or a mount-time "sync the buffer" write silently
 * deletes the separator on every mount — the same data loss this whole
 * boundary exists to prevent.
 *
 * The naive fix — install a body-only buffer once at mount — was tried in the
 * spike and rejected: it leaves the buffer without frontmatter, so any write
 * that slipped through would destroy `created`, and the embed reloading its
 * full-document buffer from disk (see "self-reload" below) would silently
 * turn the "body-only" buffer back into a full document with frontmatter
 * inside it.
 *
 * So instead the embed is left to keep the full document it loads for
 * itself, and every `EntryEditor` method translates at the boundary:
 *
 *   - `getValue()`      -> `stripSeparator(frontmatter, splitFrontmatter(editMode.get()).body)`
 *   - `setValue(body)`  -> `editMode.set(replaceBody(editMode.get(), preserveSeparator(frontmatter, existingBody, body)), false)`
 *
 * This keeps the embed's buffer in the shape it expects (nothing fights it),
 * and keeps every `EntryEditor` consumer body-only, separator-free. The
 * delicate frontmatter-guard bookkeeping below (`mountedFrontmatter`,
 * `lastRawBody`) stays entirely in the raw, byte-exact convention throughout —
 * only `readBody()`'s return value and `writeBody()`'s parameter cross the
 * translation, at the very edge. `preserveSeparator` doesn't invent a
 * separator: it preserves whatever the embed's OWN current buffer already
 * has (no blank line for a newly created entry, one for an existing entry
 * that already had it), matching `EntryRepository.writeBody`'s contract
 * exactly. `replaceBody` round-trips correctly even when there is no
 * frontmatter block at all (a user-stripped file): `splitFrontmatter`
 * reports an empty frontmatter string, `stripSeparator`/`preserveSeparator`
 * are no-ops for an empty frontmatter, and `replaceBody` then returns the
 * body unchanged.
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
 * This is confirmed the right trade: external edits no longer reaching this
 * editor's buffer on their own is intended, because the view already owns
 * that path through `setValue()`. But replacing the *instance property*
 * only intercepts callers that dispatch through `embed.onFileChanged(...)` —
 * anything that captured the original method at construction time, or that
 * reloads the buffer through some other internal route entirely, would
 * bypass this.
 *
 * There is deliberately no second, content-and-timestamp guard here trying
 * to catch a reload if this neutralisation ever turns out to be incomplete.
 * Three rounds of review each found a distinct way such a guard drops the
 * user's actual typed text (a content-keyed history misreading an ordinary
 * undo as a stale reload; a timestamp window that has no value able to be
 * both reliably longer than the poll period plus real-world echo latency
 * and reliably shorter than a human type-then-revert — those two ranges
 * don't overlap; an unfocused restore path leaving the buffer and the
 * caller's view of it diverged). A guard over an event this file cannot
 * observe cannot be tuned into correctness. And the hazard it existed to
 * insure against is already covered three times over without it: the spike
 * measured the embed never writes on its own; `onFileChanged` is
 * neutralised above; and decisively, `EntryRepository.writeBody` takes the
 * frontmatter from disk inside `vault.process`, never from this editor's
 * buffer, so losing `created` to a stray reload is structurally impossible
 * regardless of what this buffer holds. A defence that is unreliable when
 * needed, harmful when not, and covers an already-covered hazard is
 * negative value — see docs/manual-testing-editor.md for the one empirical
 * check that actually answers whether a reload happens at all, and for
 * what a real fix would need to look like if it does (a revision counter
 * the view owns, or suppressing reports while focused with a write in
 * flight — never content-and-timestamp matching).
 */

interface EmbedEditMode {
  get?(): string;
  set?(value: string, clearHistory: boolean): void;
  cm?: {
    focus?(): void;
    requestMeasure?(): void;
    /** Only read for `focus("end")`'s caret placement, below. */
    state?: { doc?: { length?: number } };
    /** Only called for `focus("end")`'s caret placement, below. A plain
     * `{anchor, head}` object is part of CM6's own public `TransactionSpec`
     * shape — this doesn't reach for anything beyond what `editMode.cm`
     * (a real CM6 `EditorView`, per docs/editor-embed-api.md) already
     * documents. */
    dispatch?(transaction: { selection?: { anchor: number; head?: number } }): void;
  };
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

export class ObsidianEmbedEditor implements EntryEditor {
  private embed: MarkdownEmbed | null = null;
  private containerEl: HTMLElement | null = null;
  private changeCallback: ((value: string) => void) | null = null;
  private blurCallback: (() => void) | null = null;
  private unusableCallback: (() => void) | null = null;
  private pollHandle: number | null = null;
  private usable = false;

  /**
   * Mirrors the current body — in the public, separator-stripped convention —
   * on every read/write. `getValue()` falls back to this after `destroy()`,
   * same as `TextareaEditor.lastValue` — a caller flushing a pending save at
   * teardown must not see this collapse to `""`.
   */
  private lastBody = "";

  /**
   * The raw (separator-included) counterpart of `lastBody`, as it stood at
   * the last successful, non-bailed `readBody()`. Used only by `readBody`'s
   * own frontmatter-guard heuristic below, which reasons about the embed's
   * actual buffer contents (a suffix relationship after a thematic-break
   * collision) — that reasoning must stay in the same raw convention
   * `mountedFrontmatter` and `splitFrontmatter` already use, independent of
   * whatever translation the public `lastBody` gets at the boundary.
   */
  private lastRawBody = "";

  /** A setValue() that arrived before mount(); applied once mount() runs. */
  private pendingValue: string | null = null;

  /**
   * The frontmatter block exactly as it stood at the last successful read.
   * Refreshed on every read that still parses (see `readBody`) — a
   * legitimate frontmatter edit (added/removed/reordered a property, still a
   * well-formed block) is not an error and must not stop body edits from
   * being reported. Only used to detect the one case that IS an error: the
   * block going from present to totally unparseable (e.g. the user deleted
   * its closing `---`), which would otherwise let `splitFrontmatter` treat
   * the whole document as "body" and have `EntryRepository.writeBody` paste
   * those now-unparsed frontmatter lines into the body as a second,
   * disk-visible frontmatter-looking block on the next write.
   */
  private mountedFrontmatter: string | null = null;

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

      const { frontmatter, body: loadedRawBody } = splitFrontmatter(loadedRaw);
      this.mountedFrontmatter = frontmatter;
      this.lastRawBody = loadedRawBody;

      // Public (separator-stripped) counterpart of what the embed actually
      // loaded, so this compares against `initialValue`/`pendingValue` — both
      // already separator-free, per this editor's contract — in the same
      // convention rather than always finding a spurious mismatch.
      const loadedBody = stripSeparator(frontmatter, loadedRawBody);

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
        // writeBody() itself refreshes lastRawBody to match what it wrote.
        this.writeBody(seedValue);
        this.lastBody = seedValue;
      } else {
        this.lastBody = loadedBody;
      }

      // Tags the pane containing the real CM6 editor. If neither its
      // synchronous nor its deferred safety-net pass ever finds one, it
      // calls markUnusable() itself (asynchronously — see its doc), which
      // is why this can't be checked synchronously here the way the other
      // mount-time failures above are.
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
      console.error("Simple Journal: embedded editor failed to mount", error);
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
   * Marks this editor unusable, stops polling, and tells the caller via
   * `onUnusable`. Called the moment something observes the embed behaving
   * unexpectedly — `readRaw()` on a shape change or a runtime failure after
   * a successful mount (e.g. the file was deleted out from under it), or
   * `tagEditorPane()` never finding the CM6 editor pane at all — so a
   * *later* failure is caught too, not only the one `isUsable()` reflects
   * right after `mount()`. Without the callback firing, the user would keep
   * typing into an editor whose text can never be read back out, with the
   * poll silently stopped and no way for the caller to notice.
   */
  private markUnusable(): void {
    if (!this.usable) return;
    this.usable = false;
    this.stopPolling();
    this.unusableCallback?.();
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
      console.error("Simple Journal: embedded editor failed to read", error);
      this.markUnusable();
      return null;
    }
  }

  /**
   * Returns the current body in the public, separator-stripped convention.
   * The frontmatter-guard bookkeeping below (`mountedFrontmatter`,
   * `lastRawBody`) stays entirely in the raw, byte-exact convention — the
   * translation to public happens only in the single `return` at the very
   * end (and the two bail branches return the already-public `this.lastBody`
   * unchanged). This keeps the delicate suffix/length comparisons below
   * self-consistent regardless of what convention callers expect.
   */
  private readBody(): string {
    const raw = this.readRaw();
    if (raw === null) return this.lastBody;

    const { frontmatter, body: rawBody } = splitFrontmatter(raw);

    if (this.mountedFrontmatter) {
      // See mountedFrontmatter's doc: bail ONLY when the block has
      // genuinely stopped parsing, not on every difference from what was
      // last seen — a single legitimate property addition/removal must not
      // silently stop all future saves. Two distinct ways it can genuinely
      // break:
      if (frontmatter === "") {
        // The delimiter is gone entirely (e.g. the closing "---" was
        // deleted with nothing else in the body that looks like one):
        // splitFrontmatter treats the whole document as body.
        return this.lastBody;
      }
      if (
        frontmatter.length > this.mountedFrontmatter.length &&
        rawBody !== this.lastRawBody &&
        this.lastRawBody.endsWith(rawBody)
      ) {
        // The closing "---" was deleted, but the body happens to contain
        // its OWN "---" (a thematic break) further down — splitFrontmatter
        // then closes the block on that line instead, silently swallowing
        // everything between the real frontmatter and the thematic break
        // into "frontmatter", and reporting only the tail after it as the
        // whole body. That combination (frontmatter grew, and what's left
        // of the body is a strict suffix of what it was) is what separates
        // this from a legitimate property addition, where the body is
        // unchanged. Reporting the truncated tail would have the view
        // write it as the entry's entire body, deleting everything before
        // the thematic break from disk while it's still visible on screen.
        //
        // Residual: if a frontmatter-growth-plus-head-deletion coincidence
        // like this happens within a single poll tick and is the user's
        // last action before teardown, flush() reads this same bailed-to
        // lastBody and reports the OLDER body, one edit behind — so a
        // caller that then writes it would restore the deleted head text
        // rather than committing whatever the user most recently typed.
        // Bailing is still the right failure mode here: nothing is written
        // that wasn't already known-good, and the file on disk is
        // preserved untouched, per CLAUDE.md's "when uncertain, preserve
        // the file" — but this loss of the very latest edit in this
        // specific, narrow coincidence is a known, accepted trade-off
        // rather than a hidden one.
        return this.lastBody;
      }
    }

    this.mountedFrontmatter = frontmatter;
    this.lastRawBody = rawBody;
    return stripSeparator(frontmatter, rawBody);
  }

  /**
   * Translates a public, separator-stripped body into a full-document
   * `set()`, per the boundary contract above: whatever separator the
   * buffer's OWN current content already has (read fresh off `raw` — none
   * for a newly created entry, one for an existing entry that already had
   * it) is preserved ahead of `body`, never imposed, before handing the
   * result to `replaceBody`.
   *
   * Also refreshes `lastRawBody` to match, here rather than at each call
   * site (`mount()`, `setValue()`): this is the one place that already
   * computes both `frontmatter` and the raw body actually being written, so
   * every caller gets a correct `lastRawBody` by construction instead of
   * needing to remember to keep it in sync itself. `setValue()` previously
   * didn't, which let `readBody`'s frontmatter-guard heuristic (see its doc)
   * compare a fresh raw body against a stale `lastRawBody` predating the
   * `setValue()` — the same false-negative-closing-delimiter case that
   * heuristic exists to catch, just reached from a path it wasn't guarding.
   */
  private writeBody(body: string): void {
    try {
      const raw = this.embed?.editMode?.get?.() ?? "";
      const { frontmatter, body: existingBody } = splitFrontmatter(raw);
      const rawBody = preserveSeparator(frontmatter, existingBody, body);
      this.embed?.editMode?.set?.(replaceBody(raw, rawBody), false);
      this.lastRawBody = rawBody;
    } catch (error) {
      console.error("Simple Journal: embedded editor failed to write", error);
      // Consistent with readRaw(): a set() that starts throwing leaves this
      // editor unable to reliably accept further edits (every setValue()
      // would fail silently, and the next poll-reported body would
      // overwrite whatever the buffer actually holds), so the caller needs
      // to know via the same isUsable()/onUnusable() path as a read failure.
      this.markUnusable();
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
    // The initial read above may itself have found the embed already
    // broken and called markUnusable() — without this check, setInterval
    // below would still be installed regardless, leaving a 250ms loop
    // running against an editor already flagged unusable, clearable only by
    // destroy() rather than the markUnusable() path that's supposed to own
    // stopping it.
    if (!this.usable) return;

    this.pollHandle = window.setInterval(() => {
      const raw = this.readRaw();
      // A null read either means nothing changed relevantly or that
      // readRaw() just flipped this editor unusable and stopped polling —
      // either way, nothing to process this tick.
      if (raw === null || raw === lastRaw) return;
      lastRaw = raw;

      const body = this.readBody();
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

  focus(caretPosition?: "end"): void {
    try {
      const cm = this.embed?.editMode?.cm;
      cm?.focus?.();

      if (caretPosition === "end") {
        const length = cm?.state?.doc?.length;
        if (typeof length === "number") {
          cm?.dispatch?.({ selection: { anchor: length, head: length } });
        }
      }
    } catch (error) {
      console.error("Simple Journal: embedded editor failed to focus", error);
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

  onUnusable(callback: () => void): void {
    this.unusableCallback = callback;
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
      console.error("Simple Journal: embedded editor failed to remeasure", error);
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
    this.unusableCallback = null;
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
    if (embed) this.teardownEmbed(embed);
    this.containerEl?.remove();
    this.containerEl = null;
  }

  private teardownEmbed(embed: MarkdownEmbed): void {
    try {
      embed.unload?.();
      embed.onunload?.();
    } catch (error) {
      console.error("Simple Journal: embedded editor failed to unload", error);
    }
  }

  /**
   * Tags whichever `.markdown-embed-content` pane actually contains the CM6
   * editor with a class the CSS keys off, so the "hide the preview pane,
   * show the editor pane" rule doesn't depend on `:has()` support — some
   * embedded webviews Obsidian can run on may not have it. Tries once
   * synchronously, then once more on the next tick as a safety net in case
   * the CM6 DOM is constructed asynchronously on some version rather than
   * synchronously as the spike observed.
   *
   * If NEITHER pass finds a pane to tag, this calls `markUnusable()`:
   * leaving nothing tagged would mean the blanket `display: none` on
   * `.markdown-embed-content` hides BOTH panes, leaving the user with a
   * blank, unusable entry while `isUsable()` still reported true at mount
   * time — the exact failure removing the CSS `:has()` selector was meant
   * to eliminate, just relocated into this method instead.
   */
  private tagEditorPane(): void {
    // Captured so the deferred pass can tell a remount happened in the
    // meantime (this.embed now points at a different instance) and skip
    // rather than wrongly declare the NEW mount unusable over the OLD one's
    // missing DOM.
    const mountedEmbed = this.embed;

    const tag = (): boolean => {
      const container = this.containerEl;
      if (!container) return false;
      let tagged = false;
      for (const pane of Array.from(container.querySelectorAll(".markdown-embed-content"))) {
        if (pane.querySelector(".cm-editor")) {
          pane.classList.add("journal-entry-embed-editor-pane");
          tagged = true;
        }
      }
      return tagged;
    };

    if (tag()) return;

    window.setTimeout(() => {
      if (this.embed !== mountedEmbed) return;
      if (!tag()) this.markUnusable();
    }, 0);
  }
}
