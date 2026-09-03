/**
 * `data.json` is a file the user can hand-edit and an older build may have
 * written, so nothing about its shape is guaranteed. `sanitizeSettings` is the
 * one place that decides what is usable, and it is pure — which is what makes
 * it testable at all: the loading around it needs a real Obsidian `Plugin`.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings/settings";

describe("sanitizeSettings", () => {
  it("returns the defaults for a file that is not an object", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("Journal")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps values that are usable", () => {
    expect(
      sanitizeSettings({
        journalFolder: "Diary/Entries",
        showMentionsUnderNotes: true,
        mentionsSidebar: true,
        mentionsFooterCollapsed: true,
        entryFolders: "flat",
      }),
    ).toEqual({
      journalFolder: "Diary/Entries",
      showMentionsUnderNotes: true,
      mentionsSidebar: true,
      mentionsFooterCollapsed: true,
      entryFolders: "flat",
    });
  });

  it("falls back to Journal for a folder that is missing, blank, or not a string", () => {
    expect(sanitizeSettings({ journalFolder: "   " }).journalFolder).toBe("Journal");
    expect(sanitizeSettings({ journalFolder: 7 }).journalFolder).toBe("Journal");
    expect(sanitizeSettings({}).journalFolder).toBe("Journal");
  });

  it("falls back for a flag that is not a boolean", () => {
    expect(sanitizeSettings({ showMentionsUnderNotes: "yes" }).showMentionsUnderNotes).toBe(false);
    expect(sanitizeSettings({ mentionsSidebar: 1 }).mentionsSidebar).toBe(false);
    expect(sanitizeSettings({ mentionsFooterCollapsed: null }).mentionsFooterCollapsed).toBe(false);
  });

  it("accepts each folder layout by name", () => {
    expect(sanitizeSettings({ entryFolders: "year-month" }).entryFolders).toBe("year-month");
    expect(sanitizeSettings({ entryFolders: "year" }).entryFolders).toBe("year");
    expect(sanitizeSettings({ entryFolders: "flat" }).entryFolders).toBe("flat");
  });

  /**
   * The one that matters most: an unrecognised layout must not reach
   * `entryFolderPath`, which would then have no case to match and return
   * undefined for a path. It falls back to the layout every existing journal
   * already uses.
   */
  it("falls back to year and month for a layout it does not recognise", () => {
    expect(sanitizeSettings({ entryFolders: "day" }).entryFolders).toBe("year-month");
    expect(sanitizeSettings({ entryFolders: "" }).entryFolders).toBe("year-month");
    expect(sanitizeSettings({ entryFolders: true }).entryFolders).toBe("year-month");
    expect(sanitizeSettings({}).entryFolders).toBe("year-month");
  });
});
