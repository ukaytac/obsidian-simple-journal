# Unloading far rows, and mounting in stages

**Date:** 2026-10-21
**Status:** approved, implemented — awaiting the device check
**Scope:** the two items the 2026-10-20 performance work deferred: group E's
unloading (only the CSS half shipped) and group A's staged mounting with
hysteresis. Stacked on `perf/remaining`. No change to what any entry shows, to
saving, or to the composer.

## 1. Residency: rows far away give back their memory

Every row ever paged in keeps its rendered body and its `Component` — embeds,
images, listeners — for the life of the view. `content-visibility: auto`
already stops the browser laying them out; it does not free them. On iOS,
memory pressure is what gets Obsidian killed.

**A third observer.** `residencyObserver`, an `IntersectionObserver` rooted at
`contentEl` like the other two, with a margin of `3000px 0px` on desktop and
`2400px 0px` on mobile — far outside `MOUNT_ROOT_MARGIN`, so a row is always
resident long before it can mount, and long before it is visible. Every row is
observed when it is created, alongside the mount observer, and unobserved where
the mount observer's is.

**Leaving residency** — only a row with no editor (`rendered.editor === null`):

1. record `bodyEl.offsetHeight` and set it as the body's inline `min-height`
2. bump `opToken`, so any render still in flight bails at its next guard
3. `renderComponent.unload()`, `renderComponent = null`, `bodyEl.empty()`,
   remove `is-static`, add `is-dehydrated`

The row and its header stay, at the same height, so nothing above or below
moves and the pager's sentinel sees the same timeline.

**Entering residency** — a row marked `is-dehydrated` with no editor: remove the
mark and call `renderStatic`. The inline `min-height` holds the height across
the read; `renderStatic`'s token-guarded `finally` removes it when the render
lands, exactly as for any other static render. (`renderStatic` will also add
`is-pending`, whose 4.5em loses to the inline `min-height`, and remove it in
the same `finally`.)

**An editor row is never unloaded.** A mounted editor is always within the
mount margin, so it cannot be outside residency; the check is still explicit.
Nothing a static row holds can be unsaved.

**External changes.** `changeApplication.refreshEntryContent` skips the render
for a row marked `is-dehydrated`: the row re-renders from disk when it comes
back, and rendering it now would undo the unload.

`clearTimeline` disconnects and recreates the observer with the others; every
row is discarded there anyway.

## 2. Staged mounting, with a band between mounting and unmounting

**Hysteresis.** Today one observer both mounts (enter `MOUNT_ROOT_MARGIN`) and
unmounts (leave it), so a row at the edge mounts and unmounts as the user
nudges. A second observer, `keepObserver`, with a margin `600px` larger on each
side, takes over unmounting:

* `mountObserver` sets `rendered.intersecting` (meaning unchanged: inside the
  mount margin) and its distance, and on entry asks for a mount. It no longer
  unmounts.
* `keepObserver` sets `rendered.withinKeep`; on exit it calls `unmountEditor`.
* `unmountEditor`'s "re-entered while flushing" decline reads `withinKeep`
  instead of `intersecting` — that check is about whether the row is still
  wanted, which is now the keep band's question.
* `mountEditor`'s "left while reading" bail keeps reading `intersecting`.
* Eviction (`enforceMountLimit`) is unchanged: it ranks by `mountDistance` and
  bypasses the decline with `evict: true`.

**Staging.** A mount observer callback mounts at once every row whose
`boundingClientRect` intersects the viewport itself (not the margin), exactly
as today. The rest join a queue ordered by `mountDistance`; a
`requestAnimationFrame` loop on `contentEl.win` mounts `MOUNTS_PER_FRAME = 2`
per frame until it is empty. A row that left the mount margin before its turn
is skipped (`mountEditor` would bail anyway). The queue is cleared by
`clearTimeline`, and a row is removed from it when it unmounts or is removed.

**Focus.** `COMPOSER_FOCUS_CLAIM_MS` assumes the first mounts finish quickly.
They still do for the visible rows, which mount immediately as before. Rows
mounted later cannot take the caret: since `5596650` mounting an embedded
editor does not focus it (`showEditorWithoutFocus`), and `TextareaEditor`
never did. The device checks below are what confirm it.

## Testing

Test first, with the fake observers (`trigger`) and the harness's fake rAF
(`installFakeRaf` in `tests/journalViewHarness.ts`).

* Residency: a static row leaving is emptied, keeps its height as
  `min-height`, has its component unloaded, and is marked; entering re-renders
  it and clears the height after; a row with an editor is never unloaded; an
  external change to an unloaded row does not render it; a render in flight
  when the row is unloaded does not write into it.
* Hysteresis: leaving the mount margin alone does not unmount; leaving the keep
  band does; the flush-race decline reads `withinKeep`.
* Staging: a visible row mounts in the callback; off-screen rows mount two per
  frame, nearest first; a row that left before its turn is skipped; `reload`
  clears the queue.
* All existing `JournalView.*` tests pass, adjusted only where they triggered an
  unmount through `mountObserver` (they now trigger `keepObserver`).

### On the device

Repeat the six timeline checks in `docs/manual-testing.md`, plus:

7. Scroll far down and back up: rows come back rendered before they are on
   screen, nothing jumps.
8. Open the journal with the composer (`New journal entry`): caret in the
   composer, keyboard up, and it stays there while the rows below mount.
9. Tap an entry that has just scrolled into view: its editor opens with the
   caret and the keyboard.

## As built

What review changed, or what the design above did not say:

* **Residency skips only a row a mount has started.** Entering residency, a
  dehydrated row is left to the mount when `intersecting &&
  !pendingMounts.has(rendered)`. A row only queued renders statically like any
  other: nothing is reading its file yet, and if it leaves before its turn the
  queue drops it and no mount would ever fill the body.
* **A tap on a still-queued row keeps its caret.** A row queued off screen and
  then scrolled on screen gets no new transition, so it was still queued when
  tapped; the next frame mounted it a second time, superseding the tap's mount
  — the only one that focuses — and the editor arrived without caret or
  keyboard. `remountOnInteraction` now takes the row out of `pendingMounts`
  first, and `mountPendingRows` skips a row with a mount in flight
  (`mountsInFlight`, a count, since a tap and an observer can both start one).
* **Heights survive coming back off screen.** `dehydrate` and `unmountEditor`'s
  freeze both drop `is-static` for a while, which makes the browser forget the
  size `contain-intrinsic-size: auto` remembered; the static render that
  follows sets `is-static` again off screen and the body laid out at the 4.5em
  fallback, growing on approach — a jump on iOS. Both now also set an inline
  `contain-intrinsic-size: auto <height>px` and leave it in place. Not on a
  first render.
* **A row that left residency with an editor is unloaded when the editor
  goes.** Residency skips a row with an editor (a focused or dirty one that
  declined to unmount, one the keep band kept, one a jump carried away), and
  its observer does not report again until the row crosses back. Every row now
  records `withinResidency` (starting true: wrongly true only leaves a row
  rendered, wrongly false could empty a visible one), and a `MountDeps`
  `afterUnmount` hook — run after every unmount attempt, including `onBlur`'s
  and an eviction's, which bypass the view's wrapper — unloads the row if it is
  still outside residency and residency may touch it.
* **`onBlur` reads `withinKeep`**, not `intersecting`: an editor blurred between
  the two margins is one the keep observer itself would have kept.
* **Removal unobserves.** A row removed without a reload is unobserved by all
  three observers and dropped from the queue (`unobserveRow`).
