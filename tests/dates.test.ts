import { describe, expect, it } from "vitest";
import {
  dayKey,
  entryFolderPath,
  formatCreatedProperty,
  formatDayHeader,
  formatEntryFilename,
  formatMonthHeader,
  formatTime,
  parseEntryFilename,
} from "../src/utils/dates";

// 12 August 2026 is a Wednesday. Local time, so formatting is deterministic.
const d = new Date(2026, 7, 12, 22, 41, 52);

describe("formatEntryFilename", () => {
  it("produces a zero-padded timestamp filename", () => {
    expect(formatEntryFilename(d)).toBe("2026-08-12-22-41-52");
  });

  it("zero-pads single-digit components", () => {
    expect(formatEntryFilename(new Date(2026, 0, 5, 9, 4, 7))).toBe("2026-01-05-09-04-07");
  });
});

describe("parseEntryFilename", () => {
  it("round-trips a filename produced by formatEntryFilename", () => {
    const parsed = parseEntryFilename(formatEntryFilename(d));
    expect(parsed?.date.getTime()).toBe(d.getTime());
    expect(parsed?.collision).toBe(1);
  });

  it("reads the collision suffix", () => {
    const parsed = parseEntryFilename("2026-08-12-22-41-52-3");
    expect(parsed?.date.getTime()).toBe(d.getTime());
    expect(parsed?.collision).toBe(3);
  });

  it("returns null for a filename that is not ours", () => {
    expect(parseEntryFilename("some-note")).toBeNull();
    expect(parseEntryFilename("2026-08-12")).toBeNull();
  });

  it("returns null for an impossible date", () => {
    expect(parseEntryFilename("2026-13-45-99-99-99")).toBeNull();
  });
});

describe("entryFolderPath", () => {
  it("nests by year and zero-padded month", () => {
    expect(entryFolderPath("Journal", d)).toBe("Journal/2026/08");
  });

  it("normalizes a folder setting with stray slashes", () => {
    expect(entryFolderPath("/Journal/", d)).toBe("Journal/2026/08");
  });
});

describe("formatCreatedProperty", () => {
  it("round-trips through Date parsing without losing the instant", () => {
    expect(new Date(formatCreatedProperty(d)).getTime()).toBe(d.getTime());
  });

  it("includes an explicit offset rather than Z-less local time", () => {
    expect(formatCreatedProperty(d)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
  });
});

describe("headers and keys", () => {
  it("formats the day key in local time", () => {
    expect(dayKey(d)).toBe("2026-08-12");
  });

  it("formats the day header", () => {
    expect(formatDayHeader(d)).toBe("WEDNESDAY, 12 AUGUST");
  });

  it("formats the month header", () => {
    expect(formatMonthHeader(d)).toBe("AUGUST 2026");
  });

  it("formats the entry time as 24-hour HH:mm", () => {
    expect(formatTime(d)).toBe("22:41");
    expect(formatTime(new Date(2026, 7, 12, 9, 4, 0))).toBe("09:04");
  });
});
