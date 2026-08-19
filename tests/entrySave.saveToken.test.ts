// @vitest-environment jsdom
/**
 * Pins `save()`'s `saveToken` guard: the mechanism that keeps two
 * overlapping `save()` calls for the same entry (a debounce timer firing
 * while a previous write is still in flight, or `flushSave` starting a
 * second one) from letting whichever settles LAST win, when it isn't
 * actually the most recent one issued.
 *
 * `saveIfChanged` (tested directly in `tests/entrySave.test.ts`) owns the
 * dirty-check/never-reject shape; this file is about the extra bookkeeping
 * `save()` layers on top of it, which only shows up once two calls actually
 * overlap and settle out of order -- exactly what a fabricated,
 * caller-controlled `writeBody` can model and a real vault write cannot
 * (real disk I/O doesn't hand a test the ability to choose which of two
 * concurrent writes finishes first).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { save, type SaveDeps, type SaveEntry } from "../src/views/entrySave";
import { installDomHelpers, TFile as FakeTFile } from "./obsidian-mock";

installDomHelpers(globalThis as unknown as Window & typeof globalThis);

afterEach(() => {
  vi.restoreAllMocks();
});

/** One entry's header, shaped enough for showSaveError/clearSaveError to find and mutate. */
function makeEntryEl(): HTMLElement {
  const el = document.createElement("div");
  const header = document.createElement("div");
  header.className = "journal-entry-header";
  el.appendChild(header);
  return el;
}

function makeTarget(el: HTMLElement, file: TFile, savedBody: string): SaveEntry {
  return { el, entry: { file }, editor: null, saveHandle: null, savedBody, saveToken: 0 };
}

/**
 * A `writeBody` whose promises settle only when the test tells them to, in
 * whatever order the test picks. Each call's settlers are pushed in call
 * order, so `settlers[0]` is always the first `save()` invocation's write
 * and `settlers[1]` the second's, regardless of which one the test later
 * resolves or rejects first -- that choice is exactly what models the
 * out-of-order settle the guard is for.
 */
function controllableWriteBody() {
  const settlers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const writeBody = vi.fn((_file: TFile, _value: string) => {
    return new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
  });
  return { writeBody, settlers };
}

describe("save (saveToken guard)", () => {
  it("does not let an older failing write stomp a newer succeeding write's state", async () => {
    // A starts, then B starts before A settles; B (newer) succeeds first,
    // then A (older) fails. Without the token guard, A's failure handler
    // runs after B's success is already recorded and would (a) show the
    // "not saved" marker on an entry that is, in fact, saved on disk with
    // B's text, and (b) rewind `savedBody` back to the pre-A value, so a
    // later save of that same (already-written) text would be wrongly
    // retried instead of skipped -- or worse, a later save of B's own text
    // would look "unchanged from a value it never actually held".
    vi.spyOn(console, "error").mockImplementation(() => {});

    const el = makeEntryEl();
    const file = new FakeTFile("Journal/2026/08/2026-08-19-10-00-00.md");
    const target = makeTarget(el, file, "original");
    const { writeBody, settlers } = controllableWriteBody();
    const deps: SaveDeps = { writeBody, markSelfWrite: vi.fn() };

    const pA = save(target, "edit-A", deps); // token 1
    const pB = save(target, "edit-B", deps); // token 2
    expect(settlers).toHaveLength(2);

    settlers[1].resolve(); // B (newer) succeeds first
    await pB;
    expect(target.savedBody).toBe("edit-B");
    expect(el.querySelector(".journal-entry-error")).toBeNull();

    settlers[0].reject(new Error("disk full")); // A (older) fails after
    await pA;

    expect(target.savedBody).toBe("edit-B");
    expect(el.querySelector(".journal-entry-error")).toBeNull();
  });

  it("does not let an older succeeding write erase a newer failing write's error state", async () => {
    // The mirror interleaving: B (newer) fails first and shows the error
    // marker; A (older) then succeeds. Without the guard, A's late success
    // would clear the marker and overwrite `savedBody` with A's stale text,
    // hiding a real, still-uncorrected write failure from the user.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const el = makeEntryEl();
    const file = new FakeTFile("Journal/2026/08/2026-08-19-10-00-01.md");
    const target = makeTarget(el, file, "original");
    const { writeBody, settlers } = controllableWriteBody();
    const deps: SaveDeps = { writeBody, markSelfWrite: vi.fn() };

    const pA = save(target, "edit-A", deps); // token 1
    const pB = save(target, "edit-B", deps); // token 2
    expect(settlers).toHaveLength(2);

    settlers[1].reject(new Error("disk full")); // B (newer) fails first
    await pB;
    expect(target.savedBody).toBe("original");
    expect(el.querySelector(".journal-entry-error")).not.toBeNull();

    settlers[0].resolve(); // A (older) succeeds after
    await pA;

    expect(target.savedBody).toBe("original");
    expect(el.querySelector(".journal-entry-error")).not.toBeNull();
  });
});
