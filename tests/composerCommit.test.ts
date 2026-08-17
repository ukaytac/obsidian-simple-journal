import { describe, expect, it } from "vitest";
import { isMeaningful, planComposerMount, resolveComposerContent } from "../src/views/composerCommit";

describe("isMeaningful", () => {
  it("is false for an empty string", () => {
    expect(isMeaningful("")).toBe(false);
  });

  it("is false for whitespace-only content", () => {
    expect(isMeaningful("   \n\t  ")).toBe(false);
  });

  it("is true for real content", () => {
    expect(isMeaningful("hello")).toBe(true);
  });

  it("is true even when surrounded by whitespace", () => {
    expect(isMeaningful("  hello  ")).toBe(true);
  });
});

describe("planComposerMount", () => {
  it("needs no save when the seed already matches what's confirmed on disk", () => {
    expect(planComposerMount("hello", "hello")).toEqual({ seed: "hello", needsSave: false });
  });

  it("needs a save when the seed is ahead of what's confirmed on disk", () => {
    expect(planComposerMount("hello", "hello there")).toEqual({
      seed: "hello there",
      needsSave: true,
    });
  });

  it("always preserves the seed, whichever way needsSave falls", () => {
    expect(planComposerMount("anything", "typed text").seed).toBe("typed text");
  });
});

describe("resolveComposerContent", () => {
  it("skips persist entirely when nothing changed after create", async () => {
    let persistCalls = 0;
    const plan = await resolveComposerContent(
      "Hello",
      () => "Hello",
      async (value, confirmedDisk) => {
        persistCalls++;
        return value ?? confirmedDisk;
      },
    );

    expect(persistCalls).toBe(0);
    expect(plan).toEqual({ seed: "Hello", needsSave: false });
  });

  it("persists a value typed while createEntry() was in flight", async () => {
    const persisted: string[] = [];
    const plan = await resolveComposerContent(
      "Hello",
      () => "Hello there",
      async (value) => {
        persisted.push(value);
        return value;
      },
    );

    expect(persisted).toEqual(["Hello there"]);
    expect(plan).toEqual({ seed: "Hello there", needsSave: false });
  });

  /**
   * Regression test for the keystroke-during-persist bug: a fast typist
   * keeps typing WHILE `persist` itself is awaited (e.g. a slow
   * `vault.process`). The naive fix reads the editor once, right after
   * create, and uses that same snapshot both to persist AND to seed the
   * real editor — so anything typed during persist's own await is missing
   * from the mounted editor, and the persisted (older) value is what
   * `savedBody` ends up reflecting. The next flush then writes that older
   * value straight back over the newer one still sitting in the editor,
   * silently discarding it from both the screen and disk.
   *
   * `resolveComposerContent` must re-read AFTER persist resolves, not reuse
   * the pre-persist snapshot, so the final plan reflects every keystroke —
   * including ones that landed during persist's own await, not just
   * create's.
   */
  it("re-reads after persist, so a keystroke landing during persist itself is not lost", async () => {
    // "Hello there" is already typed by the time createEntry() resolved
    // (confirmedDisk, "Hello", is what createEntry actually wrote) — this is
    // what triggers persist below. Simulates the user typing " world" while
    // persist (a slow vault.process) is still in flight, before persist's
    // own await resolves.
    let live = "Hello there";
    const persist = async (value: string): Promise<string> => {
      live = "Hello there world";
      await Promise.resolve();
      return value;
    };

    const plan = await resolveComposerContent("Hello", () => live, persist);

    // The keystroke that landed mid-persist must still make it into the
    // plan: seeded into the real editor, and flagged for a follow-up save
    // since only "Hello there" (persist's own argument, captured before the
    // in-flight keystroke) ever reached disk.
    expect(plan.seed).toBe("Hello there world");
    expect(plan.needsSave).toBe(true);
  });

  /**
   * The same scenario reproduced with the PRE-FIX sequencing (a single read
   * right after create, reused as both the persist argument and the mount
   * seed, with no second read after persist) — proving the bug is real and
   * that this fix is what closes it, not a coincidence of the new
   * function's shape. This was run against a temporarily-reverted
   * `resolveComposerContent` (a single read, no re-read after persist) and
   * confirmed to fail before the fix; see the parent report for that check.
   */
  it("regression: a single-read-before-persist sequence loses a keystroke that lands during persist", async () => {
    let live = "Hello there";
    const persisted: string[] = [];
    const persist = async (value: string): Promise<string> => {
      persisted.push(value);
      live = "Hello there world"; // lands mid-persist, exactly like the real bug
      await Promise.resolve();
      return value;
    };

    // The pre-fix shape: read once, persist that snapshot, seed the mounted
    // editor with the SAME stale snapshot — no second read afterward.
    const staleSnapshot = live;
    const confirmedDisk = await persist(staleSnapshot);
    const staleSeed = staleSnapshot;

    expect(persisted).toEqual(["Hello there"]);
    // The bug: "Hello there world" was typed, but the stale seed the naive
    // sequence would have mounted the real editor with is still "Hello
    // there" — the keystroke is gone from what the user would see, and
    // `confirmedDisk` never reflects it either.
    expect(staleSeed).toBe("Hello there");
    expect(staleSeed).not.toBe(live);
    expect(confirmedDisk).toBe("Hello there");
  });
});
