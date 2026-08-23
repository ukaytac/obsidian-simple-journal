# Manual test checklist

Checks that need a real Obsidian instance, because they depend on real vault,
UI, focus, timing, or rendering behaviour that the unit tests' mocks and
pure-logic extraction can't observe. Run this list against a scratch vault
before every release, on desktop and on mobile.

**Checks still open are collected in `docs/manual-testing-open.md`**, grouped
into sessions by what each needs — a desktop, a phone, a theme, a screen
reader. This file and the editor one keep the reasoning and the record of what
has already been verified; that one is the working list.

See also `docs/manual-testing-editor.md` for checks scoped to the two
`EntryEditor` implementations themselves (`TextareaEditor` resize behaviour,
and `ObsidianEmbedEditor`'s external-write and editing-fidelity questions).
Everything else — timeline, mount window, composer, entry actions, saving,
and vault events — lives here.

## Fixed: the composer opened without the caret in it

With the Journal tab **closed**, from any other note, the `New journal entry`
hotkey opened the journal but left the caret elsewhere. From the Journal tab
itself the same command worked.

Root cause: `openComposer` focuses the composer and it **does** receive focus,
on the first frame — a live trace showed `editorHasFocus: true`,
`activeTag: 'TEXTAREA'`. Something takes focus away shortly afterwards, most
likely one of the timeline's own embedded editors, since
`ObsidianEmbedEditor.mount` calls the embed's `showEditor()` and Obsidian
focuses the editor it builds, one per loaded entry. The retry loop treated
*currently holding focus* as success and stopped watching at exactly the moment
it needed to start.

Fix (`dac8f26`): input is the only success condition. The loop keeps watching
until its deadline and retakes focus whenever it is lost, stopping on input, on
the composer being replaced or gone, or on the view closing. Pinned by a
mutation-verified test — the suite passed at every wrong step before it,
including the version that quit after the first success.

Two other real bugs were found and fixed while chasing this, neither of which
was the cause: a reload could sweep away an open composer (`clearTimeline` now
snapshots it and `reloadNow` re-establishes it, giving the composer a complete
persist-or-log story), and the blur-discard fired on a stolen focus (now gated
on input received rather than on having been focused). Both are worth keeping;
neither moved the caret.

**Do not re-derive the history from this section** — the full account of what
each of the six attempts believed, and why four of them shipped without
changing anything, is in *Case study: the composer that opened without a
caret* below. It is there for its process lessons, not its narrative.

- [ ] **A composer closed mid-reload with meaningful text logs it.** Not
      unit-testable without a real Obsidian instance: type meaningful text
      into a fresh composer, trigger a reload that has nothing to do with it
      (e.g. change the journal folder in settings) so it is still rebuilding,
      and close the Journal tab before that rebuild finishes. The developer
      console should show exactly one "discarding unsaved text" line —
      `reestablishComposer` logs it directly when the view closed before it
      could re-establish the composer into the fresh timeline.
- [ ] **A re-established composer does not steal focus back from another
      pane.** Open a composer, type nothing (or something), then — while a
      reload is happening (a folder rename, a settings change) — click into a
      different pane before the rebuild finishes. Focus should stay wherever
      it was clicked, not jump back to the reappearing composer.
      `openComposer`'s `preserveExternalFocus` guard checks
      `contentEl.doc.activeElement` right before refocusing; confirm it holds
      in a real window (including a popout leaf, per `contentEl.win`'s own
      existing cross-window reasoning).
- [ ] **The same guard's *ordinary* case — nothing else has taken focus,
      refocusing the reappearing composer is correct — actually refocuses it
      in real Obsidian, not just in jsdom.** The harness tests for this pass
      because destroying the old, focused composer's plain `<textarea>` in
      jsdom leaves `document.activeElement` as `body`, which
      `preserveExternalFocus` reads as "nothing else has claimed it." Real
      Obsidian's own DOM teardown/remount timing for a live pane may differ,
      and if the journal ever mounts entries through `ObsidianEmbedEditor`
      rather than the `TextareaEditor` fallback, that embed remounting during
      the same rebuild could plausibly hold `activeElement` itself for a
      stretch — which would read as "something else claimed it" and suppress
      a focus restore the user did want. Reload the journal with a composer
      open and nothing else focused, and confirm the composer still ends up
      focused afterwards, on both the fallback and (if available) the
      embedded editor.

## Fixed: list markers were missing from every entry

A bullet list in an entry rendered as bare lines — no marker, no indent, flush
with the surrounding paragraphs. Found while shooting the README screenshot, not
by this checklist, which is the part worth noting: **"Markdown formatting remains
intact — type a list"** under *3. Content fidelity* was already here and had been
ticked. Bold, italics and headings look identical whether or not the reset below
is in play, so a pass on those read as a pass on the list too. That item now says
what to look at instead of what to type.

Root cause: `.cm-line` was inside the `padding: 0 !important` reset in
`styles.css`. Obsidian positions a live-preview bullet with an **inline**
`padding-inline-start` on the list line; an `!important` author declaration
outranks a normal inline one, so the indent went to zero, and the line's own
negative `text-indent` — untouched, because the reset never covered it — then
carried the marker out of view.

Fix: split the axes. `.cm-line` keeps `!important` on `padding-block` (the
measured opponent there is a `padding-top` on `HyperMD-header` at (0,10,0)) and
drops to a plain `padding-inline: 0`, which still outranks CodeMirror's injected
base at (0,1,0) but loses to anything Obsidian sets inline — which is what it
must do. Naming the cases instead (`:not(.HyperMD-list-line)`) was rejected:
`HyperMD-*` is undocumented internals, and CLAUDE.md confines those to the
editor-embed exception.

Verified on desktop in both themes, from the README capture itself
(`docs/images/simple-journal-screenshot-{light,dark}.png` — the light one is the
same frame that first showed the bug):

- [x] the marker is visible and the text is indented past it
- [x] a nested level indents further than its parent, not to the same column
- [x] blockquote text sits clear of its left border

One case is still open, because the demo entries the capture was shot from carry
no task line — a checklist inside a journal entry read as filler, so it came out:

- [ ] task lines show their checkbox, and it is clickable

Mobile is unverified for all four.

## Not a bug: ribbon order

The order of `Open journal` and `New journal entry` in the ribbon — and in the
`...` menu on mobile — is not something this plugin can set. `addRibbonIcon` is
the only ribbon API and it appends; there is no position argument and no
reordering API, and reaching past it would mean rearranging other plugins'
items too.

It is a user setting instead: Obsidian's Appearance settings allow ribbon items
to be dragged into any order, on both desktop and mobile. On mobile the same
settings also assign a **quick action** fired by a short press, which reaches
`New journal entry` in one tap without opening the menu at all — likely a
better answer than reordering for the capture flow this plugin is built around.

## Run these first

Five checks, in order. Each one closes an assumption that three rounds of code
review could not settle by reasoning, and the first two are in the data-loss
class. If any of them fails, stop and report it — the rest of this document is
mostly cosmetic by comparison.

- [x] **1. Does the embedded editor reload its own buffer under a write?** — **PASSED**, 19 Aug 2026, Obsidian 1.8.9 desktop. Typed continuously while changing the entry's time; no characters lost. The `onFileChanged` neutralisation holds, which three review rounds could not settle by reasoning.
      This is the plugin's single biggest unverified assumption.
      `ObsidianEmbedEditor` neutralises the embed's `onFileChanged` so that only
      this plugin writes and only this plugin decides when the buffer changes.
      Whether that neutralisation actually holds cannot be reasoned about — the
      embed may capture its own handler at construction, or reload through
      another route.

      `Change entry time` is the sharpest probe, because it is the only path
      that deliberately rewrites frontmatter under a mounted editor *without* a
      self-write mark. Type into an entry, and **without pausing**, use
      `Change entry time` to move it a few minutes, then keep typing. Open the
      file afterwards: every character you typed is present. Any gap means the
      embed self-reloaded and a poll tick read the reload as an edit.

- [x] **2. Does throwing inside `vault.process` really leave the file alone?** — **PASSED**, 19 Aug 2026. `Change entry time` on a file whose frontmatter holds a multi-line string containing a false `created:` line was refused with `UnsafeFrontmatterError`, and the file was byte-identical afterwards (md5 `ed8963f8178c0949df70633b06041279` before and after). This settles the assumption the whole refusal mechanism rests on: a throw inside the `vault.process` callback writes nothing.
      The whole refusal mechanism rests on it. Obsidian documents `process` as
      consuming the callback's return value, so a throw should write nothing —
      but "should" is not "does", and the failure mode is the guard destroying
      the file it exists to protect.

      Put a note in the journal folder whose frontmatter is:

      ```
      ---
      note: "hello
      created: bad"
      mood: calm
      ---
      Body text.
      ```

      Run `Change entry time` on it. Expected: a notice explaining the
      frontmatter is too complex, and the file **byte-identical** afterwards —
      `note` and `mood` both intact. A truncated or emptied file is a critical
      failure.

- [ ] **3. The write-echo race.** Type a long sentence steadily, without
      pausing, long enough that the debounced save reaches disk at least twice
      while you are still typing. Read it back: no characters dropped
      mid-sentence.

- [ ] **4. Minimal theme parity.** With the Minimal theme active, watch an entry
      as its editor mounts and unmounts. The font, size and weight must not jump
      between the static render and the editor, and no inline title or
      properties panel may appear.

- [ ] **5. Mobile, on a real device.** Nothing in the mobile code path has ever
      run on a phone or tablet. Focus an entry: the on-screen keyboard must not
      cover it. Long-press an entry: the actions menu opens. Scroll: older
      entries load.

## Calendar — needs a running Obsidian, a device, or a screen reader

None of this is settleable from source, and `CalendarView` has no DOM test
harness (only `calendarGrid.ts` is unit tested), so nothing below is
regression-guarded.

- [ ] **A hovered empty day paints nothing.** Move the pointer over a day with
      no dot. No background highlight, no cursor change, no outline. (The rule
      that suppresses it is inert if Electron never painted the highlight in
      the first place, so this costs nothing either way — it is worth knowing
      which.)
- [ ] **Keyboard focus is visible.** Tab into the calendar. Only days with dots
      receive focus, and each shows a clear ring.
- [ ] **Windows high contrast.** With forced-colors active, a focused day still
      shows an outline rather than nothing.
- [ ] **A community theme does not restore the chip.** With a theme active,
      day cells still read as plain numbers at rest and on hover. If one paints
      through, its hover rule outranks ours and the fix is a scoped
      `!important` inside `.journal-calendar-days`.
- [ ] **Screen reader.** With VoiceOver or NVDA: an enabled day reads as its
      full date plus "has entries. Open in journal."; a disabled day reads as
      its full date plus "no entries"; today additionally reads as the current
      date. Check a disabled day in browse or rotor mode, not only via Tab —
      that is the path that skips it.
- [ ] **Tap targets on a phone.** Day cells land near 50px square in a
      phone-width sidebar. Confirm they are comfortable, and that tapping an
      empty day does nothing at all rather than flashing.

## Case study: the composer that opened without a caret

Worth reading before diagnosing anything in this view. It took six attempts,
four of which shipped to the user and changed nothing, and the reason is a
process failure rather than a hard bug.

**The report.** With the Journal tab closed, the `New journal entry` hotkey
opened the journal but left the caret somewhere else. From the Journal tab
itself the same command worked.

**What each attempt believed, and what was actually wrong with it:**

1. *Focus is stolen during leaf activation, and the blur discards the composer.*
   The cause was right. The gate was wrong: it asked "was this ever focused",
   but focus **does** land before it is stolen, so the gate opened anyway.
2. *The first load sweeps the composer away.* A real bug, found by the harness
   and fixed — but not this one.
3. *`clearTimeline` destroys the composer on every reload.* Also a real bug,
   also fixed, and it earned the composer a complete data-safety story — but
   not this one either.
4. *Gate the discard on input rather than focus.* This one made the composer
   **appear**. Still no caret.
5. *`preserveExternalFocus` suppresses the focus of a re-established composer.*
   Reproduced in the harness and fixed. Tracing later showed
   `reestablishComposer` runs with a **null** snapshot on this flow, so this
   path was never the bug — two attempts spent on a road not taken.
6. *The retry loop stops watching at the first success.* This was it. The
   composer receives focus on the first frame and loses it shortly after, to
   one of the timeline's own embedded editors mounting. Treating "holds focus
   now" as success meant the loop quit at exactly the moment it needed to
   start. Input is the only success condition.

**The lessons, in the order they cost the most:**

- **Instrument before hypothesising, when a bug reproduces by hand but not in
  the harness.** One trace answered in a single round what four hypotheses
  could not. The first trace was added at attempt four.
- **Do not remove instrumentation until the fix is confirmed by the person who
  reported it.** It was removed once after a fix that turned out to be for a
  different bug, and had to be rebuilt.
- **Trace the whole path, not the part you suspect.** The first trace covered
  only the new-entry command, so "the journal opens but nothing logs" could not
  distinguish our command from any other route that opens it.
- **The same wrong assumption usually appears more than once.** "Was it ever
  focused" was the wrong question in *two* places — the discard gate and the
  retry gate. Fixing one and not auditing for the other cost a whole round.
- **A green suite proved nothing here.** All 401 tests passed at every wrong
  step, including the version that stopped watching after the first success.
  Which is why the retake behaviour is now pinned by a mutation-verified test.

## Coverage against CLAUDE.md's 21 testing priorities

| # | Case | Automated | Manual |
| - | --- | --- | --- |
| 1 | Create one entry | ✅ `entryRepository.test.ts` | — |
| 2 | Several entries same day | ✅ `entryRepository.test.ts`, `entryIndex.test.ts` | — |
| 3 | Entries within the same second | ✅ `entryRepository.test.ts` (collision suffix) | ✅ §1 Same-second entries |
| 4 | Entries across multiple days | ✅ `entryRepository.test.ts`, `entryIndex.test.ts` | — |
| 5 | Entry with valid `created` | ✅ `entryDate.test.ts`, `entryRepository.test.ts` | — |
| 6 | Entry without `created` | ✅ `entryDate.test.ts` | — |
| 7 | Entry with malformed `created` | ✅ `entryDate.test.ts`, `entryRepository.test.ts` | — |
| 8 | Entry with arbitrary frontmatter | ✅ `markdownDoc.test.ts`, `entryRepository.test.ts` | — |
| 9 | Editing does not destroy frontmatter | ✅ `markdownDoc.test.ts`, `entryRepository.test.ts` | ✅ §2 Frontmatter survives editing |
| 10 | Editing from another pane updates the journal | ✅ `journalService.test.ts` | ✅ §4 Editing from another pane |
| 11 | Deleting an entry updates the timeline | ✅ `journalService.test.ts` | ✅ §4 / §7 promptForDeletion |
| 12 | Restarting Obsidian preserves everything | — | ✅ §2 Restart persistence |
| 13 | Empty composer creates no garbage file | ✅ `composerCommit.test.ts` | ✅ §2 Empty composer |
| 14 | Unicode and Turkish characters | ✅ `entryRepository.test.ts` | ✅ §3 Unicode |
| 15 | Wikilinks remain valid | ✅ `entryRepository.test.ts` (byte round-trip) | ✅ §3 Wikilinks (rendering/backlinks) |
| 16 | Markdown formatting remains intact | ✅ `entryRepository.test.ts` (byte round-trip) | ✅ §3 Markdown formatting (rendering) |
| 17 | Days ordered newest → oldest | ✅ `entryIndex.test.ts`, `entryRepository.test.ts` | — |
| 18 | Entries within a day ordered newest → oldest | ✅ `entryIndex.test.ts`, `entryRepository.test.ts` | — |
| 19 | New entry appears at the top | ✅ `entryIndex.test.ts`, `applyChange.test.ts` | ✅ §1 New entry at the top |
| 20 | External timestamp change repositions the entry | ✅ `journalService.test.ts` ("moved") | ✅ §4 Externally changed timestamp |
| 21 | Loading older entries preserves scroll position | — | ✅ §1 Loading older entries |

Every priority has at least one covering layer. **12 and 21 are manual-only**
— a real app restart and real scroll-anchoring physics can't be simulated in
the Vitest/jsdom environment. Everything else has automated coverage of its
pure logic (ordering, parsing, frontmatter splitting, debounced event
handling) plus a manual check of the corresponding real-Obsidian-rendered
behaviour (search/backlinks/graph, live preview, the actual save/trash APIs).

---

## 1. Creating, ordering, and paging

- [ ] **Same-second entries.** Run **New journal entry** twice within one
      second and type in both. Two files exist, the second suffixed `-2`, and
      neither overwrote the other.
- [x] **New entry appears at the top.** — verified 19–20 Aug 2026, Obsidian 1.8.9 desktop. The composer opens under today's header above every existing entry, and a committed entry (`Journal/2026/08/2026-08-18-18-12-21.md`) was written with the right filename, a single quoted `created`, and no heading. Run **New journal entry** and type.
      The entry appears above every other entry from today.
- [ ] **Loading older entries does not disturb scroll position.** Scroll down
      until a page of older entries loads. The content under the cursor does
      not jump.
- [ ] **Go to today.** Scroll far into the past, run **Go to today**. The view
      returns to the top.

## 2. Data integrity and persistence

- [ ] **Frontmatter survives editing.** Add `mood: calm` and `tags: [journal]`
      to an entry's frontmatter by hand. Edit the entry's body from the
      timeline. Both properties are unchanged, in the same order.
- [ ] **Restarting Obsidian preserves everything.** Write several entries,
      quit Obsidian completely, reopen. Every entry is present, in the same
      order, with the same text.
- [ ] **Empty composer creates no file.** Run **New journal entry**, type
      nothing, click away. No file appears anywhere in the vault.
- [ ] **A committed entry is never auto-deleted.** Write an entry, then delete
      all of its text. The file still exists.
- [ ] **Frontmatter delimiter with trailing whitespace.** Open question since
      an early task: `splitFrontmatter`'s opening/closing `---` delimiters
      must match exactly (`/^---\r?\n/`), so a delimiter line with trailing
      spaces (`---   \n`) is treated as *not* frontmatter — the whole document
      becomes body. By hand, add trailing whitespace after an entry's opening
      or closing `---` (e.g. via a plain text editor outside Obsidian), then:
      check whether Obsidian's own Properties panel still recognises the
      block as frontmatter, and then edit that entry from the timeline and
      confirm whether the `created` property survives or gets silently
      swallowed into the body. If Obsidian itself tolerates the trailing
      whitespace, `splitFrontmatter`'s regex needs to as well.

## 3. Content fidelity

- [ ] **Unicode and Turkish characters.** Type
      `İstanbul'da yağmur yağıyordu — ışıklar süzülüyordu 🌧️` into an entry.
      Reopen the file: the text is byte-identical.
- [ ] **Wikilinks remain valid.** Type `[[Some Note]]` in an entry. It renders
      as a link, resolves on click, and appears in the target note's
      backlinks pane.
- [ ] **Markdown formatting remains intact.** Type a bullet list, a nested
      bullet under it, a task line, a blockquote, a code block, a heading, bold,
      and italics. Check the parts that only lists have: the **marker is
      visible**, the text is **indented past it**, the nested level indents
      further, the checkbox renders and toggles, and the quote's text clears its
      border. Bold and headings render the same whether or not the `.cm-line`
      reset is misconfigured, so they prove nothing on their own — see *Fixed:
      list markers were missing from every entry*. The raw file contains
      ordinary Markdown.
- [ ] **The entry is an ordinary note.** The entry appears in Search, in the
      graph, and in Properties. A Dataview or Bases query over the journal
      folder finds it.

## 4. External vault changes

- [ ] **Editing from another pane updates the journal.** Open an entry's
      source file beside the journal. Type in the source pane. The timeline
      entry updates within about a second.
- [ ] **The reverse does not loop.** Type continuously in the timeline for 30
      seconds. The editor never loses focus, the text never resets, and the
      developer console shows no repeated event storm.
- [ ] **Deleting an entry updates the timeline.** Delete an entry file from
      the File Explorer. It disappears from the timeline, and its day header
      disappears if it was that day's last entry.
- [ ] **Externally changed timestamp repositions the entry.** Edit an entry's
      `created` property to a date two weeks ago. The entry moves to that day,
      in the right position within it.
- [ ] **Journal folder rename.** `JournalService` cannot observe, from the API
      alone, whether Obsidian fires a `vault.on("rename")` event for every
      descendant file when a FOLDER is renamed, or only one event for the
      folder itself. `JournalService.rebuild()` is idempotent either way, so
      the folder-rename handler triggers it unconditionally rather than
      depending on the answer. Confirm the real behaviour:
  - [ ] **Rename the configured journal folder itself** (e.g. `Journal` ->
        `Journal2`) while the journal view is open, with a mix of entries
        loaded and scrolled past. The timeline reloads and shows every entry
        at its new location; nothing is duplicated, nothing silently
        disappears.
  - [ ] **Rename an ancestor folder that contains the journal folder.** Same
        expectation.
  - [ ] **Rename a subfolder inside the journal folder** (e.g.
        `Journal/2026` -> `Journal/2026-old`). Same expectation.
  - [ ] **Rename a folder unrelated to the journal folder** while the view is
        open. No reload happens (check the console for an unexpected full
        rebuild) and the timeline is undisturbed.
  - [ ] Repeat the first case while an entry is mid-edit (typing, not yet
        saved). The in-flight text is not lost — it's flushed to disk at the
        entry's new location before the timeline reloads.
- [ ] **First entry in a previously empty journal.** `insertEntryInPlace` (the
      path an "added" change takes, including the new-entry composer) is
      inline DOM/`IntersectionObserver` logic in `JournalView`, not covered by
      any unit test. Confirm by hand:
  - [ ] **Open the journal on a vault with zero entries.** The "No journal
        entries yet" message appears.
  - [ ] **Create the first entry** while that view stays open. The empty-state
        message disappears, the entry appears with the full live editor
        mounted — not static, dead-looking text — and typing into it works
        immediately.
  - [ ] **Create a second entry** shortly after. It appears above the first,
        also with a live editor, confirming the mount/paging observers set up
        on the empty timeline are still working normally rather than only
        working once by accident.

## 5. Timeline mount/unmount window

`JournalView`'s editor mount/unmount decision (`mountObserver`, an
`IntersectionObserver` rooted on the timeline pane) and the pure
selection/termination logic behind its `MAX_MOUNTED_EDITORS` backstop
(`src/views/mountWindow.ts`) are covered by `tests/mountWindow.test.ts` with
fabricated state. What that suite cannot cover is real scroll physics, real
focus/blur timing, and a real `IntersectionObserver` reacting to a real
layout — verify these by hand, with a vault of at least a few hundred entries
(enough to scroll well past `MAX_MOUNTED_EDITORS`, i.e. past 60 entries on
desktop or 25 on mobile).

