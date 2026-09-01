import { type App, SuggestModal } from "obsidian";
import { parseSearchQuery } from "../journal/entrySearch";
import { searchSnapshot, type JournalSnapshot, type SearchHit } from "../services/journalSearch";
import { formatTime } from "../utils/dates";

/**
 * One row. Four kinds, and the three synthetic ones each exist for a reason
 * the list of entries cannot express by itself:
 *
 * - `clear` gets the user back to the whole journal, so a query matching
 *   nothing must not be able to hide it. Same role, same position and the
 *   same argument as `TagScopeModal`'s.
 * - `all` is the second exit: it scopes the timeline instead of going to one
 *   entry. It carries the query and the hits so the caller needs no state of
 *   its own — a modal that parked its answer on the plugin would make two
 *   objects responsible for one thing.
 * - `unreadable` is not choosable. It is the only place a user can learn
 *   that this answer is incomplete, which CLAUDE.md § Error Handling asks
 *   for and a search owes more than most surfaces do.
 */
export type SearchChoice =
  | { kind: "clear" }
  | { kind: "all"; count: number; query: string; hits: SearchHit[] }
  | { kind: "hit"; hit: SearchHit }
  | { kind: "unreadable"; count: number };

/**
 * The way into a search.
 *
 * A suggester rather than a plain prompt because the command answers two
 * questions at once — "take me to that entry" and "show me all of them" —
 * and only a list can offer both without making the user decide before they
 * have seen anything.
 *
 * Matches over a snapshot read once, before this opened: `getSuggestions`
 * runs on every keystroke and must never touch the disk. See
 * `services/journalSearch.ts`.
 *
 * Like `TagScopeModal`, this matches with plain substrings rather than
 * `prepareFuzzySearch`. The reason differs — tags are short deliberate words,
 * whereas this is prose — but the conclusion is the same: fuzzy recall adds
 * noise to what is meant to be an answer, and the user is remembering
 * something they wrote themselves.
 */
export class SearchModal extends SuggestModal<SearchChoice> {
  constructor(
    app: App,
    private readonly snapshot: JournalSnapshot,
    private readonly hasScope: boolean,
    private readonly onChoose: (choice: SearchChoice) => void,
  ) {
    super(app);
    this.setPlaceholder("Search the journal");
    this.emptyStateText = "No entries match.";
  }

  getSuggestions(query: string): SearchChoice[] {
    const hits = searchSnapshot(this.snapshot, parseSearchQuery(query));

    const rows: SearchChoice[] = [];
    if (this.hasScope) rows.push({ kind: "clear" });
    if (hits.length > 0) {
      rows.push({ kind: "all", count: hits.length, query: query.trim(), hits });
    }
    for (const hit of hits) rows.push({ kind: "hit", hit });

    // Last, and only alongside an answer. It is a caveat ABOUT the results,
    // so putting it first would push the results themselves off the first
    // screen, and showing it over an empty list would read as the reason
    // there are none.
    if (this.snapshot.unreadable > 0 && rows.length > 0) {
      rows.push({ kind: "unreadable", count: this.snapshot.unreadable });
    }

    return rows;
  }

  renderSuggestion(choice: SearchChoice, el: HTMLElement): void {
    if (choice.kind === "clear") {
      el.setText("Clear filter");
      return;
    }

    if (choice.kind === "all") {
      el.setText(`Show all ${choice.count} matches`);
      return;
    }

    if (choice.kind === "unreadable") {
      el.addClass("journal-search-unreadable");
      el.setText(`${choice.count} entries could not be read.`);
      return;
    }

    el.addClass("journal-search-suggestion");
    el.createSpan({ cls: "journal-search-time", text: formatTime(choice.hit.entry.created) });
    // Three spans, not one string with markup: the excerpt is the user's own
    // text, and it reaches the DOM as text nodes only. Nothing anyone writes
    // in an entry can style or restructure the list it appears in.
    const excerpt = el.createSpan({ cls: "journal-search-excerpt" });
    excerpt.createSpan({ text: choice.hit.snippet.before });
    excerpt.createSpan({ cls: "journal-search-match", text: choice.hit.snippet.match });
    excerpt.createSpan({ text: choice.hit.snippet.after });
  }

  // Takes the same two parameters as the real abstract member, for the reason
  // `TagScopeModal.onChooseSuggestion` documents: narrowing the arity would
  // make TypeScript check calls against the narrower one for every reference
  // typed as this class rather than as the real API.
  onChooseSuggestion(choice: SearchChoice, _evt: MouseEvent | KeyboardEvent): void {
    if (choice.kind === "unreadable") return;
    this.onChoose(choice);
  }
}
