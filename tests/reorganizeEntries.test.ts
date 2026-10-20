/**
 * The bulk move behind `Reorganize journal folders`.
 *
 * Its own file because the operation's value is entirely in what it refuses to
 * do: overwrite a target, touch a file the user filed or named, abandon the
 * remaining files after one failure, or trash a folder that still holds
 * something. Each of those is a test here.
 */
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createFakeApp } from "./obsidian-mock";
import { EntryRepository } from "../src/journal/entryRepository";
import type { EntryFolderLayout } from "../src/journal/folderLayout";
import {
  formatCreatedProperty,
  parseEntryFilename,
  type EntryFilenameFormat,
} from "../src/utils/dates";

function setup(layout: EntryFolderLayout) {
  const fake = createFakeApp();
  followRenames(fake);
  const repo = new EntryRepository(fake as unknown as App, () => "Journal", () => layout);
  return { fake, repo };
}

/**
 * Obsidian's metadata cache follows a renamed file; the fake's is keyed by
 * path and does not. Without this, a moved entry looks undated to the second
 * plan of an idempotency test.
 */
function followRenames(fake: ReturnType<typeof createFakeApp>) {
  fake.vault.on("rename", (file: { path: string }, oldPath: string) => {
    const frontmatter = fake.metadataCache.frontmatter.get(oldPath);
    if (!frontmatter) return;
    fake.metadataCache.frontmatter.delete(oldPath);
    fake.metadataCache.frontmatter.set(file.path, frontmatter);
  });
}

/**
 * An entry that already has its date property, in the metadata cache only.
 * The tests in the first two blocks are about paths, and an entry lacking the
 * property would also be planned for a write — the third block's subject.
 * The raw text stays the bare string each test asserts on.
 */
function addDated(fake: ReturnType<typeof createFakeApp>, path: string, text: string) {
  const file = fake.vault.addFile(path, text);
  // The filename's own timestamp, so the property places the entry exactly
  // where the name already does and the folder targets stay what they were.
  const parsed = parseEntryFilename(file.basename);
  const created = parsed ? formatCreatedProperty(parsed.date) : "2026-01-01T00:00:00+03:00";
  fake.metadataCache.frontmatter.set(path, { created });
  return file;
}

/** Two entries in the nested shape, on different days of different months. */
function seedNested(fake: ReturnType<typeof createFakeApp>) {
  addDated(fake, "Journal/2026/08/2026-08-12-22-41-52.md", "august");
  addDated(fake, "Journal/2026/09/2026-09-01-09-00-00.md", "september");
}

describe("planReorganize", () => {
  it("lists the entries that would move, with where they would go", () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    const plan = repo.planReorganize();

    expect(plan.moves.map((move) => move.target).sort()).toEqual([
      "Journal/2026-08-12-22-41-52.md",
      "Journal/2026-09-01-09-00-00.md",
    ]);
    expect(plan.staying).toBe(0);
  });

  it("counts an entry it may not move as staying, rather than listing it", () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);
    // Filed somewhere on purpose, and named by hand: the two gates.
    addDated(fake, "Journal/inbox/2026-07-01-08-00-00.md", "filed");
    fake.vault.addFile("Journal/2026/08/holiday-notes.md", "named");

    const plan = repo.planReorganize();

    expect(plan.moves).toHaveLength(2);
    expect(plan.staying).toBe(2);
  });

  it("counts an entry already in the right place as staying", () => {
    const { fake, repo } = setup("year-month");
    seedNested(fake);

    const plan = repo.planReorganize();

    expect(plan.moves).toEqual([]);
    expect(plan.staying).toBe(2);
  });

  it("writes nothing", () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    repo.planReorganize();

    expect(fake.vault.contents.has("Journal/2026/08/2026-08-12-22-41-52.md")).toBe(true);
    expect(fake.vault.contents.has("Journal/2026-08-12-22-41-52.md")).toBe(false);
  });
});

