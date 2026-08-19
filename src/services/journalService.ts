import { App, Component, TAbstractFile, TFile, TFolder } from "obsidian";
import type { JournalEntry } from "../journal/entry";
import type { EntryRepository } from "../journal/entryRepository";
import { findByPath, insertSorted, removeByPath } from "./entryIndex";

export type JournalChange =
  | { kind: "added"; entry: JournalEntry }
  | { kind: "removed"; path: string }
  | { kind: "content"; entry: JournalEntry }
  | { kind: "moved"; entry: JournalEntry }
  /**
   * "Something changed at a scale finer-grained changes can't describe —
   * rebuild your view of the index from scratch." Currently only emitted
   * for a rename of the journal folder itself (or an ancestor/descendant of
   * it): see the "folderReload" handling in `flush()`. Always the sole
   * entry in its batch.
   */
  | { kind: "reload" };

const DEBOUNCE_MS = 300;
/** How long a self-write is remembered if no modify/changed event ever arrives for it. */
const SELF_WRITE_TTL_MS = 2000;
/** Sentinel pending-map key for a debounced folder-level reload; never a real vault path. */
const FOLDER_RELOAD_KEY = "__journal-folder-reload__";

/**
 * Owns the in-memory index of entries and translates vault events into
 * timeline-level changes. Stores only `{ file, created }` — never content —
 * so the index stays cheap at tens of thousands of entries.
 *
 * `getEntries()` returns the live backing array, not a copy: `JournalView`
 * aliases it as its own paging cursor list, so an `insertSorted`/`removeByPath`
 * done here (inside `applyUpsert`/`applyRemoval`, always before the changes
 * they produce are emitted) is already reflected by the time listeners run,
 * with no separate hand-off.
 *
 * Changes are delivered in BATCHES — one array per debounce flush, not one
 * callback per change — so a caller that needs to do expensive bookkeeping
 * once per burst (e.g. `JournalView` recomputing which day groups are now
 * empty) can do it once per batch instead of once per change.
 */
