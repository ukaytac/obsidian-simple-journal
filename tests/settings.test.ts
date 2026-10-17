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
        entryFilenames: "compact",
        dateProperty: "created_time",
      }),
    ).toEqual({
      journalFolder: "Diary/Entries",
      showMentionsUnderNotes: true,
      mentionsSidebar: true,
      mentionsFooterCollapsed: true,
      entryFolders: "flat",
      entryFilenames: "compact",
      dateProperty: "created_time",
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

  it("accepts each filename format by name, and falls back to dashed otherwise", () => {
    expect(sanitizeSettings({ entryFilenames: "dashed" }).entryFilenames).toBe("dashed");
    expect(sanitizeSettings({ entryFilenames: "compact" }).entryFilenames).toBe("compact");
    expect(sanitizeSettings({ entryFilenames: "YYYYMMDD" }).entryFilenames).toBe("dashed");
    expect(sanitizeSettings({ entryFilenames: 1 }).entryFilenames).toBe("dashed");
    expect(sanitizeSettings({}).entryFilenames).toBe("dashed");
  });

  it("accepts a plain property name, including non-ASCII letters, and trims it", () => {
    expect(sanitizeSettings({ dateProperty: "created_time" }).dateProperty).toBe("created_time");
    expect(sanitizeSettings({ dateProperty: "date-created" }).dateProperty).toBe("date-created");
    expect(sanitizeSettings({ dateProperty: "oluşturulma" }).dateProperty).toBe("oluşturulma");
    expect(sanitizeSettings({ dateProperty: "  created_time " }).dateProperty).toBe("created_time");
  });

  /**
   * The name is spliced into a line match and into the YAML the plugin
   * writes, so anything that would need quoting — or that is not a name at
   * all — must never get that far.
   */
  it("falls back to created for a property name it cannot use as a plain key", () => {
    for (const bad of ["", "   ", "two words", "a:b", "#tag", "-lead", "x\ny", 5, null]) {
      expect(sanitizeSettings({ dateProperty: bad }).dateProperty).toBe("created");
    }
    expect(sanitizeSettings({}).dateProperty).toBe("created");
  });
});