- [ ] **Scroll past the cap and back; entries at the top are live again, text
      intact.** Scroll continuously downward until you're well past the mount
      cap (at most `MAX_MOUNTED_EDITORS` mounted `.journal-entry-embed`/
      `.journal-entry-textarea` elements at any point). Note the exact text of
      a couple of entries near the top, then scroll back up. Confirm: the
      entries at the top are directly editable again (not click-to-edit, not
      static Markdown), and their text is byte-for-byte what it was before —
      nothing lost or duplicated across the unmount → static → remount round
      trip.
- [ ] **Scrolling past unedited entries touches zero files.** Note the current
      modification time of twenty or so consecutive entries you have not
      edited this session. Scroll past all of them — enough to mount and then
      unmount each one — without typing anything. Confirm not one of their
      modification times changed. This is the check that would catch a
      regression of the spurious-write bug (`savedBody` no longer matching
      what the editor's `getValue()` reports as unchanged, e.g. a line-ending
      mismatch on a CRLF file).
- [ ] **A focused editor keeps focus and its text when scrolled out of view.**
      Click into an entry near the top, place the cursor mid-sentence, and
      without clicking away, scroll it out of the viewport and past
      `MOUNT_ROOT_MARGIN`. Confirm the entry does *not* revert to static
      rendering while it holds focus. Click elsewhere to blur it, then scroll
      back: it correctly unmounted after the blur, and its text — including
      whatever you typed before scrolling — was saved and is intact.