describe("reorganizeEntries", () => {
  it("moves the planned entries, contents intact", async () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    const report = await repo.reorganizeEntries(repo.planReorganize());

    expect(report.moved).toBe(2);
    expect(report.failed).toBe(0);
    expect(fake.vault.contents.get("Journal/2026-08-12-22-41-52.md")).toBe("august");
    expect(fake.vault.contents.get("Journal/2026-09-01-09-00-00.md")).toBe("september");
  });

  it("nests a flat journal back up when the layout says year and month", async () => {
    const { fake, repo } = setup("year-month");
    addDated(fake, "Journal/2026-08-12-22-41-52.md", "august");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get("Journal/2026/08/2026-08-12-22-41-52.md")).toBe("august");
  });

  it("suffixes rather than overwriting when two entries want the same target", async () => {
    const { fake, repo } = setup("flat");
    // Same second, in different month folders: flat gives them one target.
    addDated(fake, "Journal/2026/08/2026-08-12-22-41-52.md", "first");
    addDated(fake, "Journal/2026/09/2026-08-12-22-41-52.md", "second");

    const report = await repo.reorganizeEntries(repo.planReorganize());

    // WHICH of the two keeps the unsuffixed name follows the index's own
    // ordering and is not this test's business. That both survived, in two
    // distinct files, is.
    expect(report.moved).toBe(2);
    expect([
      fake.vault.contents.get("Journal/2026-08-12-22-41-52.md"),
      fake.vault.contents.get("Journal/2026-08-12-22-41-52-2.md"),
    ].sort()).toEqual(["first", "second"]);
  });

  it("counts a failure and still moves the rest", async () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);
    const doomed = fake.vault.files.get("Journal/2026/08/2026-08-12-22-41-52.md");
    const real = fake.fileManager.renameFile.bind(fake.fileManager);
    vi.spyOn(fake.fileManager, "renameFile").mockImplementation(async (file, path) => {
      if (file === doomed) throw new Error("nope");
      return real(file, path);
    });

    const report = await repo.reorganizeEntries(repo.planReorganize());

    expect(report.failed).toBe(1);
    expect(report.moved).toBe(1);
    expect(fake.vault.contents.get("Journal/2026-09-01-09-00-00.md")).toBe("september");
    expect(fake.vault.contents.get("Journal/2026/08/2026-08-12-22-41-52.md")).toBe("august");
    vi.restoreAllMocks();
  });

  it("trashes the folders it emptied, including the year above them", async () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    const report = await repo.reorganizeEntries(repo.planReorganize());

    const trashed = fake.fileManager.trashed.map((file) => file.path).sort();
    expect(trashed).toEqual(["Journal/2026", "Journal/2026/08", "Journal/2026/09"]);
    expect(report.trashedFolders).toBe(3);
  });

  it("never trashes the journal folder itself", async () => {
    const { fake, repo } = setup("year-month");
    addDated(fake, "Journal/2026-08-12-22-41-52.md", "august");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.fileManager.trashed.map((file) => file.path)).not.toContain("Journal");
    expect(fake.vault.folders.has("Journal")).toBe(true);
  });

  it("leaves a folder that still holds something", async () => {
    const { fake, repo } = setup("flat");
    addDated(fake, "Journal/2026/08/2026-08-12-22-41-52.md", "august");
    fake.vault.addFile("Journal/2026/08/holiday-notes.md", "kept by hand");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.fileManager.trashed).toEqual([]);
    expect(fake.vault.contents.get("Journal/2026/08/holiday-notes.md")).toBe("kept by hand");
  });

  it("is a no-op the second time, so an interrupted run can simply be repeated", async () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    await repo.reorganizeEntries(repo.planReorganize());
    const second = await repo.reorganizeEntries(repo.planReorganize());

    expect(second).toMatchObject({ moved: 0, failed: 0, trashedFolders: 0 });
  });

  /**
   * The plan is computed for a confirmation dialog and applied after the user
   * reads it, so the vault can move underneath it. A vanished file is skipped,
   * not counted as a failure and not allowed to abort the rest.
   */
  it("skips a planned entry that no longer exists by the time it runs", async () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);
    const plan = repo.planReorganize();
    const path = "Journal/2026/08/2026-08-12-22-41-52.md";
    fake.vault.files.delete(path);
    fake.vault.contents.delete(path);

    const report = await repo.reorganizeEntries(plan);

    expect(report).toMatchObject({ moved: 1, skipped: 1, failed: 0 });
  });
});

