import { type App, ButtonComponent, Modal } from "obsidian";
import type { ReorganizePlan, ReorganizeReport } from "../journal/entryRepository";

/**
 * The confirmation in front of `Reorganize journal folders`.
 *
 * It exists because of scale, not semantics: moving one entry is what a
 * corrected timestamp already does silently, while moving several hundred at
 * once is the plugin's largest single operation and its only irreversible-ish
 * one. So the counts are computed first (`planReorganize` writes nothing) and
 * stated here, before anything is renamed.
 *
 * Everything it says is something the user cannot otherwise find out:
 *
 * - how many entries move, and how many the plugin will not touch
 * - where one of them would land, because "Year" and "No subfolders" are
 *   guesses until you see a path
 * - that links follow only if Obsidian is set to update them, which
 *   `renameFile`'s contract makes conditional and which this plugin cannot
 *   read without reaching into `vault.getConfig` — not public API, and not an
 *   internals exception this feature could justify
 * - that entry contents are never read or rewritten, which is the reason this
 *   operation cannot lose what anyone wrote
 */
export class ReorganizeModal extends Modal {
  constructor(
    app: App,
    private readonly plan: ReorganizePlan,
    /** Where an entry written right now would go, e.g. `Journal/2026/09`. */
    private readonly example: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Reorganize journal folders");

    const count = this.plan.moves.length;

    contentEl.createEl("p", {
      text:
        `${count} ${count === 1 ? "entry" : "entries"} will move into the folder layout ` +
        `you chose. An entry written now would go to ${this.example}/.`,
    });

    // Only when there are any: "0 entries stay where they are" is noise, and
    // the sentence explaining why would be explaining nothing.
    if (this.plan.staying > 0) {
      contentEl.createEl("p", {
        text:
          `${this.plan.staying} will stay where they are — already in place, or in a folder ` +
          `or under a filename you chose yourself.`,
      });
    }

    const notes = contentEl.createEl("ul");
    notes.createEl("li", {
      text:
        "Your entries' contents are not read or rewritten. Only their locations change.",
    });
    notes.createEl("li", {
      text:
        "Links to moved entries are updated only if Obsidian is set to automatically update " +
        "internal links.",
    });
    notes.createEl("li", {
      text: "Year and month folders left empty go to your trash.",
    });
    notes.createEl("li", {
      text: "On a large journal this takes a while. Running it again finishes an interrupted move.",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });

    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());

    // Named with the count rather than "Confirm": the last thing read before
    // a bulk move should say what the move is.
    new ButtonComponent(buttons)
      .setButtonText(`Move ${count} ${count === 1 ? "entry" : "entries"}`)
      .setCta()
      .onClick(() => {
        this.close();
        this.onConfirm();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * What the notice says afterwards.
 *
 * Pure, and tested, because it is the only account the user gets of an
 * operation that touched several hundred files: a partial result must not read
 * like a clean one. § Error Handling asks to fail visibly, and the console
 * carries the per-file detail this cannot.
 *
 * `trashedFolders` is deliberately not reported. It is a consequence of the
 * moves rather than a result of its own, the folders are recoverable from the
 * trash, and a second number in a notice competes with the one that matters.
 */
export function reorganizeSummary(report: ReorganizeReport): string {
  const parts: string[] = [];

  if (report.moved === 0) parts.push("Nothing moved.");
  else parts.push(`Moved ${report.moved} ${report.moved === 1 ? "entry" : "entries"}.`);

  if (report.skipped > 0) {
    parts.push(
      `${report.skipped} ${report.skipped === 1 ? "was" : "were"} skipped — moved or deleted ` +
        `before their turn.`,
    );
  }

  if (report.failed > 0) {
    parts.push(
      `${report.failed} could not be moved — see the developer console. Running the command ` +
        `again retries them.`,
    );
  }

  return parts.join(" ");
}