- [ ] **Does `focusout` fire for reasons other than "the user clicked a
      different entry"?** Two cases neither the automated suite nor a code
      read can settle: (1) does it fire when the whole Obsidian window loses
      OS-level focus (switching to another app); (2) does it fire when a
      CM6-internal popup takes focus (in-editor search, `[[` autocomplete)?
      Check by focusing an off-screen-eligible entry (scrolled near the
      `MOUNT_ROOT_MARGIN` edge), then (a) switch to a different application
      and back, (b) trigger the in-editor search panel or `[[` autocomplete
      and dismiss it, and in each case confirm the entry is still a live
      editor with focus afterward, not reverted to static text.
- [ ] **Do the `400px`/`900px` margins feel right?** With real scrolling
      (mouse wheel, trackpad, and — on mobile — a flick gesture), confirm an
      entry becomes editable *before* it's needed, and the number of
      simultaneously mounted editors at a normal scroll speed doesn't feel
      wasteful. Adjust `MOUNT_ROOT_MARGIN` in `JournalView.ts` if either feels
      off.

## 6. New entry composer

`JournalView.commitComposer` swaps the composer's plain `TextareaEditor` for
the real editor mid-keystroke — the file doesn't exist until the first
meaningful character, so nothing else can mount the embedded editor sooner.
Nothing automated can watch where the caret actually lands after that swap.

