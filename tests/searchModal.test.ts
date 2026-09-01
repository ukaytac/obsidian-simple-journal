// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import type { JournalEntry } from "../src/journal/entry";
import type { JournalSnapshot } from "../src/services/journalSearch";
import { SearchModal, type SearchChoice } from "../src/views/SearchModal";
import { installDomHelpers } from "./obsidian-mock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

function entry(path: string, created: Date): JournalEntry {
  return { file: { path, basename: path } as unknown as TFile, created, tags: [] };
}

const A = entry("Journal/a.md", new Date(2026, 7, 12, 22, 41, 0));
const B = entry("Journal/b.md", new Date(2026, 7, 10, 9, 34, 0));

const SNAPSHOT: JournalSnapshot = {
  entries: [
    { entry: A, body: "bugün kahve içtik" },
    { entry: B, body: "çay içtik" },
  ],
  unreadable: 0,
};

function modal(snapshot: JournalSnapshot, hasScope = false) {
  const chosen: SearchChoice[] = [];
  const instance = new SearchModal({} as App, snapshot, hasScope, (choice) => chosen.push(choice));
  return { instance, chosen };
}

function paths(suggestions: SearchChoice[]): string[] {
  return suggestions.flatMap((s) => (s.kind === "hit" ? [s.hit.entry.file.path] : []));
}

describe("SearchModal", () => {
  it("suggests nothing at all for a query below the minimum length", () => {
    expect(modal(SNAPSHOT).instance.getSuggestions("k")).toEqual([]);
  });

  it("offers Show all first, then one row per match, newest first", () => {
    const suggestions = modal(SNAPSHOT).instance.getSuggestions("içtik");

    expect(suggestions[0]).toMatchObject({ kind: "all", count: 2, query: "içtik" });
    expect(paths(suggestions)).toEqual([A.file.path, B.file.path]);
  });

  it("carries the hits on the Show all row, so the caller needs no state of its own", () => {
    const [all] = modal(SNAPSHOT).instance.getSuggestions("kahve");

    expect(all.kind === "all" && all.hits.map((hit) => hit.entry.file.path)).toEqual([A.file.path]);
  });

  it("omits Show all when nothing matched", () => {
    expect(modal(SNAPSHOT).instance.getSuggestions("zeplin")).toEqual([]);
  });

  it("keeps Clear filter reachable, first, while a scope is active", () => {
    const { instance } = modal(SNAPSHOT, true);

    expect(instance.getSuggestions("zeplin")).toEqual([{ kind: "clear" }]);
    expect(instance.getSuggestions("içtik")[0]).toEqual({ kind: "clear" });
    expect(instance.getSuggestions("içtik")[1]).toMatchObject({ kind: "all", count: 2 });
  });

  it("renders a hit as its time plus an excerpt, with the match marked", () => {
    const { instance } = modal(SNAPSHOT);
    const suggestion = instance.getSuggestions("kahve")[1];
    const el = createDiv();

    instance.renderSuggestion(suggestion, el);

    expect(el.querySelector(".journal-search-time")?.textContent).toBe("22:41");
    expect(el.querySelector(".journal-search-match")?.textContent).toBe("kahve");
    expect(el.textContent).toContain("bugün ");
  });

  it("says so when entries could not be read, last rather than first", () => {
    const { instance } = modal({ ...SNAPSHOT, unreadable: 3 });

    expect(instance.getSuggestions("içtik").at(-1)).toEqual({ kind: "unreadable", count: 3 });
  });

  it("says nothing about unreadable entries when there were none", () => {
    const { instance } = modal(SNAPSHOT);

    expect(instance.getSuggestions("içtik").some((s) => s.kind === "unreadable")).toBe(false);
  });

  /**
   * The caveat is not an answer. Selecting it must not close the modal having
   * silently done nothing — the user would read that as the search failing.
   */
  it("refuses to be chosen by way of the unreadable row", () => {
    const { instance, chosen } = modal({ ...SNAPSHOT, unreadable: 1 });

    instance.onChooseSuggestion({ kind: "unreadable", count: 1 }, new MouseEvent("click"));

    expect(chosen).toEqual([]);
  });

  it("hands every other row straight to its caller", () => {
    const { instance, chosen } = modal(SNAPSHOT, true);

    instance.onChooseSuggestion({ kind: "clear" }, new MouseEvent("click"));

    expect(chosen).toEqual([{ kind: "clear" }]);
  });
});
