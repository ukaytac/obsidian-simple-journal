import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createFakeApp } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";

function setup() {
  const fake = createFakeApp();
  const repo = new EntryRepository(fake as unknown as App, () => "Journal");
  return { fake, repo };
}

// The raw suffix a conventional file has after its frontmatter block: the
// blank-line separator, then the entry text. Used to build file contents
// below (that's what `splitFrontmatter` itself sees on disk).
const body = "\nToday I realized something.\n";
// What `EntryRepository.readBody` actually returns for that same file: the
// separator is not content, so it's stripped. Derived rather than
// hand-typed so it can never silently drift from `body`.
const strippedBody = body.slice(1);

describe("isEntryFile", () => {
  it("accepts markdown files under the journal folder", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    expect(repo.isEntryFile(file)).toBe(true);
  });

  it("rejects files outside the journal folder", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Daily Notes/2026-08-12.md", "");
    expect(repo.isEntryFile(file)).toBe(false);
  });

  it("rejects a folder whose name merely starts with the journal folder name", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journalling/note.md", "");
    expect(repo.isEntryFile(file)).toBe(false);
  });

  it("rejects non-markdown files", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/photo.png", "");
    file.extension = "png";
    expect(repo.isEntryFile(file)).toBe(false);
  });

  it("matches the journal folder case-insensitively", () => {
    const fake = createFakeApp();
    const repo = new EntryRepository(fake as unknown as App, () => "journal");
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    expect(repo.isEntryFile(file)).toBe(true);
  });

  it("still rejects a folder whose name merely starts with the journal folder name, case-insensitively", () => {
    const fake = createFakeApp();
    const repo = new EntryRepository(fake as unknown as App, () => "journal");
    const file = fake.vault.addFile("Journalling/note.md", "");
    expect(repo.isEntryFile(file)).toBe(false);
  });

  it("falls back to Journal when the folder setting is empty", () => {
    const fake = createFakeApp();
    const repo = new EntryRepository(fake as unknown as App, () => "");
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    expect(repo.isEntryFile(file)).toBe(true);
  });

  it("does not treat a differently-cased sibling folder as the journal folder", () => {
    const fake = createFakeApp();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    const strayFile = fake.vault.addFile("JOURNAL/private.md", "");
    const repo = new EntryRepository(fake as unknown as App, () => "Journal");

    expect(repo.isEntryFile(strayFile)).toBe(false);
    expect(repo.listEntries()).toHaveLength(1);
  });

  it("prefers the exact-case sibling regardless of which one was added first", () => {
    // Added in the order the setting-matching folder appears second, so a
    // naive "first case-insensitive match wins" resolution would pick the
    // stray folder instead.
    const reversed = createFakeApp();
    const strayFirst = reversed.vault.addFile("JOURNAL/private.md", "");
    reversed.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    const repoReversed = new EntryRepository(reversed as unknown as App, () => "Journal");

    expect(repoReversed.isEntryFile(strayFirst)).toBe(false);
    expect(repoReversed.listEntries()).toHaveLength(1);

    // And the original order, so sibling order can never decide the outcome.
    const forward = createFakeApp();
    forward.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    const strayLast = forward.vault.addFile("JOURNAL/private.md", "");
    const repoForward = new EntryRepository(forward as unknown as App, () => "Journal");

    expect(repoForward.isEntryFile(strayLast)).toBe(false);
    expect(repoForward.listEntries()).toHaveLength(1);
  });

  it("matches a folder across NFC and NFD Unicode normalization", () => {
    const fake = createFakeApp();
    const nfdFolder = "Günlük".normalize("NFD");
    const file = fake.vault.addFile(`${nfdFolder}/2026/08/2026-08-12-22-41-52.md`, "");
    const repo = new EntryRepository(fake as unknown as App, () => "Günlük");

    expect(repo.isEntryFile(file)).toBe(true);
  });
});

