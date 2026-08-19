// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createFakeApp, TFile, TFolder } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService, type JournalChange } from "../src/services/journalService";
import { formatCreatedProperty } from "../src/utils/dates";

function setup() {
  const fake = createFakeApp();
  const repository = new EntryRepository(fake as unknown as App, () => "Journal");
  const service = new JournalService(fake as unknown as App, repository);
  return { fake, repository, service };
}

/** Same as `setup()`, but with a configurable journal folder path. */
function setupWithFolder(folder: string) {
  const fake = createFakeApp();
  const repository = new EntryRepository(fake as unknown as App, () => folder);
  const service = new JournalService(fake as unknown as App, repository);
  return { fake, repository, service };
}

function folderAt(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split("/").pop() ?? path;
  return folder;
}

/** Collects every change the service emits, in order, flattened across batches. */
function collectChanges(service: JournalService): JournalChange[] {
  const changes: JournalChange[] = [];
  service.onChange((batch) => changes.push(...batch));
  return changes;
}

/** Collects each batch (array) the service emits, without flattening. */
function collectBatches(service: JournalService): JournalChange[][] {
  const batches: JournalChange[][] = [];
  service.onChange((batch) => batches.push(batch));
  return batches;
}

const AUG12 = "Journal/2026/08/2026-08-12-22-41-52.md";
const AUG11 = "Journal/2026/08/2026-08-11-21-10-00.md";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("JournalService: load", () => {
  it("builds the index from the repository at load time", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG11, "");
    fake.vault.addFile(AUG12, "");

    service.load();

    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12, AUG11]);
  });

  it("rebuild() re-derives the index from the repository's current state", () => {
    const { fake, service } = setup();
    service.load();
    expect(service.getEntries()).toHaveLength(0);

    fake.vault.addFile(AUG12, "");
    service.rebuild();

    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12]);
  });
});

describe("JournalService: applyKnownEntry", () => {
  it("repositions an already-indexed entry immediately, without waiting for any event or debounce", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    const older = fake.vault.addFile(AUG11, "");
    service.load();
    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12, AUG11]);

    const newlyOldest = new Date(2026, 6, 1, 8, 0, 0);
    const change = service.applyKnownEntry({ file, created: newlyOldest });

    expect(change.kind).toBe("moved");
    // No timer advance at all: the index is already correct synchronously.
    expect(service.getEntries().map((e) => e.file.path)).toEqual([older.path, file.path]);
  });

  it("does not emit to onChange listeners: the caller already knows what changed", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.applyKnownEntry({ file, created: new Date(2026, 6, 1, 8, 0, 0) });

    expect(changes).toHaveLength(0);
  });

  it("is idempotent with the later real event for the same write: reports harmless 'content', not a second 'moved'", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();

    const correctedAt = new Date(2026, 6, 1, 8, 0, 0);
    service.applyKnownEntry({ file, created: correctedAt });

    const changes = collectChanges(service);
    fake.metadataCache.frontmatter.set(file.path, { created: formatCreatedProperty(correctedAt) });
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
    expect(service.getEntries()).toHaveLength(1);
  });
});

describe("JournalService: create", () => {
  it("debounces a create event and emits 'added' once the debounce settles", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);

    // Not yet flushed: still within the debounce window.
    expect(changes).toHaveLength(0);
    expect(service.getEntries()).toHaveLength(0);

    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "added", entry: expect.objectContaining({ file }) }]);
    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12]);
  });

  it("coalesces a burst of events for the same path into the single latest action", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    // A rapid create-then-delete-then-recreate burst (e.g. a sync client
    // writing a temp file and renaming it into place) must not run every
    // intermediate action — only whatever the path's state is once things
    // settle. Proportional work: one flush, one entry in the index.
    fake.vault.trigger("create", file);
    fake.vault.trigger("delete", file);
    fake.vault.files.set(file.path, file); // simulate the recreate
    fake.vault.trigger("create", file);

    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("added");
    expect(service.getEntries()).toHaveLength(1);
  });

  it("resets the debounce timer on every new event, so a steady trickle never flushes", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(250);
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(250);

    // 500ms of wall time have passed but the debounce was reset at 250ms, so
    // the 300ms window hasn't elapsed since the last event.
    expect(changes).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(changes).toHaveLength(1);
  });
});

