import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal/entry";
import type { JournalChange } from "../src/services/journalService";
import { decideChangeAction, type RenderedState } from "../src/views/applyChange";

function state(overrides: Partial<RenderedState> = {}): RenderedState {
  return { exists: false, focused: false, dirty: false, fileStillExists: false, ...overrides };
}

const entry = { file: { path: "Journal/2026/08/2026-08-12-22-41-52.md" } } as unknown as JournalEntry;

describe("decideChangeAction: loop/clobber suppression (Important 2)", () => {
  it("never touches a focused editor", () => {
    const change: JournalChange = { kind: "content", entry };
    expect(decideChangeAction(change, state({ exists: true, focused: true }))).toEqual({
      type: "noop",
    });
  });

  it("never touches an editor whose text is dirty (differs from savedBody), even when unfocused", () => {
    // This is the crux of Important 2: without this check, an external
    // change would clobber the in-flight edit via setValue, and the
    // already-scheduled save (bound to the stale pre-clobber value) would
    // then clobber the external change right back — losing both, and
    // leaving the editor's displayed text diverged from disk.
    const change: JournalChange = { kind: "content", entry };
    expect(
      decideChangeAction(change, state({ exists: true, focused: false, dirty: true })),
    ).toEqual({ type: "noop" });
  });

  it("refreshes when unfocused and not dirty", () => {
    // Including the case a debounce timer is still conceptually "armed" at
    // the `JournalView` level (a type-then-revert within the 500ms window
    // leaves a save scheduled over a value that already matches disk again):
    // this function only ever sees the resolved `dirty` boolean, defined
    // directly on value equality rather than on timer state, so that case is
    // indistinguishable here from "never had a pending edit at all" — both
    // correctly fall through to a refresh instead of needlessly withholding
    // one. See `JournalView.renderedStateFor`'s doc for where that
    // resolution actually happens.
    const change: JournalChange = { kind: "content", entry };
    expect(
      decideChangeAction(change, state({ exists: true, focused: false, dirty: false })),
    ).toEqual({ type: "refresh" });
  });
});

describe("decideChangeAction: content falls back to insert", () => {
  it("inserts a fresh rendering when nothing is rendered at this path yet", () => {
    // Reachable right after a same-timestamp rename: the old rendering was
    // already torn down by this same batch's "removed", but nothing was
    // ever rendered at the entry's (new) path — silently dropping this
    // would leave the entry missing from the timeline until the next
    // full reload.
    const change: JournalChange = { kind: "content", entry };
    expect(decideChangeAction(change, state({ exists: false }))).toEqual({ type: "insert" });
  });

  it("focus/dirty state is irrelevant when nothing exists yet to protect", () => {
    const change: JournalChange = { kind: "content", entry };
    expect(
      decideChangeAction(change, state({ exists: false, focused: true, dirty: true })),
    ).toEqual({ type: "insert" });
  });
});

describe("decideChangeAction: ordering reposition ('moved')", () => {
  it("repositions an existing rendering, flushing first when the file still exists", () => {
    const change: JournalChange = { kind: "moved", entry };
    expect(
      decideChangeAction(change, state({ exists: true, fileStillExists: true })),
    ).toEqual({ type: "reposition", flush: true });
  });

  it("repositions without flushing when the file no longer exists", () => {
    const change: JournalChange = { kind: "moved", entry };
    expect(
      decideChangeAction(change, state({ exists: true, fileStillExists: false })),
    ).toEqual({ type: "reposition", flush: false });
  });

  it("falls back to a plain insert when nothing is rendered under this path yet", () => {
    const change: JournalChange = { kind: "moved", entry };
    expect(decideChangeAction(change, state({ exists: false }))).toEqual({ type: "insert" });
  });

  it("a focused editor is still repositioned — 'moved' never suppresses on focus", () => {
    // Unlike "content", CLAUDE.md requires the timeline to reposition an
    // entry whose `created` changed regardless of focus; only whether a
    // pending edit needs flushing first is a live concern here.
    const change: JournalChange = { kind: "moved", entry };
    expect(
      decideChangeAction(change, state({ exists: true, focused: true, fileStillExists: true })),
    ).toEqual({ type: "reposition", flush: true });
  });
});

describe("decideChangeAction: deletion branch", () => {
  it("does nothing when nothing is rendered at the removed path", () => {
    const change: JournalChange = { kind: "removed", path: "Journal/gone.md" };
    expect(decideChangeAction(change, state({ exists: false }))).toEqual({ type: "noop" });
  });

  it("removes without flushing a genuine deletion (file no longer resolves anywhere)", () => {
    const change: JournalChange = { kind: "removed", path: "Journal/gone.md" };
    expect(
      decideChangeAction(change, state({ exists: true, fileStillExists: false })),
    ).toEqual({ type: "remove", flush: false });
  });

  it("removes WITH a flush when the file still resolves elsewhere (a rename's stale old path)", () => {
    const change: JournalChange = { kind: "removed", path: "Journal/old-path.md" };
    expect(
      decideChangeAction(change, state({ exists: true, fileStillExists: true })),
    ).toEqual({ type: "remove", flush: true });
  });
});

describe("decideChangeAction: added and reload", () => {
  it("always inserts for 'added', regardless of state", () => {
    const change: JournalChange = { kind: "added", entry };
    expect(decideChangeAction(change, state({ exists: true, focused: true }))).toEqual({
      type: "insert",
    });
  });

  it("always reloads the whole view for 'reload', regardless of state", () => {
    const change: JournalChange = { kind: "reload" };
    expect(decideChangeAction(change, state())).toEqual({ type: "reloadView" });
  });
});

describe("decideChangeAction with a tag scope", () => {
  const rendered = { exists: true, focused: false, dirty: false, fileStillExists: true };
  const absent = { exists: false, focused: false, dirty: false, fileStillExists: true };

  it("does not insert an added entry the scope excludes", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent, false)).toEqual({ type: "noop" });
  });

  it("still inserts an added entry the scope admits", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent, true)).toEqual({ type: "insert" });
  });

  it("removes a rendered entry that has left the scope", () => {
    expect(decideChangeAction({ kind: "content", entry }, rendered, false)).toEqual({
      type: "remove",
      flush: true,
    });
  });

  it("inserts an entry that has entered the scope", () => {
    expect(decideChangeAction({ kind: "content", entry }, absent, true)).toEqual({
      type: "insert",
    });
  });

  it("never yanks a row the user is focused in, even out of scope", () => {
    expect(
      decideChangeAction({ kind: "content", entry }, { ...rendered, focused: true }, false),
    ).toEqual({ type: "noop" });
  });

  it("never yanks a row with unsaved text, even out of scope", () => {
    expect(
      decideChangeAction({ kind: "content", entry }, { ...rendered, dirty: true }, false),
    ).toEqual({ type: "noop" });
  });

  it("removes rather than repositions a moved entry the scope excludes", () => {
    expect(decideChangeAction({ kind: "moved", entry }, rendered, false)).toEqual({
      type: "remove",
      flush: true,
    });
  });

  it("defaults to in-scope, so an unscoped timeline behaves exactly as before", () => {
    expect(decideChangeAction({ kind: "added", entry }, absent)).toEqual({ type: "insert" });
    expect(decideChangeAction({ kind: "content", entry }, rendered)).toEqual({ type: "refresh" });
  });
});