describe("listEntries", () => {
  it("returns entries newest first across days", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-11-21-10-00.md", "");
    fake.vault.addFile("Journal/2026/08/2026-08-12-09-34-21.md", "");
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");

    expect(repo.listEntries().map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-08-12-09-34-21",
      "2026-08-11-21-10-00",
    ]);
  });

  it("uses the created property over the filename", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.metadataCache.frontmatter.set(file.path, {
      created: new Date(2026, 7, 1, 8, 0, 0).toISOString(),
    });

    expect(repo.listEntries()[0].created.getTime()).toBe(new Date(2026, 7, 1, 8, 0, 0).getTime());
  });

  it("keeps entries whose created property is malformed", () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.metadataCache.frontmatter.set(file.path, { created: "garbage" });

    expect(repo.listEntries()).toHaveLength(1);
    expect(repo.listEntries()[0].created.getTime()).toBe(
      new Date(2026, 7, 12, 22, 41, 52).getTime(),
    );
  });

  it("ignores files outside the journal folder", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.vault.addFile("Inbox/idea.md", "");
    expect(repo.listEntries()).toHaveLength(1);
  });
});

describe("createEntry", () => {
  it("writes to the nested year and month folder", async () => {
    const { fake, repo } = setup();
    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
  });

  it("creates the folder hierarchy", async () => {
    const { fake, repo } = setup();
    await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    expect([...fake.vault.folders]).toEqual(["Journal", "Journal/2026", "Journal/2026/08"]);
  });

  it("writes only a created property and no heading", async () => {
    const { fake, repo } = setup();
    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    const data = fake.vault.contents.get(file.path) ?? "";

    expect(data.startsWith('---\ncreated: "2026-08-12T22:41:52')).toBe(true);
    expect(data).not.toContain("#");
    expect(data.trimEnd().endsWith("---")).toBe(true);
  });

  it("seeds the entry with an initial body in one write, readable back via readBody", async () => {
    const { fake, repo } = setup();
    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52), "Hello there.");

    const data = fake.vault.contents.get(file.path) ?? "";
    expect(data.startsWith('---\ncreated: "2026-08-12T22:41:52')).toBe(true);
    // Exactly one blank-line separator between the frontmatter and the body
    // — not two (the naive `\n${body}` bug the plan corrections call out).
    expect(data.endsWith("---\n\nHello there.")).toBe(true);
    expect(await repo.readBody(file)).toBe("Hello there.");
  });

  it("an empty (default) body round-trips as the same empty document createEntry() always wrote", async () => {
    const { fake, repo } = setup();
    const withDefault = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    const withExplicitEmpty = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 53), "");

    expect(fake.vault.contents.get(withDefault.path)).toBe(
      fake.vault.contents.get(withExplicitEmpty.path)?.replace("22:41:53", "22:41:52"),
    );
  });

  it("suffixes a second entry created in the same second", async () => {
    const { repo } = setup();
    const at = new Date(2026, 7, 12, 22, 41, 52);
    const first = await repo.createEntry(at);
    const second = await repo.createEntry(at);
    const third = await repo.createEntry(at);

    expect(first.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
    expect(second.path).toBe("Journal/2026/08/2026-08-12-22-41-52-2.md");
    expect(third.path).toBe("Journal/2026/08/2026-08-12-22-41-52-3.md");
  });

  it("never overwrites an existing file", async () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "PRECIOUS");
    await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-12-22-41-52.md")).toBe("PRECIOUS");
  });

  it("falls back to Journal when the folder setting is empty", async () => {
    const fake = createFakeApp();
    const repo = new EntryRepository(fake as unknown as App, () => "");
    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
  });

  it("creates an entry when the folder setting's casing differs from the on-disk folder", async () => {
    const fake = createFakeApp();
    fake.vault.addFile("Journal/2026/07/2026-07-01-08-00-00.md", "");
    const repo = new EntryRepository(fake as unknown as App, () => "journal");

    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));

    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
  });

  it("resolves each segment of a nested configured root to its real casing", async () => {
    const fake = createFakeApp();
    fake.vault.addFile("Notes/Journal/2026/07/2026-07-01-08-00-00.md", "");
    const repo = new EntryRepository(fake as unknown as App, () => "notes/Journal");

    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));

    expect(file.path).toBe("Notes/Journal/2026/08/2026-08-12-22-41-52.md");
  });

  it("survives another writer creating the same folder concurrently", async () => {
    const { fake, repo } = setup();
    const originalCreateFolder = fake.vault.createFolder.bind(fake.vault);
    let calls = 0;

    fake.vault.createFolder = async (path: string) => {
      calls += 1;
      if (path === "Journal" && calls === 1) {
        // Simulate another writer (Sync, Templater, ...) winning the race:
        // the folder exists on disk by the time our createFolder call fails.
        fake.vault.folders.add(path);
        throw new Error("Folder already exists.");
      }
      return originalCreateFolder(path);
    };

    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52));
    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
  });
});

