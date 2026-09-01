import { describe, expect, it } from "vitest";
import {
  MIN_QUERY_LENGTH,
  bodyMatchesTerms,
  foldForSearch,
  parseSearchQuery,
} from "../src/journal/entrySearch";

describe("foldForSearch", () => {
  it("folds Turkish casing pairs, keeping i and ı apart", () => {
    expect(foldForSearch("İstanbul")).toBe("istanbul");
    expect(foldForSearch("İSTANBUL")).toBe("istanbul");
    expect(foldForSearch("Işık")).toBe("ışık");
    expect(foldForSearch("IŞIK")).toBe("ışık");
    expect(foldForSearch("ilik")).not.toBe(foldForSearch("ılık"));
  });

  it("leaves every other diacritic distinct", () => {
    expect(foldForSearch("açık")).not.toBe(foldForSearch("acik"));
    expect(foldForSearch("şişman")).not.toBe(foldForSearch("sisman"));
    expect(foldForSearch("Kâr")).not.toBe(foldForSearch("kar"));
    expect(foldForSearch("gün")).not.toBe(foldForSearch("gun"));
  });

  /**
   * Not a bug: the price of `I` being the capital of `ı`. Turkish casing
   * cannot be correct and leave English's capital `I` alone at the same
   * time, and this journal is Turkish. Pinned so it stays a decision.
   */
  it("costs English its capital I, deliberately", () => {
    expect(foldForSearch("I am happy")).toBe("ı am happy");
    expect(foldForSearch("I am happy").includes(foldForSearch("i am"))).toBe(false);
  });
});

describe("parseSearchQuery", () => {
  it("splits on whitespace and folds each term", () => {
    expect(parseSearchQuery("İki  Kelime")).toEqual(["iki", "kelime"]);
  });

  it("returns no terms for a query below the minimum length", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(parseSearchQuery("a")).toEqual([]);
    expect(parseSearchQuery("   ")).toEqual([]);
    expect(parseSearchQuery("")).toEqual([]);
  });

  it("measures the minimum against the trimmed query, not each term", () => {
    expect(parseSearchQuery("ab")).toEqual(["ab"]);
    expect(parseSearchQuery("a b")).toEqual(["a", "b"]);
  });
});

describe("bodyMatchesTerms", () => {
  it("requires every term, in any order", () => {
    const body = "Kutuları taşıdık, sonra kahve içtik.";
    expect(bodyMatchesTerms(body, ["kahve", "kutu"])).toBe(true);
    expect(bodyMatchesTerms(body, ["kahve", "çay"])).toBe(false);
  });

  it("matches inside a word, not only at a boundary", () => {
    expect(bodyMatchesTerms("taşınma günü", ["şınm"])).toBe(true);
  });

  it("matches nothing when there are no terms", () => {
    expect(bodyMatchesTerms("anything at all", [])).toBe(false);
  });

  it("folds the body the same way as the query", () => {
    expect(bodyMatchesTerms("İstanbul'a gittik", parseSearchQuery("istanbul"))).toBe(true);
  });
});
