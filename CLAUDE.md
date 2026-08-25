# CLAUDE.md

## Project

We are building an Obsidian community plugin for **entry-based journaling**.

The product name is **Simple Journal**, and the plugin id is `simple-journal`.
The id is fixed: it is the folder name in every user's vault and cannot change
after publication. The two view types (`simple-journal-timeline`,
`simple-journal-calendar`) are equally fixed, because they are what a saved
workspace layout refers to.

The plugin is inspired by the interaction model of Journal View: a continuous, scrollable journal inside Obsidian where the user can read and edit entries without constantly opening individual Markdown files.

However, the core data model is intentionally different.

---

# Core Product Idea

The most important principle of this project is:

> **One journal entry = one Markdown file.**

Do NOT model one day as one Markdown file.

A single day may contain zero, one, or many independent journal entries.

Example:

```text
Journal/
└── 2026/
    └── 08/
        ├── 2026-08-12-09-34-21.md
        ├── 2026-08-12-14-17-03.md
        └── 2026-08-12-22-41-52.md
```

These are three separate journal entries written on the same day.

The timeline UI should make them feel like entries in one journal rather than separate files.

---

# Product Philosophy

The plugin should feel lightweight, calm, fast, and native to Obsidian.

The user should think:

> "I am writing journal entries."

They should NOT have to think:

> "I am creating Markdown files."

The filesystem is an implementation detail.

Every entry remains a real Markdown file so that normal Obsidian features continue to work:

* backlinks
* links
* tags
* properties
* search
* embeds
* graph
* Bases
* other plugins

Do not create a proprietary database or hidden storage format for journal content.

Markdown files are the source of truth.

---

# Critical UX Principle: No Titles

The user does not like giving journal entries titles.

Therefore:

* Entries MUST NOT require titles.
* Entries MUST NOT automatically contain `# Heading` titles.
* Do not ask for an entry title when creating an entry.
* Do not show the filename as the visible title in the journal timeline.
* The timestamp is enough to visually identify an entry.

Example UI:

```text
WEDNESDAY, 12 AUGUST

22:41

Latest journal entry...


14:17

Earlier entry...


09:34

Morning entry...
```

The filename exists only as an internal identifier.

---

# Timeline Direction

The journal is **reverse chronological**.

This is a core product decision.

The newest content must always be at the top.

The user scrolls downward to move further into the past.

This applies at both levels:

* days are ordered newest → oldest
* entries within each day are ordered newest → oldest

Example:

```text
WEDNESDAY, 12 AUGUST

22:41
Latest entry...

17:23
Earlier entry...

09:34
Morning entry...


TUESDAY, 11 AUGUST

21:10
Latest entry from Tuesday...

10:14
Earlier entry...
```

Do NOT default to oldest-first chronological order.

The primary mental model is:

```text
NOW
↓
RECENT PAST
↓
OLDER PAST
```

A future setting may allow alternative sorting, but this is not required for MVP.

---

# Storage Model

Default entry directory:

```text
Journal/
```

Default nested structure:

```text
Journal/YYYY/MM/
```

Default filename format:

```text
YYYY-MM-DD-HH-mm-ss.md
```

Example:

```text
Journal/2026/08/2026-08-12-17-23-41.md
```

This must be configurable later, but V1 can start with these defaults.

Avoid filenames based on journal text.

Do not generate slugs from the first sentence.

Do not rename files when their content changes.

The one exception is a deliberate timestamp correction through `Change entry time`: because the filename convention *is* the timestamp, an entry named `2026-08-18-18-12-21.md` holding `created: 2026-07-01T09:00` contradicts itself. Such a correction moves the file to match — new filename, and a new `YYYY/MM` folder when the month or year changed.

That move uses `fileManager.renameFile`, so Obsidian updates links to the entry according to the user's own preferences, and it never overwrites: a name already taken gets the same numeric suffix `createEntry` uses.

A file whose name does not already follow the convention is left alone — only `created` is written. A name the user chose deliberately is not the plugin's to overwrite.

Nothing else may rename an entry. Editing an entry's body never does.

---

# Entry Metadata

The minimum recommended frontmatter is:

```yaml
---
created: 2026-08-12T17:23:41+03:00
---
```

Then immediately the journal content, with no blank line in between:

```markdown
---
created: 2026-08-12T17:23:41+03:00
---
Today I realized...
```

An entry created before this convention (or by an older build of the plugin) may have a blank line between the closing `---` and its text. That entry keeps whatever it already has — the plugin never rewrites an existing entry's separator, only refrains from adding one to a new entry.

No heading is required.

`created` represents the journal entry's creation time and is never changed by the plugin on its own — writing an entry's body must never touch it.

The user may correct it deliberately, through the `Change entry time` action in the entry menu. That is the one sanctioned way it changes from inside the timeline, and it exists because the timestamp is what places an entry in the timeline and a wrong one has no other remedy: the properties panel is hidden there by design.