describe("readBody and writeBody", () => {
  it("reads the body without the frontmatter or its blank-line separator", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n${body}`,
    );
    expect(await repo.readBody(file)).toBe(strippedBody);
  });

  it("preserves arbitrary frontmatter when writing", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\nmood: "calm"\ntags:\n  - journal\n---\n${body}`,
    );

    // "Rewritten.\n", not "\nRewritten.\n": callers now pass the separator-free
    // convention readBody returns, and writeBody restores the separator itself.
    await repo.writeBody(file, "Rewritten.\n");
    const data = fake.vault.contents.get(file.path) ?? "";

    expect(data).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\nmood: "calm"\ntags:\n  - journal\n---\n\nRewritten.\n`,
    );
  });

  it("round-trips an unchanged body byte-identically for a canonical file", async () => {
    const { fake, repo } = setup();
    const original = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nToday I realized something.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe("Today I realized something.\n");

    await repo.writeBody(file, readBack);
    expect(fake.vault.contents.get(file.path)).toBe(original);
  });

  it("preserves two blank lines after the frontmatter (only one is the separator)", async () => {
    const { fake, repo } = setup();
    const original = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\n\nToday I realized something.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe("\nToday I realized something.\n");

    await repo.writeBody(file, readBack);
    expect(fake.vault.contents.get(file.path)).toBe(original);
  });

  it("adds the conventional blank line back on save when the file has none (intended normalization, not a bug)", async () => {
    const { fake, repo } = setup();
    // No blank line between the closing delimiter and the text — the shape
    // this plugin wrote before this fix.
    const noBlankLine = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\nToday I realized something.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", noBlankLine);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe("Today I realized something.\n");

    await repo.writeBody(file, readBack);

    // The next save restores the Obsidian convention rather than
    // perpetuating the deviation from it.
    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nToday I realized something.\n`,
    );
  });

  it("does not convert CRLF line endings", async () => {
    const { fake, repo } = setup();
    const original = "---\r\ncreated: 2026-08-12T22:41:52+03:00\r\n---\r\n\r\nToday I realized something.\r\n";
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe("Today I realized something.\r\n");
    expect(readBack).not.toContain("\r\n\r\n");

    await repo.writeBody(file, readBack);
    expect(fake.vault.contents.get(file.path)).toBe(original);
  });

  it("leaves a file with no frontmatter at all unaffected in both directions", async () => {
    const { fake, repo } = setup();
    const original = "Just some text, no frontmatter.\n";
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe(original);

    await repo.writeBody(file, "New text, still no frontmatter.\n");
    expect(fake.vault.contents.get(file.path)).toBe("New text, still no frontmatter.\n");
  });

  it("round-trips unicode and Turkish characters", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`,
    );
    const text = "\nİstanbul'da yağmur yağıyordu — ışıklar süzülüyordu. 🌧️\n";

    await repo.writeBody(file, text);
    expect(await repo.readBody(file)).toBe(text);
  });

  it("round-trips wikilinks and markdown formatting", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`,
    );
    const text = "\nSee [[Some Note|alias]] and **bold** and `code`.\n\n- item\n";

    await repo.writeBody(file, text);
    expect(await repo.readBody(file)).toBe(text);
  });
});
