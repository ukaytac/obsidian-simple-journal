# Search and the settings tab: stop redoing the same work

**Date:** 2026-10-20
**Status:** approved design, not yet implemented
**Scope:** group D of the 2026-10-20 performance audit. Stacked on
`perf/timeline-smoothness`. No user-visible behaviour change: the same results,
the same rows, the same button state.

## Findings

1. **Search folds the whole journal on every keystroke.** `SearchModal.getSuggestions`
   → `searchSnapshot` → `bodyMatchesTerms` runs `foldForSearch(body)` (a regex
   replace plus `toLowerCase`) on every entry, per keystroke.
2. **Search builds an excerpt for every hit, shown or not.** `searchSnapshot`
   calls `buildSnippet` (flatten + fold again) for each hit. A two-letter query
   matches nearly everything, while `SuggestModal` renders only up to its
   `limit`. `JournalView`'s text-scope resolution uses the same function and
   needs only paths.
3. **Opening search starts every read at once.** `readJournalSnapshot` is a
   `Promise.all` over every entry's `cachedRead`. On iOS each one crosses the
   native bridge, and memory peaks with every promise outstanding. The modal
   opens only when the last one finishes, with nothing on screen meanwhile.
4. **The settings tab walks the journal twice to set one button.**
   `hasPendingEntryUpdates` → `planReorganize` runs `listEntries()` (walk,
   resolve every entry, sort), then `reorganizeTarget` calls `entryFor` again
   per entry for the date `listEntries` already resolved. It runs whenever the
   tab is displayed and after each storage-setting change.

## Design

### Search

**Fold once.** `SnapshotEntry` gains `folded: string`, set to
`foldForSearch(body)` when the snapshot is read. Matching moves to a new
`foldedMatchesTerms(folded, terms)` in `entrySearch.ts`; `bodyMatchesTerms`
becomes `foldedMatchesTerms(foldForSearch(body), terms)`, so there is still one
matching rule. Matching the unflattened folded body gives the same answer as
before because a term never contains whitespace (`parseSearchQuery` splits on
it), and flattening only collapses whitespace runs. Memory: the body is held
twice while a search is open, released with the snapshot.

**Excerpts on demand.** `SearchHit` becomes `{ entry, body, terms }`.
`SearchModal.renderSuggestion` calls `buildSnippet(hit.body, hit.terms)` for
the row it is drawing — only rows the modal actually renders pay for one.
`hitPaths` and the `all` row are unchanged in meaning.

**Read a bounded number at a time.** `readJournalSnapshot` reads with at most
`SNAPSHOT_READ_CONCURRENCY = 32` reads in flight. Result order is the index's
order, as before; an unreadable entry is still logged, dropped, and counted.

**Say it is reading.** `main.searchJournal` shows `Reading the journal…` if the
snapshot is not ready after 300 ms, and hides it when it is. A journal that
reads faster sees nothing new.

### The settings button

`reorganizeTarget(file, created, root, layout, format)` takes the date as a
parameter instead of calling `entryFor`. `planReorganize` passes `entry.created`
from `listEntries()`, so the plan is computed exactly as before.

New `EntryRepository.hasPendingUpdates(entries: readonly JournalEntry[])`: the
same two questions `planReorganize` asks — a non-null `reorganizeTarget`, or
`lacksDateProperty` — over the given list, returning `true` at the first entry
that needs either.

`main.hasPendingEntryUpdates()` calls it with `journal.getEntries()`: the index
already in memory, no walk, no sort. The command's confirmation still plans from
`listEntries()`, and the run re-checks each file before writing, so the button
can only ever be wrong about whether it is enabled, and only for the ~300 ms the
index can lag disk.

## Testing

* `foldedMatchesTerms` agrees with `bodyMatchesTerms` (existing `entrySearch`
  tests stay, unchanged).
* `searchSnapshot` never calls `buildSnippet`; `SearchModal` renders the same
  excerpt text as before for a hit.
* `readJournalSnapshot` never has more than 32 reads outstanding (a reader that
  counts in-flight reads), keeps index order, and still counts unreadable
  entries.
* `hasPendingUpdates` returns the same answer as `planReorganize` for moves,
  for a missing date property, and for nothing to do; and stops at the first
  hit (a spy on the per-entry check).
* Existing `settingsTab`, `reorganizeEntries`, `searchModal`, `mainSearch` and
  `JournalView.textScope` tests pass unchanged.

## Done when

Build, both test runs and lint pass, with no change to any existing assertion
about results.