- [ ] **The swap doesn't eat a keystroke.** Run **New journal entry**, then
      type a sentence at a normal typing speed without pausing (fast enough
      that several characters land before the file is likely to have been
      created). Confirm every character you typed appears in order once the
      swap to the real editor completes.
- [ ] **The caret lands at the end, not the start.** Type a full sentence into
      a fresh composer (enough to trigger the file-creation swap), then
      immediately keep typing without pausing. Confirm the continuation
      appears **after** what you already typed, not at the beginning.
- [ ] **The swapped-in editor visibly has focus.** After the swap, confirm the
      blinking cursor is visible in the entry — check this with both the
      embedded editor available and, if you can force the fallback, the
      plain-textarea fallback too, since `focus("end")` is implemented
      separately in each.
- [ ] **Typed content survives a failed create.** If you can simulate
      `EntryRepository.createEntry` throwing (e.g. temporarily make the
      configured journal folder path invalid), type into a fresh composer and
      confirm: a Notice appears, the typed text is still visible in the
      composer, and typing further retries the create rather than silently
      dropping the text or duplicating the composer.
- [ ] **Capturing a new entry clears a stale anchor.** `startNewEntry`'s
      anchor-clearing check (`if (this.anchorDate !== null) await
      this.goToDate(null);`) is plain `JournalView` orchestration, not part of
      any pure, independently-tested module — this needs a live view. Anchor
      the timeline to an old month (there's no date picker yet, so call
      `view.goToDate(new Date(2024, 0, 1))` from the console, or temporarily
      invoke it from a debug command), then run **New journal entry** and
      type a sentence. Confirm: the composer appears at today's position (not
      buried under the old anchor), the entry is created normally, and then
      force an unrelated reload (toggle the journal folder setting, or call
      `plugin.refreshJournal()` from the console) — the entry you just wrote
      must still be visible afterward, not silently excluded because the
      anchor was still pointing at 2024.
