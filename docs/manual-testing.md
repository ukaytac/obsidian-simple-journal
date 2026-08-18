# Manual testing

Checks that need a real Obsidian instance because they depend on real vault/UI
behaviour the unit tests' mocks and pure-logic extraction can't observe. Grows
as later tasks add cases; see also `docs/manual-testing-editor.md` for the
`TextareaEditor` resize checks.

## Journal folder rename (Task 14)

`JournalService` cannot observe, from the API alone, whether Obsidian fires a
`vault.on("rename")` event for every descendant file when a FOLDER is renamed,
or only one event for the folder itself. `JournalService.rebuild()` is
idempotent either way — a plain re-derivation of the index from
`EntryRepository.listEntries()` — so the folder-rename handler triggers it
unconditionally rather than depending on the answer. Confirm the real behaviour:

- [ ] **Rename the configured journal folder itself** (e.g. `Journal` ->
      `Journal2`) while the journal view is open, with a mix of entries loaded
      and scrolled past. The timeline reloads and shows every entry at its new
      location; nothing is duplicated, and nothing silently disappears.
- [ ] **Rename an ancestor folder that contains the journal folder** (e.g. the
      vault folder holding `Journal/` itself). Same expectation.
- [ ] **Rename a subfolder inside the journal folder** (e.g. `Journal/2026` ->
      `Journal/2026-old`). Same expectation.
- [ ] **Rename a folder unrelated to the journal folder** while the view is
      open. No reload happens (check the console/dev tools for an unexpected
      full rebuild) and the timeline is undisturbed.
- [ ] Repeat the first case while an entry is mid-edit (typing, not yet saved).
      The in-flight text is not lost — it's flushed to disk at the entry's new
      location before the timeline reloads.

## First entry in a previously empty journal (Task 14)

`insertEntryInPlace` (the path an "added" change from `JournalService` takes,
including the one the new-entry composer will use once Task 15 lands) is not
covered by any unit test — it's inline DOM/`IntersectionObserver` logic in
`JournalView`, not extracted behind the pure `decideChangeAction` seam the way
the loop-suppression and repositioning decisions are. Confirm by hand:

- [ ] **Open the journal on a vault with zero entries.** The "No journal
      entries yet" message appears.
- [ ] **Create the first entry** (by hand, or via the command once it creates
      files) while that view stays open. The empty-state message disappears,
      the entry appears with the full live editor mounted — not static,
      dead-looking text — and typing into it works immediately.
- [ ] **Create a second entry** shortly after. It appears above the first,
      also with a live editor, confirming the mount/paging observers set up
      on the empty timeline are still working normally rather than only
      working once by accident.

## Mobile (Task 18)

None of this can be verified without a phone or tablet — see
`docs/editor-embed-api.md`'s "Mobile" section for why each item is
unverified rather than merely untested.

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
      shell (see `docs/editor-embed-api.md`). If it fires reliably on both,
      a caret-relative scroll (rather than scrolling the whole entry) becomes
      possible.
- [ ] **Long-press an entry's timestamp area** (not its text body) and
      confirm it opens the actions menu without fighting a normal scroll or
      the editor's own text-selection gesture, and that it does not also
      pop the menu twice when the always-visible `⋯` button is long-pressed
      instead of tapped.
- [ ] **Compare the entry-actions button's dimness** against a non-mobile
      touch device if one is available (e.g. a touchscreen laptop): the
      button should sit at reduced (0.5) opacity at rest on the real mobile
      app, full opacity while it holds focus, and full opacity at rest
      everywhere else that only matches `hover: none`.