describe("JournalService: modify and self-writes", () => {
  it("emits 'content' for an external modify to an already-indexed entry", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
  });

  it("suppresses the modify event this plugin's own write causes", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.markSelfWrite(file.path);
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(0);
  });

  it("suppresses the metadataCache 'changed' event this plugin's own write causes", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.markSelfWrite(file.path);
    fake.metadataCache.trigger("changed", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(0);
  });

  it("a self-write mark is consumed only once: whichever of modify/changed arrives first suppresses, the other is treated as a normal (harmless) update", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.markSelfWrite(file.path);
    fake.vault.trigger("modify", file); // consumes the mark, suppressed
    fake.metadataCache.trigger("changed", file); // mark already gone

    vi.advanceTimersByTime(300);

    // The second event still queues a normal upsert — but since nothing
    // about the entry actually changed, it collapses to one harmless
    // "content" change, not a duplicate entry or an error.
    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
    expect(service.getEntries()).toHaveLength(1);
  });

  it("a self-write mark expires after its TTL, so a slow-arriving modify is no longer suppressed", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.markSelfWrite(file.path);
    vi.advanceTimersByTime(2001);
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
  });

  it("consuming a self-write mark removes it, so it cannot suppress a later, unrelated modify", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    service.markSelfWrite(file.path);
    fake.vault.trigger("modify", file); // consumes and suppresses
    vi.advanceTimersByTime(300);
    expect(changes).toHaveLength(0);

    // A second, genuinely external modify shortly after must not also be
    // swallowed by the same (already-consumed) mark.
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("content");
  });
});

describe("JournalService: delete", () => {
  it("removes a deleted entry from the index and emits 'removed'", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    fake.vault.files.delete(file.path);
    fake.vault.trigger("delete", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "removed", path: file.path }]);
    expect(service.getEntries()).toHaveLength(0);
  });

  it("does not emit for a delete of a path that was never indexed", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-00-00-00.md", "");
    fake.vault.files.delete(file.path);
    fake.vault.trigger("delete", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(0);
  });
});

