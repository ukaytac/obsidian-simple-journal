import { App, Component, TAbstractFile, TFile } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type { EntryRepository } from "../journal/entryRepository";
import { findByPath, insertSorted, removeByPath } from "./entryIndex";

export type JournalChange =
  | { kind: "added"; entry: JournalEntry }
  | { kind: "removed"; path: string }
  | { kind: "content"; entry: JournalEntry }
  | { kind: "moved"; entry: JournalEntry };

const DEBOUNCE_MS = 300;
/** How long a self-write is remembered if no modify/changed event ever arrives for it. */
const SELF_WRITE_TTL_MS = 2000;

/**
 * Owns the in-memory index of entries and translates vault events into
 * timeline-level changes. Stores only `{ file, created }` — never content —
 * so the index stays cheap at tens of thousands of entries.
 *
 * `getEntries()` returns the live backing array, not a copy: `JournalView`
 * aliases it as its own paging cursor list, so an `insertSorted`/`removeByPath`
 * done here (inside `applyUpsert`/`applyRemoval`, always before `emit`) is
 * already reflected by the time listeners run, with no separate hand-off.
 */
export class JournalService extends Component {
  private index: JournalEntry[] = [];
  private listeners = new Set<(change: JournalChange) => void>();
  private selfWrites = new Map<string, number>();
  private pending = new Map<string, "upsert" | "remove" | "renameSource">();
  private flushHandle: number | null = null;

  constructor(
    private readonly app: App,
    private readonly repository: EntryRepository,
  ) {
    super();
  }