Such a correction must rewrite only the `created` line. Obsidian's `fileManager.processFrontMatter` re-serializes the whole frontmatter block and can reformat the user's other properties, so it must not be used for this — see `setCreatedProperty` in `journal/markdownDoc.ts`.

Changing the time never renames the file. Filenames are internal identifiers.

Do not store redundant properties such as:

```yaml
year:
month:
day:
hour:
```

when they can be derived from `created`.

The architecture should allow users to add arbitrary Obsidian properties later without the plugin destroying them.

Never rewrite or normalize unrelated frontmatter properties.

---

# Source of Truth for Entry Date

Prefer:

1. valid `created` property
2. timestamp parsed from the plugin's filename convention
3. file creation time as a fallback

Keep this resolution logic isolated in one function/module.

The timeline should not break because one entry is missing frontmatter.

---

# Main Journal View

The main feature is a custom Obsidian view containing a continuous timeline.

Conceptually:

```text
AUGUST 2026

WEDNESDAY, 12 AUGUST

22:14
Third entry...

11:38
Second entry...

09:04
First entry...


TUESDAY, 11 AUGUST

17:42
Second entry...

10:14
First entry...
```

Entries should be:

* grouped by calendar day
* sorted newest → oldest
* editable directly from the timeline
* visually separated without looking like cards in a dashboard
* native-looking inside Obsidian
* usable with light and dark themes

Do not over-design the UI.

Avoid excessive borders, shadows, cards, gradients, or app-like chrome.

This is a writing surface.

---

# Editing

Inline editing is a core feature.

The user edits Markdown directly in the timeline without opening the source note.

The editing experience must be the **full Obsidian editor**, not an approximation. Live preview, `[[` autocomplete, editor commands, embeds, vim mode, and theme parity are product requirements, not nice-to-haves.

No public Obsidian API provides an editable embedded editor. `MarkdownRenderer.render()` is read-only, and `Editor` is reachable only from an active `MarkdownView`.

Therefore the primary editor implementation mounts a real Obsidian Markdown editor through the internal `app.embedRegistry.embedByExtension["md"]` mechanism — the same one Obsidian uses for Canvas cards and callout editing.

This is a deliberate, documented exception to the general rule of avoiding undocumented Obsidian internals. It is justified only by the editing-fidelity requirement above. It does NOT license internal API usage anywhere else in the codebase.

Two rules make this exception safe:

1. **Feature detection with fallback is mandatory.** The internal API is probed at plugin load. If it is unavailable, the plugin falls back to a plain `<textarea>` editor and shows a one-time notice. The journal must never become unusable, and no journal data may be at risk.
2. **All internal API usage is confined to a single file** behind an `EntryEditor` interface (`mount / getValue / setValue / focus / destroy / onChange`). Swapping to a future public API, or retreating permanently to the fallback, must be a one-file change.

Every entry in the loaded timeline window is a live editor, not click-to-edit. The number of simultaneously mounted editors is bounded; entries far outside the viewport fall back to static rendering.

Do not build a fragile hack anywhere else just to achieve visual parity.

Markdown content must remain valid Markdown.

---

# Creating a New Entry

There should be a command:

```text
New journal entry
```

and eventually a configurable hotkey.

The ideal UX:

1. User triggers `New journal entry`.
2. Journal view opens if necessary.
3. View moves to the top / today.
4. A fresh entry editor receives focus.
5. User starts typing.
6. A Markdown file is created automatically.
7. The new entry becomes the first entry in the timeline.

The user should never be asked:

* filename
* title
* folder
* date

during normal capture.

## New entry position

Because the timeline is reverse chronological, a newly created entry should appear at the **top of today's entries**.

If today is already visible at the top, do not jump unnecessarily.

If the user is viewing older history and explicitly invokes `New journal entry`, move them back to today and focus the new entry composer.

---

# Lazy Creation

Prefer not to create an empty Markdown file merely because an empty composer became visible.

Create the entry when the user actually starts entering meaningful content, or when creation is otherwise explicitly committed.

Avoid accumulating empty files.

Once a real entry has been created, do NOT automatically delete it just because its text temporarily becomes empty during editing.

Deletion should be an explicit user action.

---

# Entry Actions

V1 should eventually support minimal entry actions:

* Open source note
* Copy link to entry
* Change entry time
* Delete entry

Do not clutter every entry with permanently visible action buttons.

Use hover actions, context menu, or another subtle native interaction.

Deletion must use safe Obsidian file APIs and should respect Obsidian's normal trash behavior where possible.

---

# Tags

Obsidian draws no semantic distinction between an inline `#tag` — mid-sentence
or at the end of an entry — and a frontmatter `tags:` entry: `getAllTags`
merges both into one array, and search, the tag pane, and the graph all treat
them identically. Neither does this plugin, with exactly one exception, and
the exception exists for a reason specific to this timeline: the timeline
hides `.metadata-container` by design (see **Main Journal View**), so a
frontmatter tag is the one kind that would otherwise be invisible and
unremovable there. An inline tag needs no such help — it already renders as a
clickable pill in live preview, like any other note.