/**
 * The two settings the command learned after folders: the filename shape,
 * and a date property that is missing. See CLAUDE.md § Updating existing
 * entries.
 */
describe("filename format and date property", () => {
  function setupWith(options: {
    layout?: EntryFolderLayout;
    format?: EntryFilenameFormat;
    property?: string;
  }) {
    const fake = createFakeApp();
    followRenames(fake);
    const repo = new EntryRepository(
      fake as unknown as App,
      () => "Journal",
      () => options.layout ?? "year-month",
      () => options.format ?? "dashed",
      () => options.property ?? "created",
    );
    return { fake, repo };
  }

  /** An entry whose metadata cache agrees with its raw frontmatter. */
  function addEntry(
    fake: ReturnType<typeof createFakeApp>,
    path: string,
    frontmatter: Record<string, string>,
    text = "Text",
  ) {
    const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
    const data = lines.length > 0 ? `---\n${lines.join("\n")}\n---\n${text}` : text;
    const file = fake.vault.addFile(path, data);
    if (lines.length > 0) fake.metadataCache.frontmatter.set(path, { ...frontmatter });
    return file;
  }

  it("plans a rename into the configured shape, in place", () => {
    const { fake, repo } = setupWith({ format: "compact" });
    addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", {});

    expect(repo.planReorganize().moves.map((move) => move.target)).toEqual([
      "Journal/2026/08/20260812_224152.md",
    ]);
  });

  it("renames and moves in one step when both are due", () => {
    const { fake, repo } = setupWith({ format: "compact", layout: "flat" });
    addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", {});

    expect(repo.planReorganize().moves.map((move) => move.target)).toEqual([
      "Journal/20260812_224152.md",
    ]);
  });

  // The timestamp in the name is converted, never re-derived from the date
  // property: this changes a shape, not a time.
  it("keeps the name's own timestamp even when the property disagrees", () => {
    const { fake, repo } = setupWith({ format: "compact" });
    addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", { created: "2026-08-12T09:00:00+03:00" });

    expect(repo.planReorganize().moves.map((move) => move.target)).toEqual([
      "Journal/2026/08/20260812_224152.md",
    ]);
  });

  it("keeps a collision suffix, so same-second entries keep their order", async () => {
    const { fake, repo } = setupWith({ format: "compact" });
    addDated(fake, "Journal/2026/08/2026-08-12-22-41-52.md", "first");
    addDated(fake, "Journal/2026/08/2026-08-12-22-41-52-2.md", "second");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get("Journal/2026/08/20260812_224152.md")).toBe("first");
    expect(fake.vault.contents.get("Journal/2026/08/20260812_224152-2.md")).toBe("second");
  });

  it("renames a name the user chose for nothing", () => {
    const { fake, repo } = setupWith({ format: "compact" });
    addEntry(fake, "Journal/2026/08/Morning pages.md", {});

    expect(repo.planReorganize()).toMatchObject({ moves: [], missingDate: [], staying: 1 });
  });

  it("plans the date property for a managed entry that lacks it", () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const file = addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", { created: "2026-08-12" });

    const plan = repo.planReorganize();

    expect(plan.missingDate).toEqual([file]);
    expect(plan.moves).toEqual([]);
    expect(plan.staying).toBe(0);
  });

  it("does not plan the date property where it already exists, whatever it says", () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", { created_time: "2026-08-01" });

    expect(repo.planReorganize()).toMatchObject({ missingDate: [], staying: 1 });
  });

  it("does not plan the date property for a name the user chose", () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    addEntry(fake, "Journal/Morning pages.md", { created: "2026-08-12" });

    expect(repo.planReorganize()).toMatchObject({ missingDate: [], staying: 1 });
  });

  it("adds the property with the date the timeline already shows, and keeps the old one", async () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const file = addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", {
      created: "2026-08-12",
      mood: '"calm"',
    });
    const shownBefore = repo.entryFor(file)?.created;

    const report = await repo.reorganizeEntries(repo.planReorganize());

    expect(report).toMatchObject({ dated: 1, moved: 0, failed: 0 });
    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated_time: "${formatCreatedProperty(new Date(2026, 7, 12, 22, 41, 52))}"\n` +
        `created: 2026-08-12\nmood: "calm"\n---\nText`,
    );
    expect(shownBefore).toEqual(new Date(2026, 7, 12, 22, 41, 52));
  });

  it("adds the property to an entry the user filed in a folder of their own", async () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const file = addEntry(fake, "Journal/inbox/2026-08-12-22-41-52.md", {});

    await repo.reorganizeEntries(repo.planReorganize());

    expect(file.path).toBe("Journal/inbox/2026-08-12-22-41-52.md");
    expect(fake.vault.contents.get(file.path)).toContain("created_time:");
  });

  // The plan was read off the metadata cache. If the raw text has the line
  // anyway, the cache was stale, and replacing a line is not this step's job.
  it("never replaces an existing line, even when the plan thought it was missing", async () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const data = `---\ncreated_time: 2020-01-01\n---\nText`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", data);
    fake.metadataCache.frontmatter.set(file.path, {});

    const report = await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get(file.path)).toBe(data);
    expect(report).toMatchObject({ dated: 0, skipped: 1 });
  });

  it("refuses a frontmatter block Obsidian could not parse, and counts it as failed", async () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const data = `---\ncreated: "2026-08-12\n---\nText`;
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", data);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const report = await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get(file.path)).toBe(data);
    expect(report).toMatchObject({ dated: 0, failed: 1 });
  });

  it("adds a frontmatter block to an entry that has none", async () => {
    const { fake, repo } = setupWith({ property: "created_time" });
    const file = fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "Text");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get(file.path)).toBe(
      `---\ncreated_time: "${formatCreatedProperty(new Date(2026, 7, 12, 22, 41, 52))}"\n---\nText`,
    );
  });

  it("is a no-op the second time", async () => {
    const { fake, repo } = setupWith({ property: "created_time", format: "compact", layout: "flat" });
    addEntry(fake, "Journal/2026/08/2026-08-12-22-41-52.md", { created: "2026-08-12" });

    await repo.reorganizeEntries(repo.planReorganize());
    const file = fake.vault.getAbstractFileByPath("Journal/20260812_224152.md");
    // The fake cache does not re-parse on write; Obsidian's does.
    fake.metadataCache.frontmatter.set("Journal/20260812_224152.md", {
      created: "2026-08-12",
      created_time: "x",
    });

    expect(file).not.toBeNull();
    expect(repo.planReorganize()).toMatchObject({ moves: [], missingDate: [], staying: 1 });
  });
});

