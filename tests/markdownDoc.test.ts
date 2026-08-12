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

describe("empty and EOF-terminated frontmatter blocks", () => {
  it("recognizes an empty frontmatter block", () => {
    expect(splitFrontmatter("---\n---\n\nBody\n").frontmatter).toBe("---\n---\n");
  });
});

// Regression inputs for two data-loss bugs found in code review:
//  - an empty (or just-emptied, via Obsidian's Properties UI) frontmatter
//    block was not recognized as frontmatter at all, so it got silently
//    deleted on the next write.
//  - a closing `---` at end-of-file (no trailing newline) fused into the
//    body on write, so re-parsing the result found no frontmatter and the
//    *next* write deleted every property.
// Every entry must satisfy `frontmatter + body === input` and must be
// idempotent under repeated `replaceBody` calls.
const invariantTable: Array<[string, string]> = [
  ["empty block, blank line then body, LF", "---\n---\n\nBody\n"],
  ["empty block, body on next line, LF", "---\n---\nBody\n"],
  ["empty block, trailing newline, no body", "---\n---\n"],
  ["empty block, no trailing newline, no body", "---\n---"],
  ["empty block, CRLF", "---\r\n---\r\n\r\nBody\r\n"],
  ["closing delimiter at EOF, LF", "---\ncreated: x\n---"],
  ["closing delimiter at EOF, CRLF", "---\r\ncreated: x\r\n---"],
  ["document with no trailing newline, no frontmatter", "No trailing newline"],
  ["empty string", ""],
  ["whitespace-only document", "   \n  \n"],
  ["exactly the opening delimiter, no newline", "---"],
  ["exactly the opening delimiter, with newline", "---\n"],
  ["BOM-prefixed document", "﻿---\ncreated: x\n---\nBody\n"],
  ["trailing whitespace on opening delimiter", "---   \ncreated: x\n---\nBody\n"],
  ["trailing whitespace on closing delimiter", "---\ncreated: x\n---   \nBody\n"],
  ["mixed line endings", "---\r\ncreated: x\n---\r\nBody\r\n"],
  [
    "YAML block scalar containing an indented line equal to ---",
    "---\ndescription: |\n  ---\nreal: value\n---\nBody\n",
  ],
];

describe("splitFrontmatter invariant", () => {
  it.each(invariantTable)("frontmatter + body === input for: %s", (_label, input) => {
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter + body).toBe(input);
  });
});

describe("replaceBody idempotence", () => {
  it.each(invariantTable)("is idempotent for: %s", (_label, input) => {
    const newBody = "\nReplacement body.\n";
    const once = replaceBody(input, newBody);
    const twice = replaceBody(once, newBody);
    expect(twice).toBe(once);
  });
});

describe("replaceBody with an unusual body argument", () => {
  it("accepts a body that does not begin with a newline", () => {
    const data = "---\ncreated: x\n---\n\nOld body.\n";
    const result = replaceBody(data, "No leading newline body.\n");
    expect(result).toBe("---\ncreated: x\n---\nNo leading newline body.\n");
  });
});