- [ ] **Re-invoking while a composer is open doesn't touch the anchor.**
      Anchor to an old month, run **New journal entry** (this clears the
      anchor per the check above), then — while the composer is still open
      and uncommitted — run **New journal entry** again. Confirm it simply
      refocuses the same composer with no visible reload/flicker; this is the
      fast-path branch at the top of `startNewEntry`, which must return
      before ever reaching the anchor-clearing check.

## 7. Entry actions

`JournalView.confirmDelete` relies on `FileManager.promptForDeletion` to both
confirm the deletion and perform the trash. Its JSDoc documents only the
prompt and the returned boolean — that it also performs the deletion
afterward is real Obsidian behaviour, undocumented in `obsidian.d.ts`, so it
needs confirming once against a live vault rather than assumed from the type
signature alone.

- [ ] **Deleting an entry actually reaches the trash.** From the timeline,
      open an entry's actions menu (hover button or right-click on its
      chrome) and choose **Delete entry**. Confirm the prompt. Then check:
      the file is gone from its original location in the File Explorer, the
      row disappears from the timeline, and the file is present in whichever
      trash Obsidian is configured to use (`.trash/` in the vault, or the
      system trash/Recycle Bin).
      - **If the file is NOT actually trashed** — i.e. `promptForDeletion`
        only prompts and never performs the deletion — then `confirmDelete`
        needs its own explicit trash call after a confirmed prompt (e.g.
        `this.app.fileManager.trashFile(file)`), and `handleDeleteFallback`'s
        existence check would otherwise restore every deleted entry a moment
        later, defeating deletion entirely.

