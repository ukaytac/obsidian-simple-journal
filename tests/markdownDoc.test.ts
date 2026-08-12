import { describe, expect, it } from "vitest";
import { replaceBody, splitFrontmatter } from "../src/journal/markdownDoc";

const withFrontmatter = `---
created: 2026-08-12T22:41:52+03:00
tags:
  - journal
mood: "calm"
---

Today I realized something.
`;

describe("splitFrontmatter", () => {
  it("separates the frontmatter block from the body", () => {
    const { frontmatter, body } = splitFrontmatter(withFrontmatter);
    expect(frontmatter).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\ntags:\n  - journal\nmood: "calm"\n---\n`,
    );
    expect(body).toBe("\nToday I realized something.\n");
  });

  it("treats a document without frontmatter as all body", () => {
    const { frontmatter, body } = splitFrontmatter("Just text.\n");
    expect(frontmatter).toBe("");
    expect(body).toBe("Just text.\n");
  });

  it("treats an unterminated frontmatter block as all body", () => {
    const data = "---\ncreated: 2026-08-12T22:41:52+03:00\nno closing delimiter\n";
    expect(splitFrontmatter(data).frontmatter).toBe("");
    expect(splitFrontmatter(data).body).toBe(data);
  });

  it("does not treat a horizontal rule mid-document as frontmatter", () => {
    const data = "Some text\n\n---\n\nMore text\n";
    expect(splitFrontmatter(data).frontmatter).toBe("");
  });
});

describe("replaceBody", () => {
  it("preserves unknown frontmatter properties byte for byte", () => {
    const result = replaceBody(withFrontmatter, "\nCompletely new text.\n");
    expect(result).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\ntags:\n  - journal\nmood: "calm"\n---\n` +
        `\nCompletely new text.\n`,
    );
  });

  it("round-trips an unchanged body", () => {
    const { body } = splitFrontmatter(withFrontmatter);
    expect(replaceBody(withFrontmatter, body)).toBe(withFrontmatter);
  });

  it("replaces the whole document when there is no frontmatter", () => {
    expect(replaceBody("Old text.\n", "New text.\n")).toBe("New text.\n");
  });

  it("preserves CRLF frontmatter delimiters", () => {
    const data = "---\r\ncreated: x\r\n---\r\nold body";
    expect(replaceBody(data, "new body")).toBe("---\r\ncreated: x\r\n---\r\nnew body");
  });
});
