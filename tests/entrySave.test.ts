import { describe, expect, it, vi } from "vitest";
import { saveIfChanged } from "../src/views/entrySave";

describe("saveIfChanged", () => {
  it("skips the write entirely when value matches savedBody", async () => {
    // Critical 1: this is what makes scrolling an unedited entry in and out
    // of the mount window a no-op on disk, instead of an unconditional
    // rewrite (mtime bump, vault `modify` event, sync upload) on every
    // unmount.
    const write = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    const result = await saveIfChanged("same text", "same text", write, onError);

    expect(write).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result).toBe("same text");
  });

  it("writes and returns the new value when it differs from savedBody", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    const result = await saveIfChanged("new text", "old text", write, onError);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("new text");
    expect(onError).not.toHaveBeenCalled();
    expect(result).toBe("new text");
  });

  it("treats empty savedBody and empty value as unchanged (skips the write)", () => {
    const write = vi.fn().mockResolvedValue(undefined);
    return saveIfChanged("", "", write, vi.fn()).then((result) => {
      expect(write).not.toHaveBeenCalled();
      expect(result).toBe("");
    });
  });

  it("never rejects when write fails, and reports the failure via onError", async () => {
    // Critical 2's shape, at the unit this method actually owns: a caller
    // (JournalView's flushSave, and transitively clearTimeline/
    // unmountEditor) must be able to await this without a try/catch of its
    // own and always proceed with teardown.
    const failure = new Error("disk full");
    const write = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    await expect(saveIfChanged("new text", "old text", write, onError)).resolves.toBe("old text");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not advance savedBody past a failed write", async () => {
    // So a later save attempt with the same (still-unwritten) value is
    // retried rather than wrongly treated as already on disk.
    const write = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();

    const first = await saveIfChanged("v1", "v0", write, onError);
    expect(first).toBe("v0");

    write.mockResolvedValueOnce(undefined);
    const second = await saveIfChanged("v1", first, write, onError);

    expect(write).toHaveBeenCalledTimes(2);
    expect(second).toBe("v1");
  });
});