## 8. Saving

`JournalView.save`/`unmountEditor` only get one honest signal that a write
actually failed: the real filesystem. Fake it with permissions, not with a
mocked repository, so this exercises the real `Notice`, the real marker DOM,
and the real decline-to-unmount path together.

- [ ] **A failed write shows a persistent marker, and scrolling away and back
      does not lose the text.** Type in an entry, then — before the 500ms
      debounce fires — make its file read-only from a terminal:
      `chmod 444 "$VAULT/Journal/2026/08/<some entry>.md"`. Type once more and
      wait a second: a red **not saved** marker appears next to that entry's
      timestamp, the developer console logs the failure, and a transient
      `Notice` appears. Scroll the entry well out of view (past
      `MOUNT_ROOT_MARGIN`) and back. Confirm: the marker is still there, and
      the text you typed is still in the editor, unchanged — not replaced by
      the last-saved (pre-failure) disk content.
- [ ] **Restore and confirm recovery.** Restore permissions
      (`chmod 644 …`) and type once more in the same entry. Confirm the
      marker disappears and the file on disk now matches the editor.
- [ ] **The recovered entry becomes evictable again.** With many entries open
      (more than `MAX_MOUNTED_EDITORS`), repeat the read-only steps on one
      entry, then scroll it far away without restoring permissions — confirm
      it stays mounted even while many other entries compete for mount slots.
      Restore permissions and let a write succeed, then scroll far away again
      — confirm this entry can now be unmounted/evicted like any other.
