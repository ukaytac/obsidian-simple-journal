# CLAUDE.md

## Project

We are building an Obsidian community plugin for **entry-based journaling**.

The working name is **Journal Entries**. The final product name may change later.

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

---

# Entry Metadata

The minimum recommended frontmatter is:

```yaml
---
created: 2026-08-12T17:23:41+03:00
---
```

Then immediately the journal content:

```markdown
---
created: 2026-08-12T17:23:41+03:00
---

Today I realized...
```

No heading is required.

`created` represents the journal entry's creation time and should normally remain immutable.

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
* Delete entry

Do not clutter every entry with permanently visible action buttons.

Use hover actions, context menu, or another subtle native interaction.

Deletion must use safe Obsidian file APIs and should respect Obsidian's normal trash behavior where possible.

---

# Navigation

Required commands:

```text
Open journal
New journal entry
Go to today
```

Later:

```text
Go to date
Search journal
```

When opening the journal, focusing the newest entries is the default.

The view should open at or near the top of the timeline.

Do not make calendar navigation part of the first implementation unless core architecture already supports it cleanly.

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

# Non-Goals for MVP

Do NOT implement yet:

* AI features
* mood tracking
* prompts
* analytics
* streaks
* calendar heatmaps
* multiple journals
* encryption
* sync
* mobile-specific redesign
* templates
* automatic tagging
* semantic search
* daily summaries
* weekly/monthly reviews
* Bases integration
* advanced filters
* alternative sort modes

Do not expand scope unless explicitly asked.

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
