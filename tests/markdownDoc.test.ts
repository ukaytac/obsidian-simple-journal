import { describe, expect, it } from "vitest";
import {
  replaceBody,
  restoreSeparator,
  setCreatedProperty,
  splitFrontmatter,
  stripSeparator,
  UnsafeFrontmatterError,
} from "../src/journal/markdownDoc";

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

describe("stripSeparator", () => {
  it("strips exactly one leading LF separator when frontmatter is present", () => {
    expect(stripSeparator("---\ncreated: x\n---\n", "\nBody.\n")).toBe("Body.\n");
  });

  it("strips exactly one leading CRLF separator when frontmatter is present", () => {
    expect(stripSeparator("---\r\ncreated: x\r\n---\r\n", "\r\nBody.\r\n")).toBe("Body.\r\n");
  });

  it("leaves a body with no leading blank line unchanged", () => {
    expect(stripSeparator("---\ncreated: x\n---\n", "Body.\n")).toBe("Body.\n");
  });

  it("strips only one of two leading blank lines, keeping the second as content", () => {
    expect(stripSeparator("---\ncreated: x\n---\n", "\n\nBody.\n")).toBe("\nBody.\n");
  });

  it("returns the body untouched when there is no frontmatter at all", () => {
    expect(stripSeparator("", "\nBody.\n")).toBe("\nBody.\n");
  });

  it("returns an empty body untouched", () => {
    expect(stripSeparator("---\ncreated: x\n---\n", "")).toBe("");
  });
});

describe("restoreSeparator", () => {
  it("restores an LF separator when frontmatter ends in LF", () => {
    expect(restoreSeparator("---\ncreated: x\n---\n", "Body.\n")).toBe("\nBody.\n");
  });

  it("restores a CRLF separator when frontmatter ends in CRLF", () => {
    expect(restoreSeparator("---\r\ncreated: x\r\n---\r\n", "Body.\r\n")).toBe("\r\nBody.\r\n");
  });

  it("restores a CRLF separator when the closing delimiter is at EOF with no trailing newline of its own", () => {
    // Regression case: `endsWith("\r\n")` would be false here (the block ends
    // in bare "---", not a newline), wrongly falling back to LF and
    // introducing a bare LF into an otherwise all-CRLF file. `includes`
    // finds the CRLF earlier in the block instead.
    const frontmatter = "---\r\ncreated: x\r\n---";
    expect(restoreSeparator(frontmatter, "Body.\n")).toBe("\r\nBody.\n");
  });

  it("restores an LF separator when the closing delimiter is at EOF with no CRLF anywhere in the block", () => {
    const frontmatter = "---\ncreated: x\n---";
    expect(restoreSeparator(frontmatter, "Body.\n")).toBe("\nBody.\n");
  });

  it("restores a CRLF separator for a block with mixed line endings, even though it ends in a bare LF", () => {
    // A property line uses CRLF but the closing delimiter's own trailing
    // newline is bare LF: `endsWith("\r\n")` would be false and wrongly pick
    // LF; `includes` finds the CRLF used earlier in the block instead.
    const frontmatter = "---\ncreated: x\r\n---\n";
    expect(restoreSeparator(frontmatter, "Body.\n")).toBe("\r\nBody.\n");
  });

  it("returns the body untouched when there is no frontmatter at all", () => {
    expect(restoreSeparator("", "Body.\n")).toBe("Body.\n");
  });

  it("still adds the separator ahead of an empty body when frontmatter is present", () => {
    // Unlike stripSeparator, an empty body is not "nothing to restore": a
    // brand-new entry's empty body still gets the conventional blank line.
    expect(restoreSeparator("---\ncreated: x\n---\n", "")).toBe("\n");
  });
});

