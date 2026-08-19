import { describe, expect, it } from "vitest";
import {
  compareDayKeys,
  dayKey,
  entryFolderPath,
  formatCreatedProperty,
  formatDateTimeLocalValue,
  formatDayHeader,
  formatEntryFilename,
  formatMonthHeader,
  formatTime,
  parseDateTimeLocalValue,
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

  it("returns null for 31 April", () => {
    expect(parseEntryFilename("2026-04-31-10-00-00")).toBeNull();
  });

  it("accepts a time inside a DST spring-forward gap without failing", () => {
    // In zones that spring forward at this instant (e.g. America/New_York),
    // 02:30 on this date does not exist as a local time. Date normalizes it
    // rather than rolling over, so this must still parse as a valid entry
    // filename rather than being rejected as foreign. Assert only in a
    // timezone-independent way: this holds in every zone.
    const parsed = parseEntryFilename("2026-03-08-02-30-00");
    expect(parsed).not.toBeNull();
    expect(parsed?.collision).toBe(1);
  });

  it("rejects a zero or zero-padded collision suffix", () => {
    expect(parseEntryFilename("2026-08-12-22-41-52-0")).toBeNull();
    expect(parseEntryFilename("2026-08-12-22-41-52-02")).toBeNull();
  });
});

describe("entryFolderPath", () => {
  it("nests by year and zero-padded month", () => {
    expect(entryFolderPath("Journal", d)).toBe("Journal/2026/08");
  });

  it("normalizes a folder setting with stray slashes", () => {
    expect(entryFolderPath("/Journal/", d)).toBe("Journal/2026/08");
  });

  it("does not produce a leading slash for an empty root", () => {
    expect(entryFolderPath("", d)).toBe("2026/08");
    expect(entryFolderPath("/", d)).toBe("2026/08");
  });
});

describe("formatCreatedProperty", () => {
  it("round-trips through Date parsing without losing the instant", () => {
    expect(new Date(formatCreatedProperty(d)).getTime()).toBe(d.getTime());
  });

  it("includes an explicit offset rather than Z-less local time", () => {
    expect(formatCreatedProperty(d)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
  });

  it("truncates milliseconds to the second", () => {
    const withMs = new Date(2026, 7, 12, 22, 41, 52, 789);
    const truncatedToSecond = new Date(2026, 7, 12, 22, 41, 52, 0);
    expect(new Date(formatCreatedProperty(withMs)).getTime()).toBe(truncatedToSecond.getTime());
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

  it("compareDayKeys orders keys newest first", () => {
    expect(compareDayKeys("2026-08-12", "2026-08-10")).toBeLessThan(0);
    expect(compareDayKeys("2026-08-10", "2026-08-12")).toBeGreaterThan(0);
    expect(compareDayKeys("2026-08-12", "2026-08-12")).toBe(0);
  });

  it("compareDayKeys agrees with calendar order across month and year boundaries", () => {
    expect(compareDayKeys("2026-08-01", "2026-07-31")).toBeLessThan(0);
    expect(compareDayKeys("2027-01-01", "2026-12-31")).toBeLessThan(0);
  });

  it("formats the entry time as 24-hour HH:mm", () => {
    expect(formatTime(d)).toBe("22:41");
    expect(formatTime(new Date(2026, 7, 12, 9, 4, 0))).toBe("09:04");
  });
});

describe("formatDateTimeLocalValue", () => {
  it("formats a local date as a datetime-local value with seconds", () => {
    expect(formatDateTimeLocalValue(d)).toBe("2026-08-12T22:41:52");
  });

  it("zero-pads single-digit components", () => {
    expect(formatDateTimeLocalValue(new Date(2026, 0, 5, 9, 4, 7))).toBe("2026-01-05T09:04:07");
  });
});

describe("parseDateTimeLocalValue", () => {
  it("round-trips a value produced by formatDateTimeLocalValue, as local time", () => {
    const parsed = parseDateTimeLocalValue(formatDateTimeLocalValue(d));
    expect(parsed?.getTime()).toBe(d.getTime());
  });

  it("accepts a value with no seconds, per the datetime-local spec's minute-granularity default", () => {
    const parsed = parseDateTimeLocalValue("2026-08-12T22:41");
    expect(parsed?.getTime()).toBe(new Date(2026, 7, 12, 22, 41, 0).getTime());
  });

  it("returns null for an empty string", () => {
    expect(parseDateTimeLocalValue("")).toBeNull();
  });

  it("returns null for whitespace", () => {
    expect(parseDateTimeLocalValue("   ")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseDateTimeLocalValue("not a date")).toBeNull();
  });

  it("returns null for an impossible date", () => {
    expect(parseDateTimeLocalValue("2026-02-30T10:00")).toBeNull();
    expect(parseDateTimeLocalValue("2026-13-01T10:00")).toBeNull();
  });

  it("returns null for an out-of-range time component", () => {
    expect(parseDateTimeLocalValue("2026-08-12T24:00")).toBeNull();
    expect(parseDateTimeLocalValue("2026-08-12T10:60")).toBeNull();
  });

  it("accepts a date far in the past", () => {
    const parsed = parseDateTimeLocalValue("1901-01-01T00:00:00");
    expect(parsed?.getTime()).toBe(new Date(1901, 0, 1, 0, 0, 0).getTime());
  });

  it("accepts a date far in the future", () => {
    const parsed = parseDateTimeLocalValue("2200-01-01T00:00:00");
    expect(parsed?.getTime()).toBe(new Date(2200, 0, 1, 0, 0, 0).getTime());
  });

  it("rejects a value carrying an explicit UTC/offset designator, since the input is documented as local-only", () => {
    expect(parseDateTimeLocalValue("2026-08-12T22:41:52Z")).toBeNull();
    expect(parseDateTimeLocalValue("2026-08-12T22:41:52+03:00")).toBeNull();
  });
});
