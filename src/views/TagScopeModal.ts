import { type App, SuggestModal } from "obsidian";
import { normalizeTag } from "../journal/entryTags";

/** Either a tag to scope to, or the request to clear the current scope. */
export type TagChoice = { kind: "tag"; tag: string } | { kind: "clear" };

/**
 * The primary way into a tag scope. A suggester rather than clickable tags
 * everywhere: it covers inline and frontmatter tags alike with one control,
 * and hijacks no native interaction — Obsidian's own inline tag pill keeps
 * opening Obsidian's own search, so the same pill never means two different
 * things in two different places.
 *
 * `getSuggestions` matches with a plain substring `includes`, not
 * `prepareFuzzySearch` — the fuzzy matcher every sibling Obsidian suggester
 * (command palette, quick switcher, link autocomplete) uses, complete with
 * highlighted matched characters. That is a deliberate departure from
 * "native Obsidian behaviour", accepted because tags are short, complete,
 * deliberately-typed words rather than long titles a user is scanning or
 * half-remembering: fuzzy recall and highlighting solve a recall problem
 * this list doesn't have, at the cost of a control most users will never
 * need. No behaviour change is intended here — only naming the tension.
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
    // Reachable in exactly one case: `main.ts`'s `filterByTag` refuses to open
    // this modal at all when the journal has no tags and no scope is active,
    // and `getSuggestions` always keeps at least the "Clear filter" item while
    // a scope IS active — so an empty list only ever means a query that
    // matched nothing in a journal that has tags. A message claiming the
    // journal has no tags would be false every time it is shown.
    this.emptyStateText = "No matching tags.";
  }

  getSuggestions(query: string): TagChoice[] {
    // A user who types `#work` means `work` — the `#` is how tags are written
    // inline, and refusing it would just look broken. Shares `entryTags.ts`'s
    // `normalizeTag` rather than re-deriving the same rule here: this file's
    // own `query.trim().replace(/^#+/, "").toLowerCase()` used to skip the
    // second trim `normalizeTag` does after stripping the `#`, so a query
    // like `"# work"` left a leading space in the needle and silently failed
    // to match a tag that was visibly right there in the list.
    const needle = normalizeTag(query).toLowerCase();
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
