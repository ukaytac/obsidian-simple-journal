// This file has two layers:
//
//   - The byte-exact layer: `splitFrontmatter` and `replaceBody`. Their
//     contract is `frontmatter + body === data`, always, for any input,
//     including a body that itself starts with a newline. This is what
//     protects a user's arbitrary frontmatter — it must never be changed to
//     "help" a caller, and its round-trip guarantee holds regardless of
//     anything below.
//   - The convention layer: `stripSeparator`/`preserveSeparator`. These know
//     one extra fact the byte-exact layer deliberately doesn't: an entry MAY
//     have exactly one blank line between the closing `---` and its text,
//     and when it does, that line is a separator, not content. A newly
//     created entry (`EntryRepository.createEntry`) is written WITHOUT that
//     blank line; an existing entry keeps whatever it already has — this
//     layer's job is to preserve that choice, never to impose one. They
//     exist so callers (EntryRepository, ObsidianEmbedEditor) can work in a
//     body-without-separator convention without each reimplementing the same
//     one-newline-wide rule. Nothing here changes what `splitFrontmatter`/
//     `replaceBody` themselves consider "the body" — the stripping/preserving
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
 * This and `preserveSeparator` are the only functions that know the separator
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
 * Preserves whatever separator `existingBody` already has ahead of `newBody`,
 * rather than imposing one. `existingBody` is the body half of
 * `splitFrontmatter` on the document exactly as it stood on disk BEFORE this
 * write. If it already starts with a blank-line separator — `\r\n` or `\n` —
 * that same separator is kept ahead of `newBody`; if it doesn't (in
 * particular, a brand-new entry, which `EntryRepository.createEntry` now
 * writes with no separator at all), none is added.
 *
 * This function used to be `restoreSeparator` and unconditionally invented a
 * separator from `frontmatter`'s own newline flavour — appropriate when
 * every entry this plugin wrote was guaranteed to have one. That guarantee
 * no longer holds: CLAUDE.md's storage format for a NEW entry has no blank
 * line, and an existing entry's separator (or lack of one) is exactly the
 * kind of byte this plugin must never normalize out from under a user. So
 * this now preserves what is already there instead of choosing for the
 * caller — the separator itself is read directly off `existingBody`, which
 * makes sniffing `frontmatter` for a newline flavour unnecessary: whatever
 * separator bytes exist are already sitting in `existingBody` to copy.
 *
 * Returns `newBody` unchanged when `frontmatter` is empty — there is no
 * separator concept to preserve when there's no frontmatter block at all.
 *
 * Pass the result to `replaceBody`, not straight to disk: `replaceBody` still
 * owns inserting the newline that keeps the delimiter from fusing with the
 * body when frontmatter itself has no trailing newline.
 */
export function preserveSeparator(frontmatter: string, existingBody: string, newBody: string): string {
  if (!frontmatter) return newBody;
  if (existingBody.startsWith("\r\n")) return `\r\n${newBody}`;
  if (existingBody.startsWith("\n")) return `\n${newBody}`;
  return newBody;
}

// Matches a top-level `created` property line: anchored to the start of a
// line (via `m`), so it only ever fires at column 0. A nested key such as
// `context:\n  created: false` can never match here — its line starts with
// spaces, not `c` — without this function having to understand YAML nesting
// at all. Captures nothing; the whole match (key, colon, and everything up
// to but not including the line's own terminator) is what gets replaced, so
// the CRLF/LF terminator itself is left completely alone.
//
// This same anchoring is what makes it possible for the match to land
// somewhere that ISN'T the real top-level `created` key: a multi-line YAML
// scalar belonging to an EARLIER property can itself contain a line that
// starts with `created:` at column 0 (YAML plain/quoted scalars don't
// require their continuation lines to be indented). `assertSafeCreatedLine`
// exists specifically to catch that and every other shape this regex alone
// cannot tell apart from a genuine single-line `created: value`.
const CREATED_LINE = /^created:[ \t]*[^\r\n]*/m;
const CREATED_LINE_GLOBAL = /^created:[ \t]*[^\r\n]*/gm;

// Matches just the frontmatter's opening delimiter line (optional BOM,
// `---`, optional trailing spaces/tabs, its newline), so a missing `created`
// key can be inserted immediately after it — as the new first property —
// without disturbing anything else in the block.
const OPENING_DELIMITER = /^﻿?---[ \t]*\r?\n/;

/**
 * Thrown by `setCreatedProperty` when it refuses to touch a `created`
 * property it cannot safely treat as an ordinary single-line scalar — see
 * `assertSafeCreatedLine` for exactly which shapes this covers. Refusing is
 * deliberate: CLAUDE.md forbids rewriting or normalizing frontmatter this
 * plugin doesn't own, and every one of these shapes is a case where a blind
 * line-replace would either destroy content or leave an orphaned fragment
 * behind, invisibly. `JournalView.changeEntryTime` catches this specifically
 * to show the user a message they can act on (edit `created` in the source
 * note themselves) rather than the generic write-failure Notice.
 */
export class UnsafeFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFrontmatterError";
  }
}

