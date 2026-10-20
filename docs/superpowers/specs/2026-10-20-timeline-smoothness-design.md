# Timeline smoothness: the pager waits for real heights and a real scroll

**Date:** 2026-10-20
**Status:** approved design, not yet implemented
**Scope:** group A of the 2026-10-20 performance audit. Builds on
`2026-10-20-index-and-background-perf-design.md` (group B+C), on the branch
stacked on top of it.

## The reported bug

On an iPhone, opening the journal makes the timeline **scroll by itself**: with
no finger on the screen it moves down, or keeps loading older entries.

## Why it happens

Two mechanisms feed each other.

**The pager re-asks too early.** `loadNextPage` appends a page of `PAGE_SIZE`
rows. Each row's body is empty until `renderStatic` finishes an uncached
`vault.read` and a `MarkdownRenderer` pass, so a fresh page is about forty
headers tall. `onSentinelVisible` immediately forces a re-observe
(`JournalView.ts`, the `unobserve`/`observe` pair). With mobile's
`rootMargin: "1200px 0px"` the sentinel is still inside the margin, so the next
page loads — up to `MAX_BURST_PAGES` (10): four hundred rows, four hundred disk
reads, four hundred renders, on open.

**Heights keep changing afterwards.** `mountEditor` empties the body *before*
its read (`mountLifecycle.ts`), so an entry sits at zero height for a whole
bridge round-trip and then grows to the editor's height. Bodies filling in late
do the same. Each change can carry the sentinel out of the margin and back in,
and a real re-entry is treated as a user scroll (`isBurstContinuation` false),
which starts a fresh ten-page burst. Desktop Chromium hides much of this with
scroll anchoring; WebKit does not ship it, so on iOS every height change above
the viewport moves the visible text.

## Design

No change to the composer, the focus-claim window, `reloadNow`'s ordering, or
`MAX_BURST_PAGES`.

### 1. The pager

**1a. Re-ask against real heights.** `timelineDom.appendEntry` returns the
promise of the `renderStatic` it starts. `loadNextPage` collects the page's
promises, and `onSentinelVisible` awaits `Promise.allSettled` of them before it
forces the re-observe, with the existing `generation` check after the await. A
read that never settles only pauses the burst; nothing else waits on it.

**1b. A new burst needs a real scroll.** The view remembers `contentEl.scrollTop`
after each load. A sentinel callback that is not a burst continuation proceeds
only when one of these holds:

* `scrollTop` differs from the value remembered at the last load
* it is the first load after a `reload` (remembered value reset to `null`)
* the content does not fill the pane (`scrollHeight <= clientHeight`), so a
  pane that grew wider can never stall with nothing to scroll

Otherwise the load is **deferred**: a flag records it, and a passive `scroll`
listener on `contentEl` (registered through `registerDomEvent`) runs it on the
next scroll that changes `scrollTop`, provided the sentinel is still
intersecting — the observer callback records the sentinel's last
`isIntersecting` for exactly this. Programmatic scrolls (a calendar jump, a
restored position) change `scrollTop` like any other and are not held back.

**1c. A smaller mobile margin.** The sentinel's mobile `rootMargin` goes from
`1200px` to `800px`, about one phone screen. Desktop stays at `600px`.

**1d. Static bodies use the cached read.** `renderStatic` reads through
`EntryRepository.readBodyCached` instead of `readBody`. It only displays;
nothing it reads is ever written back. The editor's baseline keeps coming
from the uncached `readBody` in `mountEditor`, which is what the save path's
dirty check relies on.

### 2. Stable heights

**2a. Mount: read, then swap.** `mountEditor` keeps bumping `opToken` first, so
it still wins against an in-flight static render. The
`renderComponent.unload()`, `bodyEl.empty()` and `min-height` removal move to
**after** the read and its guards. Until the read returns, the static text stays
on screen; afterwards unload, empty and mount happen in one synchronous step. A
guard that bails therefore leaves the static rendering untouched, and the
"left the margin while reading" branch no longer needs to re-render.

**2b. Unmount: no disk read.** `unmountEditor` reaches its static render only
after the dirty check passed, i.e. `editor.getValue() === savedBody`. It calls
`renderStatic(target, target.savedBody)`: `renderStatic` gains an optional
`knownBody`, and uses it instead of reading. The existing `min-height` freeze
around the swap stays.

**2c. Static render: hold the height across the swap.** `renderStatic` reads
first (or takes `knownBody`), passes its `generation`/`opToken` guards, then
freezes the body's current `offsetHeight` as `min-height`, empties, renders, and
removes the freeze once `MarkdownRenderer.render` resolves.

**2d. A placeholder height for a body never rendered.** On a row's first
render `renderStatic` adds `is-pending` to the body, and `styles.css` gives
`.journal-entry-body.is-pending` a `min-height` of about three lines (`4.5em`).
The class is removed after the render. It applies only to an empty,
never-rendered row, so no entry's settled appearance changes.

Unchanged: the `generation`/`opToken` guards after every await, `isDirty`'s
refusal to unmount unsaved text, `flushSave`, and `refreshEntryContent`, which
still reads from disk because there the content changed outside the view.

## Not in scope

* Staggered mounting and a mount/unmount hysteresis band. That would touch the
  composer's 400 ms focus claim, the focus race `docs/manual-testing.md`'s case
  study documents. It is the next suspect if the device check below still
  fails, and gets its own design then.
* Unloading rows far outside the viewport — group E.

## Testing

Test first, per change, with `journalViewHarness.ts` and the fake
`IntersectionObserver`.

* Paging: no forced re-observe while the page's static reads are held; a
  callback with an unchanged `scrollTop` loads nothing, and a later `scroll`
  that changes it does; the first callback after `reload` loads; content
  shorter than the pane loads without a scroll (`scrollHeight`/`clientHeight`
  set with `Object.defineProperty`); a `reload` landing mid-burst still bails.
* Mounting: while `mountEditor`'s read is held, the static body is still in the
  DOM; a mount whose guard bails leaves it untouched.
* Unmounting: renders from `savedBody` with no `readBody` or `readBodyCached`
  call.
* `renderStatic`: reads through `readBodyCached`; `is-pending` is present only
  until the first render finishes; no `min-height` is left behind.

### On the device

Added to `docs/manual-testing.md`, run after each step is synced:

1. Open the journal and leave the screen alone for ten seconds: nothing scrolls,
   nothing keeps loading.
2. Scroll down slowly and continuously: pages keep arriving; loading never
   stalls.
3. Flick hard and stop: the text does not jump after it stops.
4. Tap an entry to edit it: the text does not move while the editor opens.
5. `New journal entry`: the composer opens with the caret in it, as before.

## Done when

Build, both test runs and lint pass, and checks 1–5 pass on the iPhone. If
check 1 still fails, gather evidence before changing anything else.
