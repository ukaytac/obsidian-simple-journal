import { describe, expect, it } from "vitest";
import { resolveEntryDate } from "../src/journal/entryDate";

const filenameDate = new Date(2026, 7, 12, 22, 41, 52);
const createdDate = new Date(2026, 7, 12, 9, 0, 0);
const ctimeDate = new Date(2026, 0, 1, 12, 0, 0);

const base = {
  basename: "2026-08-12-22-41-52",
  ctime: ctimeDate.getTime(),
};

describe("resolveEntryDate", () => {
  it("prefers a valid created property", () => {
    const result = resolveEntryDate({ ...base, created: createdDate.toISOString() });
    expect(result.getTime()).toBe(createdDate.getTime());
  });

  it("accepts a Date instance from the metadata cache", () => {
    const result = resolveEntryDate({ ...base, created: createdDate });
    expect(result.getTime()).toBe(createdDate.getTime());
  });

  it("falls back to the filename when created is missing", () => {
    expect(resolveEntryDate(base).getTime()).toBe(filenameDate.getTime());
  });

  it("falls back to the filename when created is malformed", () => {
    expect(resolveEntryDate({ ...base, created: "not a date" }).getTime()).toBe(
      filenameDate.getTime(),
    );
  });

  it("falls back to the filename when created is the wrong type", () => {
    expect(resolveEntryDate({ ...base, created: 42 }).getTime()).toBe(filenameDate.getTime());
    expect(resolveEntryDate({ ...base, created: null }).getTime()).toBe(filenameDate.getTime());
    expect(resolveEntryDate({ ...base, created: {} }).getTime()).toBe(filenameDate.getTime());
  });

  it("falls back to ctime when created and the filename are both unusable", () => {
    const result = resolveEntryDate({ basename: "some-note", ctime: ctimeDate.getTime() });
    expect(result.getTime()).toBe(ctimeDate.getTime());
  });

  it("never returns an invalid Date", () => {
    const result = resolveEntryDate({ basename: "some-note", ctime: Number.NaN });
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  describe("date-only created values", () => {
    it("treats a full date-only string as local midnight, not UTC midnight", () => {
      const result = resolveEntryDate({ ...base, created: "2026-08-12" });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7);
      expect(result.getDate()).toBe(12);
      expect(result.getHours()).toBe(0);
    });

    it("treats a year-month string as local midnight on the 1st", () => {
      const result = resolveEntryDate({ ...base, created: "2026-08" });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7);
      expect(result.getDate()).toBe(1);
      expect(result.getHours()).toBe(0);
    });

    it("treats a bare year string as local midnight on Jan 1st", () => {
      const result = resolveEntryDate({ ...base, created: "2026" });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(0);
      expect(result.getDate()).toBe(1);
      expect(result.getHours()).toBe(0);
    });

    it("treats a date-only Date instance at UTC midnight as local midnight", () => {
      const result = resolveEntryDate({ ...base, created: new Date(Date.UTC(2026, 7, 12)) });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7);
      expect(result.getDate()).toBe(12);
      expect(result.getHours()).toBe(0);
    });

    it("falls back to the filename when the date-only string is impossible", () => {
      const result = resolveEntryDate({ ...base, created: "2026-02-30" });
      expect(result.getTime()).toBe(filenameDate.getTime());
    });

    it("leaves ISO strings that carry a time unaffected", () => {
      const result = resolveEntryDate({ ...base, created: "2026-08-12T09:00:00" });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7);
      expect(result.getDate()).toBe(12);
      expect(result.getHours()).toBe(9);
    });

    it("leaves the YAML space-separated time form unaffected", () => {
      const result = resolveEntryDate({ ...base, created: "2026-08-12 09:00:00" });
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(7);
      expect(result.getDate()).toBe(12);
      expect(result.getHours()).toBe(9);
    });

    it("leaves Date instances that carry a non-midnight time unaffected", () => {
      const result = resolveEntryDate({ ...base, created: createdDate });
      expect(result.getTime()).toBe(createdDate.getTime());
    });
  });
});
