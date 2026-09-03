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

function setup(layout: EntryFolderLayout) {
  const fake = createFakeApp();
  const repo = new EntryRepository(fake as unknown as App, () => "Journal", () => layout);
  return { fake, repo };
}

/** Two entries in the nested shape, on different days of different months. */
function seedNested(fake: ReturnType<typeof createFakeApp>) {
  fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "august");
  fake.vault.addFile("Journal/2026/09/2026-09-01-09-00-00.md", "september");
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
    fake.vault.addFile("Journal/inbox/2026-07-01-08-00-00.md", "filed");
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
    fake.vault.addFile("Journal/2026-08-12-22-41-52.md", "august");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.vault.contents.get("Journal/2026/08/2026-08-12-22-41-52.md")).toBe("august");
  });

  it("suffixes rather than overwriting when two entries want the same target", async () => {
    const { fake, repo } = setup("flat");
    // Same second, in different month folders: flat gives them one target.
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "first");
    fake.vault.addFile("Journal/2026/09/2026-08-12-22-41-52.md", "second");

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
    fake.vault.addFile("Journal/2026-08-12-22-41-52.md", "august");

    await repo.reorganizeEntries(repo.planReorganize());

    expect(fake.fileManager.trashed.map((file) => file.path)).not.toContain("Journal");
    expect(fake.vault.folders.has("Journal")).toBe(true);
  });

  it("leaves a folder that still holds something", async () => {
    const { fake, repo } = setup("flat");
    fake.vault.addFile("Journal/2026/08/2026-08-12-22-41-52.md", "august");
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