## Rule 1 — One reader, source-blind

A single module, `journal/entryTags.ts`, resolves every tag on an entry —
inline and frontmatter alike — exactly as `entryDate.ts` is the one place an
entry's chronology is resolved. Nothing downstream asks which kind a given tag
came from. Obsidian does not ask; neither do we.

## Rule 2 — The plugin never writes a tag

Frontmatter belongs to the user: only `created` is the plugin's to write (see
**Entry Metadata**), and that boundary holds for tags too — no code path adds,
removes, or reformats a `tags:` entry. The body needs no help either: the
embedded editor is a real Obsidian editor (see **Editing**), so typing `#`
brings up Obsidian's own tag autocomplete with nothing from this plugin
involved. There is no tag-entry UI. "Automatic tagging" stays a non-goal.

## Rule 3 — Chips show only what the timeline hides

Inline tags already render as clickable pills in live preview, so rendering
them again as chips would show the same tag twice. Frontmatter tags render
nowhere else in the timeline. So: chips are rendered for frontmatter tags
only. Nothing then appears twice, and nothing appears zero times.

## Rule 4 — Clicking a tag scopes the timeline

A tag is not a point on the chronological axis, so anchoring — what a
calendar day click does — has no meaning for it. The honest options were
filter or nothing; this filters, and calls it a **scope**. A scope composes
with an anchor ("this tag, from that day backwards"), and the calendar's dots
stay scope-independent — they describe the journal, not the current filter.

Matching is exact and case-insensitive: `#work` does not include
`#work/project`. Nested tags are listed separately in the tag suggester, so
every tag stays reachable, and tag-hierarchy browsing stays out of scope.

## A scope is never persisted

Not to view state, not to settings, not to the saved workspace layout. A
restored filter at startup would hide most of a user's journal with no
visible cause — the same "permanently locked out" failure the calendar's
placement policy above exists to avoid.

Its lifecycle is therefore entirely explicit user action: only `setTagScope`
and the reset a new entry triggers ever write it — nothing else, including a
folder reload, touches it on its own. Silently changing state the user didn't
ask to change is exactly the failure this section's precedent warns about.

`New journal entry` clears both the scope and any active anchor before opening
the composer: a new entry has no tags, and would otherwise be written safely
to disk and be invisible in a timeline still filtered to something else.

## Entry points

The way into a scope is one command, `Filter journal by tag`, plus the
plugin's own frontmatter chips. Obsidian's inline tag pill is deliberately
left alone — intercepting it would make the same pill mean two different
things in two different places.

---

# Mentions

A journal entry has no title, and that is a North Star principle. Inside the
timeline it costs nothing: the timestamp identifies the entry and the entry's
text is right underneath it.

Outside the timeline it costs a great deal. Obsidian's backlinks pane lists a
backlink by **filename**, and this plugin's filenames are bare timestamps like
`2026-08-12-14-17-03`. So a person note linked from twenty entries shows twenty
near-identical rows, and the one place in Obsidian where titlelessness takes
something away from the user rather than saving them something is the one place
they most need to read the entries: under the note the entries are *about*.

That asymmetry is the entire justification for this feature, exactly as `# Tags`
turns on the asymmetry between an inline tag (already visible) and a frontmatter
tag (invisible in the timeline). Neither section is a licence to add surfaces in
general. Each fixes one thing that is unreadable because of a decision made
elsewhere in this document.

What is shown is therefore not a list of links. It is the entries themselves,
with their content, in the journal's own reverse-chronological shape.

## Rule 1 — One query, source-blind

A single module, `mentions/mentionQuery.ts`, answers "which entries mention this
note?", exactly as `entryDate.ts` is the one place an entry's chronology is
resolved and `entryTags.ts` the one place its tags are.

A body `[[link]]`, an embed `![[link]]`, an aliased `[[link|text]]` and a
frontmatter `people: "[[link]]"` are **one thing**. Obsidian folds all four into
`metadataCache.resolvedLinks` before a plugin ever sees them, and its search,
graph and backlinks pane treat them identically. So does this. Nothing
downstream may ask which kind a reference was.

Two things are deliberately **not** mentions:

* An **unresolved** link. It points at no file, so there is no note for a panel
  to be attached to in the first place.
* A **plain-text** occurrence of the note's name. Full-text matching is semantic
  search by another name, and that is a documented non-goal.

An entry that links to the target five times appears once — `resolvedLinks`
carries a count and the count is ignored — and an entry never lists itself.

## Rule 2 — Only journal entries are searched, never the vault