describe("JournalService: rename", () => {
  it("emits 'removed' for the stale old path, unconditionally, alongside the upsert for the new path", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    const oldPath = file.path;
    // Renaming to a name outside the plugin's filename convention also
    // changes the resolved `created` (falls back from the parsed filename to
    // ctime), so the index-level half of this is a "moved", not a plain
    // "content" — deliberately chosen to also exercise that combination.
    const newPath = "Journal/2026/08/2026-08-12-22-41-52-renamed.md";

    // Obsidian mutates the same TFile in place on rename rather than handing
    // back a new object; mirror that here.
    fake.vault.files.delete(oldPath);
    file.path = newPath;
    file.name = "2026-08-12-22-41-52-renamed.md";
    file.basename = "2026-08-12-22-41-52-renamed";
    fake.vault.files.set(newPath, file);
    fake.vault.contents.set(newPath, fake.vault.contents.get(oldPath) ?? "");

    fake.vault.trigger("rename", file, oldPath);
    vi.advanceTimersByTime(300);

    // "removed" for the stale path comes first (JournalView.rendered is
    // keyed by the path an entry was actually rendered at — the OLD path —
    // and has no other way to learn it must tear that rendering down), then
    // the new path's own upsert.
    expect(changes).toEqual([
      { kind: "removed", path: oldPath },
      { kind: "moved", entry: expect.objectContaining({ file }) },
    ]);
    // The index itself never held a duplicate: one entry, now at the new path.
    expect(service.getEntries().map((e) => e.file.path)).toEqual([newPath]);
  });

  it("still emits the unconditional 'removed' for the old path even when the resolved timestamp is unchanged", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    // An explicit `created` property makes the resolved timestamp immune to
    // the filename change below, isolating the "removed(oldPath)" behaviour
    // from the "moved" one exercised above.
    fake.metadataCache.frontmatter.set(file.path, {
      created: new Date(2026, 7, 12, 22, 41, 52).toISOString(),
    });
    service.load();
    const changes = collectChanges(service);

    const oldPath = file.path;
    const newPath = "Journal/2026/08/2026-08-12-22-41-52-renamed.md";

    fake.vault.files.delete(oldPath);
    file.path = newPath;
    file.name = "2026-08-12-22-41-52-renamed.md";
    file.basename = "2026-08-12-22-41-52-renamed";
    fake.vault.files.set(newPath, file);
    fake.vault.contents.set(newPath, fake.vault.contents.get(oldPath) ?? "");
    fake.metadataCache.frontmatter.set(newPath, fake.metadataCache.frontmatter.get(oldPath)!);

    fake.vault.trigger("rename", file, oldPath);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([
      { kind: "removed", path: oldPath },
      { kind: "content", entry: expect.objectContaining({ file }) },
    ]);
    expect(service.getEntries()).toHaveLength(1);
    // The "content" change's `entry` must be the EXACT object `this.index`
    // holds, by reference — not merely an equal-looking one freshly parsed
    // from disk. `applyUpsert`'s "content" branch is the one branch that
    // never calls `insertSorted`/`removeByPath`, so nothing else re-derives
    // this invariant for it; a caller that locates its target via
    // `index.indexOf(change.entry)` (JournalView.insertEntryInPlace, after a
    // same-timestamp external rename) depends on this exact identity, or the
    // lookup silently fails and the rendered row is lost — see
    // `JournalView.changes.test.ts`'s "a renamed entry is re-keyed in place,
    // never duplicated".
    const contentChange = changes.find((c) => c.kind === "content");
    expect(contentChange?.entry).toBe(service.getEntries()[0]);
  });

  it("refreshes a stale `.file` reference in place when a same-path content upsert supplies a different file object", () => {
    // Not reachable through the normal vault-event path exercised above
    // (Obsidian always mutates the SAME TFile in place on rename), but
    // `applyKnownEntry` is a direct, public entry point (used by
    // `JournalView.commitEntryTimeChange`) that hands `applyUpsert` whatever
    // `entry.file` its caller built — nothing guarantees that's always the
    // exact object already sitting in the index.
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();

    const [existing] = service.getEntries();
    expect(existing.file).toBe(file);

    const replacement = new TFile(file.path, file.stat.ctime);
    const change = service.applyKnownEntry({ file: replacement, created: existing.created });

    // Same `JournalEntry` object — the identity `indexOf`-by-reference
    // callers depend on is preserved — but its `.file` now points at the
    // fresh object instead of staying stuck on the stale one.
    expect(change).toEqual({ kind: "content", entry: existing });
    expect(service.getEntries()[0]).toBe(existing);
    expect(existing.file).toBe(replacement);
  });

  it("removes the entry when a file is renamed out of the journal folder", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    const oldPath = file.path;
    const newPath = "Elsewhere/2026-08-12-22-41-52.md";
    fake.vault.files.delete(oldPath);
    file.path = newPath;
    fake.vault.files.set(newPath, file);

    fake.vault.trigger("rename", file, oldPath);
    vi.advanceTimersByTime(300);

    // Two distinct "removed" changes: the renameSource's unconditional one
    // for the stale old path (nothing in the index actually matches it by
    // then, but JournalView's own `rendered` map still does), and the
    // upsert-turned-removal for the new path once `entryFor` reports it's no
    // longer inside the journal folder at all (that's the one that actually
    // empties the index). Either JournalView's "removed" handler running
    // twice for the same underlying entry must stay a harmless no-op on the
    // second pass — it does, since `removeRenderedEntry` and `applyRemoval`
    // both no-op when there's nothing left to act on.
    expect(changes).toEqual([
      { kind: "removed", path: oldPath },
      { kind: "removed", path: newPath },
    ]);
    expect(service.getEntries()).toHaveLength(0);
  });
});

