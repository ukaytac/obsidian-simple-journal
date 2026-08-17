// This file has two layers:
//
//   - The byte-exact layer: `splitFrontmatter` and `replaceBody`. Their
//     contract is `frontmatter + body === data`, always, for any input,
//     including a body that itself starts with a newline. This is what
//     protects a user's arbitrary frontmatter — it must never be changed to
//     "help" a caller, and its round-trip guarantee holds regardless of
//     anything below.
//   - The convention layer: `stripSeparator`/`restoreSeparator`. These know
//     one extra fact the byte-exact layer deliberately doesn't: a
//     conventional entry has exactly one blank line between the closing
//     `---` and its text, and that line is a separator, not content. They
//     exist so callers (EntryRepository, ObsidianEmbedEditor) can work in a
//     body-without-separator convention without each reimplementing the same
//     one-newline-wide rule. Nothing here changes what `splitFrontmatter`/
//     `replaceBody` themselves consider "the body" — the stripping/restoring
//     happens entirely on the caller's side of the byte-exact boundary.

export interface SplitDocument {
  /** The frontmatter block including both `---` delimiter lines and the trailing newline. Empty when absent. */
  frontmatter: string;
  /** Everything after the frontmatter block, including any leading blank line. */
  body: string;
}

// Matches the whole frontmatter block in one pass: an optional leading BOM,
// the opening `---` (with optional trailing spaces/tabs), an optional
// property region, the closing `---` (with optional trailing spaces/tabs),
// and its trailing newline if present. The property region is non-greedy and
// always consumes a full trailing newline before matching the closer, so a
// `---` line is only ever recognized as a delimiter at the very start of a
// line — never as a horizontal rule embedded in a YAML block scalar.
const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Splits a Markdown document into its frontmatter block and its body.
 * Frontmatter is only recognized at the very start of the document, so a
 * horizontal rule further down is never mistaken for a delimiter.
 *
 * Invariant: `frontmatter + body === data` always holds.
 */
export function splitFrontmatter(data: string): SplitDocument {
  const match = FRONTMATTER.exec(data);
  if (!match) return { frontmatter: "", body: data };

  const frontmatter = match[0];
  return { frontmatter, body: data.slice(frontmatter.length) };
}

/**
 * Returns `data` with its body replaced. The frontmatter block, including any
 * properties this plugin does not understand, is preserved exactly.
 *
 * Guarantees the result never reparses with different frontmatter than what
 * was preserved: if the frontmatter block doesn't already end in a newline
 * (only possible when the original document had no trailing newline after
 * its closing `---`), a newline is inserted so the delimiter can never fuse
 * with `body` into what would look like a horizontal rule or altered line.
 */
export function replaceBody(data: string, body: string): string {
  const { frontmatter } = splitFrontmatter(data);
  if (frontmatter && !frontmatter.endsWith("\n")) return `${frontmatter}\n${body}`;
  return frontmatter + body;
}

/**
 * Strips exactly one leading newline (`\n` or `\r\n`) from a `splitFrontmatter`
 * body, when `frontmatter` is non-empty — that one newline is the blank-line
 * *separator* between the frontmatter block and the entry text, not content.
 * A body that doesn't start with a newline (no blank line was there to begin
 * with) is returned unchanged: there is nothing to strip.
 *
 * When `frontmatter` is empty (no frontmatter block at all), the body is
 * returned untouched — the document's first newline is then part of the
 * content, not a separator, since there is no separator to speak of.
 *
 * This and `restoreSeparator` are the only functions that know the separator
 * is exactly one newline wide. `splitFrontmatter`/`replaceBody` themselves
 * stay byte-exact and are never called with anything but the whole document.
 */
export function stripSeparator(frontmatter: string, body: string): string {
  if (!frontmatter) return body;
  if (body.startsWith("\r\n")) return body.slice(2);
  if (body.startsWith("\n")) return body.slice(1);
  return body;
}

/**
 * The inverse of `stripSeparator`: restores exactly one newline of separator
 * ahead of `body`, in whichever newline flavour `frontmatter` uses — `\r\n`
 * if the block contains one anywhere, `\n` otherwise. Checked with
 * `includes`, not `endsWith`: the closing delimiter can sit at EOF with no
 * trailing newline of its own (`---\r\ncreated: x\r\n---`, the rare case a
 * user's last edit left with no final newline at all), and `endsWith` would
 * then miss the `\r\n` earlier in the block and wrongly fall back to `\n`,
 * introducing a bare LF into an otherwise all-CRLF file. Returns `body`
 * unchanged when `frontmatter` is empty, so a file with no frontmatter block
 * is never given one.
 *
 * Pass the result to `replaceBody`, not straight to disk: `replaceBody` still
 * owns inserting the newline that keeps the delimiter from fusing with the
 * body when frontmatter itself has no trailing newline.
 */
export function restoreSeparator(frontmatter: string, body: string): string {
  if (!frontmatter) return body;
  return (frontmatter.includes("\r\n") ? "\r\n" : "\n") + body;
}
