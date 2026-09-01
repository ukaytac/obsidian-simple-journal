# Open checks — for a person, not the suite

696 automated tests cover the pure logic and, through a jsdom harness, a good
deal of the timeline's DOM behaviour. What is left here needs a running
Obsidian, a real phone, a community theme, or a screen reader — things no fake
can stand in for.

Grouped into sessions so it can be picked up in pieces. Each item is an action
and an expected result. **Bold-marked items are stop-and-report**: if one fails,
say so before moving on, because a failure there means something is losing data
or breaking the product's core promise rather than looking wrong.

What has already been verified lives in `manual-testing.md` and
`manual-testing-editor.md`, marked `[x]` with the evidence. This file holds only
what is still open.

---

## Status before the 1.0.0 release

The author reported running these sessions and finding them all passing on
2026-08-21, mobile included, ahead of tagging 1.0.0. Per-item evidence was not
recorded, so the individual boxes below are left unticked on purpose: they mark
what a future regression hunt should **re-run** rather than trust. `manual-testing.md`
and `manual-testing-editor.md` are the files where a check is ticked only
alongside the evidence for it.

Session C stays worth re-reading in particular. Nothing in the mobile code had
run on a device when it was written, and its two timings — 300 ms for the
keyboard, 500 ms for the long press — were guesses. A device pass that says
"fine" is weaker evidence than one that says "the long press feels slow", so if
anything felt off, it is worth writing down here rather than remembering.

---

## Session A — desktop, the ones that matter most (~15 min)

Failure in any of these is a real defect, not a rough edge.

- [ ] **A task line shows its checkbox.** Type `- [ ] something` in an entry.
      The checkbox renders and toggles on click. *(The rest of this check —
      bullet markers, nested indent, quote border — passed on desktop in both
      themes via the README capture; only the task line is left, and all four
      are still unverified on mobile. Regression check for the `.cm-line`
      padding split: the previous reset erased every bullet in the timeline and
      the old wording, "type a list", passed anyway. See `manual-testing.md`,
      "Fixed: list markers were missing from every entry".)*

- [ ] **Continuous typing loses no characters.** Type a long sentence steadily,
      without pausing, for long enough that the save reaches disk twice while
      you are still typing. Read it back: every character present, in order.
      *(Related to a check that already passed — that one changed the entry's
      time mid-typing; this one is the plain debounce race.)*

- [ ] **Frontmatter survives editing.** Add `mood: calm` and `tags: [journal]`
      to an entry's frontmatter by hand. Edit the entry's body from the
      timeline. Both properties unchanged, in the same order, same formatting.

- [ ] **A committed entry is never auto-deleted.** Write an entry, then delete
      all of its text from the timeline. The file must still exist.

- [ ] **An empty composer creates no file.** Run `New journal entry`, type
      nothing, click away. No file appears anywhere in the vault.

- [ ] **Typed content survives a failed create.** Make the journal folder
      read-only (`chmod 500 Journal`), run `New journal entry`, type something.
      Expect a notice and your text still on screen. Restore with `chmod 700`
      and type one more character — it should then commit.

- [ ] **Deleting an entry reaches the trash.** Delete an entry from its `⋯`
      menu, then check wherever Obsidian's trash setting points. The file must
      be recoverable, not gone.

- [ ] **Restarting Obsidian preserves everything.** Write a few entries, quit
      Obsidian completely, reopen. All present, same order, same text.

---

## Session B — desktop, ordinary use (~20 min)

- [ ] **Same-second entries.** Run `New journal entry` twice within one second
      and type in both. Two files, the second suffixed `-2`, neither
      overwritten, and the later one sits above the earlier in the timeline.

- [ ] **Editing from another pane updates the journal.** Open an entry's source
      file beside the journal and type there. The timeline entry updates within
      about a second.

- [ ] **And the reverse does not loop.** Type in the timeline for thirty
      seconds. Focus never jumps, text never resets, and the console shows no
      repeating event storm.

- [ ] **An externally changed timestamp repositions the entry.** Edit an
      entry's `created` property in its source file to a date two weeks back.
      It moves to that day, in the right position within it.

- [ ] **A new entry on a day between two loaded days lands in the middle.**
      Create a file by hand under `Journal/YYYY/MM/` dated between two days
      already on screen. Its day group appears between them, not at the top.
      *(This was broken until recently — a fix landed and is worth confirming.)*

