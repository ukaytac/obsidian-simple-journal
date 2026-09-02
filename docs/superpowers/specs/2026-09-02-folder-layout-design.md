# Entry folders: a choice of three, and a safe way to move what exists

**Date:** 2026-09-02
**Status:** approved, not yet implemented
**Target version:** 1.4.0

## What this is

`CLAUDE.md` § Storage Model has always said the `Journal/YYYY/MM/` structure
"must be configurable later", and § Settings lists `Folder pattern` as a
potential future setting. This is that, narrowed to what was actually asked
for: three fixed shapes, chosen from a dropdown.

| Setting | A new entry is written to |
| --- | --- |
| **Year and month** (default) | `Journal/2026/08/2026-08-12-14-17-03.md` |
| **Year** | `Journal/2026/2026-08-12-14-17-03.md` |
| **No subfolders** | `Journal/2026-08-12-14-17-03.md` |

Plus one command, `Reorganize journal folders`, that moves entries already
written into the configured shape.

## Why it is a small change on the reading side, and none at all on the model

Nothing about how entries are *found* changes, because nothing about it was
ever layout-dependent:

* `listEntries` walks the journal folder with `Vault.recurseChildren` and asks
  `entryFor` about every Markdown file it meets. A file three folders deep and
  a file at the root are found the same way. `Journal/inbox/foo.md` is found
  today.
* An entry's chronology comes from `entryDate.ts` — `created`, then the
  filename, then file ctime. Never the folder.

So a mixed tree is not a broken state. It is the state the plugin already
handles, and the reason the migration below can be an explicit command instead
of a mandatory one.

Writing is one seam: `entryFolderPath(root, date)`, called from `createEntry`
and `renameEntryToMatch`. The layout enters there and nowhere else.

## Not a pattern language

§ Settings names the future setting `Folder pattern`, and a format string with
tokens (`YYYY/MM/DD`, arbitrary text) is deliberately **not** what this builds.
A pattern means a parser, a validator, an error state, and a class of
configurations a user can break their own journal with. Three fixed shapes
answer the actual request and keep § Development Principles' "avoid premature
abstractions" and § Settings' "avoid premature configurability" intact.

Day-level nesting (`Journal/2026/08/12/`) was offered and declined. It is one
more shape in the same seam if it is ever wanted.

## One reader: what shape is this file's folder in?

`isYearMonthFolder` exists today to gate `renameEntryToMatch`'s folder move: an
entry in `root/YYYY/MM` is machine-managed and may be relocated when its month
changes; an entry in `Journal/inbox/` is somewhere the user chose and is left
alone. With three shapes it generalises to one function:

```ts
folderShapeOf(root, folder): EntryFolderLayout | null
```

`"year-month"` for `root/YYYY/MM`, `"year"` for `root/YYYY`, `"flat"` for `root`
itself, and `null` for anything else — `Journal/inbox`, `root/2026/8`
(unpadded), `root/26/08`, a folder outside the root.

**A time correction preserves the file's own shape and updates the date
components in it.** Not the shape the setting currently names:

| The file | Corrected to Jan 2027 | Lands at |
| --- | --- | --- |
| `Journal/2026/08/…` | | `Journal/2027/01/…` |
| `Journal/2026/…` | | `Journal/2027/…` |
| `Journal/…` (flat) | | unchanged, in place |
| `Journal/inbox/…` | | in place; filename only |

So the layout setting has **no interaction at all** with correcting a time. It
answers one question — where a *new* entry is written — and `folderShapeOf`
answers the other, from the file itself.

An earlier draft of this spec gated the move on the *current setting's* shape
instead, and that was wrong in a way worth recording. With the setting on
**Year and month** and a file still in the year-only shape at `Journal/2026/`,
a correction crossing into 2027 would have left a file named `2027-01-…` inside
a folder named `2026` — the folder contradicting the filename, which is the
exact contradiction § Storage Model invented this rename to remove, one level
up. Preserving the file's own shape cannot produce that state.

