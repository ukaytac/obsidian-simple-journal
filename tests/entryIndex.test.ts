import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import {
  anchorPosition,
  anchorSeed,
  compareEntries,
  findByPath,
  insertSorted,
  pageAfter,
  removeByPath,
  sliceBefore,
  sortEntries,
} from "../src/services/entryIndex";

function entry(basename: string, created: Date): JournalEntry {
  return {
    file: { path: `Journal/${basename}.md`, basename } as JournalEntry["file"],
    created,
  };
}

const aug12_2241 = entry("2026-08-12-22-41-52", new Date(2026, 7, 12, 22, 41, 52));
const aug12_1723 = entry("2026-08-12-17-23-41", new Date(2026, 7, 12, 17, 23, 41));
const aug12_0934 = entry("2026-08-12-09-34-21", new Date(2026, 7, 12, 9, 34, 21));
const aug11_2110 = entry("2026-08-11-21-10-00", new Date(2026, 7, 11, 21, 10, 0));

describe("sortEntries", () => {
  it("orders newest first across days and within a day", () => {
    const sorted = sortEntries([aug12_0934, aug11_2110, aug12_2241, aug12_1723]);
    expect(sorted.map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-08-12-17-23-41",
      "2026-08-12-09-34-21",
      "2026-08-11-21-10-00",
    ]);
  });

  it("puts the later collision suffix first when timestamps are identical", () => {
    const same = new Date(2026, 7, 12, 22, 41, 52);
    const first = entry("2026-08-12-22-41-52", same);
    const second = entry("2026-08-12-22-41-52-2", same);
    expect(sortEntries([first, second]).map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52-2",
      "2026-08-12-22-41-52",
    ]);
  });

  it("is a total order, so sorting is stable across calls", () => {
    const a = sortEntries([aug12_0934, aug12_2241, aug11_2110]);
    const b = sortEntries([aug11_2110, aug12_2241, aug12_0934]);
    expect(a.map((e) => e.file.path)).toEqual(b.map((e) => e.file.path));
  });

  it("orders collision suffixes numerically, not lexicographically", () => {
    const same = new Date(2026, 7, 12, 22, 41, 52);
    const ten = entry("2026-08-12-22-41-52-10", same);
    const two = entry("2026-08-12-22-41-52-2", same);
    // Lexicographically "-2" > "-10", so this only passes with numeric parsing.
    expect(sortEntries([two, ten]).map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52-10",
      "2026-08-12-22-41-52-2",
    ]);
  });
});

describe("compareEntries", () => {
  it("breaks ties between Unicode-equivalent but distinct paths by code point, stably", () => {
    const same = new Date(2026, 7, 12, 22, 41, 52);
    // Otherwise-identical basenames differing only in how "cafe" is
    // accented: NFC (single U+00E9) vs NFD (e + combining acute U+0301).
    // localeCompare's ICU collation treats these as equal; a code-point
    // compare must not.
    const nfc = entry(`2026-08-12-22-41-52-caf${"\u00e9"}`, same);
    const nfd = entry(`2026-08-12-22-41-52-caf${"e\u0301"}`, same);
    expect(nfc.file.path).not.toBe(nfd.file.path);
    expect(nfc.file.path.localeCompare(nfd.file.path)).toBe(0); // sanity check

    const first = compareEntries(nfc, nfd);
    const second = compareEntries(nfc, nfd);
    expect(first).not.toBe(0);
    expect(first).toBe(second);
    expect(compareEntries(nfd, nfc)).toBe(-first);
  });
});

describe("insertSorted", () => {
  it("puts a newer entry at the top", () => {
    const list = [aug12_1723, aug12_0934];
    const index = insertSorted(list, aug12_2241);
    expect(index).toBe(0);
    expect(list[0]).toBe(aug12_2241);
  });

  it("puts an older entry at the bottom", () => {
    const list = [aug12_2241, aug12_1723];
    expect(insertSorted(list, aug11_2110)).toBe(2);
  });

  it("inserts into the middle at the right position", () => {
    const list = [aug12_2241, aug12_0934];
    expect(insertSorted(list, aug12_1723)).toBe(1);
    expect(list.map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-08-12-17-23-41",
      "2026-08-12-09-34-21",
    ]);
  });

  it("keeps the list consistent with compareEntries", () => {
    const list: JournalEntry[] = [];
    for (const e of [aug12_0934, aug12_2241, aug11_2110, aug12_1723]) insertSorted(list, e);
    expect(list).toEqual(sortEntries(list));
  });

  it("replaces the stale copy when the same path is reinserted with a new timestamp", () => {
    // The exact mutation the service runs when an entry's created time is
    // edited: remove-then-reinsert under the same path. Simulated without
    // the upsert this leaves two copies, one of them stale forever.
    const list = [aug12_2241, aug12_1723, aug12_0934];
    const edited: JournalEntry = {
      file: aug12_1723.file,
      created: new Date(2026, 7, 12, 23, 0, 0), // now newer than aug12_2241
    };

    insertSorted(list, edited);

    expect(list.filter((e) => e.file.path === aug12_1723.file.path)).toHaveLength(1);
    expect(list[0]).toBe(edited);
    expect(list.map((e) => e.file.basename)).toEqual([
      "2026-08-12-17-23-41",
      "2026-08-12-22-41-52",
      "2026-08-12-09-34-21",
    ]);
  });

  it("keeps exactly one, newest, copy when inserted twice with the same path", () => {
    const list: JournalEntry[] = [];
    const first: JournalEntry = { file: aug12_1723.file, created: aug12_1723.created };
    const second: JournalEntry = {
      file: aug12_1723.file,
      created: new Date(2026, 7, 12, 18, 0, 0),
    };

    insertSorted(list, first);
    insertSorted(list, second);

    expect(list).toHaveLength(1);
    expect(list[0]).toBe(second);
  });
});

