# Search: choosing a result opens the entry's note

**Date:** 2026-09-02
**Status:** approved, implemented
**Supersedes:** the "anchors the timeline" half of
`2026-09-01-journal-search-design.md`

## The problem

`Search journal` shipped with two exits (§ Search Rule 3). One of them was
wrong.

Choosing a result called `goToDateInJournal(entry.created)`, which anchors the
timeline to the entry's **calendar day**. An anchor renders that day and
everything older, and nothing newer. So:

1. **The journal read as truncated.** Everything written after the matched
   entry vanished from the timeline. Scroll up and there was nothing there. The
   user asked a question about words and got a journal that appeared to have
   lost half its history, with no cause they could connect to what they had
   done — the failure § Tags names for a restored scope, arriving by a
   different route.
2. **It landed on the wrong entry.** An anchor lands on the newest entry of the
   day it anchors to. Search for something written at 09:34 on a day that also
   holds a 22:41 entry and the timeline lands on 22:41, with the actual match
   below the fold. The one row the user picked out of the list was the one row
   not on screen.

The documented promise did not match either. `CHANGELOG.md` 1.3.0 said "the
journal goes to it, with the rest of the timeline still there around it", and
the *older* rest was there while the newer rest was not.

## The decision

Choosing a result **opens that entry's note in a new tab**. The timeline is not
touched: no anchor, no scope, same scroll position.

"Show all N matches" is unchanged — it still scopes the timeline to the query.

Rule 3 keeps its name. There are still two exits behind one door; one of them
now leaves the timeline instead of moving it.

## Why not scroll the timeline to the entry

Considered, and it is the more elegant answer: keep the journal continuous and
put the matched entry on screen with the newer entries still above it. Rejected
as a bigger feature than this exit needs. The entry may sit thousands of
entries below the loaded window, so reaching it means paging forward from the
newest entry until it arrives, and § Performance is explicit that the whole
history must never be mounted at once. It would also need a highlight to say
*which* entry, which § Non-Goals rules out ("highlighting matches inside the
timeline itself").

The note is already the surface that shows one entry and only that entry.

## Why a new tab

`app.workspace.getLeaf("tab").openFile(file)` — the same call § Entry Actions'
"Open source note" already makes from the entry menu (`JournalView.ts`). Not a
new mechanism: the same one, reached from a second place.

Deliberately not `getLeaf(false)`, which reuses the active leaf. That leaf is
the journal `searchJournal` has just revealed, so the timeline itself would be
replaced by the note.

## Scope of the change

| File | Change |
| --- | --- |
| `src/main.ts` | `searchJournal`'s `case "hit"` opens the note instead of calling `goToDateInJournal`; the method's doc records why |
| `tests/mainSearch.test.ts` | New. Pins both halves: the note opens in a tab, and the timeline is left alone |
| `tests/obsidian-mock.ts` | `FakeWorkspace.getLeaf`, `WorkspaceLeaf.openFile`, both real API with real signatures; opens recorded on the workspace, which is free to carry test-only state |
| `CLAUDE.md` | § Search Rule 3 rewritten, with the two reasons above kept |
| `CHANGELOG.md` | 1.3.0's promise corrected (unreleased, so corrected in place rather than as a new entry) |
| `docs/manual-testing-open.md` | "Both exits do different things" now checks a new tab and an untouched journal |

Nothing else moves. `SearchModal` is unchanged — the `hit` choice it emits
already carries the entry, and what happens to that choice was never its
decision.

## Testing

`tests/mainSearch.test.ts`, at the plugin level for the reason
`mainMentionSurfaces.test.ts` gives: the decision lives in `main.ts` and
neither the modal nor the view can make it. Only `Modal.open` is stubbed, so
the real `SearchModal` still guards the choice on its way through.

Two tests, one behaviour each:

- the chosen entry's note is opened, in a new tab
- `goToDateInJournal` is not called and no scope is requested — the regression

Both were watched failing against the old implementation: the first with
nothing opened, the second with `goToDateInJournal` called once.

The remaining check is manual, and stays where the rest of the search glue's
manual checks are: `docs/manual-testing-open.md`.
