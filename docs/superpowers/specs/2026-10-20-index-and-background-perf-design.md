# Index and background work: stop paying for what did not change

**Date:** 2026-10-20
**Status:** approved design, not yet implemented
**Scope:** groups B and C of the 2026-10-20 performance audit. The other three
groups — iOS paging and scroll jumps (A), search and the settings tab (D), and
unbounded DOM growth (E) — each get their own spec.

## What this is

A set of fixes with **no observable behaviour change**. Every one of them
removes work that runs while nothing relevant happened: at startup, on an edit
to a note outside the journal, on a save to an entry a panel does not show,
or on an idle editor's timer. None of them touch the composer, the focus
timing, the save path, or what any surface displays.

## Findings this addresses

All verified against the code on 2026-10-20.

1. **Startup event storm.** `JournalService.onload` (`services/journalService.ts:56`)
   registers `vault.on("create")` and `metadataCache.on("changed")` from inside
   the plugin's `onload`. Obsidian's load-time guide: "As a part of Obsidian's
   vault initialization process, it will call `create` for every file … Your
   vault event registration should be inside an `onLayoutReady` callback."
   Every file in the vault is then queued, and each flush entry does a linear
   path scan (`entryIndex.ts:54-62`): O(vault files × entries) on every launch.
2. **Linear path lookups.** `findByPath`/`removeByPath` are `Array.find` /
   `findIndex` on path strings. A bulk rename (`Update existing journal entries`
   on a large journal) makes the follow-up flush quadratic.
3. **Edits outside the journal reach the index.** `queue` accepts any `TFile`.
   Every `modify`/`changed` of any note costs an O(n) `removeByPath` that finds
   nothing, and restarts the shared debounce timer.
4. **Mentions panels re-render on every journal save.** `MentionsPanel.ts:144`
   repaints on any `onChange` batch: `findMentions`, a body read per shown
   entry, and a `MarkdownRenderer` pass each — for every live footer, sidebar
   and code block, even when the saved entry has nothing to do with the target.
5. **The calendar rebuilds its grid on every batch** (`CalendarView.ts:60`),
   about 45 elements and a dozen `toLocaleDateString` calls, whether or not
   its month's dots changed.
6. **Every embedded editor polls every 250 ms, idle or not**
   (`ObsidianEmbedEditor.ts:633`). An unchanged tick ends at one string
   comparison, so the cost per tick is small; the cost is the wakeups — 25
   editors on a phone is 100 timer firings a second, which keeps the CPU out
   of idle.

## Design

### 1. The index keeps a path map (`services/entryIndex.ts`)

A small `EntryIndex` class owns the sorted array and a `Map<string,
JournalEntry>` keyed by path, and is the only thing that mutates either.

* `entries` is the same live array `getEntries()` returns today. `JournalView`
  aliases it as its paging cursor list; that contract is unchanged.
* `get(path)` and `has(path)` are map lookups.
* `insert(entry)` binary-searches with `compareEntries`, as `insertSorted` does
  now, after removing any existing record for the path.
* `remove(path)` looks the record up in the map and splices it out with
  `indexOf(record)` — still O(n), but a native reference scan rather than a
  string comparison per element.
* `rekey(oldPath)` handles a rename. Obsidian mutates the renamed `TFile` in
  place, so the record found under `oldPath` already reports its new path
  through `entry.file.path`; `rekey` moves the map key there. It leaves the
  array alone, except that a *different* record already filed under the new
  path is a stale duplicate and is removed, so one path never names two rows.
* `staleKeys()` lists keys whose record now reports a different path — only the
  layout-ready reconcile needs it.
* `replaceAll(list)` is `rebuild()`'s path.

`insertSorted`, `removeByPath` and `findByPath` were removed: `EntryIndex`
replaced them and nothing else called them. The rest of the pure functions
(`insertionIndex`, `compareEntries`, paging, anchoring) stay exported and keep
their tests; `EntryIndex` is built on them.

`JournalService` swaps its `index: JournalEntry[]` for an `EntryIndex`. The
rename listener calls `rekey(oldPath)` (see § 3 for why at event time).
`applyRenameSource(path)` still returns `{ kind: "removed", path }`
unconditionally — `JournalView.rendered` is keyed
by the stale path and depends on that removal (see its existing doc). The
upsert queued for the new path then finds the record by map lookup and reports
`content` or `moved` exactly as today.

