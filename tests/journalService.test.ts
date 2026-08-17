// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createFakeApp } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { JournalService, type JournalChange } from "../src/services/journalService";

function setup() {
  const fake = createFakeApp();
  const repository = new EntryRepository(fake as unknown as App, () => "Journal");
  const service = new JournalService(fake as unknown as App, repository);
  return { fake, repository, service };
}

/** Collects every change the service emits, in order. */
function collectChanges(service: JournalService): JournalChange[] {
  const changes: JournalChange[] = [];
  service.onChange((change) => changes.push(change));
  return changes;
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
});

describe("JournalService: onChange unsubscribe", () => {
  it("the returned function stops future callbacks without touching others", () => {
    const { fake, service } = setup();
    service.load();

    const a: JournalChange[] = [];
    const b: JournalChange[] = [];
    const unsubA = service.onChange((c) => a.push(c));
    service.onChange((c) => b.push(c));

    unsubA();

    const file = fake.vault.addFile(AUG12, "");
    fake.vault.trigger("create", file);
    vi.advanceTimersByTime(300);

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});
