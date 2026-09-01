import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { JournalEntry } from "../src/journal/entry";
import { parseSearchQuery } from "../src/journal/entrySearch";
import {
  hitPaths,
  readJournalSnapshot,
  searchSnapshot,
  type JournalSnapshotReader,
} from "../src/services/journalSearch";

function entry(path: string, created: Date): JournalEntry {
  return { file: { path, basename: path } as unknown as TFile, created, tags: [] };
}

/** A reader whose bodies are a plain map, and whose failures are explicit. */
function reader(bodies: Record<string, string | Error>): JournalSnapshotReader {
  return {
    readBodyCached: (file: TFile) => {
      const body = bodies[file.path];
      if (body instanceof Error) return Promise.reject(body);
      return Promise.resolve(body ?? "");
    },
  };
}

const A = entry("Journal/a.md", new Date(2026, 7, 12, 22, 0, 0));
const B = entry("Journal/b.md", new Date(2026, 7, 10, 9, 0, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readJournalSnapshot", () => {
  it("reads every entry once and keeps the index's order", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "kahve", "Journal/b.md": "çay" }),
      [A, B],
    );

    expect(snapshot.entries.map((e) => e.entry.file.path)).toEqual([A.file.path, B.file.path]);
    expect(snapshot.entries.map((e) => e.body)).toEqual(["kahve", "çay"]);
    expect(snapshot.unreadable).toBe(0);
  });

  it("counts and logs an unreadable entry instead of failing the whole search", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": new Error("EACCES"), "Journal/b.md": "çay" }),
      [A, B],
    );

    expect(snapshot.entries.map((e) => e.entry.file.path)).toEqual([B.file.path]);
    expect(snapshot.unreadable).toBe(1);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("searchSnapshot", () => {
  it("returns a hit per matching entry, in the index's order, with a snippet", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "bugün kahve içtik", "Journal/b.md": "çay içtik" }),
      [A, B],
    );

    const hits = searchSnapshot(snapshot, parseSearchQuery("kahve"));

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.file.path).toBe(A.file.path);
    expect(hits[0].snippet.match).toBe("kahve");
  });

  it("returns nothing for a query below the minimum length", async () => {
    const snapshot = await readJournalSnapshot(reader({ "Journal/a.md": "kahve" }), [A]);
    expect(searchSnapshot(snapshot, parseSearchQuery("k"))).toEqual([]);
  });

  it("requires every term across the whole body, not one line", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "kahve içtik\n\nsonra kutu taşıdık" }),
      [A],
    );
    expect(searchSnapshot(snapshot, parseSearchQuery("kahve kutu"))).toHaveLength(1);
  });
});

describe("hitPaths", () => {
  it("is exactly the paths of the hits, which is what a text scope is built from", async () => {
    const snapshot = await readJournalSnapshot(
      reader({ "Journal/a.md": "kahve içtik", "Journal/b.md": "çay" }),
      [A, B],
    );

    expect([...hitPaths(searchSnapshot(snapshot, parseSearchQuery("kahve")))]).toEqual([
      A.file.path,
    ]);
  });
});