### 2. Only journal events are queued (`services/journalService.ts`)

`queue(file, action)` drops the event unless
`repository.isEntryFile(file) || index.has(file.path)`.

The second half is what keeps "an entry moved out of the journal folder
disappears from the timeline" working: the file is no longer an entry file,
but its path is still indexed until the flush removes it.

A file rename is queued, both halves, when `index.has(oldPath)` (an entry is
moving, possibly out of the journal) or `repository.isEntryFile(file)` (a file
is arriving in the journal). The test runs before `rekey`, while the map still
holds the record under `oldPath`, so `oldPath` is the key to test.
Moving out works as it does today: `rekey` files the record under the new path,
the upsert finds `entryFor` returns null, and the removal reports the new path
gone. Folder renames keep their existing `isJournalFolderPath` gate.

`delete` goes through the same `queue` gate as every other event (the path is
indexed, or is an entry file), which matches the old behaviour: the removal of
an unindexed entry file is a no-op.

### 3. Listeners wait for the layout; one reconcile replaces the storm

`JournalService.onload` keeps calling `rebuild()` synchronously, and registers
its vault and metadata-cache listeners inside `workspace.onLayoutReady`.

The rebuild stays in `onload` on purpose. A timeline restored from a saved
workspace can open before the layout is ready; with an empty index it would
show the empty state, and repainting it afterwards means `reload()`, which runs
through the composer path `CLAUDE.md` § JournalView calls the most expensive
code in the plugin to get wrong.

The storm used to do one useful thing: if the metadata cache was incomplete at
`onload`, some entries were indexed with a filename-derived date and corrected
later by `changed` events. That correction now comes from a **one-time
reconcile** at layout-ready, before the listeners are registered:

1. Build a fresh list with `repository.listEntries()`.
2. Diff it against the index by path:
   * in fresh, not indexed → insert, `added`
   * indexed, not in fresh → remove, `removed`
   * both, `created` differs → re-insert, `moved`
   * both, tags differ → write back tags, `content`
3. Emit the changes as one ordinary batch, or nothing when there are none.

On a normal launch the diff is empty and nothing is emitted. Views receive
ordinary changes, never `reload`. Registered from `onload` before
the plain `onLayoutReady` callback at the end of `main.ts`'s `onload` (calendar
leaf, mention settings), so the index is current before a mention footer reads
it. A URI-opened composer is safe regardless: its callback is queued only when
a URI is dispatched, later still. When the layout is already ready (plugin
enabled mid-session) the reconcile is skipped, since `rebuild()` just read the
same vault.

An event that fires between the reconcile and listener registration cannot be
missed: both happen synchronously in the same callback.

The reconcile also repairs a record whose `TFile` was renamed before the
listeners existed: Obsidian mutates the file in place, so its map key no longer
matches `entry.file.path`. Those keys are re-filed first and reported as
`removed` for the old path, which is the half of a rename `JournalView` needs.

The rename listener calls `rekey` synchronously, at event time rather than at
flush, so no caller in between — `applyKnownEntry` above all — can look a
renamed entry up under its new path and miss it.

### 4. Mentions panels repaint only when affected (`mentions/MentionsPanel.ts`)

Each render records the paths of **every** mention `findMentions` returned —
not only the shown slice — as `mentionPaths`.

An `onChange` batch schedules a refresh when any of:

* it contains `reload`
* a `removed` path is in `mentionPaths`
* an `added`, `moved` or `content` entry's path is in `mentionPaths`, or
  `resolvedLinks[path]?.[target.path]` is set (it links to the target now)

The `resolve` subscription keeps its `isEntryFile` filter and adds the same
test: in `mentionPaths`, or links to the target now. A link removed → the entry
is in `mentionPaths` → repaint, and it drops out. A link added →
`resolvedLinks` shows it → repaint, and it appears.

The registry repaint (`refreshMentionPanels`) and every explicit caller still
render unconditionally. The debounce is unchanged.

### 5. The calendar skips an identical grid (`views/CalendarView.ts`)

`render()` computes a signature — displayed month, today's date, and the
dotted days of that month from `entryDaysInMonth` — and returns early from the
`onChange` path when it equals the last one. `refresh()` and month navigation
always render. Today's date is in the signature so the midnight change of the
"today" emphasis is not lost.

