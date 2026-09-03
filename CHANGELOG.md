# Changelog

The text of each GitHub release is taken from here. Starts at 1.1.0 — earlier
versions were released without written notes.

## 1.4.0

### Entry folders

Journal entries have always been filed under `Journal/2026/08/`. Now that is a
setting, with three shapes:

```
Year and month   Journal/2026/08/2026-08-12-09-34-21.md
Year             Journal/2026/2026-08-12-09-34-21.md
No subfolders    Journal/2026-08-12-09-34-21.md
```

It defaults to year and month, so nothing about an existing journal changes
until you change it.

- **Changing it moves nothing by itself.** It decides where the next entry is
  written. The timeline reads your entries wherever they are, so a journal
  holding more than one shape works exactly as before.
- **Picking a shape offers to move the rest**, and you can say no. The same
  offer is a command, `Reorganize journal folders`, whenever you want it
  later. Either way it counts the entries and tells you before it moves
  anything.
- **It never touches what is inside your entries.** Only their locations
  change: nothing is read from them and nothing is written to them.
- **It never overwrites a file**, and it leaves alone anything you filed into a
  folder of your own or named yourself.
- **Links follow**, as long as Obsidian is set to update internal links
  automatically. If a move fails partway, running the command again finishes
  the job.
- **Emptied year and month folders go to your trash**, not straight to
  deletion.

### One behaviour change worth knowing

Correcting an entry's time has always moved its file, so the filename — which
*is* the timestamp — keeps telling the truth. It now moves it to whatever the
folder setting says, which is what makes the setting mean something.

One case is different from before: an entry sitting directly in your journal
folder, rather than in a year or month subfolder, used to stay there through a
time correction and now moves into the shape you chose. Entries you filed into
a folder of your own, or named yourself, are still never moved.

## 1.3.0

### Search

`Search journal` finds an entry by the words in it.

Type, and matching entries appear with their time and the words around the
match. There are two ways out. Pick one entry and its note opens in a new tab,
with the journal left exactly as you had it. Pick "Show all" and the timeline
narrows to every entry that matched.

- **It searches what you wrote**, not properties and not filenames.
- **Turkish casing works, and so does English's.** `istanbul` finds
  `İstanbul`; `ışık` finds `IŞIK`; `i am` finds `I am happy`. All four of
  `İ I ı i` are one letter here, so a search never misses a word over the dot
  on an i. The cost is the other direction: `ısı` also finds `isi`. An extra
  row is easier to read past than a missing one is to notice.
  Accents are not folded, so `acik` does not find `açık` — this folds case,
  not accents.
- **Every term must appear**, in any order. There is no query syntax — no
  quotes, no `OR`, no exclusion.
- **A search filter is never remembered.** Restarting Obsidian, or writing a
  new entry, puts the whole journal back.
- **Nothing is written.** As with mentions, this release adds no writes at all.

### Known limitations

- **Searching reads every entry once each time you open the command.** On a
  journal of a few hundred entries this is imperceptible. On a very large one
  it may not be; if it ever stutters, the fix is a different reading strategy
  and not a different search.

## 1.2.0

### Mentions

You can now read the journal entries that mention a note, on the note itself.

Obsidian's backlinks pane could never do this for a journal. It lists a backlink
by filename, and these filenames are bare timestamps — so a person you had
written about twenty times showed up as twenty near-identical rows. The one
place where titleless entries cost you something was the one place you most
wanted to read them.

What you get is not a list of links. It is the entries themselves, with their
text, in the journal's own newest-first shape.