- [ ] **Deleting an entry updates the timeline.** Delete an entry file from the
      File Explorer. It disappears, and its day header goes too if it was that
      day's last entry.

- [ ] **Journal folder rename.** Rename the `Journal` folder from the File
      Explorer, then update the setting to match. Entries still appear.

- [ ] **Go to today.** Scroll deep into the past, run `Go to today`. The view
      returns to the top.

- [ ] **Loading older entries does not disturb scroll position.** Scroll down
      until a page loads. What you were reading does not jump.

- [ ] **A focused editor keeps focus and its text when scrolled out of view.**
      Start typing in an entry, scroll it well out of view without pausing,
      scroll back. Text intact.

- [ ] **Unicode and Turkish characters.** Type
      `İstanbul'da yağmur yağıyordu — ışıklar süzülüyordu 🌧️` into an entry.
      Reopen the file: byte-identical.

- [ ] **Wikilinks and Markdown survive.** Type `[[Some Note]]`, a list, a code
      fence, bold and italics. All render, the link resolves, and it shows up in
      the target note's backlinks.

- [ ] **An entry is an ordinary note.** Confirm one appears in Search, in the
      graph, in Properties, and in a Dataview or Bases query over the folder.

- [ ] **Live preview in a timeline entry.** Markdown renders as you type,
      exactly as in any other note in Live Preview mode.

- [ ] **`[[` autocomplete in a timeline entry.** Already confirmed against a
      probe embed during the API spike; this is the same check inside a real
      mounted entry.

- [ ] **Escape in the composer, with vim mode on.** Turn on Vim key bindings
      (Settings → Editor), run `New journal entry`, type nothing, press Escape.
      Then do it again with the caret in an ordinary entry's editor, in insert
      mode. Write down what happens in each case. *(Unverified, and not
      knowable from the source: the composer's Escape handler sits on the
      view's keymap scope, and whether CodeMirror's vim keymap consumes the
      key before Obsidian's scope stack reaches that handler is Obsidian's
      decision, not this plugin's. If vim consumes it, a vim user simply
      leaves insert mode and the composer stays open — nothing is lost. If it
      does not, a vim user gets the composer closed where they expected normal
      mode. Either answer is worth recording; the second one is a product
      question to reopen, not a bug to patch blind. Nothing is at risk of
      being lost either way: Escape never closes a composer holding text.)*

- [ ] **What Escape does with no composer open must not have changed.** Open
      the journal in a tab that already had a note in it, press Escape with
      nothing being composed. Obsidian should navigate back to that note,
      exactly as it did before this handler existed. *(That "goes back to the
      previous note" is the observed behaviour reported from a real vault —
      not "the journal view closes", which is what it looks like and what an
      earlier commit message wrongly said. The handler returns a non-`false`
      value in this case precisely so Obsidian's own behaviour, whatever it
      turns out to be, is left alone; this check is what proves the fall-through
      works rather than the view scope swallowing the key unconditionally.)*

- [ ] **An entry cannot be renamed from the timeline.** Confirm there is
      nothing focusable or editable in an entry that would rename the file.
      Renaming from the File Explorer still works normally.

---

## Session C — a real phone or tablet

**Nothing in the mobile code has ever run on a device.** The keyboard-scroll
correction, the long-press menu and the touch targets were written by reasoning
from documented behaviour, and the two timings in them — 300 ms for the
keyboard, 500 ms for the long press — are guesses, not measurements.

That caveat has teeth: diagnosing one focus race on desktop took six attempts,
four of which shipped without changing anything, because the real ordering was
not knowable from the source. A keyboard opening on a real device is less
predictable than that, not more.

- [ ] **The keyboard does not cover the entry being edited.** Tap an entry near
      the bottom of the screen. When the keyboard opens, the caret stays
      visible.

- [ ] **A long entry keeps its caret visible above the keyboard.** Same, with
      an entry taller than the visible area. This is the case the correction
      exists for, and the one most likely to fall short.

- [ ] **Long-press opens the actions menu.** Long-press an entry's timestamp
      area. The menu appears. Does 500 ms feel right next to the platform's own
      long-press, or noticeably fast or slow?

