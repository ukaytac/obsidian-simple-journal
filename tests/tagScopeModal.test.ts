// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { TagScopeModal, type TagChoice } from "../src/views/TagScopeModal";
import { installDomHelpers } from "./obsidian-mock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

function modal(tags: string[], hasScope: boolean) {
  const chosen: TagChoice[] = [];
  const instance = new TagScopeModal({} as App, tags, hasScope, (choice) => chosen.push(choice));
  return { instance, chosen };
}

describe("TagScopeModal", () => {
  it("lists every tag when the query is empty", () => {
    const { instance } = modal(["books", "work"], false);
    expect(instance.getSuggestions("")).toEqual([
      { kind: "tag", tag: "books" },
      { kind: "tag", tag: "work" },
    ]);
  });

  it("filters case-insensitively and ignores a typed #", () => {
    const { instance } = modal(["books", "Work"], false);
    expect(instance.getSuggestions("#wor")).toEqual([{ kind: "tag", tag: "Work" }]);
  });

  it("offers Clear filter first, but only when a scope is active", () => {
    expect(modal(["work"], true).instance.getSuggestions("")[0]).toEqual({ kind: "clear" });
    expect(modal(["work"], false).instance.getSuggestions("")[0]).toEqual({
      kind: "tag",
      tag: "work",
    });
  });

  it("keeps Clear filter reachable while a query is being typed", () => {
    const { instance } = modal(["work"], true);
    expect(instance.getSuggestions("zzz")).toEqual([{ kind: "clear" }]);
  });

  it("hands the chosen tag to its callback", () => {
    const { instance, chosen } = modal(["work"], false);
    // Calls the real API member directly, rather than a mock-only helper,
    // because this test type-checks against the real Obsidian types.
    instance.onChooseSuggestion({ kind: "tag", tag: "work" }, new MouseEvent("click"));
    expect(chosen).toEqual([{ kind: "tag", tag: "work" }]);
  });

  it("renders a tag with its # and the clear item as plain words", () => {
    const { instance } = modal(["work"], true);

    const tagEl = document.createElement("div");
    instance.renderSuggestion({ kind: "tag", tag: "work" }, tagEl);
    expect(tagEl.textContent).toBe("#work");

    const clearEl = document.createElement("div");
    instance.renderSuggestion({ kind: "clear" }, clearEl);
    expect(clearEl.textContent).toBe("Clear filter");
  });
});
