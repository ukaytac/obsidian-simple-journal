import type { App, TFile } from "obsidian";

/**
 * One entry's editing surface. Every implementation detail of how text gets
 * edited lives behind this interface, so the internal-API implementation can be
 * swapped for the fallback — or for a future public API — in one place.
 */
export interface EntryEditor {
  /**
   * Renders the editor into `el` for `file`. `file` is null for an
   * uncommitted composer.
   *
   * `initialValue` is the construction-time content: it seeds the editor
   * without being treated as an edit (no `onChange` callback fires for it).
   * This is the path the internal embedded editor requires — it is
   * constructed with its content and must not report a spurious change.
   * Use `setValue` for every value the editor receives after mount, e.g. to
   * absorb an edit made from another pane. A `setValue` call that arrives
   * before `mount` is buffered and applied as part of mounting rather than
   * being dropped.
   *
   * A second `mount` call tears down any editor this instance already
   * holds first — but does so without flushing it, so any unflushed text
   * in that prior editor is discarded. Not reachable today (nothing
   * remounts a live `EntryEditor`), but a future caller that does must
   * `flush()` first.
   */
  mount(el: HTMLElement, file: TFile | null, initialValue: string): void;
  /**
   * The editor's current text. Stays truthful even after `destroy()`: a
   * focused element removed from the DOM never fires `blur` in Chromium, so
   * `destroy()` cannot rely on that to capture the last value, and callers
   * that read this at teardown (e.g. to flush a pending debounced save)
   * must not see it collapse to `""`.
   */
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  /** True when this editor currently holds the keyboard focus. */
  hasFocus(): boolean;
  /** Called on every edit. Registered before mount. */
  onChange(callback: (value: string) => void): void;
  /** Called when the editor loses focus. */
  onBlur(callback: () => void): void;
  /**
   * Commits whatever text this editor currently holds, as if the user had
   * just triggered a change, without waiting for a debounce or an event
   * from the editing surface itself. Callers invoke this before `destroy()`
   * so an in-flight edit is not lost to teardown.
   */
  flush(): void;
  /**
   * "You may be visible again — re-measure if you need to." A no-op unless
   * a previous resize bailed out because the editor was hidden (e.g. its
   * leaf was `display: none` in a background tab while an external
   * `setValue` arrived). `ItemView` inherits `onResize()` (`@since 0.9.7`),
   * which Obsidian calls when a leaf becomes visible again; the view is
   * expected to call `remeasure()` from there so a stale height left by a
   * background-tab edit is corrected once the tab is switched back to.
   */
  remeasure(): void;
  destroy(): void;
  /**
   * Checked after `mount`. Implemented only by editors that can fail at mount
   * time; when it returns false the caller destroys this editor and mounts a
   * `TextareaEditor` instead. Absent means "always usable".
   */
  isUsable?(): boolean;
}

export type EntryEditorFactory = {
  create(): EntryEditor;
  /**
   * True when the internal API was unavailable at the single load-time
   * probe (`hasEmbeddedEditorApi`, checked once when the factory is
   * created) and every editor this factory creates is therefore a
   * `TextareaEditor`. It does not reflect per-entry fallbacks: an
   * individual editor's `isUsable()` can still fail after a successful
   * load-time probe, in which case that one entry falls back while this
   * flag remains false. Do not use it to decide whether any particular
   * mounted editor is the fallback.
   */
  usingFallback: boolean;
};

/**
 * True when Obsidian exposes the internal embedded-editor registry this plugin
 * uses for full-fidelity editing. See docs/editor-embed-api.md.
 */
export function hasEmbeddedEditorApi(app: App): boolean {
  const registry = (app as unknown as {
    embedRegistry?: { embedByExtension?: Record<string, unknown> };
  }).embedRegistry?.embedByExtension;

  return typeof registry?.md === "function";
}
