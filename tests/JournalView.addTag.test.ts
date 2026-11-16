// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry, createHarness, internals, settle, tagEntryInFrontmatter, timelineEl } from "./journalViewHarness";
import type { Harness } from "./journalViewHarness";
import { AbstractInputSuggest, Notice } from "./obsidian-mock";
import type { TFile } from "obsidian";

/**
 * The header's "Add tag" field — CLAUDE.md § Tags, Rule 2. What it writes is
 * pinned in `addFrontmatterTag.test.ts` and `entryRepository.test.ts`; these
 * pin the control: where it is, when it writes, and when it does not.
 */
describe("JournalView add tag", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    Notice.instances = [];
    h = createHarness();
  });

  afterEach(async () => {
    await h.view.onClose();
    h.service.unload();
    vi.useRealTimers();
  });

  function row(path: string): HTMLElement {
    const el = Array.from(timelineEl(h.view).querySelectorAll<HTMLElement>(".journal-entry")).find(
      (candidate) => candidate.dataset.path === path,
    );
    if (!el) throw new Error(`no row for ${path}`);
    return el;
  }

  function openField(path: string): HTMLInputElement {
    row(path).querySelector<HTMLButtonElement>(".journal-entry-tag-add")!.click();
    const input = row(path).querySelector<HTMLInputElement>(".journal-entry-tag-input");
    if (!input) throw new Error("the field did not open");
    return input;
  }

  function type(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  async function openWith(): Promise<TFile> {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "Body text");
    h.service.load();
    await h.view.onOpen();
    return file;
  }

  it("sits in the header beside the time, outside the chips", async () => {
    const file = await openWith();

    const adder = row(file.path).querySelector(".journal-entry-header > .journal-entry-tag-adder");
    expect(adder?.previousElementSibling?.classList.contains("journal-entry-time")).toBe(true);
    expect(adder?.querySelector(".journal-entry-tag-add")?.textContent).toBe("+ tag");
    expect(row(file.path).querySelector(".journal-entry-tags .journal-entry-tag-add")).toBeNull();
  });

  it("puts the added tags under the text, not in the header", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "Body text");
    tagEntryInFrontmatter(h, file, ["work"]);
    h.service.load();
    await h.view.onOpen();

    const chips = row(file.path).querySelector(".journal-entry-tags");
    expect(chips?.previousElementSibling?.classList.contains("journal-entry-body")).toBe(true);
    expect(chips?.textContent).toBe("#work");
    expect(row(file.path).querySelector(".journal-entry-header .journal-entry-tag")).toBeNull();
  });

  it("writes a typed new tag on Enter, and nothing else in the file", async () => {
    const file = await openWith();
    const before = h.app.vault.contents.get(file.path)!;

    const input = openField(file.path);
    type(input, "#günlük");
    press(input, "Enter");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(before.replace("\n---\n", "\ntags:\n  - günlük\n---\n"));
    expect(row(file.path).querySelector(".journal-entry-tag-input")).toBeNull();
  });

  // The suggest is reached the way Obsidian reaches it: the instance is the
  // `this` of the `onSelect` registration, and the pick goes through the
  // public `selectSuggestion`.
  function captureSuggest() {
    const spy = vi.spyOn(AbstractInputSuggest.prototype, "onSelect");
    return () => spy.mock.contexts.at(-1) as any;
  }

  it("writes a picked suggestion", async () => {
    const other = addEntry(h, new Date(2026, 7, 11, 9, 0, 0));
    tagEntryInFrontmatter(h, other, ["travel"]);
    const file = await openWith();
    const suggest = captureSuggest();

    const input = openField(file.path);
    type(input, "tra");
    suggest().selectSuggestion({ tag: "travel", isNew: false }, new KeyboardEvent("keydown"));
    await settle();

    expect(h.app.vault.contents.get(file.path)).toContain("\ntags:\n  - travel\n---\n");
  });

  it("offers the typed text first as a new tag, then the journal's matching tags", async () => {
    const other = addEntry(h, new Date(2026, 7, 11, 9, 0, 0));
    tagEntryInFrontmatter(h, other, ["travel", "work"]);
    const file = await openWith();
    const suggest = captureSuggest();

    openField(file.path);

    expect(suggest().getSuggestions("tra")).toEqual([
      { tag: "tra", isNew: true },
      { tag: "travel", isNew: false },
    ]);
    expect(suggest().getSuggestions("Travel")).toEqual([{ tag: "travel", isNew: false }]);
    expect(suggest().getSuggestions("")).toEqual([]);
  });

  it("never suggests a tag the entry already has", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "Body text");
    tagEntryInFrontmatter(h, file, ["travel"]);
    h.service.load();
    await h.view.onOpen();
    const suggest = captureSuggest();

    openField(file.path);

    expect(suggest().getSuggestions("travel")).toEqual([{ tag: "travel", isNew: true }]);
  });

  it("leaves Enter to the open list, so one keypress cannot write twice", async () => {
    const file = await openWith();
    const before = h.app.vault.contents.get(file.path);

    const input = openField(file.path);
    type(input, "work");
    await settle(); // the list opens: "work" is offered as a new tag
    press(input, "Enter");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(before);
  });

  it("closes on Escape without writing", async () => {
    const file = await openWith();
    const before = h.app.vault.contents.get(file.path);

    const input = openField(file.path);
    type(input, "work");
    press(input, "Escape");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(before);
    expect(row(file.path).querySelector(".journal-entry-tag-input")).toBeNull();
    expect(row(file.path).querySelector<HTMLButtonElement>(".journal-entry-tag-add")!.hidden).toBe(false);
  });

  it("keeps the field and writes nothing when the tag is not valid", async () => {
    const file = await openWith();
    const before = h.app.vault.contents.get(file.path);

    const input = openField(file.path);
    type(input, "deep work");
    press(input, "Enter");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(before);
    expect(row(file.path).querySelector(".journal-entry-tag-input")).toBe(input);
    expect(Notice.instances.map((n) => n.message)).toContain("A tag can't contain spaces.");
  });

  it("writes nothing for a tag the entry already carries", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "Body text");
    h.app.vault.contents.set(file.path, `---\ntags: [Work]\n---\nBody text`);
    tagEntryInFrontmatter(h, file, ["Work"]);
    h.service.load();
    await h.view.onOpen();

    const input = openField(file.path);
    type(input, "work");
    press(input, "Enter");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(`---\ntags: [Work]\n---\nBody text`);
  });

  it("refuses a tags shape it cannot edit safely, visibly, writing nothing", async () => {
    const file = addEntry(h, new Date(2026, 7, 12, 22, 41, 52), "Body text");
    h.app.vault.contents.set(file.path, `---\ntags: life\n---\nBody text`);
    tagEntryInFrontmatter(h, file, ["life"]);
    h.service.load();
    await h.view.onOpen();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const input = openField(file.path);
    type(input, "work");
    press(input, "Enter");
    await settle();

    expect(h.app.vault.contents.get(file.path)).toBe(`---\ntags: life\n---\nBody text`);
    expect(Notice.instances.some((n) => n.message.includes("Add the tag in the source note"))).toBe(true);
  });

  it("is hidden on the composer, which has no file to tag yet", async () => {
    await openWith();
    await h.view.startNewEntry();
    await settle();

    const composer = timelineEl(h.view).querySelector(".journal-entry-composer");
    expect(composer?.querySelector(".journal-entry-tag-adder")?.classList.contains("journal-entry-actions-pending")).toBe(
      true,
    );
  });
});