The question is never "what links to this note?" It is "which *journal entries*
link to this note?" — a smaller question, and one the plugin can already answer
cheaply, because `JournalService` holds a sorted index of every entry. The query
is one object lookup per entry, and it returns them in the order the index gave
them. It does not sort. A second sort would be a second place for the timeline's
ordering rule to drift out of agreement with itself.

`metadataCache.getFileBacklinks` is **refused**, and the refusal is the point.
It appears in Obsidian's published developer docs but is absent from the
installed type definitions, which makes it an undocumented internal by the
standard `# Development Principles` sets. This plugin has exactly two internals
exceptions, both argued for in writing and both carrying safety rules; a third
one bought for convenience — when a fully public API does the job — would turn a
pair of deliberate exceptions into a habit. It would also answer the wrong,
vault-sized question at greater cost.

## Rule 3 — One renderer, three shells

`mentions/MentionsPanel.ts` is the single renderer. It owns the header and the
count, the day grouping, the rendered entry bodies, the "Show more" control, and
the two subscriptions that keep it current. It does not know why it was mounted.

The three shells — the code block, the sidebar view, the note footer — each do
one job: obtain a container and a target `TFile`, and delegate. They are not
three features. A change to how mentions look or behave is a change to one file.

They differ in exactly one option, and deliberately: whether an empty result
prints a line or renders nothing at all. The code block prints one, because the
user typed that block on purpose and silence there would read as a bug. The
footer prints nothing, because the user did not ask for anything at the bottom
of that note and an empty panel is pure noise.

## Rule 4 — Read-only, with a way back to the timeline

Entry content goes through `MarkdownRenderer`, so wikilinks, embeds, inline tags
and formatting behave as they do anywhere else in Obsidian. Nothing in any of
the three surfaces writes.

Editing is what the timeline is for (see `# Editing`). Mounting live embedded
editors inside an arbitrary note would put the most data-critical code in this
plugin — the mount cap, the debounced save path, self-write suppression, the
save tokens — behind a code-block lifecycle that nothing here controls, in a
note this plugin does not own. The stated need is *seeing* the content. Clicking
an entry's timestamp hands the user back to the timeline instead, through the
same `goToDateInJournal` the calendar's day click uses.

Read-only does not mean silent. An entry that cannot be read, or that a
post-processor from some other plugin throws while rendering, says so in place.
A failed read rendered as an empty body is indistinguishable from an entry the
user genuinely left empty, and one bad entry must never hide the others — the
same bar `entrySave.ts`'s "not saved" marker sets for a failed write.

## Rule 5 — Three surfaces, gated differently and on purpose

**The code block**, ` ```simple-journal `. The language string is effectively
permanent once published, for the same reason the plugin id and the view types
are: it lives inside users' notes. It understands one directive,
`note: [[Some Note]]`; with no directive it targets the note it sits in.
Anything else in the block is ignored rather than treated as an error, because a
code block that renders an error message in the middle of someone's note is
worse than one that renders the obvious default — and the obvious default is
always available.

**No setting gates the code block.** A toggle that turned the processor off
would leave raw ` ```simple-journal ` fences showing in notes the user had
already written, which reads as breakage rather than as an option being off. The
block is opt-in per note already: the way to not have one is to not write one.

Its recursion guard is structural, not a counter. The panel renders entry
markdown, and an entry may itself contain a `simple-journal` block. The
processor therefore asks whether *this* block's own ancestry runs through a
rendered panel, and draws an inert placeholder if it does. A global depth flag
would mistake an unrelated block rendering concurrently in another note for a
nested one.

**The sidebar**, view type `simple-journal-mentions` — fixed forever, because a
saved workspace layout refers to it. It follows the active file. Its setting
governs **automatic placement only**, mirroring the calendar's policy: the view
type is always registered whatever the setting says (a saved layout referring to
an unregistered type is a broken layout), and `Open journal mentions` works
either way, because a command is how you reach a thing. Turning the setting off
detaches the leaf rather than merely declining to re-place it — leaving a panel
the user just switched off sitting there until the next restart is the same
failure as ignoring the switch. Unlike the footer it does not exclude journal
entries: the user opened this panel deliberately, and it costs nothing to answer
honestly for whatever file is active.

**The footer**, under an ordinary note, **off by default**. It is the surface
that relies on Obsidian's internal layout DOM, so nobody may end up with it
appearing under their notes without having asked. It never attaches to a journal
entry — the entry's own timeline already shows this, and rendering entries
inside an entry invites exactly the recursion the code block has to guard
against.

Both settings take effect immediately, without a reload. A setting whose only
observable behaviour is at the next restart teaches the user not to trust it.

## The second internals exception

The footer is the second place in this codebase that touches Obsidian internals.
The first is the embedded editor, and `# Editing` says of it, in terms, that it
"does NOT license internal API usage anywhere else in the codebase". This is not
that licence being spent. It is a separate exception, granted on its own merits,
and it carries the same two rules.

