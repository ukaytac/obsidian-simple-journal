import { describe, expect, it } from "vitest";
import { UnsafeFrontmatterError, addFrontmatterTag, hasTagsLine } from "../src/journal/markdownDoc";

const body = "Today I realized something.\n";

describe("addFrontmatterTag", () => {
  it("adds a tags list at the end of a block that has none, leaving every other line alone", () => {
    const data = `---\ncreated: "2026-08-12T17:23:41+03:00"\nmood:   ok   \n---\n${body}`;
    expect(addFrontmatterTag(data, "work")).toBe(
      `---\ncreated: "2026-08-12T17:23:41+03:00"\nmood:   ok   \ntags:\n  - work\n---\n${body}`,
    );
  });

  it("creates a frontmatter block when the entry has none, keeping the body byte-identical", () => {
    expect(addFrontmatterTag(body, "work")).toBe(`---\ntags:\n  - work\n---\n${body}`);
  });

  it("fills an empty frontmatter block", () => {
    expect(addFrontmatterTag(`---\n---\n${body}`, "work")).toBe(`---\ntags:\n  - work\n---\n${body}`);
  });

  it("appends to a block list, keeping its own indent", () => {
    const data = `---\ntags:\n    - work\n    - life\nmood: ok\n---\n${body}`;
    expect(addFrontmatterTag(data, "travel")).toBe(
      `---\ntags:\n    - work\n    - life\n    - travel\nmood: ok\n---\n${body}`,
    );
  });

  it("appends to a zero-indented block list", () => {
    const data = `---\ntags:\n- work\n---\n${body}`;
    expect(addFrontmatterTag(data, "life")).toBe(`---\ntags:\n- work\n- life\n---\n${body}`);
  });

  it("fills an empty tags key", () => {
    const data = `---\ntags:\nmood: ok\n---\n${body}`;
    expect(addFrontmatterTag(data, "work")).toBe(`---\ntags:\n  - work\nmood: ok\n---\n${body}`);
  });

  it("appends to a flow list, keeping its spacing", () => {
    expect(addFrontmatterTag(`---\ntags: [work, life]\n---\n${body}`, "travel")).toBe(
      `---\ntags: [work, life, travel]\n---\n${body}`,
    );
    expect(addFrontmatterTag(`---\ntags: [ work ]\n---\n${body}`, "life")).toBe(
      `---\ntags: [ work, life ]\n---\n${body}`,
    );
  });

  it("fills an empty flow list", () => {
    expect(addFrontmatterTag(`---\ntags: []\n---\n${body}`, "work")).toBe(`---\ntags: [work]\n---\n${body}`);
  });

  it("writes into a singular tag key, which Obsidian reads the same way", () => {
    expect(addFrontmatterTag(`---\ntag:\n  - work\n---\n${body}`, "life")).toBe(
      `---\ntag:\n  - work\n  - life\n---\n${body}`,
    );
  });

  it("keeps CRLF line endings", () => {
    const data = `---\r\ncreated: x\r\ntags:\r\n  - work\r\n---\r\n${body}`;
    expect(addFrontmatterTag(data, "life")).toBe(`---\r\ncreated: x\r\ntags:\r\n  - work\r\n  - life\r\n---\r\n${body}`);
    expect(addFrontmatterTag(`---\r\ncreated: x\r\n---\r\n${body}`, "life")).toBe(
      `---\r\ncreated: x\r\ntags:\r\n  - life\r\n---\r\n${body}`,
    );
  });

  it("keeps Turkish characters as they are", () => {
    expect(addFrontmatterTag(`---\ntags: [iş]\n---\n${body}`, "günlük")).toBe(
      `---\ntags: [iş, günlük]\n---\n${body}`,
    );
  });

  it("never touches a tags-looking line in the body", () => {
    const data = `---\ncreated: x\n---\ntags: [not, frontmatter]\n`;
    expect(addFrontmatterTag(data, "work")).toBe(`---\ncreated: x\ntags:\n  - work\n---\ntags: [not, frontmatter]\n`);
  });

  it("quotes a tag YAML would read as something other than text", () => {
    expect(addFrontmatterTag(`---\ntags: []\n---\n`, "2026-plans")).toBe(`---\ntags: ["2026-plans"]\n---\n`);
    expect(addFrontmatterTag(`---\ntags: []\n---\n`, "true")).toBe(`---\ntags: ["true"]\n---\n`);
    expect(addFrontmatterTag(`---\ntags: []\n---\n`, "No")).toBe(`---\ntags: ["No"]\n---\n`);
    expect(addFrontmatterTag(`---\ntags: []\n---\n`, "_inbox")).toBe(`---\ntags: ["_inbox"]\n---\n`);
  });

  describe("refuses, writing nothing, rather than guess", () => {
    const refused = (data: string) => () => addFrontmatterTag(data, "work");

    it("a single scalar value", () => {
      expect(refused(`---\ntags: life\n---\n`)).toThrow(UnsafeFrontmatterError);
      expect(refused(`---\ntags: "life, home"\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("a block scalar", () => {
      expect(refused(`---\ntags: |\n  life\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("a comment after the key", () => {
      expect(refused(`---\ntags: # mine\n  - life\n---\n`)).toThrow(UnsafeFrontmatterError);
      expect(refused(`---\ntags: [life] # mine\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("a flow list spanning lines, or nesting", () => {
      expect(refused(`---\ntags: [life,\n  home]\n---\n`)).toThrow(UnsafeFrontmatterError);
      expect(refused(`---\ntags: [[life]]\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("a list item continuing onto another line", () => {
      expect(refused(`---\ntags:\n  - life\n    home\n---\n`)).toThrow(UnsafeFrontmatterError);
      expect(refused(`---\ntags:\n  - |\n    life\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("items at mixed indents", () => {
      expect(refused(`---\ntags:\n  - life\n    - home\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("a list that resumes after a blank line", () => {
      expect(refused(`---\ntags:\n  - life\n\n  - home\n---\n`)).toThrow(UnsafeFrontmatterError);
    });

    it("more than one tags key", () => {
      expect(refused(`---\ntags: [a]\ntag: [b]\n---\n`)).toThrow(UnsafeFrontmatterError);
    });
  });
});

describe("hasTagsLine", () => {
  it("sees a top-level tags or tag key, in any case", () => {
    expect(hasTagsLine(`---\ntags: [a]\n---\n`)).toBe(true);
    expect(hasTagsLine(`---\nTag:\n  - a\n---\n`)).toBe(true);
  });

  it("does not mistake a longer key or an indented line for one", () => {
    expect(hasTagsLine(`---\ntagsCount: 3\n---\n`)).toBe(false);
    expect(hasTagsLine(`---\nnested:\n  tags: [a]\n---\n`)).toBe(false);
  });
});
