import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import type { JournalEntry } from "../src/journal/entry";
import { buildSnippet, foldForSearch, parseSearchQuery } from "../src/journal/entrySearch";
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

  it("folds each body once, when it is read, so a keystroke never has to", async () => {
    const snapshot = await readJournalSnapshot(reader({ "Journal/a.md": "İstanbul'a" }), [A]);

    expect(snapshot.entries[0].folded).toBe(foldForSearch("İstanbul'a"));
  });

  it("never has more than 32 reads outstanding, and keeps the index's order", async () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      entry(`Journal/${i}.md`, new Date(2026, 7, 12, 0, 0, 100 - i)),
    );
    let outstanding = 0;
    let max = 0;
    const releases: Array<() => void> = [];
    const held: JournalSnapshotReader = {
      readBodyCached: (file: TFile) => {
        outstanding++;
        max = Math.max(max, outstanding);
        return new Promise<string>((resolve) => {
          releases.push(() => {
            outstanding--;
            resolve(`body ${file.path}`);
          });
        });
      },
    };

    const pending = readJournalSnapshot(held, entries);
    // Release in rounds until everything has been read, newest-last on purpose
    // so completion order differs from index order.
    for (let round = 0; round < 1000 && releases.length > 0; round++) {
      await Promise.resolve();
      const batch = releases.splice(0).reverse();
      batch.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const snapshot = await pending;

    expect(max).toBeLessThanOrEqual(32);
    expect(max).toBeGreaterThan(1);
    expect(snapshot.entries.map((e) => e.entry.file.path)).toEqual(entries.map((e) => e.file.path));
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
    expect(hits[0].terms).toEqual(["kahve"]);
    expect(buildSnippet(hits[0].body, hits[0].terms).match).toBe("kahve");
  });

  it("builds no excerpt for a hit: only the rows the modal draws pay for one", async () => {
    const snapshot = await readJournalSnapshot(reader({ "Journal/a.md": "bugün kahve içtik" }), [A]);

    const [hit] = searchSnapshot(snapshot, parseSearchQuery("kahve"));

    expect(hit).not.toHaveProperty("snippet");
    expect(Object.keys(hit).sort()).toEqual(["body", "entry", "terms"]);
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