export class JournalService extends Component {
  private index: JournalEntry[] = [];
  private listeners = new Set<(changes: JournalChange[]) => void>();
  private selfWrites = new Map<string, number>();
  private pending = new Map<string, "upsert" | "remove" | "renameSource" | "folderReload">();
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
        if (file instanceof TFolder) {
          // A folder rename never fires per-descendant "rename" events on
          // every Obsidian version this plugin has been verified against
          // (unconfirmed without a live vault either way — see
          // docs/manual-testing.md). Whether or not those also fire,
          // unconditionally rebuilding here is correct: `rebuild()` just
          // re-derives the whole index from `listEntries()`, so it's a
          // no-op on top of whatever per-file events (if any) already did.
          if (this.isJournalFolderPath(oldPath) || this.isJournalFolderPath(file.path)) {
            this.queuePath(FOLDER_RELOAD_KEY, "folderReload");
          }
          return;
        }

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
    this.selfWrites.clear();
  }

  /** Rebuilds the index from scratch, e.g. after the journal folder setting changes. */
  rebuild(): void {
    this.index = this.repository.listEntries();
  }

  /** The live, sorted index. See this class's doc for why this is not a copy. */
  getEntries(): JournalEntry[] {
    return this.index;
  }

  /**
   * Directly inserts/repositions a known-good `entry` in the index, without
   * waiting for (or trusting the timing of) the vault/metadata-cache events
   * for the write that produced it.
   *
   * The event path this class's `onload` listeners drive re-derives an
   * entry from `EntryRepository.entryFor`, which reads
   * `metadataCache.getFileCache()` — not guaranteed to already reflect a
   * write whose own promise has merely resolved; the metadata cache's
   * re-parse is a separate pipeline with its own timing, and the debounce
   * on top of it adds up to `DEBOUNCE_MS` more. A caller that already knows
   * the exact entry it just wrote — e.g. `JournalView.changeEntryTime`,
   * right after writing a `created` value it computed itself — can use
   * this to make the index correct immediately, and use the returned
   * `JournalChange` to update its own rendering right away, rather than at
   * the mercy of that timing.
   *
   * Does not emit to `onChange` listeners: unlike the debounced event path,
   * the caller here already knows exactly what changed and is expected to
   * act on the returned value itself. Idempotent with the eventual real
   * vault/metadata event for the same write: when it arrives, `applyUpsert`
   * re-derives the entry from disk/metadata and finds it already matches
   * what this applied, reporting harmless "content" rather than a second
   * "moved".
   */
  applyKnownEntry(entry: JournalEntry): JournalChange {
    return this.applyUpsert(entry);
  }

  onChange(callback: (changes: JournalChange[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Marks a path as about to be written by this plugin, so the resulting
   * `modify`/`changed` events do not bounce back and re-render the entry
   * being typed in. TTL-bounded: if neither event ever arrives (e.g. the
   * write itself failed before touching disk), the mark cannot leak forever
   * and silently swallow a later, genuinely external change to the same path.
   * Sweeps every already-expired mark first, so `selfWrites` cannot grow
   * without bound across a long session purely from writes whose `modify`
   * happened to never arrive.
   */
  markSelfWrite(path: string): void {
    this.sweepExpiredSelfWrites();
    this.selfWrites.set(path, Date.now());
  }

  private sweepExpiredSelfWrites(): void {
    const now = Date.now();
    for (const [path, stamp] of this.selfWrites) {
      if (now - stamp >= SELF_WRITE_TTL_MS) this.selfWrites.delete(path);
    }
  }

  private consumeSelfWrite(path: string): boolean {
    const stamp = this.selfWrites.get(path);
    if (stamp === undefined) return false;

    this.selfWrites.delete(path);
    return Date.now() - stamp < SELF_WRITE_TTL_MS;
  }

  /**
   * True when `folderPath` IS the configured journal folder, contains it, or
   * is contained by it — i.e. renaming it can move entries out from under
   * (or into) the journal root. Compared as plain path segments, since both
   * sides come from the vault's own path strings (this method's caller) and
   * `EntryRepository.rootPath()` (already resolved to on-disk casing).
   */
  private isJournalFolderPath(folderPath: string): boolean {
    const root = this.repository.rootPath();
    if (folderPath === root) return true;
    if (root.startsWith(`${folderPath}/`)) return true;
    if (folderPath.startsWith(`${root}/`)) return true;
    return false;
  }

  private queue(file: TAbstractFile, action: "upsert" | "remove"): void {
    if (!(file instanceof TFile)) return;
    this.queuePath(file.path, action);
  }

  private queuePath(path: string, action: "upsert" | "remove" | "renameSource" | "folderReload"): void {
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
   * has already been torn down.
   *
   * A pending "folderReload" pre-empts everything else in the batch:
   * `rebuild()` re-derives the whole index from scratch, so any other
   * pending per-file change in the same batch is already reflected by it,
   * and re-emitting them individually afterward would be redundant at best
   * and, since some of those paths may no longer resolve to anything
   * sensible after a folder rename, confusing at worst.
   */
  private flush(): void {
    const pending = [...this.pending.entries()];
    this.pending.clear();

    if (pending.some(([, action]) => action === "folderReload")) {
      this.rebuild();
      this.emitBatch([{ kind: "reload" }]);
      return;
    }

    const changes: JournalChange[] = [];

    for (const [path, action] of pending) {
      if (action === "remove") {
        const change = this.applyRemoval(path);
        if (change) changes.push(change);
      } else if (action === "renameSource") {
        changes.push(this.applyRenameSource(path));
      }
    }

    for (const [path, action] of pending) {
      if (action !== "upsert") continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      const entry = file instanceof TFile ? this.repository.entryFor(file) : null;

      if (!entry) {
        // Not (or no longer) an entry — e.g. moved out of the journal folder.
        const change = this.applyRemoval(path);
        if (change) changes.push(change);
        continue;
      }

      changes.push(this.applyUpsert(entry));
    }

    if (changes.length > 0) this.emitBatch(changes);
  }

  private applyRemoval(path: string): JournalChange | null {
    if (removeByPath(this.index, path) < 0) return null;
    return { kind: "removed", path };
  }

  /**
   * The old-path half of a rename — queued as "renameSource", not a plain
   * "remove". Obsidian mutates the renamed TFile in place rather than
   * handing back a new object, so by the time this flushes, `this.index`
   * has nothing keyed by `path` any more: whatever entry used to live there
   * (if any) already reads its NEW path through that same object, and is
   * found instead by the "upsert" queued alongside this for the new path.
   * `removeByPath` is attempted anyway, for defensiveness (a harmless no-op
   * in the ordinary case), but unlike `applyRemoval`, "removed" is returned
   * UNCONDITIONALLY regardless of its result.
   *
   * That unconditional return is the entire point: `JournalView.rendered` is
   * keyed by the path an entry was actually rendered at — this exact stale
   * path — and has no other way to learn that rendering needs tearing down.
   * `applyRemoval`'s guard (only report if the index actually had something
   * there) is correct for a genuine delete but wrong here, where the index
   * never had anything keyed at `path` to begin with, precisely because the
   * rename already happened before this ever runs. Safe to report even when
   * `path` was never a real entry (nothing outside the journal folder is
   * ever rendered, so `JournalView` simply no-ops on it).
   */
  private applyRenameSource(path: string): JournalChange {
    removeByPath(this.index, path);
    return { kind: "removed", path };
  }

  private applyUpsert(entry: JournalEntry): JournalChange {
    const existing = findByPath(this.index, entry.file.path);

    if (!existing) {
      insertSorted(this.index, entry);
      return { kind: "added", entry };
    }

    if (existing.created.getTime() !== entry.created.getTime()) {
      removeByPath(this.index, entry.file.path);
      insertSorted(this.index, entry);
      return { kind: "moved", entry };
    }

    // Same `created`, so `existing` already stands for this file correctly
    // (its `.file` is the very TFile Obsidian mutated in place for a rename —
    // see `applyRenameSource`'s doc — and `.created` matches `entry`'s own).
    // Deliberately returns `existing`, NOT the freshly-parsed `entry`: this
    // is the one `applyUpsert` branch that never calls `insertSorted`/
    // `removeByPath`, so `entry` is never spliced into `this.index` — a
    // caller that locates its target via `this.index.indexOf(...)` (e.g.
    // `JournalView.insertEntryInPlace`, reachable here after a same-
    // timestamp rename) needs the exact object the index already holds, or
    // that lookup fails by reference and silently drops the change. The
    // "added"/"moved" branches above already maintain that invariant by
    // construction (`entry` IS what they just inserted); this restores it
    // for "content" too, rather than leaving indexOf-by-reference callers to
    // special-case it themselves.
    return { kind: "content", entry: existing };
  }

  private emitBatch(changes: JournalChange[]): void {
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch (error) {
        console.error("Journal Entries: change listener failed", error);
      }
    }
  }
}
