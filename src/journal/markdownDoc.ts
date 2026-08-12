export interface SplitDocument {
  /** The frontmatter block including both `---` delimiter lines and the trailing newline. Empty when absent. */
  frontmatter: string;
  /** Everything after the frontmatter block, including any leading blank line. */
  body: string;
}

const OPENING_DELIMITER = /^---\r?\n/;
const CLOSING_DELIMITER = /\r?\n---(\r?\n|$)/;

/**
 * Splits a Markdown document into its frontmatter block and its body.
 * Frontmatter is only recognized at the very start of the document, so a
 * horizontal rule further down is never mistaken for a delimiter.
 */
export function splitFrontmatter(data: string): SplitDocument {
  const opening = OPENING_DELIMITER.exec(data);
  if (!opening) return { frontmatter: "", body: data };

  const afterOpening = opening[0].length;
  const closing = CLOSING_DELIMITER.exec(data.slice(afterOpening));
  if (!closing) return { frontmatter: "", body: data };

  const end = afterOpening + closing.index + closing[0].length;
  return { frontmatter: data.slice(0, end), body: data.slice(end) };
}

/**
 * Returns `data` with its body replaced. The frontmatter block, including any
 * properties this plugin does not understand, is preserved exactly.
 */
export function replaceBody(data: string, body: string): string {
  return splitFrontmatter(data).frontmatter + body;
}
