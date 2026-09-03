// @vitest-environment jsdom
/**
 * The confirmation in front of the bulk move. Its whole job is to let someone
 * decline, so what it says and which button does what are worth pinning.
 */
import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { installDomHelpers } from "./obsidian-mock";
import { ReorganizeModal, reorganizeSummary } from "../src/views/ReorganizeModal";
import type { ReorganizePlan } from "../src/journal/entryRepository";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

function plan(moves: number, staying: number): ReorganizePlan {
  return {
    moves: Array.from({ length: moves }, (_, i) => ({
      file: { path: `Journal/2026/08/entry-${i}.md` } as unknown as TFile,
      target: `Journal/entry-${i}.md`,
    })),
    staying,
  };
}

function open(moves: number, staying: number) {
  const confirmed = vi.fn();
  const modal = new ReorganizeModal(
    {} as App,
    plan(moves, staying),
    "Journal/2026/09",
    confirmed,
  );
  modal.open();
  return { modal, confirmed, text: modal.contentEl.textContent ?? "" };
}

function buttons(modal: ReorganizeModal): HTMLButtonElement[] {
  return [...modal.contentEl.querySelectorAll("button")];
}

describe("ReorganizeModal", () => {
  it("says how many entries move, and shows where one would land", () => {
    const { text } = open(12, 0);
    expect(text).toContain("12");
    expect(text).toContain("Journal/2026/09");
  });

  it("says how many stay, and why", () => {
    const { text } = open(12, 3);
    expect(text).toContain("3");
    expect(text.toLowerCase()).toContain("stay");
  });

  it("says nothing about entries staying when none do", () => {
    const { text } = open(12, 0);
    expect(text.toLowerCase()).not.toContain("stay");
  });

  /**
   * `renameFile` only updates links "depending on the user's preferences", and
   * reading that preference would mean `vault.getConfig` — not public API. So
   * the dialog states the dependency rather than guessing at it.
   */
  it("warns that links follow only if Obsidian is set to update them", () => {
    const { text } = open(12, 0);
    expect(text.toLowerCase()).toContain("automatically update internal links");
  });

  it("promises that entry contents are not touched", () => {
    const { text } = open(12, 0);
    expect(text.toLowerCase()).toContain("contents");
  });

  it("confirms once, through the last button", () => {
    const { modal, confirmed } = open(12, 0);
    const all = buttons(modal);

    all[all.length - 1].click();

    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("does not confirm when cancelled", () => {
    const { modal, confirmed } = open(12, 0);
    const all = buttons(modal);

    all[0].click();

    expect(confirmed).not.toHaveBeenCalled();
  });

  it("names the count on the confirm button, so it is not a bare Yes", () => {
    const { modal } = open(12, 0);
    const all = buttons(modal);

    expect(all[all.length - 1].textContent).toContain("12");
  });
});

describe("reorganizeSummary", () => {
  it("reports a clean run", () => {
    expect(reorganizeSummary({ moved: 12, skipped: 0, failed: 0, trashedFolders: 3 })).toBe(
      "Moved 12 entries.",
    );
  });

  it("says one entry in the singular", () => {
    expect(reorganizeSummary({ moved: 1, skipped: 0, failed: 0, trashedFolders: 0 })).toBe(
      "Moved 1 entry.",
    );
  });

  /**
   * A partial result must never read as a clean one: CLAUDE.md § Error
   * Handling asks to fail visibly, and a search-and-replace over someone's
   * journal that quietly half-finished is the worst version of that.
   */
  it("names failures and points at the console", () => {
    const text = reorganizeSummary({ moved: 10, skipped: 0, failed: 2, trashedFolders: 0 });
    expect(text).toContain("2 could not be moved");
    expect(text).toContain("console");
  });

  it("mentions entries that had moved or vanished before their turn", () => {
    const text = reorganizeSummary({ moved: 10, skipped: 1, failed: 0, trashedFolders: 0 });
    expect(text).toContain("1 was skipped");
  });

  it("says plainly when there was nothing left to do", () => {
    expect(reorganizeSummary({ moved: 0, skipped: 0, failed: 0, trashedFolders: 0 })).toBe(
      "Nothing moved.",
    );
  });
});
