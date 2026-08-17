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

---

# Manual testing: ObsidianEmbedEditor

None of this is exercisable in jsdom: it depends on the real internal embed
registry, a real CodeMirror 6 instance, and Obsidian's actual save/debounce
pipeline (Task 13+), none of which `tests/obsidianEmbedEditor.test.ts`'s fake
embed can stand in for. Verify these by hand in a real Obsidian window.

## The write-echo race

- [ ] **Typing continuously past the autosave debounce without losing
      characters.** Open an entry and type a long sentence steadily, without
      pausing — long enough that the view's debounced save fires and writes
      to disk at least once or twice while you keep typing. Re-read the
      sentence back: every character you typed is present, in order, with
      nothing dropped mid-sentence. This is the exact failure mode of the
      write-echo bug (a save landing, the vault emitting `modify`, and a
      stale reload clobbering newer keystrokes) — `tests/obsidianEmbedEditor.test.ts`
      reproduces it against a fake embed, but only a real Obsidian window
      exercises the real `onFileChanged` path this plugin neutralises plus
      the real debounced writer from JournalView.
- [ ] **Same test, faster.** Repeat holding down a single key (e.g. arrow
      key through autorepeat isn't useful here — instead paste-then-edit, or
      type as fast as you can) to make the save/keystroke race as tight as
      possible. Still no dropped characters.

## Editing fidelity

- [ ] **`[[` autocomplete.** Type `[[` inside an entry. The real Obsidian
      link suggester appears and lists actual vault files (not a plain-text
      fallback), including the "Type # to link to a heading" hint.
- [ ] **Live preview.** Markdown syntax (headings, bold/italic, lists, code
      fences, callouts) renders inline as you'd see in any other Obsidian
      note in Live Preview mode — not as raw source text.

## No titles, no renaming (CLAUDE.md "no titles" rule)

- [ ] **No title or properties panel visible.** Open an entry with several
      frontmatter properties (e.g. `created` plus a couple of extra keys).
      Neither the note's inline title nor a properties/metadata panel is
      visible anywhere in the timeline entry — only the body text and its
      timestamp.
- [ ] **The entry cannot be renamed from the timeline.** Confirm there is no
      focusable, editable title element inside a mounted entry at all — there
      is nothing in the timeline to click or type into that would rename the
      underlying file. (Renaming the file from the File Explorer or the
      command palette, outside the timeline, is unaffected and still works
      normally.)