describe("removeByPath and findByPath", () => {
  it("removes the matching entry and reports its old index", () => {
    const list = [aug12_2241, aug12_1723, aug12_0934];
    expect(removeByPath(list, aug12_1723.file.path)).toBe(1);
    expect(list.map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-08-12-09-34-21",
    ]);
  });

  it("returns -1 for an unknown path", () => {
    expect(removeByPath([aug12_2241], "Journal/nope.md")).toBe(-1);
    expect(findByPath([aug12_2241], "Journal/nope.md")).toBeNull();
  });

  it("finds an entry by path", () => {
    expect(findByPath([aug12_2241, aug12_1723], aug12_1723.file.path)).toBe(aug12_1723);
  });
});

describe("sliceBefore", () => {
  const list = [aug12_2241, aug12_1723, aug12_0934, aug11_2110];

  it("returns the newest entries when no cursor is given", () => {
    expect(sliceBefore(list, undefined, 2)).toEqual([aug12_2241, aug12_1723]);
  });

  it("returns only entries strictly older than the cursor", () => {
    expect(sliceBefore(list, new Date(2026, 7, 12, 17, 23, 41))).toEqual([
      aug12_0934,
      aug11_2110,
    ]);
  });

  it("returns everything when no limit is given", () => {
    expect(sliceBefore(list)).toHaveLength(4);
  });
});

describe("pageAfter", () => {
  const list = [aug12_2241, aug12_1723, aug12_0934, aug11_2110];

  it("returns the first page when there is no cursor", () => {
    expect(pageAfter(list, null, 2)).toEqual([aug12_2241, aug12_1723]);
  });

  it("continues after the cursor entry by position", () => {
    expect(pageAfter(list, aug12_1723.file.path, 2)).toEqual([aug12_0934, aug11_2110]);
  });

  it("does not skip entries that share a timestamp with the cursor", () => {
    const same = new Date(2026, 7, 12, 22, 41, 52);
    const twin = entry("2026-08-12-22-41-52-2", same);
    const withTwin = sortEntries([...list, twin]);
    expect(pageAfter(withTwin, twin.file.path, 1)).toEqual([aug12_2241]);
  });

  it("returns an empty page when the cursor is the last entry", () => {
    expect(pageAfter(list, aug11_2110.file.path, 5)).toEqual([]);
  });

  it("returns null when the cursor is no longer in the list", () => {
    expect(pageAfter(list, "Journal/deleted.md", 1)).toBeNull();
  });
});

describe("anchorPosition and anchorSeed", () => {
  const list = [aug12_2241, aug12_1723, aug12_0934, aug11_2110];

  it("anchoring to the day of the newest entries includes all of them", () => {
    expect(anchorPosition(list, new Date(2026, 7, 12))).toBe(0);
    expect(anchorSeed(list, new Date(2026, 7, 12))).toBeNull();
  });

  it("anchoring to an older day excludes every entry from the newer day", () => {
    // Only aug11_2110 (index 3) is at or before the end of 11 August.
    expect(anchorPosition(list, new Date(2026, 7, 11))).toBe(3);
    expect(anchorSeed(list, new Date(2026, 7, 11))).toBe(aug12_0934.file.path);
  });

  it("anchoring newer than every entry includes everything (position 0, no seed)", () => {
    expect(anchorPosition(list, new Date(2026, 7, 13))).toBe(0);
    expect(anchorSeed(list, new Date(2026, 7, 13))).toBeNull();
  });

  it("anchoring older than every entry excludes everything", () => {
    expect(anchorPosition(list, new Date(2026, 7, 10))).toBe(list.length);
    expect(anchorSeed(list, new Date(2026, 7, 10))).toBe(aug11_2110.file.path);
  });

  it("anchoring to an empty day lands on the nearest older entry, not a dead end", () => {
    // A gap day (11 August) with no entries at all, between two days that do
    // have entries — anchoring here should behave like anchoring to the
    // nearest entry at or before it, not come back empty.
    const gappy = [aug12_2241, entry("2026-08-10-08-00-00", new Date(2026, 7, 10, 8, 0, 0))];
    const aug10 = gappy[1];

    expect(anchorPosition(gappy, new Date(2026, 7, 11))).toBe(1);
    expect(anchorSeed(gappy, new Date(2026, 7, 11))).toBe(aug12_2241.file.path);
    // Confirms the seed actually pages to the right next entry.
    expect(pageAfter(gappy, anchorSeed(gappy, new Date(2026, 7, 11)), 5)).toEqual([aug10]);
  });

  it("anchoring an empty journal excludes everything without throwing", () => {
    expect(anchorPosition([], new Date(2026, 7, 12))).toBe(0);
    expect(anchorSeed([], new Date(2026, 7, 12))).toBeNull();
  });

  it("treats an entry exactly at the anchor boundary as included", () => {
    const boundary = entry("2026-08-11-23-59-59", new Date(2026, 7, 11, 23, 59, 59));
    const withBoundary = [aug12_2241, boundary];
    expect(anchorPosition(withBoundary, new Date(2026, 7, 11))).toBe(1);
    expect(anchorSeed(withBoundary, new Date(2026, 7, 11))).toBe(aug12_2241.file.path);
  });
});
