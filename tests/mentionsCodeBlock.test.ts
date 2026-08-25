// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installDomHelpers } from "./obsidian-mock";
import { isInsideMentionsPanel, parseMentionsBlock } from "../src/mentions/mentionsCodeBlock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("parseMentionsBlock", () => {
  it("reads no target from an empty block", () => {
    expect(parseMentionsBlock("")).toEqual({ noteLink: null });
    expect(parseMentionsBlock("\n\n  \n")).toEqual({ noteLink: null });
  });

  it("reads a note: directive", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseMentionsBlock("\n   note:   [[Ekin]]   \n")).toEqual({ noteLink: "Ekin" });
  });

  it("uses the link target, not the alias", () => {
    expect(parseMentionsBlock("note: [[Ekin Arslan Aytaç|Ekin]]")).toEqual({
      noteLink: "Ekin Arslan Aytaç",
    });
  });

  it("ignores anything it does not understand rather than erroring", () => {
    expect(parseMentionsBlock("sort: oldest\nlimit: 3")).toEqual({ noteLink: null });
  });
});

describe("isInsideMentionsPanel", () => {
  it("is false for a block in an ordinary note", () => {
    const el = document.body.createDiv();
    expect(isInsideMentionsPanel(el)).toBe(false);
  });

  it("is true for a block rendered inside a panel's own output", () => {
    const panel = document.body.createDiv({ cls: "journal-mentions" });
    const el = panel.createDiv({ cls: "journal-mentions-body" }).createDiv();
    expect(isInsideMentionsPanel(el)).toBe(true);
  });
});