It is also bit-for-bit today's behaviour for today's journals: a
`root/YYYY/MM` entry moves as it always has, a flat entry stays as it always
has (its shape's target is the root, so there is nothing to move), and an entry
under a user-chosen folder is untouched as it always has been.

**One accepted ambiguity.** `folderShapeOf` classifies by shape alone, so a
folder the user made and named `2026` reads as the year shape. Today's comment
argues `root/YYYY/MM` is "never a folder a user could plausibly have typed by
hand", and that argument is genuinely weaker for a bare year. The consequence
is bounded and benign: the only thing that changes is that a correction
crossing a year boundary moves the file to `2027`, which is what a folder named
by year would have wanted anyway. The migration's second gate — the filename
convention — is what keeps a hand-named file in such a folder out of reach.

## The migration, and what "safe" means concretely

`Reorganize journal folders` — a command, not a side effect of the dropdown. A
setting that also started a thousand-file operation could not be the instant,
cheap thing the other settings are, and an irreversible bulk move belongs
behind a deliberate act.

Seven properties, each answering a specific way this could go wrong:

1. **Paths only, never bytes.** The whole operation is `fileManager.renameFile`
   and folder creation. No entry is read, no entry is written. The worst bug
   reachable inside it cannot corrupt an entry's text — which is the property
   § Error Handling's "never risk data loss" most wants here.
2. **Only files the plugin itself would have placed.** Two gates, the same two
   `renameEntryToMatch` already applies: the filename parses as
   `YYYY-MM-DD-HH-mm-ss[-N].md`, **and** `folderShapeOf` returns a shape for
   its current folder rather than `null`. An entry the user filed under
   `Journal/inbox/`, or named themselves, is never touched.
3. **Never overwrites.** Targets go through `withFreeName`, the same function
   `createEntry` and `renameEntryToMatch` share, so a target already held by
   another entry from the same second gets the deterministic `-2`, `-3`, …
   suffix rather than a clobber. § Error Handling: "Never overwrite a file if a
   collision occurs."
4. **Links follow.** `fileManager.renameFile`, never `vault.rename`. Its
   contract updates links "depending on the user's preferences", so with
   Obsidian's *Automatically update internal links* off, links break. Reading
   that setting means `vault.getConfig`, which is not public API and would need
   an internals exception this feature does not justify — so the confirmation
   **says** it instead of guessing.
5. **Previewed before anything is written.** The confirmation counts first: how
   many entries will move, and how many will stay and why. Nothing is renamed
   until the user confirms that dialog.
6. **Idempotent and resumable.** Each file's target is computed from its own
   resolved `created` and the current setting. There is no progress state to
   keep or corrupt. Interrupted halfway — Obsidian quit, a sync conflict, a
   failure — running it again finishes the rest.
7. **One failure does not stop the rest.** Failures are counted and logged per
   file, and reported at the end: "Moved 412 of 415 entries. 3 could not be
   moved — see the developer console." Stopping at the first failure would
   leave a half-moved tree *and* hide the other two failures; because the
   command is idempotent, continuing and reporting is strictly better.

This command is the only place the layout **setting** decides where an
existing file goes. That is the whole division of labour: the setting governs
new entries, a time correction preserves each file's own shape, and this
command — asked for explicitly, previewed, confirmed — is how a journal is
brought over to one shape.

**Empty folders left behind** are trashed, not deleted: after the move, a
folder that is (a) under the journal root, (b) one of the machine shapes, and
(c) now actually empty goes through `fileManager.trashFile`, which respects the
user's configured trash behaviour and is therefore recoverable. A folder still
holding anything — an image, a note the user put there — is not empty and is
left alone. The plugin created those folders; leaving a few hundred empty ones
behind for the user to sweep up by hand is not tidier for being timid.

## What it does not do

* Does not run on the setting change.
* Does not run on plugin load, ever.
* Does not read or write entry content.
* Does not touch anything outside the journal folder.
* Does not rename a file whose name the user chose.
* Does not offer a pattern language.

## Scope of the change

| File | Change |
| --- | --- |
| `src/journal/folderLayout.ts` | New, pure. The `EntryFolderLayout` type, `entryFolderPath(root, date, layout)`, and `folderShapeOf(root, folder)` |
| `src/utils/dates.ts` | `entryFolderPath` moves out to the module above; date formatting stays |
| `src/journal/entryRepository.ts` | Takes a layout getter beside its folder getter; `createEntry` and `renameEntryToMatch` use it; new `reorganizeEntries()` returning a report |
| `src/settings/settings.ts` | `entryFolders` field, default `"year-month"`, validated on load like the rest — an unknown value falls back to the default rather than throwing |
| `src/settings/SettingsTab.ts` | The dropdown, with each option's example path in its label |
| `src/main.ts` | The `Reorganize journal folders` command and its confirmation |
| `CLAUDE.md` | § Storage Model, § Settings, and a section for the new command (§ Navigation requires one) |
| `README.md`, `CHANGELOG.md` | The setting, the command, and 1.4.0 |

## Testing

Pure, in a new `tests/folderLayout.test.ts`:

* each layout's path for a date, including the root-folder edge cases the
  existing `normalizeRoot` handles
* `folderShapeOf` returns each of the three shapes for the folder that
  produces it, and `null` for `root/inbox`, `root/2026/8` (unpadded),
  `root/26/08`, and a folder outside the root
* `entryFolderPath(root, date, folderShapeOf(root, folder))` is the identity
  for a folder already correct for that date — the property the rename's
  no-op check depends on

Repository-level:

* `createEntry` writes to the right folder under each layout
* `renameEntryToMatch` preserves each shape while updating its date
  components — the four rows of the table above, including the year-crossing
  case that the discarded rule got wrong
* `reorganizeEntries` moves managed entries, skips user-placed folders and
  hand-named files, suffixes rather than overwrites a taken target, counts a
  failure without abandoning the remaining files, and trashes a folder it
  emptied but not one that still holds something

Settings:

* an unknown persisted value falls back to `"year-month"`

Manual, because no fake can prove it: the command on a real vault with a few
hundred entries — the preview's counts match what happens, links still
resolve, the timeline rebuilds once rather than flickering per file, and an
interrupted run resumes cleanly.
