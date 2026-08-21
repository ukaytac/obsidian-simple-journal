import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createFakeApp } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import { UnsafeFrontmatterError } from "../src/journal/markdownDoc";
import { formatCreatedProperty } from "../src/utils/dates";

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

  /**
   * The test above passes whether the repository filters the whole vault or
   * walks only the journal folder — the visible answer is the same either way.
   * These pin the walk itself, which is the part that matters for anyone whose
   * journal sits beside notes they would rather no plugin enumerated.
   */
  it("never asks the vault for every file", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.vault.addFile("Journal/2026/08/2026-08-11-21-10-00.md", "");
    fake.vault.addFile("Private/therapy notes.md", "");

    // Not a spy: enumeration is not merely counted, it is made impossible.
    // If the repository needs this, the test fails rather than passing quietly.
    fake.vault.getMarkdownFiles = () => {
      throw new Error("listEntries must not enumerate the vault");
    };

    expect(repo.listEntries().map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-08-11-21-10-00",
    ]);
  });

  /**
   * The strongest form of the claim, and the one the test above cannot make:
   * not "outside files are filtered out" but "outside files are never
   * examined". Walking from the vault root and filtering afterwards produces
   * an identical return value, so only watching what the walk touches can
   * tell the two apart.
   */
  it("never even looks at a file outside the journal folder", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.vault.addFile("Private/therapy notes.md", "");
    fake.vault.addFile("Inbox/idea.md", "");
    fake.vault.addFile("Work/salaries.md", "");

    const seen: string[] = [];
    const real = repo.entryFor.bind(repo);
    repo.entryFor = (file) => {
      seen.push(file.path);
      return real(file);
    };

    repo.listEntries();

    // Exactly the one entry — no outside file, and no folder either.
    expect(seen).toEqual(["Journal/2026/08/2026-08-12-22-41-52.md"]);
  });

  it("finds entries nested in year and month subfolders", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2025/12/2025-12-31-23-59-00.md", "");
    fake.vault.addFile("Journal/2026/01/2026-01-01-00-01-00.md", "");
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");

    expect(repo.listEntries().map((e) => e.file.basename)).toEqual([
      "2026-08-12-22-41-52",
      "2026-01-01-00-01-00",
      "2025-12-31-23-59-00",
    ]);
  });

  it("ignores a non-Markdown file sitting among the entries", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    // Previously unreachable: the vault pre-filtered to Markdown. Walking the
    // folder means attachments turn up, and must not become entries.
    fake.vault.addFile("Journal/2026/08/photo.png", "");
    fake.vault.addFile("Journal/2026/08/notes.txt", "");

    expect(repo.listEntries().map((e) => e.file.basename)).toEqual(["2026-08-12-22-41-52"]);
  });

  it("returns nothing for a journal folder that does not exist yet", () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Inbox/idea.md", "");
    fake.vault.getMarkdownFiles = () => {
      throw new Error("a missing folder must not fall back to enumerating");
    };

    expect(repo.listEntries()).toEqual([]);
  });

  it("walks the folder as it is spelled on disk, not as it is configured", () => {
    const fake = createFakeApp();
    // Configured lower-case; the vault has it capitalised.
    const repo = new EntryRepository(fake as unknown as App, () => "journal");
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "");
    fake.vault.getMarkdownFiles = () => {
      throw new Error("casing resolution must not fall back to enumerating");
    };

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
    // No blank line between the closing delimiter and the body: CLAUDE.md's
    // storage format for a NEW entry has none. Only pre-existing entries
    // written before this fix carry one.
    expect(data.endsWith("---\nHello there.")).toBe(true);
    expect(await repo.readBody(file)).toBe("Hello there.");
  });

  it("writes a new entry with no blank line between the frontmatter and the body", async () => {
    const { fake, repo } = setup();
    const file = await repo.createEntry(new Date(2026, 7, 12, 22, 41, 52), "Test 123");

    const data = fake.vault.contents.get(file.path) ?? "";
    expect(data).not.toContain("---\n\n");
    expect(data.endsWith("---\nTest 123")).toBe(true);
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

  it("a body whose first line is genuinely blank survives an edit-then-read round trip", async () => {
    const { fake, repo } = setup();
    const original = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nOriginal.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    const withGenuineBlankFirstLine = "\nStarts with a blank line the user actually typed.\n";
    await repo.writeBody(file, withGenuineBlankFirstLine);

    expect(await repo.readBody(file)).toBe(withGenuineBlankFirstLine);
  });

  it("preserves a file with no blank line as having none (never imposes the separator)", async () => {
    const { fake, repo } = setup();
    // No blank line between the closing delimiter and the text — the shape
    // a NEW entry is now written in (and also the shape a file written by an
    // older build of this plugin, before this fix, might have).
    const noBlankLine = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\nToday I realized something.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", noBlankLine);

    const readBack = await repo.readBody(file);
    expect(readBack).toBe("Today I realized something.\n");

    await repo.writeBody(file, "Rewritten, still no separator.\n");

    // writeBody must never impose a separator the file didn't already have —
    // CLAUDE.md's "never rewrite or normalize frontmatter this plugin does
    // not own" applies to this blank line exactly as it does to any other
    // byte outside the body.
    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\nRewritten, still no separator.\n`,
    );
  });

  it("keeps an existing entry's blank line when its body is edited to different text", async () => {
    const { fake, repo } = setup();
    const original = `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nOriginal text.\n`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", original);

    await repo.writeBody(file, "Edited text.\n");

    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n\nEdited text.\n`,
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
    // No blank line in the fixture: this is the new-entry shape
    // (`createEntry`'s empty-body template), so `text` must not start with
    // one either — see the dedicated "genuinely blank first line" test above
    // for that separate case, which uses a file that already has a separator.
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`,
    );
    const text = "İstanbul'da yağmur yağıyordu — ışıklar süzülüyordu. 🌧️\n";

    await repo.writeBody(file, text);
    expect(await repo.readBody(file)).toBe(text);
  });

  it("round-trips wikilinks and markdown formatting", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile(
      "Journal/2026/08/2026-08-12-22-41-52.md",
      `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n`,
    );
    const text = "See [[Some Note|alias]] and **bold** and `code`.\n\n- item\n";

    await repo.writeBody(file, text);
    expect(await repo.readBody(file)).toBe(text);
  });
});

describe("setEntryCreated", () => {
  // Computed rather than hardcoded, since `formatCreatedProperty`'s offset
  // depends on the local timezone the tests run under (see `npm run test:tz`).
  const newAt = new Date(2026, 7, 13, 9, 0, 0);
  const newCreated = formatCreatedProperty(newAt);

  // `setEntryCreated` now cross-checks the raw text against
  // `metadataCache.getFileCache()` before writing (see its doc), so a
  // realistic fixture — unlike a real vault — must populate BOTH: the
  // fake vault's raw contents, and the fake metadata cache's independent,
  // hand-populated parse of the same file's frontmatter.
  function addEntry(
    fake: ReturnType<typeof createFakeApp>,
    data: string,
    frontmatter: Record<string, unknown> | undefined,
  ) {
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", data);
    if (frontmatter) fake.metadataCache.frontmatter.set(file.path, frontmatter);
    return file;
  }

  it("rewrites only the created property's value", async () => {
    const { fake, repo } = setup();
    const file = addEntry(fake, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n${body}`, {
      created: "2026-08-12T22:41:52+03:00",
    });

    await repo.setEntryCreated(file, newAt);

    expect(fake.vault.contents.get(file.path)).toBe(`---\ncreated: "${newCreated}"\n---\n${body}`);
  });

  it("preserves a user's other frontmatter properties, in order, byte for byte", async () => {
    const { fake, repo } = setup();
    const file = addEntry(fake, `---\ncreated: 2026-08-12T22:41:52+03:00\nmood: "calm"\ntags:\n  - journal\n---\n${body}`, {
      created: "2026-08-12T22:41:52+03:00",
      mood: "calm",
      tags: ["journal"],
    });

    await repo.setEntryCreated(file, newAt);

    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated: "${newCreated}"\nmood: "calm"\ntags:\n  - journal\n---\n${body}`,
    );
  });

  it("does not touch the body", async () => {
    const { fake, repo } = setup();
    const file = addEntry(fake, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n${body}`, {
      created: "2026-08-12T22:41:52+03:00",
    });

    await repo.setEntryCreated(file, newAt);

    expect(await repo.readBody(file)).toBe(strippedBody);
  });

  it("inserts a created property when the entry's frontmatter has none (e.g. its timestamp was resolved from the filename or ctime)", async () => {
    const { fake, repo } = setup();
    const file = addEntry(fake, `---\nmood: "calm"\n---\n${body}`, { mood: "calm" });

    await repo.setEntryCreated(file, newAt);

    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated: "${newCreated}"\nmood: "calm"\n---\n${body}`,
    );
  });

  it("does not rename the file", async () => {
    const { fake, repo } = setup();
    const file = addEntry(fake, `---\ncreated: 2026-08-12T22:41:52+03:00\n---\n${body}`, {
      created: "2026-08-12T22:41:52+03:00",
    });

    await repo.setEntryCreated(file, newAt);

    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
  });

  it("rejects with UnsafeFrontmatterError and writes nothing when the frontmatter is not safe to edit surgically (setCreatedProperty's own guard)", async () => {
    const { fake, repo } = setup();
    const original = `---\ncreated: |\n  2026-08-12T22:41:52+03:00\n---\n${body}`;
    // The metadata cache agrees a `created` key exists (a block scalar is
    // valid YAML, so Obsidian's own parser would report one too) — this
    // isolates `setCreatedProperty`'s own "block scalar" guard from the
    // metadata cross-check exercised separately below.
    const file = addEntry(fake, original, { created: "2026-08-12T22:41:52+03:00\n" });

    await expect(repo.setEntryCreated(file, newAt)).rejects.toThrow(UnsafeFrontmatterError);

    // Never risk data loss: a refused edit leaves the file byte-identical.
    expect(fake.vault.contents.get(file.path)).toBe(original);
  });

  it("rejects a single false-positive 'created:' match with no genuine created key, via the metadata-cache cross-check", async () => {
    const { fake, repo } = setup();
    // `setCreatedProperty`'s own "more than one match" guard cannot catch
    // this alone: there is only ONE line matching `created:` at column 0
    // (inside `note`'s own multi-line quoted value), and no real `created`
    // key anywhere else in the block to raise the alarm. Obsidian's own
    // YAML parser, unlike a line-oriented regex, correctly finds no
    // top-level `created` key at all here — exactly the disagreement the
    // cross-check in `setEntryCreated` exists to catch.
    const original = `---\nnote: "hello\ncreated: bad"\nmood: calm\n---\n${body}`;
    const file = addEntry(fake, original, { note: 'hello\ncreated: bad', mood: "calm" });

    await expect(repo.setEntryCreated(file, newAt)).rejects.toThrow(UnsafeFrontmatterError);

    // Never risk data loss: `note` and `mood` both survive untouched, and
    // no `created` is written either.
    expect(fake.vault.contents.get(file.path)).toBe(original);
  });
});

describe("renameEntryToMatch", () => {
  it("moves a conventionally-named entry within the same month", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "hello");

    const result = await repo.renameEntryToMatch(file, new Date(2026, 7, 15, 9, 0, 0));

    expect(result).toBe(file);
    expect(file.path).toBe("Journal/2026/08/2026-08-15-09-00-00.md");
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-15-09-00-00.md")).toBe("hello");
    expect(fake.vault.contents.has("Journal/2026/08/2026-08-12-22-41-52.md")).toBe(false);
  });

  it("moves a conventionally-named entry across months, creating the new folder", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "hello");

    await repo.renameEntryToMatch(file, new Date(2026, 8, 1, 0, 0, 0));

    expect(file.path).toBe("Journal/2026/09/2026-09-01-00-00-00.md");
    expect([...fake.vault.folders]).toContain("Journal/2026/09");
  });

  it("moves a conventionally-named entry across years", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/12/2026-12-31-23-00-00.md", "hello");

    await repo.renameEntryToMatch(file, new Date(2027, 0, 1, 0, 0, 0));

    expect(file.path).toBe("Journal/2027/01/2027-01-01-00-00-00.md");
    expect([...fake.vault.folders]).toContain("Journal/2027/01");
  });

  it("suffixes the target name when another entry already occupies it", async () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-15-09-00-00.md", "occupied");
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "hello");

    await repo.renameEntryToMatch(file, new Date(2026, 7, 15, 9, 0, 0));

    expect(file.path).toBe("Journal/2026/08/2026-08-15-09-00-00-2.md");
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-15-09-00-00.md")).toBe("occupied");
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-15-09-00-00-2.md")).toBe("hello");
  });

  it("leaves a non-conventionally-named file's name alone", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/My favorite entry.md", "hello");

    const result = await repo.renameEntryToMatch(file, new Date(2026, 7, 15, 9, 0, 0));

    expect(result).toBe(file);
    expect(file.path).toBe("Journal/2026/08/My favorite entry.md");
    expect(fake.vault.contents.get("Journal/2026/08/My favorite entry.md")).toBe("hello");
  });

  it("is a no-op when the computed target equals the current path", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "hello");
    const originalRename = fake.fileManager.renameFile.bind(fake.fileManager);
    let called = false;
    fake.fileManager.renameFile = async (...args: Parameters<typeof originalRename>) => {
      called = true;
      return originalRename(...args);
    };

    const result = await repo.renameEntryToMatch(file, new Date(2026, 7, 12, 22, 41, 52));

    expect(result).toBe(file);
    expect(file.path).toBe("Journal/2026/08/2026-08-12-22-41-52.md");
    expect(called).toBe(false);
  });

  it("does not oscillate when confirming an already-collision-suffixed entry unchanged (Important 1)", async () => {
    const { fake, repo } = setup();
    fake.vault.addFile("Journal/2026/08/2026-08-15-09-00-00.md", "first");
    const file = fake.vault.addFile("Journal/2026/08/2026-08-15-09-00-00-2.md", "second");
    const originalRename = fake.fileManager.renameFile.bind(fake.fileManager);
    let calls = 0;
    fake.fileManager.renameFile = async (...args: Parameters<typeof originalRename>) => {
      calls += 1;
      return originalRename(...args);
    };
    const at = new Date(2026, 7, 15, 9, 0, 0);

    // Confirming the SAME (unchanged) value repeatedly, as a user re-opening
    // "Change entry time" and confirming without editing anything would,
    // must never actually move the file — landing on its own current path
    // (the "-2" slot) at attempt 2 of the free-name search means it is
    // already correctly named, not merely "free".
    await repo.renameEntryToMatch(file, at);
    await repo.renameEntryToMatch(file, at);
    await repo.renameEntryToMatch(file, at);

    expect(file.path).toBe("Journal/2026/08/2026-08-15-09-00-00-2.md");
    expect(calls).toBe(0);
  });

  it("bails without a second real move when the write throws after the file already landed at the target", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "hello");
    const target = new Date(2026, 7, 15, 9, 0, 0);
    const realRename = fake.fileManager.renameFile.bind(fake.fileManager);

    // Simulates a rename whose file move genuinely lands, but which still
    // throws afterward (e.g. a later, unrelated link-rewrite step failing).
    fake.fileManager.renameFile = async (f: any, path: string) => {
      await realRename(f, path);
      throw new Error("link rewrite failed");
    };

    const result = await repo.renameEntryToMatch(file, target);

    expect(result).toBe(file);
    expect(file.path).toBe("Journal/2026/08/2026-08-15-09-00-00.md");
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-15-09-00-00.md")).toBe("hello");
  });

  it("keeps a conventionally-named entry in its own custom subfolder, renaming the file only (Minor 3)", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/inbox/2026-08-12-22-41-52.md", "hello");

    const result = await repo.renameEntryToMatch(file, new Date(2026, 8, 1, 0, 0, 0));

    expect(result).toBe(file);
    expect(file.path).toBe("Journal/inbox/2026-09-01-00-00-00.md");
    expect(fake.vault.contents.get("Journal/inbox/2026-09-01-00-00-00.md")).toBe("hello");
    // No YYYY/MM folder was created for this move: the entry never left its
    // user-chosen subfolder.
    expect([...fake.vault.folders]).not.toContain("Journal/2026/09");
  });

  it("keeps a conventionally-named entry directly under a flat journal root, renaming the file only", async () => {
    const { fake, repo } = setup();
    const file = fake.vault.addFile("Journal/2026-08-12-22-41-52.md", "hello");

    await repo.renameEntryToMatch(file, new Date(2026, 8, 1, 0, 0, 0));

    expect(file.path).toBe("Journal/2026-09-01-00-00-00.md");
  });
});
