import { type App, SuggestModal } from "obsidian";

/** Either a tag to scope to, or the request to clear the current scope. */
export type TagChoice = { kind: "tag"; tag: string } | { kind: "clear" };

/**
 * The primary way into a tag scope. A suggester rather than clickable tags
 * everywhere: it covers inline and frontmatter tags alike with one control,
 * and hijacks no native interaction — Obsidian's own inline tag pill keeps
 * opening Obsidian's own search, so the same pill never means two different
 * things in two different places.
 */
export class TagScopeModal extends SuggestModal<TagChoice> {
  constructor(
    app: App,
    private readonly tags: readonly string[],
    private readonly hasScope: boolean,
    private readonly onChoose: (choice: TagChoice) => void,
  ) {
    super(app);
    this.setPlaceholder("Filter the journal by tag");
    this.emptyStateText = "No tags in the journal yet.";
  }

  getSuggestions(query: string): TagChoice[] {
    // A user who types `#work` means `work` — the `#` is how tags are written
    // inline, and refusing it would just look broken.
    const needle = query.trim().replace(/^#+/, "").toLowerCase();
    const matches = this.tags
      .filter((tag) => tag.toLowerCase().includes(needle))
      .map((tag): TagChoice => ({ kind: "tag", tag }));

    // Unfiltered and always first while a scope is active: it is how the user
    // gets back to the whole journal, so a query that happens to match
    // nothing must not be able to hide it.
    return this.hasScope ? [{ kind: "clear" }, ...matches] : matches;
  }

  renderSuggestion(choice: TagChoice, el: HTMLElement): void {
    el.setText(choice.kind === "clear" ? "Clear filter" : `#${choice.tag}`);
  }

  // Takes the same two parameters as the real abstract member (rather than
  // dropping the unused `evt`) so a caller holding a `TagScopeModal`-typed
  // reference can still call it at the real API's arity — narrowing the
  // override to one parameter would make TypeScript check calls against that
  // narrower arity for every reference typed as this class, not the real one.
  onChooseSuggestion(choice: TagChoice, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(choice);
  }
}
