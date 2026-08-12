import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import {
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

  it("returns the first page when the cursor is no longer in the list", () => {
    expect(pageAfter(list, "Journal/deleted.md", 1)).toEqual([aug12_2241]);
  });
});