**Why no public API can do it.** Obsidian exposes nothing for appending content
to the end of a note's *content flow* — the part that scrolls with the note's
text. The public `view.contentEl` is the whole pane, so a panel appended there
is pinned to the bottom of the window while the note scrolls underneath it. That
is a docked strip, a different feature, and not the one this section exists for.
The only element that sits after the last paragraph and scrolls with it is
Obsidian's own layout element: `.markdown-preview-sizer` in reading view,
`.cm-sizer` in source mode (which covers live preview and raw source alike —
both are CodeMirror).

**How narrow it is.** *Which* of the two to look for is decided by
`MarkdownView.getMode()`, which is public, documented API. Only the two class
names are internal, in exactly one `querySelector` call in the whole codebase.
That is not merely tidier. A `MarkdownView`'s `containerEl` can hold both
`.markdown-source-view` and `.markdown-reading-view` at once with the inactive
one hidden rather than removed, so a single comma-separated selector would
return whichever came first in document order — and in reading view that mounts
the footer into a pane the user cannot see. Public API decides; document order
does not.

1. **Feature detection, with a silent no-op fallback.** The lookup is allowed to
   return nothing, and every caller reads that as "this note gets no footer". No
   throw, no notice, no console line. If a future Obsidian renames or
   restructures those elements the surface simply stops appearing: no note is
   altered, nothing is written, no journal data is at risk. Deliberately quieter
   than the editor exception's one-time notice — that one guards the plugin's
   core writing surface, where silence would leave the user wondering why
   editing feels wrong; this one is an optional, off-by-default, read-only
   convenience whose absence degrades nothing anybody depends on.
2. **Every DOM assumption lives in `mentions/mentionsFooter.ts`.** Retreating
   from this surface permanently, or moving to a future public API, must be a
   one-file change.

`tests/mentionsFooter.test.ts` pins rule 1: with neither layout element present,
the footer does nothing, throws nothing, adds nothing to the view, and leaves
the note byte-identical on disk. **That test must not be deleted.** It is the
reason this exception may be kept at all — an exception whose safety rule is
unenforced is not an exception, it is a hack with a paragraph attached.

The footer does not assume anything else: not the sizer's internals, not its
children, not its styling. It appends one plain div as a last child, never
reorders or removes what Obsidian put there, and in live preview it is a sibling
of `.cm-content` rather than inside it, so it is not part of the editable
document and cannot reach the user's text. The one remaining assumption is that
Obsidian will not silently discard a foreign child of the sizer — which is why
each sync re-checks where the footer actually is rather than trusting its own
bookkeeping, and simply mounts it again if it was removed or orphaned.

---

# Navigation

Required commands:

```text
Open journal
New journal entry
Go to today
```

Also implemented:

```text
Open calendar
Filter journal by tag
Open journal mentions
Insert journal mentions block
```

Still later:

```text
Search journal
```

When opening the journal, focusing the newest entries is the default.

The view should open at or near the top of the timeline.

## The calendar

A companion view in the sidebar, reachable by the `Open calendar` command and
also ensured present on every plugin load: if no calendar leaf exists anywhere
in the workspace, one is placed in the right sidebar automatically, without
stealing focus or revealing the sidebar. An earlier version placed it only once,
on first install, and never forced it again afterwards — the idea being that
Obsidian persists the workspace layout, so re-placing it on every load would put
it back for a user who deliberately closed it. That once-only policy was
abandoned because it permanently locked users out: once a saved layout lost its
calendar leaf for any reason, the plugin would never place it again, and the
only way back was a command few people had found in the first place.

It marks days holding entries with a dot, and today with emphasis. Those are two
different signals and must stay distinguishable: **the dot means "there is
something here", the emphasis means "this is today"**. Only days with a dot are
clickable; a day with nothing in it is inert, because clicking an empty square
and being taken months back into history contradicts the affordance the dot
establishes.

Clicking a day **anchors** the timeline to it: that day and everything older.
Anchoring, not filtering — the timeline stays continuous, which is the whole
product. A single-day filter was considered and rejected for that reason.

## Reaching capture from outside Obsidian

`obsidian://simple-journal-new` opens a new entry, so a phone home-screen shortcut or
any other launcher can capture a thought in one tap. It runs the same path as
the command and the ribbon icon; nothing about capture is duplicated for it.

Which vault receives the URI is Obsidian's decision, not this plugin's.

---

# Sorting

Internally, entries should be represented approximately as:

```ts
interface JournalEntry {
  file: TFile;
  created: Date;
  content?: string;
}
```

Do not treat filename ordering as the only source of chronology.

Resolve timestamps explicitly.

The default and required MVP sorting order is:

```text
newest → oldest
```

Example:

```ts
entries.sort(
  (a, b) => b.created.getTime() - a.created.getTime()
);
```

This order should naturally result in:

```text
12 August
  22:41
  17:23
  09:34

11 August
  21:10
  10:14
```