- [ ] **Deleting an entry while its write is failing still leaves a
      recoverable trace.** Repeat the read-only setup (type, break
      permissions, type again, marker appears), then open that entry's
      actions menu and choose **Delete entry**, confirming the prompt. Before
      the row disappears, check the developer console: a `console.error` line
      names the entry's path and prints the exact text you typed. Restore
      permissions afterward.
- [ ] **Closing the journal with an unsent composer draft leaves a
      recoverable trace.** Run **New journal entry**, type something, then
      immediately close the journal view/tab before the composer commits to a
      file. Check the developer console for a `console.error` line labeled
      "uncommitted composer" with the text you typed. Confirm no empty or
      partial file was created in the journal folder.
- [ ] **Renaming a dirty entry's file re-keys the row instead of duplicating
      it.** Not exercised by the automated suite: the re-key touches
      `this.rendered`, `this.mountOrder`, and the element's `data-path`
      together — live `JournalView` instance state and real DOM. Repeat the
      read-only setup so the entry is dirty, then — from the File Explorer,
      NOT from the journal view — rename that entry's `.md` file to a
      different (still-valid) timestamp filename in the same folder. Confirm:
      exactly ONE row for it remains in the timeline (no duplicate), it still
      shows the text you typed, and it is still marked **not saved**. Restore
      permissions and type once more; confirm the marker clears and the file
      on disk (at its new name) now matches the editor.

## 9. Editing surface

- [ ] **Full editor features.** Inside a timeline entry: `[[` opens link
      autocomplete, live preview renders formatting as you type, and editor
      commands from the command palette apply to the focused entry. (See
      `docs/manual-testing-editor.md` for the detailed fidelity and
      external-write checks.)
- [ ] **Fallback path.** Temporarily force the fallback by editing
      `hasEmbeddedEditorApi` to `return false`, rebuild, and reload. A notice
      appears once, entries are editable as plain text, and saving still
      works. Revert the change afterwards.

## 10. Themes and platforms

- [ ] Light theme and dark theme both look native; no unreadable text, no
      stray borders or shadows.
- [ ] At least one community theme renders acceptably.

### Mobile

None of this can be verified without a phone or tablet — see
`docs/editor-embed-api.md`'s "Mobile" section for why each item is unverified
rather than merely untested.