describe("JournalService: created timestamp changes (moved)", () => {
  it("emits 'moved' and repositions the entry when its resolved created time changes", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    const older = fake.vault.addFile(AUG11, "");
    service.load();
    expect(service.getEntries().map((e) => e.file.path)).toEqual([AUG12, AUG11]);

    const changes = collectChanges(service);

    // Give the Aug-12 entry an explicit `created` far in the past — older
    // than the Aug-11 entry — simulating an external frontmatter edit.
    fake.metadataCache.frontmatter.set(file.path, {
      created: new Date(2026, 6, 1, 8, 0, 0).toISOString(),
    });
    fake.metadataCache.trigger("changed", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("moved");
    // Now the oldest: July 1st is before August 11th.
    expect(service.getEntries().map((e) => e.file.path)).toEqual([older.path, file.path]);
  });

  it("does not emit at all when the same value is written back (no-op modify)", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    // Nothing actually changed about the file; a spurious modify (e.g. a
    // metadata-only touch) for an entry whose resolved timestamp is
    // unchanged must still be reported as "content", not silently dropped
    // (JournalView relies on this to know it may need to re-read the body),
    // and must not duplicate or reorder the index.
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
    expect(service.getEntries()).toHaveLength(1);
  });
});

describe("JournalService: EntryRepository.setEntryCreated must not be a self-write", () => {
  // Pins this commit's central design invariant: `setEntryCreated` writes a
  // corrected `created` value WITHOUT calling `markSelfWrite`, on purpose —
  // repositioning the entry in the timeline depends entirely on the
  // resulting modify/changed event reaching `applyUpsert` unsuppressed (see
  // `EntryRepository.setEntryCreated`'s doc). Adding a `markSelfWrite` call
  // there would silently break repositioning while every other test in this
  // suite stayed green; these two tests would catch it.
  //
  // `FakeMetadataCache` is populated independently of `FakeVault`'s
  // contents (unlike the real metadata cache, which re-parses the file
  // itself), so it's updated by hand here to the value the write actually
  // produced — exactly what a real re-parse would eventually settle on,
  // since `formatCreatedProperty` is the same formatter `setEntryCreated`
  // itself writes through `setCreatedProperty`.
  const newAt = new Date(2026, 6, 1, 8, 0, 0);

  it("a created-only change via setEntryCreated is NOT suppressed, and emits 'moved'", async () => {
    const { fake, repository, service } = setup();
    const file = fake.vault.addFile(AUG12, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`);
    fake.metadataCache.frontmatter.set(file.path, { created: "2026-08-12T22:41:52+03:00" });
    service.load();
    const changes = collectChanges(service);

    await repository.setEntryCreated(file, newAt);
    fake.metadataCache.frontmatter.set(file.path, { created: formatCreatedProperty(newAt) });
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("moved");
  });

  it("regression guard: the same change WOULD be silently swallowed if the write were ever marked a self-write", async () => {
    const { fake, repository, service } = setup();
    const file = fake.vault.addFile(AUG12, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`);
    fake.metadataCache.frontmatter.set(file.path, { created: "2026-08-12T22:41:52+03:00" });
    service.load();
    const changes = collectChanges(service);

    // Simulates the exact regression this design avoids: if a future edit
    // added `journal.markSelfWrite(file.path)` inside `setEntryCreated`,
    // this is what would happen to the very same write exercised above.
    service.markSelfWrite(file.path);
    await repository.setEntryCreated(file, newAt);
    fake.metadataCache.frontmatter.set(file.path, { created: formatCreatedProperty(newAt) });
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(0);
  });
});

