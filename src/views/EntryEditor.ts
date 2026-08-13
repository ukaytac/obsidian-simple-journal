import type { App, TFile } from "obsidian";

/**
 * One entry's editing surface. Every implementation detail of how text gets
 * edited lives behind this interface, so the internal-API implementation can be
 * swapped for the fallback — or for a future public API — in one place.
 */
export interface EntryEditor {
  /** Renders the editor into `el` for `file`. `file` is null for an uncommitted composer. */
  mount(el: HTMLElement, file: TFile | null, initialValue: string): void;
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  /** True when this editor currently holds the keyboard focus. */
  hasFocus(): boolean;
  /** Called on every edit. Registered before mount. */
  onChange(callback: (value: string) => void): void;
  /** Called when the editor loses focus. */
  onBlur(callback: () => void): void;
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
  /** True when the internal API was unavailable and the fallback is in use. */
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
