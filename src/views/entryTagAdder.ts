import { AbstractInputSuggest, Notice, setTooltip, type App } from "obsidian";
import { validateNewTag } from "../journal/entryTags";

/**
 * The "Add tag" control beside an entry's time: a quiet `+ tag` that turns into a
 * one-line field with the journal's tags as suggestions — CLAUDE.md § Tags,
 * Rule 2, for why the plugin writes a tag at all, and only from here.
 *
 * It sits in its own element, never inside `.journal-entry-tags` (the chip
 * row under the text): the chips are re-rendered from the metadata cache on
 * every change to the entry (`JournalView.refreshEntryTags`), including the
 * change this control's own write causes, and a field living in there would
 * be emptied out from under the user's typing.
 *
 * It knows nothing about files. `commit` is the view's: it flushes a pending
 * body save and writes through `EntryRepository.addEntryTag`, so the one
 * write path stays where the time correction's already is.
 */
export interface TagAdderDeps {
  app: App;
  /** Every tag in the journal, for suggestions. Read when the field opens. */
  journalTags(): string[];
  /** The entry's frontmatter tags now, so a suggestion never offers one it has. */
  entryTags(): string[];
  /** Writes `tag` (already validated). Reports its own failures. */
  commit(tag: string): Promise<void>;
}

/** How many suggestions to show at once; a journal's tag list is short anyway. */
const SUGGESTION_LIMIT = 20;

/**
 * One suggestion: an existing tag, or the typed text itself as a new one.
 * The typed text is offered first whenever it is not already an existing
 * tag, so Enter on `trav` writes `trav` rather than the highlighted `travel`.
 */
interface TagSuggestion {
  tag: string;
  isNew: boolean;
}

class TagSuggest extends AbstractInputSuggest<TagSuggestion> {
  /** Whether the list is showing — it owns Enter while it is. */
  showing = false;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly candidates: () => string[],
  ) {
    super(app, inputEl);
    this.limit = SUGGESTION_LIMIT;
  }

  protected getSuggestions(query: string): TagSuggestion[] {
    const typed = query.trim().replace(/^#+/, "").trim();
    // Nothing for an empty field: Enter there would otherwise write whatever
    // tag happened to be highlighted first, which the user never chose.
    if (!typed) return [];

    const needle = typed.toLowerCase();
    const matches = this.candidates().filter((tag) => tag.toLowerCase().includes(needle));
    const exact = matches.some((tag) => tag.toLowerCase() === needle);
    const suggestions = matches.map((tag) => ({ tag, isNew: false }));
    return exact ? suggestions : [{ tag: typed, isNew: true }, ...suggestions];
  }

  renderSuggestion(value: TagSuggestion, el: HTMLElement): void {
    el.setText(`#${value.tag}`);
    if (value.isNew) el.createSpan({ cls: "journal-tag-suggestion-new", text: "New tag" });
  }

  override open(): void {
    super.open();
    this.showing = true;
  }

  override close(): void {
    super.close();
    this.showing = false;
  }
}

export function createTagAdder(containerEl: HTMLElement, deps: TagAdderDeps): void {
  const button = containerEl.createEl("button", {
    cls: "journal-entry-tag-add",
    text: "+ tag",
    attr: { type: "button" },
  });
  // The visible "+ tag" reads to a screen reader as "plus tag"; the tooltip
  // doubles as the accessible name and names the action instead, as the
  // chips' "Filter by #…" does.
  setTooltip(button, "Add tag");

  let inputEl: HTMLInputElement | null = null;
  let suggest: TagSuggest | null = null;
  let committing = false;

  const closeField = (): void => {
    suggest?.close();
    suggest = null;
    inputEl?.remove();
    inputEl = null;
    button.hidden = false;
  };

  const submit = async (raw: string): Promise<void> => {
    if (committing) return;
    const result = validateNewTag(raw);
    if (!result.ok) {
      // An empty Enter is how a keyboard user says "never mind".
      if (!raw.trim().replace(/^#+/, "").trim()) {
        closeField();
        button.focus();
        return;
      }
      new Notice(result.reason);
      return;
    }

    committing = true;
    closeField();
    button.focus();
    try {
      await deps.commit(result.tag);
    } finally {
      committing = false;
    }
  };

  const openField = (): void => {
    if (inputEl) return;
    button.hidden = true;

    const input = containerEl.createEl("input", {
      cls: "journal-entry-tag-input",
      attr: {
        type: "text",
        placeholder: "Add tag",
        "aria-label": "Add tag",
        enterkeyhint: "done",
        autocapitalize: "off",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    inputEl = input;

    const candidates = (): string[] => {
      const present = new Set(deps.entryTags().map((tag) => tag.toLowerCase()));
      return deps.journalTags().filter((tag) => !present.has(tag.toLowerCase()));
    };
    const suggestEl = new TagSuggest(deps.app, input, candidates);
    suggestEl.onSelect((value) => {
      void submit(value.tag);
    });
    suggest = suggestEl;

    input.addEventListener("keydown", (event) => {
      // While the list is open it owns Enter and the arrows: it selects the
      // highlighted suggestion, which is the typed text itself when that is
      // new (see `TagSuggestion`).
      if (event.key === "Enter" && !event.isComposing && !suggestEl.showing) {
        event.preventDefault();
        void submit(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeField();
        button.focus();
      }
    });

    // Leaving an empty field closes it. Leaving one with text in it does not:
    // what was typed is kept until Enter or Escape decides, rather than
    // written or thrown away by a blur nobody may have meant — and a click on
    // a suggestion must still find the field there.
    input.addEventListener("blur", () => {
      if (inputEl === input && !input.value.trim()) closeField();
    });

    input.focus();
  };

  button.addEventListener("click", openField);
}