### 6. Editors poll fast only while in use (`views/ObsidianEmbedEditor.ts`)

Confined to the one file that holds the editor exception, as `CLAUDE.md`
§ Editing requires.

The `setInterval` becomes a self-rescheduling `window.setTimeout`, on the same
global `window` the interval used:

* **hot, 250 ms** — the editor holds focus, or lost it under 2 s ago
* **cold, 2000 ms** — everything else

A `focusin` listener on the container cancels a pending cold tick and
schedules a hot one, so the first keystroke after focusing is picked up within
250 ms, exactly as today, never up to 2 s late. The existing `focusout` path
stamps the blur time; the editor goes cold 2 s later.

The tick body (`readRaw` → compare → `readBody` → `onChange`), `markUnusable`,
`getValue` and `destroy` are unchanged, and `destroy` clears the timer.
`getValue()` reads the editor directly, so a flush on unmount or close sees the
latest text regardless of polling speed. A change made without focus — a drop,
a plugin writing through the editor — is reported within 2 s, never lost.

Confirmed against `mountLifecycle.ts` while planning: eviction does not depend
on `onChange` at all. `isDirty` compares `editor.getValue()` with `savedBody`,
and `flushSave` starts with `editor.flush()`, which reads the editor directly
and reports it. A cold editor's not-yet-polled change is therefore still seen
as unsaved and still written on unmount. A test pins `flush()` reporting text
the poll has not seen.

`TextareaEditor` already works from `input` events and is not touched.

## Not in scope

* Folding a large change batch into one `rebuild()` plus `reload`. With the map
  it gains little, and `reload` runs through the composer path.
* Replacing polling with CM6's `onUpdate`. The existing comment rejects it as
  unverifiable monkey-patching, and it would widen the internals exception.
* The double render in `refreshJournal`. Rare, idempotent, token-guarded.
* Making the self-write mark absorb both `modify` and `changed`. Within its 2 s
  window it could swallow a genuine external edit.

## Testing

Test first, per change.

* `tests/obsidian-mock.ts`: `onLayoutReady` gains an opt-in "not ready yet"
  mode with a test-only `fireLayoutReady()`. The default stays immediate, so
  existing tests are untouched.
* `entryIndex.test.ts`: map and array agree after insert, remove, move, rekey;
  a rename chain A→B→C; a path removed and re-added; `entries` stays the same
  array object.
* `journalService.test.ts`: a pre-layout `create` storm emits nothing; the
  reconcile emits nothing when the index matches, one `moved` for a changed
  date, `added`/`removed` for a file created or deleted in between; a `modify`
  outside the journal schedules no flush; an entry moved out of the folder
  still emits `removed`; renames into and out of the journal.
* `mentionsPanel.test.ts`: an unrelated save does not render; a change to a
  mention does; a link removed or added through `resolve` does; `reload` and
  `refreshMentionPanels` always do.
* `calendarView.test.ts` (new): an identical signature skips the rebuild; a
  change of month, dots or date does not.
* `obsidianEmbedEditor.test.ts`, fake timers: cold ticks are 2 s apart;
  `focusin` triggers an immediate tick; cold again 2 s after `focusout`;
  `getValue()` is current while cold; `destroy` clears the timer.
* Eviction: a cold editor with an unreported change still writes it on unmount.

### Measurement

`tests/perf/indexScale.bench.ts`, run with `vitest bench`, outside `npm test`.
50,000 synthetic entries plus 50,000 non-journal files:

1. 100,000 `create` events and a flush — old behaviour against new
2. 50,000 renames, the shape `Update existing journal entries` produces
3. 100 `modify` events on a note outside the journal

Before-and-after numbers go in the commit message and the release notes.

### Manual

Added to `docs/manual-testing.md`:

* desktop, large vault: no startup hitch, and a restored timeline opens full
* `obsidian://simple-journal-new` immediately after startup lands in a composer
* iPhone, timeline open and idle: energy use
* the mentions footer and the calendar still update when an entry is edited

## Done when

`npm run build`, `npm test`, `npm run test:tz` and `npm run lint` pass; the
benchmark shows startup and bulk rename going from quadratic to linear; and no
user-visible behaviour changed.
