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
