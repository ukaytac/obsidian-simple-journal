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

## External writes: does the embed actually reload?

`ObsidianEmbedEditor` neutralises the embed's `onFileChanged` hook so this
editor's buffer stays authoritative while mounted (see the source file's top
comment). There is deliberately no runtime guard on top of that anymore: an
earlier design tried to catch a reload with a content-and-timestamp check,
and three separate rounds of review each found a different way it dropped
the user's own typed text — a heuristic over an event this file cannot
observe could not be tuned into correctness, so it was removed rather than
tuned a fourth time. That makes this a single, open empirical question this
checklist exists to answer, not a mechanism to verify:

- [ ] **Type while an external write lands on the same file.** Open an
      entry in the journal timeline and type a long sentence continuously,
      without pausing, for long enough that the view's own debounced save
      writes to disk at least once. While that's happening (or immediately
      after), force an external change to the *same* file — edit it from a
      second pane, or edit it directly outside Obsidian and let the vault
      pick up the change — and keep typing through it. Then check: does the
      buffer ever visibly revert to older text, and is any typed text lost
      or out of order?
      - **If nothing is lost:** the neutralisation is holding as expected in
        a real Obsidian window, and no guard is needed here. Leave this file
        as-is.
      - **If text IS lost:** the embed is reloading despite the
        neutralisation, through some path other than `embed.onFileChanged(...)`.
        Whatever replaces the old guard must be deterministic, not another
        heuristic layered on the same unobservable event — e.g. a revision
        counter the view owns and checks before accepting a change, or
        suppressing reported changes entirely while the editor is focused
        and a write is known to be in flight. Content-and-timestamp matching
        is not an option again: it was tried here and removed specifically
        because it cannot be made correct.

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

---

# Manual testing: the viewport-driven mount window

`JournalView`'s editor mount/unmount decision (`mountObserver`, an
`IntersectionObserver` rooted on the timeline pane) and the pure
selection/termination logic behind its `MAX_MOUNTED_EDITORS` backstop
(`src/views/mountWindow.ts`) are covered by `tests/mountWindow.test.ts` with
fabricated state. What that suite cannot cover is real scroll physics, real
focus/blur timing, and a real `IntersectionObserver` reacting to a real
layout — verify these by hand, in a real Obsidian window, with a vault of at
least a few hundred entries (enough to scroll well past `MAX_MOUNTED_EDITORS`,
i.e. past 60 entries on desktop or 25 on mobile).

- [ ] **Scroll past the cap and back; entries at the top are live again, text
      intact.** Open the journal, then scroll continuously downward until
      you're well past the mount cap (the console should show at most
      `MAX_MOUNTED_EDITORS` mounted `.journal-entry-embed`/`.journal-entry-textarea`
      elements at any point — the entries scrolled past should have quietly
      reverted to static rendering). Before scrolling back, note the exact
      text of a couple of entries near the top. Scroll back up to today.
      Confirm: the entries at the top are directly editable again (not
      click-to-edit, not static Markdown) — `mountObserver` re-mounts them the
      moment they re-enter `MOUNT_ROOT_MARGIN` — and their text is byte-for-byte
      what it was before you scrolled away (nothing was lost or duplicated
      across the unmount → static → remount round trip).
- [ ] **Scrolling past unedited entries touches zero files.** Note the
      current modification time (in the file explorer, or your OS's file
      info) of twenty or so consecutive entries you have not edited this
      session. Scroll past all of them — enough to mount and then unmount
      each one via `mountObserver` — without typing anything. Confirm not
      one of their modification times changed. This is the check that would
      catch a regression of the spurious-write bug (`savedBody` no longer
      matching what the editor's `getValue()` reports as unchanged, e.g. a
      line-ending mismatch on a CRLF file): the seeding wiring lives in
      `mountEditor`/`save()`, which no automated test can reach without a
      real `JournalView`.
- [ ] **A focused editor keeps focus and its text when scrolled out of view.**
      Click into an entry near the top and place the cursor mid-sentence.
      Without clicking away (so the entry keeps keyboard focus), scroll it
      out of the viewport and past `MOUNT_ROOT_MARGIN` — far enough that an
      ordinary (unfocused) entry at that position would already have
      unmounted. Confirm the entry does *not* revert to static rendering
      while it holds focus (`unmountEditor` skips a focused editor
      unconditionally). Now click elsewhere in the document to blur it, then
      scroll back to check that entry: it correctly unmounted after the blur
      (via `wireEditor`'s `onBlur` callback, since it was still off-screen at
      that point) and its text — including whatever you typed before
      scrolling — was saved and is intact.
- [ ] **Does `focusout` fire for reasons other than "the user clicked a
      different entry"?** `ObsidianEmbedEditor`'s blur handling is a
      `focusout` listener on the embed's container, filtered by
      `relatedTarget` (see its source). Two cases neither the automated
      suite nor a code read can settle: (1) does it fire when the whole
      Obsidian window loses OS-level focus (switching to another app) —
      `relatedTarget` would be `null` there just as it is for a real blur,
      which the current filter can't distinguish from "moved outside the
      container"; (2) does it fire when a CM6-internal popup takes focus
      (the in-editor search panel, an autocomplete/suggestion dropdown)? If
      either fires `onBlur`, `wireEditor`'s "second chance" unmount
      (`if (!rendered.intersecting) void this.unmountEditor(rendered)`)
      would tear down and revert to static rendering an entry the user
      still considers "in", the moment it's also off-screen — e.g. tabbing
      to another app mid-sentence while scrolled past the margin. Check by:
      focusing an off-screen-eligible entry (scroll it near the
      `MOUNT_ROOT_MARGIN` edge), then (a) switch to a different application
      and back, (b) trigger the in-editor search panel or `[[` autocomplete
      and dismiss it, and in each case confirm the entry is still a live
      editor with focus afterward, not reverted to static text.
- [ ] **Do the `400px`/`900px` margins feel right?** With real scrolling
      (mouse wheel, trackpad, and — on mobile — a flick gesture), confirm an
      entry becomes editable *before* it's needed, not exactly as it scrolls
      into view (a visible "pop-in" or a moment of lag before `[[` works
      would mean the margin is too small for that input method), and that
      the number of simultaneously mounted `.journal-entry-embed`/
      `.journal-entry-textarea` elements at a normal scroll speed doesn't
      feel wasteful relative to what's actually on screen (too large a
      margin). Adjust `MOUNT_ROOT_MARGIN` in `JournalView.ts` if either feels
      off.
