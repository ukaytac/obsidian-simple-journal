import { describe, expect, it } from "vitest";
import {
  MIN_QUERY_LENGTH,
  SNIPPET_CONTEXT,
  bodyMatchesTerms,
  buildSnippet,
  foldForSearch,
  parseSearchQuery,
} from "../src/journal/entrySearch";

describe("foldForSearch", () => {
  it("folds Turkish casing pairs", () => {
    expect(foldForSearch("İstanbul")).toBe("istanbul");
    expect(foldForSearch("İSTANBUL")).toBe("istanbul");
    expect(foldForSearch("Işık")).toBe("işik");
    expect(foldForSearch("IŞIK")).toBe("işik");
  });

  /**
   * The English capital `I` used to fold to `ı`, so `i am` did not find
   * `I am happy` — a daily failure in an English sentence, mirroring the
   * `İstanbul` one in a Turkish sentence. Both are fixed by folding all four
   * of `İ I ı i` together.
   */
  it("folds English's capital I to the same i", () => {
    expect(foldForSearch("I am happy")).toBe("i am happy");
    expect(foldForSearch("I am happy").includes(foldForSearch("i am"))).toBe(true);
  });

  /**
   * The cost of the line above, and the reason it is the right trade: dotted
   * and dotless i are one letter to this search, so `ısı` also finds `isi`.
   * That returns an extra row; the alternative returned none at all. A search
   * may over-match — it may not lose what the user wrote.
   */
  it("merges dotted and dotless i, over-matching rather than missing", () => {
    expect(foldForSearch("ısı")).toBe(foldForSearch("isi"));
    expect(foldForSearch("sık")).toBe(foldForSearch("sik"));
  });

  it("leaves every other diacritic distinct", () => {
    expect(foldForSearch("açık")).not.toBe(foldForSearch("acik"));
    expect(foldForSearch("şişman")).not.toBe(foldForSearch("sisman"));
    expect(foldForSearch("Kâr")).not.toBe(foldForSearch("kar"));
    expect(foldForSearch("gün")).not.toBe(foldForSearch("gun"));
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

  /**
   * Through `parseSearchQuery`, not a hand-written term: `bodyMatchesTerms`
   * takes terms that are ALREADY folded, and a raw `ı` here passed only
   * because it used to fold to itself.
   */
  it("matches inside a word, not only at a boundary", () => {
    expect(bodyMatchesTerms("taşınma günü", parseSearchQuery("şınm"))).toBe(true);
  });

  it("matches nothing when there are no terms", () => {
    expect(bodyMatchesTerms("anything at all", [])).toBe(false);
  });

  it("folds the body the same way as the query", () => {
    expect(bodyMatchesTerms("İstanbul'a gittik", parseSearchQuery("istanbul"))).toBe(true);
  });
});

describe("buildSnippet", () => {
  it("splits the body around the first matching term", () => {
    const snippet = buildSnippet("Bugün kahve içtik.", ["kahve"]);
    expect(snippet).toEqual({ before: "Bugün ", match: "kahve", after: " içtik." });
  });

  it("uses whichever term appears first, not the first term given", () => {
    const snippet = buildSnippet("kahve, sonra kutu", ["kutu", "kahve"]);
    expect(snippet.match).toBe("kahve");
  });

  it("returns the matched text as the body spells it, not as the query does", () => {
    expect(buildSnippet("İstanbul'a gittik", ["istanbul"]).match).toBe("İstanbul");
  });

  it("trims context on both sides and marks the trim", () => {
    const body = `${"a".repeat(200)} kahve ${"b".repeat(200)}`;
    const snippet = buildSnippet(body, ["kahve"]);
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.before.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 2);
    expect(snippet.after.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 2);
  });

  it("does not mark a trim that did not happen", () => {
    const snippet = buildSnippet("kısa kahve notu", ["kahve"]);
    expect(snippet.before).toBe("kısa ");
    expect(snippet.after).toBe(" notu");
  });

  /**
   * The expectation is spelled as a slice of the collapsed text rather than
   * as a literal so it states the rule — every run of whitespace becomes one
   * space — instead of a number someone would have to re-derive to check.
   */
  it("collapses newlines so a row stays one line", () => {
    expect(buildSnippet("ilk satır\n\nkahve\nson", ["kahve"])).toEqual({
      before: "ilk satır kahve".slice(0, 10),
      match: "kahve",
      after: " son",
    });
  });

  it("returns the head of the body when nothing matched", () => {
    const snippet = buildSnippet("hiçbir şey", ["kahve"]);
    expect(snippet.match).toBe("");
    expect(snippet.before).toBe("hiçbir şey");
    expect(snippet.after).toBe("");
  });
});