- [ ] **Tapping an empty calendar day does nothing at all** — no flash, no
      highlight, no navigation.

- [ ] **Calendar tap targets.** Day cells land near 50px square in a
      phone-width sidebar. Comfortable, or fiddly?

- [ ] **Paging works.** Scroll into the past; older entries load without
      stutter.

- [ ] **Entry body touch targets.** Tapping an entry places a caret reliably,
      without needing precision.

- [ ] **Investigation, not a test:** does `window.visualViewport` fire `resize`
      when the keyboard opens, on both iOS and Android? It was deliberately
      left unused rather than guessed at. If it fires reliably on both, a
      future pass could scroll the caret itself into view above the keyboard
      instead of scrolling the whole entry — which is a no-op once the entry
      already fills the screen, exactly the long-entry case above.

---

## Session D — themes, contrast, screen reader

- [ ] **Minimal theme parity.** With Minimal active, watch an entry as its
      editor mounts and unmounts. Font, size and weight must not jump between
      the static render and the editor, and no title or properties panel may
      appear. *(Minimal sets `--font-weight` and scopes some styles to
      `.markdown-preview-view`, which this plugin deliberately does not add —
      so this is the theme most likely to disagree.)*

- [ ] **One other community theme** renders the timeline acceptably.

- [ ] **The timestamp still reads as a timestamp.** It is a real `<button>`
      with eleven of Obsidian's button properties overridden. Under a theme, at
      rest and on hover, it must still look like plain muted text — not a
      filled chip. If a chip appears, that theme's hover rule outranks ours.

- [ ] **A hovered empty calendar day paints nothing.** No background, no
      cursor change. *(The rule that suppresses this is inert if Electron never
      painted it — either answer is useful.)*

- [ ] **Keyboard focus is visible.** Tab into the calendar: only days with dots
      take focus, each showing a clear ring. Tab to an entry's timestamp: same.
      Check the first and last entry, where a ring could be clipped.

- [ ] **Windows high contrast.** With forced-colors active, a focused calendar
      day and a focused timestamp both still show an outline.

- [ ] **Screen reader.** With VoiceOver or NVDA: an enabled calendar day reads
      as its full date plus "has entries. Open in journal."; a disabled day as
      its full date plus "no entries"; today additionally as the current date.
      Check a disabled day in browse or rotor mode, not only via Tab — that is
      the path that skips it.

---

## Session E — the editor's resize behaviour

These only reproduce in a real window: jsdom reports every element's height as
zero, so the automated suite deliberately does not exercise them.

Each is about the plain-text fallback editor, which is what runs if the internal
embed API is ever unavailable — so it is worth knowing it behaves, even though
the embedded editor is the normal path.

Some of this is now automated. `textareaEditor.resize.test.ts` fakes just
enough layout — whether the element is laid out, and what height it reports — to
drive the real resize decision, including the asymmetry it is built around:
scrollHeight can prove content grew but never that it shrank. The shrink cases
below are still worth doing by hand, because the stub models that asymmetry from
reasoning rather than measurement; but they are no longer the only thing
standing between a regression and a user.

- [ ] **An external edit that shrinks content shrinks the box**, with no
      leftover blank gap.
- [ ] **Undo after typing several lines** shrinks the box as lines go.
- [ ] **Typing or pasting over a multi-line selection** shrinks it immediately.
- [ ] **A multi-line paste into a one-line entry** grows it immediately.
- [ ] **IME composition** near a line wrap resizes correctly while composing
      and again on commit.
- [ ] **Dragging the split divider** re-wraps text and grows the entry; no
      clipped lines. Widen again and it shrinks back.
- [ ] **Mounting while the tab is in the background:** switch away, shrink an
      entry's content from another pane, switch back. Correctly sized already,
      not clipped or stale.

- [ ] **Force the fallback once.** Temporarily make `hasEmbeddedEditorApi`
      return `false`, rebuild, reload. A notice appears once, entries are
      editable as plain text, saving still works. Revert afterwards. This is
      the path that keeps the plugin usable if a future Obsidian release
      changes the internal API, and it has never been exercised in a real
      window.

---

## Session F — the slow ones

- [ ] **Scrolling past unedited entries touches zero files.** Scroll through a
      few hundred entries without editing. No writes should occur — check file
      modification times afterwards.