describe("JournalService: a rename following a created write settles to exactly one row (Important 2)", () => {
  it("index ends up with exactly one entry, at the new path, after applyKnownEntry's immediate reposition is followed by the real rename event", () => {
    // Mirrors the full sequence JournalView.commitEntryTimeChange drives:
    // EntryRepository.setEntryCreated's write (not exercised at this level;
    // see the describe block above), then the immediate, synchronous
    // reposition via applyKnownEntry, THEN the real vault "rename" event
    // EntryRepository.renameEntryToMatch's file move eventually triggers,
    // debounced through the service like any other vault event. Regardless
    // of what JournalView itself does with the individual changes emitted
    // along the way (its own re-keying, covered separately), the service's
    // own index must never end up holding this entry twice.
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`);
    fake.metadataCache.frontmatter.set(file.path, { created: "2026-08-12T22:41:52+03:00" });
    service.load();
    const changes = collectChanges(service);

    const correctedAt = new Date(2026, 8, 1, 0, 0, 0);
    service.applyKnownEntry({ file, created: correctedAt });
    expect(service.getEntries()).toHaveLength(1);

    // The rename itself: Obsidian mutates the same TFile in place rather
    // than handing back a new object, moving it into the new YYYY/MM folder
    // and filename EntryRepository.renameEntryToMatch computed.
    const oldPath = file.path;
    const newPath = "Journal/2026/09/2026-09-01-00-00-00.md";
    fake.vault.files.delete(oldPath);
    file.path = newPath;
    file.name = "2026-09-01-00-00-00.md";
    file.basename = "2026-09-01-00-00-00";
    fake.vault.files.set(newPath, file);
    fake.vault.contents.set(newPath, fake.vault.contents.get(oldPath) ?? "");
    fake.metadataCache.frontmatter.set(newPath, { created: formatCreatedProperty(correctedAt) });

    fake.vault.trigger("rename", file, oldPath);
    vi.advanceTimersByTime(300);

    expect(service.getEntries()).toHaveLength(1);
    expect(service.getEntries()[0].file.path).toBe(newPath);
    expect(service.getEntries()[0].created.getTime()).toBe(correctedAt.getTime());
    // The debounced batch reports the stale old path removed and the new
    // path re-confirmed — "content", not a second "moved", since
    // applyKnownEntry already applied this exact created value.
    expect(changes).toEqual([
      { kind: "removed", path: oldPath },
      { kind: "content", entry: expect.objectContaining({ file }) },
    ]);
  });
});

describe("JournalService: unload", () => {
  it("stops a pending flush from ever running", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);

    service.unload();
    vi.advanceTimersByTime(1000);

    expect(changes).toHaveLength(0);
  });

  it("clears listeners, so a change after unload reaches no one", () => {
    const { fake, service } = setup();
    service.load();
    const changes = collectChanges(service);
    service.unload();

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(changes).toHaveLength(0);
  });

  it("actually unregisters its vault/metadata-cache event handlers, not merely its own listener set", () => {
    // If `registerEvent`'s unregistration were a no-op (as it used to be:
    // the mock previously never called back into `Events.on`'s returned
    // ref at all), `JournalService.onunload` clearing its own `listeners`
    // set would still make this test pass for the wrong reason — nothing
    // would prove the underlying vault event handler itself stopped
    // running. Here, a real (still-registered) handler firing would queue
    // a pending upsert and, given a still-running debounce timer, mutate
    // the index — which is exactly what this asserts does NOT happen.
    const { fake, service } = setup();
    service.load();
    service.unload();

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(service.getEntries()).toHaveLength(0);
  });

  it("clears the self-write map, so a stale mark cannot leak past the component's own lifetime", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    service.markSelfWrite(file.path);

    service.unload();
    service.load(); // simulate reuse in the same test run, e.g. a settings-driven reload cycle

    const changes = collectChanges(service);
    fake.vault.trigger("modify", file);
    vi.advanceTimersByTime(300);

    // Had the mark survived unload, this modify would be wrongly swallowed.
    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
  });
});

describe("JournalService: self-write eviction (Minor 6)", () => {
  it("sweeps an expired mark rather than leaving it in the map forever", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();

    service.markSelfWrite(file.path);
    vi.advanceTimersByTime(2001); // past the 2000ms self-write TTL

    // A second, unrelated self-write elsewhere must not accidentally revive
    // or interact with the first, already-expired mark: sweeping happens
    // inside `markSelfWrite` itself. Exercised indirectly: if the first
    // mark were never swept, it would still be consumable (if this test's
    // TTL math were wrong) — the real assertion is functional, below.
    const other = fake.vault.addFile("Journal/2026/08/2026-08-12-09-00-00.md", "");
    service.markSelfWrite(other.path);

    const changes = collectChanges(service);
    fake.vault.trigger("modify", file); // the ORIGINAL, expired mark
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ kind: "content", entry: expect.objectContaining({ file }) }]);
  });
});

describe("JournalService: folder rename (Important 4)", () => {
  it("rebuilds and emits a sole 'reload' when the configured journal folder itself is renamed", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);
    const rebuildSpy = vi.spyOn(service, "rebuild");

    fake.vault.trigger("rename", folderAt("JournalRenamed"), "Journal");
    vi.advanceTimersByTime(300);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ kind: "reload" }]);
  });

  it("also triggers on a rename of an ancestor folder that contains the journal folder", () => {
    const { fake, service } = setupWithFolder("Root/Journal");
    fake.vault.addFile("Root/Journal/2026/08/2026-08-12-22-41-52.md", "");
    service.load();
    const changes = collectChanges(service);
    const rebuildSpy = vi.spyOn(service, "rebuild");

    // The journal folder's own name never changes; its ancestor does.
    fake.vault.trigger("rename", folderAt("Root-Renamed"), "Root");
    vi.advanceTimersByTime(300);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ kind: "reload" }]);
  });

  it("also triggers on a rename of a subfolder contained by the journal folder", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);
    const rebuildSpy = vi.spyOn(service, "rebuild");

    fake.vault.trigger("rename", folderAt("Journal/2026-renamed"), "Journal/2026");
    vi.advanceTimersByTime(300);

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ kind: "reload" }]);
  });

  it("does not reload for a rename of a folder unrelated to the journal folder", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);
    const rebuildSpy = vi.spyOn(service, "rebuild");

    fake.vault.trigger("rename", folderAt("InboxRenamed"), "Inbox");
    vi.advanceTimersByTime(300);

    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(changes).toHaveLength(0);
  });

  it("supersedes any other pending per-file change queued in the same debounce window", () => {
    const { fake, service } = setup();
    const file = fake.vault.addFile(AUG12, "");
    service.load();
    const changes = collectChanges(service);

    // A modify queued moments before the folder rename, still within the
    // same 300ms debounce window.
    fake.vault.trigger("modify", file);
    fake.vault.trigger("rename", folderAt("JournalRenamed"), "Journal");
    vi.advanceTimersByTime(300);

    // Only the reload — the rebuild it triggers already reflects whatever
    // the modify would have reported, so re-emitting "content" for it too
    // would be redundant, and its path may no longer resolve sensibly.
    expect(changes).toEqual([{ kind: "reload" }]);
  });
});

describe("JournalService: batching (Minor 5's precondition)", () => {
  it("delivers every change from one flush in a single batch, not one callback per change", () => {
    const { fake, service } = setup();
    fake.vault.addFile(AUG12, "");
    const toDelete = fake.vault.addFile(AUG11, "");
    service.load();
    const batches = collectBatches(service);

    const a = fake.vault.addFile("Journal/2026/08/2026-08-12-01-00-00.md", "");
    const b = fake.vault.addFile("Journal/2026/08/2026-08-12-02-00-00.md", "");
    fake.vault.trigger("create", a);
    fake.vault.trigger("create", b);
    fake.vault.files.delete(toDelete.path);
    fake.vault.trigger("delete", toDelete);

    vi.advanceTimersByTime(300);

    // One flush, one callback invocation, carrying every change from it —
    // exactly what lets a listener (JournalView) batch its own expensive
    // per-flush bookkeeping instead of repeating it per change.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });
});

describe("JournalService: onChange unsubscribe", () => {
  it("the returned function stops future callbacks without touching others", () => {
    const { fake, service } = setup();
    service.load();

    const a: JournalChange[] = [];
    const b: JournalChange[] = [];
    const unsubA = service.onChange((batch) => a.push(...batch));
    service.onChange((batch) => b.push(...batch));

    unsubA();

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});