- **Write ` ```simple-journal ` in any note** and it fills with the entries that
  link to that note. `Insert journal mentions block` writes the block for you.
  Point it somewhere else with `note: [[Some Other Note]]` inside the block.
- **`Open journal mentions`** puts the same panel in the sidebar, following
  whatever note you are reading.
- **`Show mentions under notes`** adds it to the bottom of a note automatically.
  Off by default. Its header folds the panel away and remembers that you folded
  it, keeping the count on screen so you can always see there is something
  there.
- **A mention is a real link** — in the text, an embed, or a property like
  `people: "[[Ekin]]"`. Obsidian treats all three as the same thing and so does
  this. A note whose name merely appears as text is not a mention, and neither
  is a link to a note that does not exist.
- **The panel is read-only.** Click an entry's time and the journal opens at
  that entry, which is where editing belongs. Five entries show at first, twenty
  more per click.
- **Nothing is written.** No new property, no change to any entry, no new file.
  This release adds no writes at all.

### Escape closes the composer

Pressing `Esc` in a new, empty entry now closes it instead of navigating away
from the journal. With no entry being composed the key behaves exactly as it
did. It never closes a composer whose text is already on its way to disk.

### Known limitations

- **None of this has run on a phone or tablet**, as with the rest of this
  plugin's mobile support. The note-footer panel in particular depends on the
  editor's layout, which has never been observed on a device.
- **The note footer is the one surface that reaches into Obsidian's own
  layout.** No public API can put content at the end of a note's text where it
  scrolls with the note. If a future Obsidian changes that layout, the panel
  quietly stops appearing — no error, no notice, and nothing in your notes
  altered. That silence is deliberate, but on a phone it is indistinguishable
  from the setting being off.
- **The footer shortens the empty click area under a short note.** Obsidian
  leaves a screenful of space below the last line so you can click there and
  keep writing; on a note with a footer that space is capped, so the panel is
  not stranded a screen away. Clicking below the text still works, with less
  room.
- **Folding the footer is one switch for the whole vault**, not one per note.
  Fold it under one note and it starts folded under all of them.
- **"Show more" re-renders what is already on screen** rather than only adding
  the new entries. Harmless at ordinary sizes; noticeable if you page through
  hundreds.
- **Whether property links are counted has not been confirmed in a real
  vault.** The plugin asks Obsidian which links a note has and trusts the
  answer; that answer is expected to include links written in properties, but
  it has only been reasoned about, not observed.
- **With Vim key bindings on, `Esc` in a new entry is unverified.** It will
  either leave insert mode as usual or close the empty entry, depending on
  which handler Obsidian reaches first. Nothing is at risk either way — `Esc`
  never closes an entry that has text in it.

### Requirements

Unchanged: Obsidian 1.7.2 or newer, desktop and mobile.

## 1.1.0

### Tags

Journal entries can now be filtered by tag.

- **Tag an entry the way you tag anything else in Obsidian** — type
  `#something` as you write, or put `tags:` in the entry's properties. The
  plugin never writes a tag for you and never rewrites one you wrote.
- **`Filter journal by tag`** narrows the timeline to a single tag, still
  newest-first and still continuous. The filtered tag is named at the top of
  the timeline with a `✕` beside it; `Esc` clears it too.
- **Property tags appear as a chip** beside the entry's time, and clicking one
  filters by it. Tags typed into the text don't get a chip — they already show
  as Obsidian's own clickable pill, and showing them twice would just be noise.
  The chip exists because the timeline deliberately hides the properties panel,
  which would otherwise make a property tag invisible here.
- **The filter composes with the calendar**, so you can read one tag from a
  given day backwards. It filters rather than anchors, because a tag is not a
  point in time — "this tag and older" would mean nothing.
- **Matching is exact and case-insensitive.** Filtering by `#work` does not
  pull in `#work/project`, which is offered separately when you pick a tag.
- **The filter is never saved.** Restart Obsidian and the journal comes back
  whole. A filter restored at startup would hide most of your journal with no
  visible reason.

Nothing about your files changed: entries are still ordinary Markdown notes,
and this release adds no new writes to them.

### Known limitations

- **None of the tag UI has run on a phone or tablet.** The layout and touch
  behaviour were written by reasoning from documented behaviour, as the rest of
  this plugin's mobile support was, and remain unverified on a device.
- **A filtered timeline that empties itself says nothing.** If the last visible
  entry stops matching the filter — because you removed its tag from another
  pane — its row disappears and the timeline is left blank until the next
  reload, with the filter bar still naming the tag but no message explaining
  the emptiness.
- **The tag suggester's "Clear filter" row is never filtered out**, so a query
  matching no tag leaves it as the only row. Pressing Enter there clears the
  filter rather than doing nothing. It is one command away from being undone,
  but it can surprise you.

### Requirements

Unchanged: Obsidian 1.7.2 or newer, desktop and mobile.