  onload(): void {
    this.rebuild();

    this.registerEvent(this.app.vault.on("create", (file) => this.queue(file, "upsert")));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.consumeSelfWrite(file.path)) return;
        this.queue(file, "upsert");
      }),
    );
    this.registerEvent(this.app.vault.on("delete", (file) => this.queue(file, "remove")));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Queued as "renameSource", not a plain "remove": see
        // `applyRenameSource`'s doc for why a plain removal would silently
        // never fire here.
        this.queuePath(oldPath, "renameSource");
        this.queue(file, "upsert");
      }),
    );
    // The metadata cache re-indexes and fires its own "changed" event after
    // every vault write, independently of "modify" — both must be checked
    // against the same self-write mark, or a write that lands its "modify"
    // suppression first would still bounce back in through this listener a
    // moment later. `consumeSelfWrite` deletes the mark on whichever of the
    // two arrives first; the other sees no mark and queues a normal upsert —
    // harmless, since it reads back the content this plugin itself just
    // wrote (see `JournalView.refreshEntryContent`'s equality check, and
    // that neither `EntryEditor` implementation's `setValue` ever re-fires
    // `onChange`), not a loop.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.consumeSelfWrite(file.path)) return;
        this.queue(file, "upsert");
      }),
    );
  }

  onunload(): void {
    if (this.flushHandle !== null) window.clearTimeout(this.flushHandle);
    this.listeners.clear();
  }

  /** Rebuilds the index from scratch, e.g. after the journal folder setting changes. */
  rebuild(): void {
    this.index = this.repository.listEntries();
  }

  /** The live, sorted index. See this class's doc for why this is not a copy. */
  getEntries(): JournalEntry[] {
    return this.index;
  }

  onChange(callback: (change: JournalChange) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Marks a path as about to be written by this plugin, so the resulting
   * `modify`/`changed` events do not bounce back and re-render the entry
   * being typed in. TTL-bounded: if neither event ever arrives (e.g. the
   * write itself failed before touching disk), the mark cannot leak forever
   * and silently swallow a later, genuinely external change to the same path.
   */
  markSelfWrite(path: string): void {
    this.selfWrites.set(path, Date.now());
  }

  private consumeSelfWrite(path: string): boolean {
    const stamp = this.selfWrites.get(path);
    if (stamp === undefined) return false;

    this.selfWrites.delete(path);
    return Date.now() - stamp < SELF_WRITE_TTL_MS;
  }

  private queue(file: TAbstractFile, action: "upsert" | "remove"): void {
    if (!(file instanceof TFile)) return;
    this.queuePath(file.path, action);
  }

  private queuePath(path: string, action: "upsert" | "remove" | "renameSource"): void {
    this.pending.set(path, action);

    if (this.flushHandle !== null) window.clearTimeout(this.flushHandle);
    this.flushHandle = window.setTimeout(() => {
      this.flushHandle = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  /**
   * Every removal in this batch (a genuine delete, or the stale old-path
   * half of a rename) is applied before any upsert, in a first pass —
   * regardless of the order `this.pending`'s entries happen to iterate in.
   * `Map` preserves insertion order, and a path only moves within that order
   * on its FIRST use in the batch; a later `.set()` on an already-present
   * key updates the value in place without moving it. So if some earlier,
   * unrelated event already queued an action for what is about to become a
   * rename's new path, that path's position could end up ahead of the
   * rename's own old-path removal purely by insertion-order accident.
   * `JournalView`'s handling for a rename's old path depends on that
   * removal running first — its "content"/"moved" handling only falls back
   * to inserting a fresh rendering when nothing is rendered under the new
   * path yet, which is only reliably true once the stale old-path rendering
   * has already been torn down. Two passes over the same already-captured
   * `pending` array costs nothing extra it wasn't already going to do.
   */
  private flush(): void {
    const pending = [...this.pending.entries()];
    this.pending.clear();

    for (const [path, action] of pending) {
      if (action === "remove") this.applyRemoval(path);
      else if (action === "renameSource") this.applyRenameSource(path);
    }

    for (const [path, action] of pending) {
      if (action !== "upsert") continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      const entry = file instanceof TFile ? this.repository.entryFor(file) : null;

      if (!entry) {
        // Not (or no longer) an entry — e.g. moved out of the journal folder.
        this.applyRemoval(path);
        continue;
      }

      this.applyUpsert(entry);
    }
  }

  private applyRemoval(path: string): void {
    if (removeByPath(this.index, path) < 0) return;
    this.emit({ kind: "removed", path });
  }

  /**
   * The old-path half of a rename — queued as "renameSource", not a plain
   * "remove". Obsidian mutates the renamed TFile in place rather than
   * handing back a new object, so by the time this flushes, `this.index`
   * has nothing keyed by `path` any more: whatever entry used to live there
   * (if any) already reads its NEW path through that same object, and is
   * found instead by the "upsert" queued alongside this for the new path.
   * `removeByPath` is attempted anyway, for defensiveness (a harmless no-op
   * in the ordinary case), but unlike `applyRemoval`, "removed" is emitted
   * UNCONDITIONALLY regardless of its result.
   *
   * That unconditional emit is the entire point: `JournalView.rendered` is
   * keyed by the path an entry was actually rendered at — this exact stale
   * path — and has no other way to learn that rendering needs tearing down.
   * `applyRemoval`'s guard (only emit if the index actually had something
   * there) is correct for a genuine delete but wrong here, where the index
   * never had anything keyed at `path` to begin with, precisely because the
   * rename already happened before this ever runs. Safe to emit even when
   * `path` was never a real entry (nothing outside the journal folder is
   * ever rendered, so `JournalView` simply no-ops on it).
   */
  private applyRenameSource(path: string): void {
    removeByPath(this.index, path);
    this.emit({ kind: "removed", path });
  }

  private applyUpsert(entry: JournalEntry): void {
    const existing = findByPath(this.index, entry.file.path);

    if (!existing) {
      insertSorted(this.index, entry);
      this.emit({ kind: "added", entry });
      return;
    }

    if (existing.created.getTime() !== entry.created.getTime()) {
      removeByPath(this.index, entry.file.path);
      insertSorted(this.index, entry);
      this.emit({ kind: "moved", entry });
      return;
    }

    this.emit({ kind: "content", entry });
  }

  private emit(change: JournalChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("Journal Entries: change listener failed", error);
      }
    }
  }
}
