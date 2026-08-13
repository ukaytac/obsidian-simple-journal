# Manual testing: TextareaEditor resize

`TextareaEditor.resize()` depends on real layout (`offsetParent`, `scrollHeight`),
which jsdom reports as `null`/`0` unconditionally — so `tests/textareaEditor.test.ts`
deliberately does not exercise it; a jsdom test would bail out on every case
and pass green without proving anything. Verify these by hand in a real
Obsidian window instead, using a fresh entry with a few lines of text.

## Shrink paths (fast-path guard must NOT skip these)

- [ ] **External setValue shrinking content.** Open the same entry in a second
      pane (or edit the underlying file directly). Delete a paragraph from the
      other pane. Switch back to the journal tab: the entry's box shrinks to
      match, with no leftover blank gap below the text.
- [ ] **Undo after typing several lines.** Type 4–5 new lines into an entry,
      then press your undo shortcut until they're gone. The box shrinks back
      down as each line is removed; it doesn't stay tall.
- [ ] **Typing or pasting over a multi-line selection.** Select several lines
      of an entry, then type a single character (or paste a short string) to
      replace the selection. The box shrinks to fit the now-short content
      immediately, not on some later keystroke.
- [ ] **Multi-line paste into short content.** Reverse case: paste several
      lines into a one-line entry. The box grows immediately to fit.

## IME

- [ ] **IME composition.** Using an IME (Japanese/Chinese/Korean input, or any
      composed input method), compose a multi-character candidate in an entry
      that's near a line wrap. The box resizes correctly as composition
      grows/shrinks the pre-edit text, and again once the candidate commits.

## Width changes

- [ ] **Divider drag re-wraps text.** With an entry whose text wraps across
      several lines, drag the split divider to narrow the journal pane, or open
      the right sidebar. The entry grows taller as the text re-wraps — no lines
      are clipped below a stale height. Widen it again and the box shrinks back.
      Nothing automated can cover this: it depends on `onResize()` firing for a
      size change rather than a visibility change.

## Background-tab recovery

- [ ] **Mounting while the tab is in the background, then switching back.**
      Open the journal in one tab, switch to a different tab so the journal's
      leaf is hidden, then edit the same entry from another pane (or the file
      directly) so its content shrinks by several lines. Switch back to the
      journal tab: the entry is already correctly sized (via `remeasure()`
      on `onResize()`) — it isn't clipped or left at a stale, oversized height
      waiting for the next keystroke.