describe("hasPendingUpdates", () => {
  /** The answer `planReorganize` gives, as the boolean the settings button needs. */
  function planSaysPending(repo: EntryRepository): boolean {
    const plan = repo.planReorganize();
    return plan.moves.length > 0 || plan.missingDate.length > 0;
  }

  it("agrees with planReorganize when an entry would move", () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);

    expect(planSaysPending(repo)).toBe(true);
    expect(repo.hasPendingUpdates(repo.listEntries())).toBe(true);
  });

  it("agrees with planReorganize when only the date property is missing", () => {
    const { fake, repo } = setup("year-month");
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "undated");

    expect(planSaysPending(repo)).toBe(true);
    expect(repo.hasPendingUpdates(repo.listEntries())).toBe(true);
  });

  it("agrees with planReorganize when there is nothing to do", () => {
    const { fake, repo } = setup("year-month");
    seedNested(fake);
    // An entry the plugin may not touch contributes nothing either.
    fake.vault.addFile("Journal/2026/08/holiday-notes.md", "named");

    expect(planSaysPending(repo)).toBe(false);
    expect(repo.hasPendingUpdates(repo.listEntries())).toBe(false);
  });

  it("is false for an empty journal", () => {
    const { repo } = setup("flat");
    expect(repo.hasPendingUpdates([])).toBe(false);
  });

  it("stops at the first entry that needs something", () => {
    const { fake, repo } = setup("flat");
    seedNested(fake);
    const entries = repo.listEntries();
    const target = vi.spyOn(repo as unknown as { reorganizeTarget: () => unknown }, "reorganizeTarget");

    expect(repo.hasPendingUpdates(entries)).toBe(true);
    expect(target).toHaveBeenCalledTimes(1);
  });
});