Do not sort days ascending and then reverse only entries, or vice versa.

The full timeline must be reverse chronological.

The architecture may allow an alternative sorting preference in the future, but this is not required for MVP.

---

# File Watching

The journal must react to changes made outside the journal view.

Examples:

* entry edited in a normal Obsidian editor
* entry created manually
* entry deleted
* entry renamed
* metadata changed

Use Obsidian's documented vault/workspace/metadata events.

Avoid aggressive polling.

Debounce refreshes where appropriate.

Do not cause update loops when the plugin itself saves an entry.

If an entry's `created` timestamp changes externally, reposition the entry correctly in the reverse-chronological timeline.

---

# Performance

A user may eventually have thousands or tens of thousands of journal entries.

Do not render the entire journal history into the DOM at once.

Because newest entries are shown first, initial loading should prioritize recent entries.

A sensible loading model is conceptually:

```text
load newest entries
↓
user scrolls downward
↓
load older entries
↓
continue into the past
```

This direction should shape pagination and incremental loading.

V1 does not need sophisticated virtualization if that would significantly increase complexity, but architecture must not assume that all historical entries stay mounted forever.

Prefer incremental loading, date windows, or another bounded rendering approach.

Optimize only after correctness, but avoid obviously unscalable decisions.

---

# Scroll Behavior

Reverse chronology does NOT mean reversing the DOM with CSS tricks.

Avoid implementations such as relying on:

```css
flex-direction: column-reverse;
```

as the primary data-ordering mechanism.

The data itself should be ordered correctly:

```text
newest → oldest
```

The DOM should represent the logical order.

This makes:

* accessibility
* keyboard navigation
* incremental loading
* focus handling
* selection
* scroll restoration

more predictable.

When older entries are loaded at the bottom, preserve the user's scroll position naturally.

---

# Settings

Keep V1 settings minimal.

Initial settings:

```text
Journal folder
```

Since added, both off by default and both covered by `# Mentions` Rule 5 —
they gate optional surfaces rather than configure the journal itself:

```text
Show mentions under notes
Mentions sidebar
```

Potential future settings:

```text
Folder pattern
Filename pattern
Timestamp format
Date header format
Autosave delay
Entries initially loaded
Focus newest entry on open
Sort order
```

Do not build all future settings in V1.

Avoid premature configurability.

Even if a future `Sort order` setting exists, the current product default is:

```text
Newest first
```

---

# Target Platforms

The MVP targets **desktop and mobile**.

`manifest.json` sets `isDesktopOnly: false`.

Mobile is not a separate UI. It is the same timeline and the same code paths, with:

* larger touch targets on the entry body
* an earlier incremental-loading threshold
* keeping the focused entry visible when the on-screen keyboard opens
* a lower cap on simultaneously mounted editors

Do not build a mobile-specific redesign.

**None of the mobile code has run on a device.** The keyboard-scroll
correction, the long-press menu and the touch targets were all written by
reasoning from documented behaviour, and their timings — 300 ms for the
keyboard, 500 ms for the long press — are guesses, not measurements. Treat them
as unverified until someone runs `docs/manual-testing.md` on a phone.

That caveat is not a formality. Losing a focus race on desktop took six
attempts to diagnose, four of which shipped without changing anything, because
the real ordering was not knowable from the source. A keyboard opening on a
real device is less predictable than that, not more.

---

# Compatibility With Obsidian

All journal entries must remain ordinary `.md` files inside the user's vault.

The plugin must work correctly if users interact with those files through:

* File Explorer
* Search
* Properties
* Backlinks
* Bases
* Dataview or similar plugins
* normal Markdown links

Do not require Obsidian Bases.

Bases compatibility is desirable but Bases is NOT the storage engine for this plugin.

---

# Optional Relationship With Daily Notes

This plugin is NOT a Daily Notes replacement and does not require Daily Notes.

A user may use:

```text
Daily Notes/
2026-08-12.md
```

and independently have:

```text
Journal/
2026/08/
2026-08-12-09-34-21.md
2026-08-12-17-42-10.md
```

Do not assume there is one journal document per date.

Later we may allow journal entries to link to a daily note automatically, but this is NOT required for V1.

---

# Bases

Do not make Bases a dependency.

However, journal entries should be easy to query using Bases because they are normal Markdown notes with structured properties.

A future optional feature may add metadata such as a link to another note, for example:

```yaml
context: "[[2026-08-12]]"
```

A Base embedded in that context note could then filter entries relevant to the embedding note.

Do not implement this until specifically requested.

---

# Journal View Reference

The open-source Obsidian plugin **Journal View by RUverse** is useful as a product and implementation reference.

Study it for ideas such as:

* continuous journal UX
* timeline navigation
* editor lifecycle
* scrolling
* autosave
* incremental loading
* view registration
* theme compatibility

But DO NOT blindly copy its architecture.