- [ ] **The mount margins feel right.** Do entries become editable early enough
      as you scroll, without the plugin mounting far more than it needs?

- [ ] **A save failure is visible, and recovery works.** Make one entry's file
      read-only, type into it, wait. A "not saved" marker appears next to its
      timestamp and the text stays on screen. Restore permissions, type once
      more: the marker clears and the text persists.

- [ ] **The recovered entry becomes evictable again** — scroll it far out of
      view afterwards and it unmounts normally.

- [ ] **A composer closed mid-reload logs its text.** Type meaningful text into
      a fresh composer, trigger an unrelated reload (change the journal folder
      in settings), and close the Journal tab before the rebuild finishes. The
      console should show exactly one "discarding unsaved text" line. This is
      the last unverified branch of the composer's persist-or-log guarantee.

---

## Session G — mentions

Every one of these is new and none has run in a real Obsidian. Two of them are
not "does the feature work" but "is an assumption the code rests on actually
true" — those are marked as such, and the answer is worth writing down here
either way, because nothing in the suite can settle them.

- [ ] **Assumption, not a feature: frontmatter links count.** Give a note
      `people: "[[Ekin Arslan Aytaç]]"` in its frontmatter and nothing in its
      body. It must appear in Ekin's mentions panel. `mentionQuery.test.ts`
      pins only what the plugin does *with* a `resolvedLinks` map, never what
      Obsidian puts into one, so this is the sole evidence that a frontmatter
      link is a mention at all. If it fails, the documented fallback is an
      explicit `cache.links` + `cache.embeds` + `cache.frontmatterLinks` scan
      resolved through `getFirstLinkpathDest` — one function, one module.

- [ ] **Embeds and aliases count.** `![[Ekin Arslan Aytaç]]` and
      `[[Ekin Arslan Aytaç|Ekin]]` both appear. Same reasoning as above: the
      plugin never distinguishes them, but that they all reach `resolvedLinks`
      is Obsidian's behaviour, not ours.

- [ ] **The very first switch into reading view shows the panel.** Not the
      second, not after a tab switch: the first. This was a real bug, found in
      a real vault and not by the suite — Obsidian builds the reading pane
      *after* the workspace event fires, so the footer looked for a sizer that
      did not exist yet and, correctly, mounted nothing; nothing then re-asked
      until some unrelated event happened to fire. The footer now waits for the
      element instead of guessing when it arrives, so watch specifically for a
      note that switches into reading view with no panel and grows one a while
      later. Do it on a cold pane (a note not opened this session) and on a long
      note, where the pane takes longest to build. Then switch back to live
      preview and in again a few times: still exactly one panel each time.

- [ ] **Assumption, not a feature: do both view panes exist at once?** Turn on
      "Show mentions under notes", open a mentioned note, and switch between
      live preview and reading view several times. The panel must appear in
      both, exactly once, at the end of the note's content, scrolling with it.
      *Then look at the DOM*: does the view hold both `.markdown-source-view`
      and `.markdown-reading-view` simultaneously with one hidden, or does it
      replace one with the other? The footer now picks its sizer by
      `getMode()`, so it is correct either way — but a `querySelector` over
      both class names at once was the original implementation, and it would
      have mounted into the hidden pane. **Write the answer down here.** It
      decides whether that whole class of bug is live in this codebase.

- [ ] **Assumption, not a feature: does CodeMirror tolerate a foreign child of
      the sizer?** In live preview, with the footer showing, type into the note
      — several paragraphs, enough to make CodeMirror re-measure and rebuild.
      The footer must still be there afterwards, still last, still scrolling
      with the text. Then scroll a long note (a few hundred lines) to the
      bottom and back: the scroll position must not jump and the note must not
      end in a band of dead space. `sync()` only re-checks the footer's parent
      on workspace events, so a removal CodeMirror does on its own is invisible
      until the next tab switch — and CM measures heights for its own
      viewport, which the appended div is not accounted for in. If either half
      fails, the fix direction is reading view only for the footer, and the
      code block for live preview.

