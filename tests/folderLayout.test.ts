/**
 * The folder layout, in one place and pure — the seam every writer goes
 * through, so a test here pins where entries land without a vault.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRY_FOLDER_LAYOUT,
  entryFolderPath,
  isManagedFolder,
} from "../src/journal/folderLayout";

const AUGUST = new Date(2026, 7, 12, 14, 17, 3);

describe("entryFolderPath", () => {
  it("nests by year and month", () => {
    expect(entryFolderPath("Journal", AUGUST, "year-month")).toBe("Journal/2026/08");
  });

  it("nests by year alone", () => {
    expect(entryFolderPath("Journal", AUGUST, "year")).toBe("Journal/2026");
  });

  it("puts a flat journal's entries straight in its folder", () => {
    expect(entryFolderPath("Journal", AUGUST, "flat")).toBe("Journal");
  });

  it("pads a single-digit month, in both nesting layouts", () => {
    const january = new Date(2027, 0, 5, 9, 0, 0);
    expect(entryFolderPath("Journal", january, "year-month")).toBe("Journal/2027/01");
    expect(entryFolderPath("Journal", january, "year")).toBe("Journal/2027");
  });

  it("tolerates slashes around the configured folder", () => {
    expect(entryFolderPath("/Journal/", AUGUST, "year-month")).toBe("Journal/2026/08");
    expect(entryFolderPath("/Journal/", AUGUST, "flat")).toBe("Journal");
  });

  /**
   * An empty journal folder means the vault root. Flat then has nowhere to
   * nest, so the path is empty — the one case a caller has to join carefully
   * rather than with a bare `${folder}/`, which would produce a leading
   * slash.
   */
  it("is empty for a flat layout at the vault root", () => {
    expect(entryFolderPath("", AUGUST, "flat")).toBe("");
    expect(entryFolderPath("/", AUGUST, "flat")).toBe("");
    expect(entryFolderPath("", AUGUST, "year-month")).toBe("2026/08");
    expect(entryFolderPath("", AUGUST, "year")).toBe("2026");
  });

  it("defaults to the layout every existing journal already uses", () => {
    expect(DEFAULT_ENTRY_FOLDER_LAYOUT).toBe("year-month");
  });
});

describe("isManagedFolder", () => {
  it("accepts the three shapes the plugin produces", () => {
    expect(isManagedFolder("Journal", "Journal")).toBe(true);
    expect(isManagedFolder("Journal", "Journal/2026")).toBe(true);
    expect(isManagedFolder("Journal", "Journal/2026/08")).toBe(true);
  });

  it("rejects a folder the user filed something into on purpose", () => {
    expect(isManagedFolder("Journal", "Journal/inbox")).toBe(false);
    expect(isManagedFolder("Journal", "Journal/2026/trips")).toBe(false);
    expect(isManagedFolder("Journal", "Journal/2026/08/12")).toBe(false);
  });

  it("rejects shapes that only look like the plugin's", () => {
    expect(isManagedFolder("Journal", "Journal/2026/8")).toBe(false);
    expect(isManagedFolder("Journal", "Journal/26/08")).toBe(false);
    expect(isManagedFolder("Journal", "Journal/202X")).toBe(false);
  });

  it("rejects anything outside the journal folder", () => {
    expect(isManagedFolder("Journal", "Other/2026/08")).toBe(false);
    expect(isManagedFolder("Journal", "")).toBe(false);
    // A sibling whose name merely starts with the root's.
    expect(isManagedFolder("Journal", "Journal2/2026")).toBe(false);
  });

  it("tolerates slashes around the configured folder", () => {
    expect(isManagedFolder("/Journal/", "Journal/2026/08")).toBe(true);
    expect(isManagedFolder("/Journal/", "Journal")).toBe(true);
  });

  /** A vault-root journal: the root itself is the flat shape. */
  it("treats the vault root as managed when the journal is the whole vault", () => {
    expect(isManagedFolder("", "")).toBe(true);
    expect(isManagedFolder("", "2026")).toBe(true);
    expect(isManagedFolder("", "2026/08")).toBe(true);
    expect(isManagedFolder("", "inbox")).toBe(false);
  });
});