- [ ] **A long entry keeps its caret visible above the keyboard.** Open (or
      create) an entry with enough lines to exceed the screen's height, and
      focus it near its END (tap near the last line, or use "New journal
      entry" and type several screens' worth of lines). Confirm the caret
      stays visible once the keyboard opens. This is the known gap: the
      keyboard-scroll correction scrolls the entry's element into view, which
      is a no-op once that element already spans the scrollport — so this
      specific case (a long entry, focused near the end) is the one most
      likely to still show the caret hidden under the keyboard.
- [ ] **Tune the 300ms keyboard-scroll delay and the 500ms long-press
      threshold** (`JournalView.createEntryEl`) against how the real keyboard
      animation and the OS's own long-press convention actually feel.
- [ ] **Check whether `window.visualViewport`'s `resize` event fires** when
      the keyboard opens, on both iOS and Android, inside Obsidian's mobile
      shell. If it fires reliably on both, a caret-relative scroll (rather
      than scrolling the whole entry) becomes possible.
- [ ] **Long-press an entry's timestamp area** (not its text body) and
      confirm it opens the actions menu without fighting a normal scroll or
      the editor's own text-selection gesture, and that it does not also pop
      the menu twice when the always-visible `⋯` button is long-pressed
      instead of tapped.
- [ ] **Compare the entry-actions button's dimness** against a non-mobile
      touch device if one is available (e.g. a touchscreen laptop): the
      button should sit at reduced (0.5) opacity at rest on the real mobile
      app, full opacity while it holds focus, and full opacity at rest
      everywhere else that only matches `hover: none`.
- [ ] **Paging works on mobile.** Entries render, the keyboard does not cover
      the focused entry, long-press opens the actions menu, and scrolling
      down loads older entries without jumping.

## 11. Tags

Tags are read-only from the plugin's side (see `CLAUDE.md`'s `# Tags`
section: the plugin never writes one), so what needs confirming by hand is
autocomplete, chip rendering, and the scope's lifecycle against a live vault
and a live metadata cache — none of which the unit tests' mocks can observe.

- [ ] **`#` autocomplete fires inside the embedded editor.** UNVERIFIED — the
      editor is real, but nothing proves its suggester is actually wired
      without running it, and this is the assumption Rule 2 of `# Tags`
      rests on. Type `#` inside a timeline entry and confirm Obsidian's own
      tag-autocomplete popup appears. Expected to NOT fire in the
      `<textarea>` fallback (force it per §9's "Fallback path" check above) —
      that is accepted.
- [ ] **Frontmatter chips appear; an inline tag does not get a chip.** Add
      `tags: [work]` to an entry's frontmatter by hand and type `#therapy`
      somewhere in its body. Confirm a `#work` chip renders in the entry's
      header, and `#therapy` shows only as its usual live-preview pill inside
      the body — never a second chip for it.
- [ ] **Clicking a chip scopes the timeline.** Click the `#work` chip.
      Confirm only entries carrying that tag remain, the scope bar names
      `#work`, and both its `✕` and `Esc` restore the full timeline.
- [ ] **Scope survives a reload, and composes with a calendar day click.**
      With the timeline scoped to a tag, trigger a reload unrelated to the
      scope (e.g. edit a different entry from another pane). Confirm the
      scope bar is still there and still names the tag. Then click a
      calendar day: confirm the timeline now shows only that tag, from that
      day backwards, with the scope bar still present.
- [ ] **Removing the scoped tag from an entry elsewhere in Obsidian drops its
      row.** With the timeline scoped, open one of the visible entries'
      source file in another pane and delete its tag. Confirm the row
      disappears from the timeline and the file itself is untouched.
- [ ] **Editing a scoped entry while its tag is removed elsewhere does not
      yank the row.** Put the caret in a scoped entry (typing, not yet
      saved), then, from another pane, remove that entry's scoped tag.
      Confirm the row stays on screen rather than being torn down
      mid-keystroke.
- [ ] **`New journal entry` while scoped clears the scope.** With a scope
      active, run **New journal entry**. Confirm the scope bar disappears,
      the timeline returns to today, and the composer has focus.
- [ ] **Nothing persists.** Scope the timeline to a tag, restart Obsidian
      completely, reopen the journal. Confirm it comes back unscoped.
- [ ] **The tag suggester's "Clear filter" row is never filtered out.** Open
      **Filter journal by tag** and type text that matches no tag. Confirm
      "Clear filter" is the only row left. Not a pass/fail check, but worth
      watching: reflex-pressing Enter there clears the scope — non-destructive
      and one command from undo, but worth seeing how it feels in practice.

### Mobile

Unverified, like the rest of this file's mobile items — none of the tag UI
has run on a device.

- [ ] The scope bar's left edge lines up with the entries beneath it.
- [ ] Tapping a chip does not flash Obsidian's default button chrome.
- [ ] The scope bar's `✕` is comfortably tappable.