Its fundamental model is approximately:

```text
one day = one daily note
```

Our model is:

```text
one entry = one note
many entries = one day
```

This distinction must remain fundamental throughout the codebase.

Also remember that our timeline is:

```text
newest → oldest
```

with the newest journal entry at the top.

If reusing MIT-licensed source code, preserve all license and attribution requirements.

Prefer understanding and reimplementing concepts rather than unnecessarily copying large sections.

---

# Architecture

Prefer small focused modules rather than putting everything in `main.ts`.

A reasonable direction is:

```text
src/
  main.ts

  journal/
    entry.ts
    entryRepository.ts
    entryDate.ts

  views/
    JournalView.ts
    DayGroup.ts
    EntryEditor.ts

  mentions/
    mentionQuery.ts
    MentionsPanel.ts
    mentionsCodeBlock.ts
    MentionsView.ts
    mentionsFooter.ts

  services/
    journalService.ts

  settings/
    settings.ts
    SettingsTab.ts

  utils/
    dates.ts
```

This is a guideline, not a mandatory structure.

Responsibilities should stay separated.

---

# EntryRepository

Responsible for:

* discovering journal entry files
* parsing entry metadata
* creating entry files
* reading/writing entry content
* deleting entries
* resolving timestamps
* sorting/querying entries

Repository queries should naturally support reverse chronological retrieval.

Conceptually:

```ts
getEntries({
  before?: Date,
  limit?: number
});
```

is preferable to an architecture that assumes forward chronological pagination.

It should know about files.

It should NOT know about UI.

---

# JournalView

Responsible for:

* timeline
* reverse chronological grouping
* scrolling
* focus
* loading/unloading entries
* loading older history as the user scrolls downward
* reacting to repository updates

It should not contain file parsing logic.

## What has been split out, and what deliberately has not

Four seams are separate modules, each a `createX(deps)` closure over the state it
owns, with the view keeping DOM and wiring:

* `entrySave.ts` — the debounced write path, its tokens, and the failure marker
* `mountLifecycle.ts` — mounting, unmounting, the mount order and the cap
* `timelineDom.ts` — day groups, month headers, insert position
* `changeApplication.ts` — applying a vault-change batch to the rendered rows

Beside them sit pure decision functions, unit tested directly and holding no DOM:
`mountWindow.ts`, `applyChange.ts`, `composerCommit.ts`, `entryIndex.ts`.

**Reload and composer orchestration stays in `JournalView`, on purpose.** It owns
`generation` and `timelineMutationChain`, which every other module's guards check
against, and it was assessed for extraction and rejected:

* Its methods are not self-contained. `reloadNow` drives the paging and observer
  cluster; `openComposer` and `startNewEntry` reach into `createEntryEl`, day
  groups, scrolling and anchoring. Moving only the named methods would cut a
  boundary through the interaction between `openComposer`'s focus claim,
  `reloadNow`'s awaits, and Obsidian's own focus timing — the one that took six
  attempts to diagnose (see the case study in `docs/manual-testing.md`). A
  recurrence would then have to be read across files instead of in a straight
  line.
* Moving everything it touches would leave the view nearly empty. That is not a
  seam, it is a rewrite.
* The remaining modules read `generation` from here; a module owning it would
  also have to call back into them, creating a circular dependency none of the
  four existing seams has.

Extract something here only if it has a genuinely one-directional interface.
Neither the composer nor the reload path does. Splitting the mutation chain
alone (~30 lines) is narrow but addresses nothing — the bulk of what remains is
the composer's data-safety logic, which is the most expensive code in this
plugin to get wrong and the least helped by a boundary running through it.

---

# EntryEditor

Responsible for:

* rendering one entry
* editing
* saving
* focus behavior
* keyboard interactions

It should not own journal-wide sorting.

---

# Development Principles

Use:

* TypeScript
* current Obsidian plugin APIs
* strict typing where practical
* native Obsidian CSS variables
* small modules
* explicit cleanup of event handlers/listeners
* clear lifecycle management

Avoid:

* React unless there is a compelling reason
* external databases
* cloud services
* network requests
* telemetry
* unnecessary dependencies
* undocumented Obsidian internals — except the single sanctioned editor exception described under **Editing**
* storing journal content in plugin settings
* giant `main.ts` files
* premature abstractions

This plugin should work entirely locally.

---

# Security and Privacy

Journal content is highly personal.

The plugin must:

* make no network requests
* collect no telemetry
* send no journal content anywhere
* require no account
* keep content entirely inside the vault

Any future feature that changes this would require an explicit product decision.

---

# Error Handling

Never risk data loss.

When uncertain:

* preserve the Markdown file
* fail visibly
* log a useful developer error
* avoid destructive automatic recovery

Never overwrite a file if a collision occurs.

Filename creation must handle two entries created within the same second.

Use a deterministic collision strategy such as adding a suffix.

---