/**
 * Refuses (via `UnsafeFrontmatterError`) to let `setCreatedProperty` touch a
 * `created` line unless it can be confident the line is an ordinary,
 * self-contained scalar. A no-op when there is no top-level `created` key at
 * all — `setCreatedProperty` inserts one fresh in that case, with nothing
 * existing to misjudge. Four distinct shapes are rejected:
 *
 * - More than one line matches `CREATED_LINE`. Most often a genuine
 *   duplicate key (which `created:` value Obsidian's own YAML reader
 *   resolves to isn't something this function should guess at either), but
 *   also how the multi-line-scalar collision above gets caught: a line deep
 *   inside another property's own value that happens to start with
 *   `created:` at column 0 produces a second match, and this bails before
 *   either one is touched.
 * - The value starts with `|` or `>`: a multi-line YAML block scalar.
 *   Replacing only the header line would leave its indented body behind as
 *   an orphaned fragment.
 * - The line right after the match is indented, OR is a block-sequence
 *   item (`-` followed by a space/tab) at column 0. A plain YAML scalar
 *   can fold onto an indented line without any `|`/`>` marker at all; an
 *   empty value (`created:` with nothing after it) can equally be followed
 *   by a zero-indented block sequence (`created:\n- foo`), which is its
 *   value, not a sibling property. Either way, replacing only the matched
 *   line would leave that line behind as an orphaned fragment.
 * - The value has a `#` preceded by whitespace (or starting it) — a YAML
 *   comment. Replacing the line would silently drop it, and telling a real
 *   comment apart from a value that merely contains `#` needs a full YAML
 *   parser this function deliberately doesn't have.
 */
function assertSafeCreatedLine(frontmatter: string): void {
  const matches = frontmatter.match(CREATED_LINE_GLOBAL) ?? [];
  if (matches.length > 1) {
    throw new UnsafeFrontmatterError(
      "This entry's frontmatter has more than one line that looks like a top-level \"created\" key.",
    );
  }
  if (matches.length === 0) return;

  const match = CREATED_LINE.exec(frontmatter)!;
  const value = match[0].slice(match[0].indexOf(":") + 1).trim();

  if (value.startsWith("|") || value.startsWith(">")) {
    throw new UnsafeFrontmatterError("This entry's \"created\" property is a multi-line YAML block scalar.");
  }

  if (/(^|[ \t])#/.test(value)) {
    throw new UnsafeFrontmatterError("This entry's \"created\" line has a trailing comment.");
  }

  const rest = frontmatter.slice(match.index + match[0].length);
  if (/^\r?\n(?:[ \t]+\S|-[ \t])/.test(rest)) {
    throw new UnsafeFrontmatterError("This entry's \"created\" property continues onto an indented line.");
  }
}

/**
 * True if `frontmatter` (as `splitFrontmatter` returns it) has at least one
 * line matching the top-level `created:` pattern. Exposed so a caller with
 * independent knowledge of what a file's frontmatter actually parses to —
 * `EntryRepository.setEntryCreated`, cross-checking against
 * `metadataCache.getFileCache()` — can detect the one shape
 * `assertSafeCreatedLine`'s "more than one match" guard cannot: exactly one
 * match that is a false positive (found inside another property's own
 * multi-line value), with no genuine second `created` line to raise the
 * alarm. See `setEntryCreated`'s doc for that cross-check.
 */
export function hasCreatedLine(frontmatter: string): boolean {
  return CREATED_LINE.test(frontmatter);
}

/**
 * Replaces the value of the top-level `created` property, and nothing else.
 * Every other byte of the document — other properties, their order and
 * formatting, the body, a horizontal rule or a `created:`-looking line
 * inside the body — is left untouched.
 *
 * `value` is always written double-quoted (matching the convention
 * `EntryRepository.createEntry` already writes), regardless of whether the
 * existing value was quoted, unquoted, or had trailing whitespace: this
 * function replaces the value, it does not attempt to preserve the previous
 * value's own formatting.
 *
 * If the frontmatter block has no `created` key, one is inserted as the
 * first property. If the document has no frontmatter block at all, one is
 * created — the whole original document becomes the body, byte-identical,
 * exactly as `splitFrontmatter` would already report it (an empty
 * frontmatter, the original text as body).
 *
 * Throws `UnsafeFrontmatterError` — writing nothing — rather than guess at a
 * `created` line it cannot safely treat as a single-line scalar. See
 * `assertSafeCreatedLine`.
 */
export function setCreatedProperty(data: string, value: string): string {
  const { frontmatter, body } = splitFrontmatter(data);
  const quoted = JSON.stringify(value);

  if (!frontmatter) {
    return `---\ncreated: ${quoted}\n---\n${data}`;
  }

  assertSafeCreatedLine(frontmatter);

  if (CREATED_LINE.test(frontmatter)) {
    return frontmatter.replace(CREATED_LINE, `created: ${quoted}`) + body;
  }

  // No existing `created` key: insert one right after the opening
  // delimiter. `splitFrontmatter` only ever returns a non-empty
  // `frontmatter` when it matched the same opening-delimiter shape, so this
  // is guaranteed to match too.
  const opening = OPENING_DELIMITER.exec(frontmatter)![0];
  const newLine = `created: ${quoted}${frontmatter.includes("\r\n") ? "\r\n" : "\n"}`;
  return opening + newLine + frontmatter.slice(opening.length) + body;
}