- [ ] **The padding cap still finds its target.** The rule that trims the
      editor's click-past-the-text space under a footered note used to select
      with `.cm-sizer:has(> .journal-mentions-footer)`; it now reads a class
      `mentionsFooter.ts` writes on the sizer, so that the `:has()` is not
      matched against every editor in the app. Unit tests pin the class going
      on and coming off; only a running vault shows the cap itself. In live
      preview, on a short mentioned note: the panel sits a few lines under the
      text, not most of a screen below it. Then switch the same note to
      reading view and back, and turn "Show mentions under notes" off — with
      no footer, the click-below-to-write space must be back to full, not
      still capped. A cap that outlives its footer is the one way this can be
      wrong that the old selector could not be.

- [ ] **`Search journal` opens at all.** The one thing no fake proves: that
      the command is registered, that `openJournal()` resolves, and that a
      `SuggestModal` appears. Every branch behind it is unit-tested; this is
      the glue. Run the command from the palette on the real vault.

- [ ] **Search finds what you remember, in your own language.** Write an entry
      containing `İstanbul` and another containing `Işık`. Search `istanbul` —
      the first must appear. Search `ışık` — the second must, and so must one
      written `IŞIK`. Then, with an entry containing `açık` in the journal,
      search `acik`: it must NOT appear. That is the folding decision working
      in both directions, and no unit test can prove the keyboard produces the
      characters you think it does.

- [ ] **Both exits do different things.** Search a word that several entries
      share. Choose one result: the timeline lands on that entry with older
      entries below it and NO filter — scroll up and the newer ones are still
      there. Search again and choose "Show all": now only matches are shown
      and the bar names the query in quotes. Escape, or the bar's ×, puts the
      whole journal back.

- [ ] **The excerpt is legible in both themes.** In light and dark, the
      matched word reads as emphasised without the row looking striped, and a
      long entry's excerpt stays on one line with an ellipsis rather than
      wrapping.

- [ ] **A search over the real journal feels immediate.** Not "is fast in a
      test" — open the command on the actual vault and type. If the first
      keystroke stutters, the snapshot read is the suspect and the fix
      direction is the incremental index named in `CLAUDE.md` § Search.

- [ ] **Search on a phone.** The suggester is Obsidian's own, so the keyboard
      and the list are its problem. The row layout is ours: confirm the
      timestamp and the excerpt share one line at phone width rather than the
      excerpt collapsing to nothing.

- [ ] **The footer is absent on journal entries.** Open an entry as an ordinary
      note. No panel — its own timeline already shows this, and a panel there
      invites the recursion the code block has to guard against.

- [ ] **Turning either setting off removes its surface immediately**, with no
      reload. Off must mean gone, not "gone after a restart".

- [ ] **Collapsing the footer holds, everywhere and across a restart.** Click a
      footer's header: the entries go, the header and its count stay, the
      chevron turns. Open a second mentioned note in a split — its footer must
      already be folded too, not still showing entries. Reopen Obsidian: still
      folded. Then expand, page in with **Show more**, fold and unfold: the
      pages you had asked for must come back, not the first five. Do it in live
      preview as well as reading view — there the header sits inside
      CodeMirror's own scroller, where a click could in principle be taken for
      a click into the document. Only the
      footer folds — the sidebar panel and a `simple-journal` block stay put
      through all of it. Tab to the header and press Enter and Space: both must
      work, and the focus ring must be visible in your theme.

- [ ] **A nested block does not recurse.** Put a `simple-journal` block inside
      a journal entry, then view a note that entry mentions. The panel shows the
      entry with an inert placeholder where its block is, and Obsidian does not
      hang. *(The guard asks whether the block's element sits beneath a
      `.journal-mentions` ancestor, which assumes the element is already
      attached when its processor runs. True under jsdom; not knowable from the
      API. If it ever nests, the fix direction is a depth signal passed down
      the render.)*

- [ ] **Changing the Journal folder setting repaints an open sidebar panel.**
      This was a real bug — `rebuild()` emits nothing to `onChange` by design,
      and the view short-circuited on the active file, so the panel kept showing
      mentions computed against the old folder. Fixed and unit-tested; worth one
      confirmation with real leaves.

- [ ] **Mobile — unverified, like the rest of the mobile code.** See
      `CLAUDE.md`'s `# Target Platforms`. The footer's sizer lookup in
      particular has never run on a device, and by design it fails silently: if
      it finds nothing it does nothing, with no notice and no console line. So
      on a phone a failure looks exactly like the setting being off. Check the
      setting first, then the DOM.
