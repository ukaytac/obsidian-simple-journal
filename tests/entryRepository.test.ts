import { beforeEach, describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { createFakeApp } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";

function setup() {
  const fake = createFakeApp();
  const repo = new EntryRepository(fake as unknown as App, () => "Journal");
  return { fake, repo };
}

const body = "\nToday I realized something.\n";

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
  it("reads the body without the frontmatter", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n${body}`,
    );
    expect(await repo.readBody(file)).toBe(body);
  });

  it("preserves arbitrary frontmatter when writing", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\nmood: "calm"\ntags:\n  - journal\n---\n${body}`,
    );

    await repo.writeBody(file, "\nRewritten.\n");
    const data = fake.vault.contents.get(file.path) ?? "";

    expect(data).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\nmood: "calm"\ntags:\n  - journal\n---\n\nRewritten.\n`,
    );
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

describe("deleteEntry", () => {
  it("uses the file manager so Obsidian's trash setting is respected", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    await repo.deleteEntry(file as TFile);
    expect(fake.fileManager.trashed.map((f) => f.path)).toEqual([file.path]);
  });
});