# Testing Priorities

Prioritize tests around data integrity and ordering.

Important cases:

1. Create one entry.
2. Create several entries on the same day.
3. Create entries within the same second.
4. Load entries across multiple days.
5. Entry with valid `created`.
6. Entry without `created`.
7. Entry with malformed `created`.
8. Entry with arbitrary frontmatter.
9. Editing does not destroy frontmatter.
10. Editing from another Obsidian pane updates the journal.
11. Deleting an entry updates the timeline.
12. Restarting Obsidian preserves everything.
13. Empty composer does not create garbage files.
14. Unicode and Turkish characters work correctly.
15. Wikilinks remain valid.
16. Markdown formatting remains intact.
17. Days are ordered newest → oldest.
18. Entries within each day are ordered newest → oldest.
19. A newly created entry appears at the top.
20. Changing an entry timestamp externally moves it to the correct position.
21. Loading older entries does not disturb the current scroll position.

---

# MVP Definition

**Status: met.** All seven steps below work, and the two assumptions they rested
on that could only be settled in a running Obsidian have been verified by hand —
that the embedded editor does not reload its buffer over in-flight typing, and
that a throw inside `vault.process` writes nothing. See `docs/manual-testing.md`.

Kept here as the definition of "working", not as a to-do list: a change that
breaks any of these seven has broken the product, whatever else it improves.

The first usable MVP is deliberately narrow.

It is complete when the following flow works reliably:

## 1. Open Journal

A command opens a custom Journal view.

The newest entries are visible first.

## 2. See Entries

Existing Markdown entry files from the configured Journal folder appear in a continuous timeline grouped by day.

The complete ordering is:

```text
newest → oldest
```

## 3. Create

The user can create a new titleless journal entry from the Journal view.

The new entry appears at the top of today's entries.

## 4. Edit

The user can edit an entry without navigating away from the timeline.

## 5. Persist

Changes are safely stored in the underlying Markdown file.

## 6. External Changes

If the same Markdown file changes elsewhere in Obsidian, the journal view eventually reflects it.

## 7. Normal Markdown

The created entry remains a completely ordinary Obsidian note.

Anything beyond these seven requirements is secondary until they are reliable.

---

# Non-Goals

The MVP above is met, and a few things have deliberately been built past it —
the calendar, the capture URI, timeline anchoring, correcting an entry's time,
the tag scope, and the three mention surfaces. Each is documented in its own
section as a product decision, not left as an undocumented feature.

Still NOT to implement:

* AI features
* mood tracking
* prompts
* analytics
* streaks
* activity heatmaps — the calendar marks which days hold entries, deliberately
  as a plain dot; density shading is a different feature and remains out
* multiple journals
* encryption
* sync
* templates
* automatic tagging
* semantic search
* daily summaries
* weekly/monthly reviews
* Bases integration
* advanced filters, except the tag scope described under `# Tags` — a single
  tag, chosen from one command, never persisted
* alternative sort modes
* single-day filtering — clicking a calendar day anchors the timeline rather
  than filtering it; see the calendar section for why

And, specific to `# Mentions`:

* filtering a mentions panel by tag, or by date range
* querying more than one note at a time — one panel answers for one note
* a sort-order option for the panel; it is the journal's order, which is a
  North Star principle and not a preference
* editing an entry from inside a panel — see `# Mentions` Rule 4
* a "new entry mentioning this note" button
* counting plain-text occurrences of a note's name as mentions
* replacing or modifying Obsidian's own backlinks pane. Mentions sit beside it
  and answer a narrower question; the pane keeps working exactly as it did

Mobile is no longer a non-goal, but it is still **not a separate UI**: see
`# Target Platforms`. The same timeline and the same code paths, adapted, never
redesigned.

Do not expand scope unless explicitly asked. "Past the MVP" is not licence to
keep going — every addition above was asked for.

---

# Working Style for Claude

Before implementing a feature:

1. Inspect the existing repository.
2. Understand the relevant code.
3. Check current official Obsidian documentation for APIs that may have changed.
4. If useful, inspect Journal View as an implementation reference.
5. Explain the intended change briefly.
6. Implement the smallest coherent solution.
7. Run type checking/build/tests.
8. Fix errors before moving on.
9. Summarize what changed and what remains.

Do not make broad unrelated refactors.

Do not silently change established product decisions in this file.

If an implementation detail conflicts with a product requirement here, preserve the product requirement and propose another implementation.

When there is ambiguity, prefer:

* simpler UX
* fewer controls
* native Obsidian behavior
* Markdown portability
* data safety
* minimal scope

above cleverness.

---

# North Star

Always preserve these five principles:

1. **Every journal entry is its own Markdown note.**
2. **Journal entries do not need titles.**
3. **The newest journal entry is always at the top.**
4. **The timeline hides filesystem complexity from the user.**
5. **The user's Markdown remains portable, local, and safe.**
