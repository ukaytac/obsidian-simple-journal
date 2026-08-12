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
});
