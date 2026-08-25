import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import { findMentions, type ResolvedLinks } from "../src/mentions/mentionQuery";

function entry(path: string, created: Date): JournalEntry {
  return { file: { path } as JournalEntry["file"], created, tags: [] };
}

/** Newest first, exactly as `JournalService`'s index is kept. */
const AUG_24 = entry("Journal/2026/08/2026-08-24-21-40-00.md", new Date(2026, 7, 24, 21, 40));
const AUG_20 = entry("Journal/2026/08/2026-08-20-17-03-00.md", new Date(2026, 7, 20, 17, 3));
const AUG_12 = entry("Journal/2026/08/2026-08-12-09-34-00.md", new Date(2026, 7, 12, 9, 34));
const INDEX = [AUG_24, AUG_20, AUG_12];

const TARGET = { path: "People/Ekin Arslan Aytaç.md" } as JournalEntry["file"];

function links(map: Record<string, Record<string, number>>): ResolvedLinks {
  return map;
}

describe("findMentions", () => {
  it("returns the entries Obsidian resolved a link from", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 1 } }),
    );
    expect(result.map((e) => e.file.path)).toEqual([AUG_24.file.path]);
  });

  it("ignores entries with no link to the target", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { "People/Someone Else.md": 1 } }),
    );
    expect(result).toEqual([]);
  });

  it("ignores an entry with no resolvedLinks record at all", () => {
    expect(findMentions(INDEX, TARGET, links({}))).toEqual([]);
  });

  it("ignores a zero count", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 0 } }),
    );
    expect(result).toEqual([]);
  });

  it("lists an entry that links twice only once", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({ [AUG_24.file.path]: { [TARGET.path]: 2 } }),
    );
    expect(result).toHaveLength(1);
  });

  it("never lists the target as a mention of itself", () => {
    const self = entry(TARGET.path, new Date(2026, 7, 25));
    const result = findMentions(
      [self, ...INDEX],
      TARGET,
      links({ [TARGET.path]: { [TARGET.path]: 1 } }),
    );
    expect(result).toEqual([]);
  });

  it("preserves the index's newest-first order", () => {
    const result = findMentions(
      INDEX,
      TARGET,
      links({
        [AUG_12.file.path]: { [TARGET.path]: 1 },
        [AUG_24.file.path]: { [TARGET.path]: 1 },
        [AUG_20.file.path]: { [TARGET.path]: 1 },
      }),
    );
    expect(result.map((e) => e.file.path)).toEqual([
      AUG_24.file.path,
      AUG_20.file.path,
      AUG_12.file.path,
    ]);
  });

  it("returns nothing for an empty index", () => {
    expect(findMentions([], TARGET, links({}))).toEqual([]);
  });
});