describe("setCreatedProperty", () => {
  const NEW_VALUE = "2026-08-13T09:00:00+03:00";

  it("replaces an unquoted value, preserving other properties byte for byte and in order", () => {
    const data =
      `---\ncreated: 2026-08-12T22:41:52+03:00\ntags:\n  - journal\nmood: "calm"\n---\n\nBody text.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\ntags:\n  - journal\nmood: "calm"\n---\n\nBody text.\n`,
    );
  });

  it("replaces a quoted value", () => {
    const data = `---\ncreated: "2026-08-12T22:41:52+03:00"\n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\n---\nBody.\n`);
  });

  it("replaces a value with trailing whitespace", () => {
    const data = `---\ncreated: 2026-08-12T22:41:52+03:00   \n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\n---\nBody.\n`);
  });

  it("inserts created as the first property when frontmatter has no created key", () => {
    const data = `---\nmood: "calm"\ntags:\n  - journal\n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\nmood: "calm"\ntags:\n  - journal\n---\nBody.\n`,
    );
  });

  it("creates a frontmatter block when the document has none", () => {
    const data = "Just some text.\n";
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\n---\nJust some text.\n`);
  });

  it("does not touch a body line that happens to start with 'created:'", () => {
    const data =
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\ncreated: this is body text about creation, not frontmatter.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\n---\ncreated: this is body text about creation, not frontmatter.\n`,
    );
  });

  it("does not confuse a horizontal rule in the body with another frontmatter block", () => {
    const data = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nSome text\n\n---\n\nMore text\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\n---\n\nSome text\n\n---\n\nMore text\n`,
    );
  });

  it("preserves CRLF line endings", () => {
    const data = "---\r\ncreated: 2026-08-12T22:41:52+03:00\r\n---\r\nBody.\r\n";
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\r\ncreated: "${NEW_VALUE}"\r\n---\r\nBody.\r\n`);
  });

  it("handles an empty document", () => {
    expect(setCreatedProperty("", NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\n---\n`);
  });

  it("does not mistake a nested/indented 'created' key for the top-level one, and inserts a top-level key instead", () => {
    const data = `---\ncontext:\n  created: false\ntags:\n  - journal\n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\ncontext:\n  created: false\ntags:\n  - journal\n---\nBody.\n`,
    );
  });

  it("updates only the top-level 'created' key, leaving a nested 'created' key under another property untouched", () => {
    const data = `---\ncreated: 2026-08-12T22:41:52+03:00\ncontext:\n  created: false\n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(
      `---\ncreated: "${NEW_VALUE}"\ncontext:\n  created: false\n---\nBody.\n`,
    );
  });

  it("treats an unterminated frontmatter block the same as no frontmatter at all: wraps a fresh block around the untouched original", () => {
    const data = "---\ncreated: 2026-08-12T22:41:52+03:00\nno closing delimiter\n";
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\n---\n${data}`);
  });

  it("replaces an empty ('created' with no value) property, when it is followed by an ordinary unindented sibling", () => {
    // Nothing to lose here — an empty value is safely replaced like any
    // other. Contrast with the nested-mapping shape below, where an
    // "empty" `created:` is actually followed by an indented child and
    // must be refused instead.
    const data = `---\ncreated:\nmood: calm\n---\nBody.\n`;
    expect(setCreatedProperty(data, NEW_VALUE)).toBe(`---\ncreated: "${NEW_VALUE}"\nmood: calm\n---\nBody.\n`);
  });

  // Regression-style invariant: the body region (per splitFrontmatter) must
  // be byte-identical before and after, for every shape that actually
  // exercises the value-REPLACE path (a real, single, top-level `created`
  // match). Deliberately excludes shapes where `frontmatter` is empty (no
  // frontmatter at all, an empty document, an unterminated block): for
  // those, `setCreatedProperty` always returns `prefix + data` verbatim, so
  // the body is trivially unchanged no matter what `data` is — an
  // assertion that can never fail is not a test, and each of those shapes
  // already has its own exact-output assertion above instead.
  const bodyInvariantTable: Array<[string, string]> = [
    ["canonical entry", withFrontmatter],
    ["CRLF", "---\r\ncreated: x\r\n---\r\nBody.\r\n"],
    ["horizontal rule in the body", "---\ncreated: x\n---\n\nSome text\n\n---\n\nMore text\n"],
    ["body line starting with 'created:'", "---\ncreated: x\n---\ncreated: not frontmatter.\n"],
  ];

  it.each(bodyInvariantTable)("leaves the body byte-identical for: %s", (_label, input) => {
    const before = splitFrontmatter(input).body;
    const after = splitFrontmatter(setCreatedProperty(input, NEW_VALUE)).body;
    expect(after).toBe(before);
  });
});

describe("setCreatedProperty: refuses rather than mangles unsafe frontmatter", () => {
  const NEW_VALUE = "2026-08-13T09:00:00+03:00";

  it("refuses when the match lands inside another property's own multi-line quoted value (does not touch anything)", () => {
    // The exact shape found in review: `note`'s multi-line quoted value
    // contains a line that starts with `created:` at column 0, producing a
    // second match alongside the real one below it.
    const data = '---\nnote: "hello\ncreated: bad"\nmood: calm\ncreated: 2026-08-12T22:41:52+03:00\n---\nBody.\n';
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses on a duplicate top-level 'created' key", () => {
    const data = "---\ncreated: 2026-08-12T22:41:52+03:00\nmood: calm\ncreated: 2026-08-13T00:00:00+03:00\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses a literal block scalar ('|')", () => {
    const data = "---\ncreated: |\n  2026-08-12T22:41:52+03:00\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses a folded block scalar ('>')", () => {
    const data = "---\ncreated: >\n  2026-08-12T22:41:52+03:00\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses a plain scalar that folds onto an indented continuation line, even with no '|'/'>' marker", () => {
    const data = "---\ncreated: 2026-08-12T22:41:52+03:00\n  continued\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses an empty 'created' followed by an indented nested mapping (not a scalar at all)", () => {
    const data = "---\ncreated:\n  foo: bar\nmood: calm\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses an empty 'created' followed by a zero-indented block sequence (its value, not a sibling property)", () => {
    // "- 2026-08-12" starts at column 0, so the plain "next line indented"
    // check alone would miss this: a YAML block sequence item doesn't need
    // to be indented relative to its key.
    const data = "---\ncreated:\n- 2026-08-12\nmood: calm\n---\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });

  it("refuses a trailing inline comment on the 'created' line", () => {
    const data = "---\ncreated: 2026-08-12T22:41:52+03:00 # when I wrote this\n---\nBody.\n";
    expect(() => setCreatedProperty(data, NEW_VALUE)).toThrow(UnsafeFrontmatterError);
  });
});
