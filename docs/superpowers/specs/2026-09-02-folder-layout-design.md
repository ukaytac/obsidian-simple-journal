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

## One target, one permission

Everything the plugin writes goes where the setting says. There is exactly one
function that computes a folder:

```ts
entryFolderPath(root, date, layout): string
```

and all three writers call it with the **current setting**: `createEntry` for a
new entry, `renameEntryToMatch` after a time correction, and
`reorganizeEntries` for the migration. They therefore cannot drift apart about
where an entry belongs — the same structural guarantee `withFreeName` already
gives the three of them about collision suffixes.

So a corrected timestamp places the entry at "current setting + corrected
date". With the setting on **No subfolders**, correcting an entry still sitting
in `2026/08` moves it to `Journal/`. With the setting on **Year and month**, an
entry in `2026/` whose date is corrected into 2027 moves to `2027/01/`.

The second question is permission, and it is a boolean:

```ts
isManagedFolder(root, folder): boolean
```

True for the three shapes this plugin produces — `root`, `root/YYYY`,
`root/YYYY/MM` — and false for anything else: `Journal/inbox`, `root/2026/8`
(unpadded), `root/26/08`, a folder outside the root. It replaces today's
`isYearMonthFolder` and gates both the correction's move and the migration.

An entry in a folder `isManagedFolder` rejects keeps its folder and has only
its filename corrected — today's rule, unchanged, for the reason today's
comment gives: a location the user chose on purpose is not this plugin's to
overwrite.

### The two rules this replaced, and why they lost

Recorded because the choice is not obvious, and a later reader deserves the
alternatives rather than a fait accompli.

**A — "move only within the shape the setting names, otherwise leave it."**
Produced a state the rename exists to prevent. Setting on year-and-month, file
in the year-only shape at `Journal/2026/`, correction crossing into 2027: the
file ends up named `2027-01-…` inside a folder named `2026`. That is the folder
contradicting the filename, which is exactly the self-contradiction
§ Storage Model invented this rename to remove, one level up.

**B — "preserve each file's own shape, updating the date components in it."**
Fixes A's contradiction, and asks the plugin to maintain two or three layouts
simultaneously and forever: a file born under year-only stays year-only, so a
journal never converges without the command, and every shape stays a live
maintenance target. It also needed a third function (`folderShapeOf`, returning
which shape a folder is) that the accepted rule does not.

**C — the accepted rule above.** One layout is ever written to, one function
computes it, one boolean decides whether a file may be moved at all, and the
contradiction in A is unreachable by construction.

### What C changes for existing journals, deliberately

For an entry in `root/YYYY/MM` — every entry this plugin has ever created —
nothing changes: the setting defaults to year-and-month, so the computed target
is what `isYearMonthFolder` and `entryFolderPath` produce today.

One case does change. A file sitting **directly in the journal root** with a
plugin-convention filename is movable now, where today it is left alone: with
the setting on year-and-month, correcting its time moves it into
`root/YYYY/MM`.

That is accepted rather than overlooked, and the reasoning is about which gate
carries which question. **The filename gate answers "is this ours?"** —
`YYYY-MM-DD-HH-mm-ss[-N].md` is this plugin's convention and nobody types it by
hand. **The folder gate answers the narrower "did the user file this somewhere
on purpose?"** — and `Journal/inbox/` is filing something somewhere, while the
journal folder's own root is not.

The residual risk is a conventionally-named file a user deliberately parked in
the root: a time correction will move it. Bounded on both sides — the bulk
command previews and confirms before touching anything, and a single
correction moves one file with `renameFile`, so links follow.

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
   `YYYY-MM-DD-HH-mm-ss[-N].md`, **and** `isManagedFolder` accepts its current
   folder. An entry the user filed under `Journal/inbox/`, or named themselves,
   is never touched.
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

This command is the bulk form of the rule above rather than a second concept:
apply the same "current setting + the entry's own date" placement to every
managed entry, touching no timestamp. What makes it a command is scale, not
semantics — hundreds of `renameFile` calls at once want a preview and a
confirmation that one deliberate time correction does not.

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
| `src/journal/folderLayout.ts` | New, pure. The `EntryFolderLayout` type, `entryFolderPath(root, date, layout)`, and `isManagedFolder(root, folder)` |
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
* `isManagedFolder` accepts the three shapes and rejects `root/inbox`,
  `root/2026/8` (unpadded), `root/26/08`, and a folder outside the root

Repository-level:

* `createEntry` writes to the right folder under each layout
* `renameEntryToMatch` places the file per the current setting: out of
  `2026/08` and into the root under **No subfolders**, out of `2026/` and into
  `2027/01/` under **Year and month**, and — unchanged from today — filename
  only, folder untouched, for an entry under `Journal/inbox/`
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
