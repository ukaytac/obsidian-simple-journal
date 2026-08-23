import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import {
  collectTags,
  entriesWithTag,
  entryHasTag,
  frontmatterTags,
  resolveTags,
} from "../src/journal/entryTags";

/** A cache shaped like Obsidian's, as `getFileCache` returns it. */
function cache(inline: string[] = [], frontmatter?: Record<string, unknown>) {
  return {
    tags: inline.map((tag) => ({ tag: `#${tag}` })),
    ...(frontmatter ? { frontmatter } : {}),
  } as never;
}

function entry(tags: string[]): JournalEntry {
  return {
    file: { path: "Journal/2026/08/2026-08-12-22-41-52.md" } as JournalEntry["file"],
    created: new Date(2026, 7, 12, 22, 41, 52),
    tags,
  };
}

describe("resolveTags", () => {
  it("reads inline tags, stripping the #", () => {
    expect(resolveTags(cache(["work"]))).toEqual(["work"]);
  });

  it("reads frontmatter tags, which carry no #", () => {
    expect(resolveTags(cache([], { tags: ["work"] }))).toEqual(["work"]);
  });

  it("merges both without caring which side a tag came from", () => {
    expect(resolveTags(cache(["therapy"], { tags: ["work"] }))).toEqual(["therapy", "work"]);
  });

  it("keeps nested tags whole", () => {
    expect(resolveTags(cache(["work/project"]))).toEqual(["work/project"]);
  });

  it("dedupes case-insensitively, keeping the casing seen first", () => {
    expect(resolveTags(cache(["Work"], { tags: ["work", "WORK"] }))).toEqual(["Work"]);
  });

  it("accepts a comma-separated frontmatter string", () => {
    expect(resolveTags(cache([], { tags: "work, therapy" }))).toEqual(["work", "therapy"]);
  });

  it("is empty for an absent cache rather than throwing", () => {
    expect(resolveTags(null)).toEqual([]);
    expect(resolveTags(undefined)).toEqual([]);
  });

  it("is empty for a cache with no tags at all", () => {
    expect(resolveTags(cache([], { created: "2026-08-12T22:41:52+03:00" }))).toEqual([]);
  });

  it("ignores frontmatter tag entries that are not usable text", () => {
    expect(resolveTags(cache([], { tags: ["work", "", null, 7] }))).toEqual(["work", "7"]);
  });

  it("strips a doubled leading # — a malformed frontmatter value a user can really write", () => {
    expect(resolveTags(cache([], { tags: ["##work"] }))).toEqual(["work"]);
  });

  it("trims whitespace exposed by stripping the #, not just whitespace at the original edges", () => {
    // "# work" has no leading/trailing whitespace of its own, but stripping
    // the "#" exposes a leading space that a single trim (before, or only
    // after, the replace) would miss — normalizeTag trims twice for exactly
    // this reason. Frontmatter is free-form user text, so "# work" is a
    // realistic value, not a contrived one.
    expect(resolveTags(cache([], { tags: ["# work"] }))).toEqual(["work"]);
  });
});

describe("frontmatterTags", () => {
  it("returns only the frontmatter side — the part the timeline hides", () => {
    expect(frontmatterTags(cache(["therapy"], { tags: ["work"] }))).toEqual(["work"]);
  });

  it("is empty when there is no frontmatter", () => {
    expect(frontmatterTags(cache(["therapy"]))).toEqual([]);
  });
});

describe("entryHasTag", () => {
  it("matches case-insensitively", () => {
    expect(entryHasTag(entry(["Work"]), "work")).toBe(true);
  });

  it("accepts a needle written with a #", () => {
    expect(entryHasTag(entry(["work"]), "#work")).toBe(true);
  });

  it("does not match a child tag — scoping is exact", () => {
    expect(entryHasTag(entry(["work/project"]), "work")).toBe(false);
  });

  it("is false for an entry with no tags", () => {
    expect(entryHasTag(entry([]), "work")).toBe(false);
  });
});

describe("entriesWithTag", () => {
  it("matches case-insensitively", () => {
    const hit = entry(["Work"]);
    expect(entriesWithTag([hit, entry(["therapy"])], "work")).toEqual([hit]);
  });

  it("accepts a needle written with a #", () => {
    const hit = entry(["work"]);
    expect(entriesWithTag([hit, entry([])], "#work")).toEqual([hit]);
  });

  it("does not match a child tag — scoping is exact", () => {
    expect(entriesWithTag([entry(["work/project"])], "work")).toEqual([]);
  });

  it("is empty for an empty needle", () => {
    expect(entriesWithTag([entry(["work"])], "#")).toEqual([]);
  });

  /**
   * The scoped index is handed to `pageAfter` and `insertEntryInPlace`, which
   * look entries up by reference — so the result must hold the SAME objects,
   * and must never be the input array itself (an unscoped view relies on
   * that identity meaning "no filter is active").
   */
  it("returns a new array of the same entry objects, leaving the input alone", () => {
    const hit = entry(["work"]);
    const entries = [hit, entry(["therapy"])];

    const filtered = entriesWithTag(entries, "work");

    expect(filtered).not.toBe(entries);
    expect(filtered[0]).toBe(hit);
    expect(entries).toHaveLength(2);
  });
});

describe("collectTags", () => {
  it("returns every tag across entries, deduped and alphabetical", () => {
    const tags = collectTags([entry(["work", "therapy"]), entry(["Work", "books"])]);
    expect(tags).toEqual(["books", "therapy", "work"]);
  });

  it("is empty for an empty journal", () => {
    expect(collectTags([])).toEqual([]);
  });
});
