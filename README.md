# Simple Journal

An Obsidian plugin for entry-based journaling.

One journal entry is one Markdown file. A day holds as many entries as you
wrote that day. The plugin shows them all in a single continuous timeline,
newest first, directly editable — so you think about writing, not about
files.

## What it does

- **No titles.** Entries are identified by their timestamp. Nothing asks you
  for a name, a folder, or a date.
- **Newest first.** Days run newest to oldest, and so do the entries inside
  each day.
- **Directly editable.** Every entry in the loaded timeline is a live,
  full-fidelity Obsidian editor — `[[` link autocomplete, live preview, and
  editor commands all work — not a click-to-edit placeholder. Entries far
  outside the viewport fall back to static rendering and remount as you
  scroll back to them.
- **Ordinary Markdown.** Every entry is a normal note in your vault. Links,
  tags, properties, search, backlinks, graph, Bases, Dataview, and other
  plugins all work.
- **Reacts to changes made elsewhere.** Edit an entry from another pane,
  rename it, delete it, or change its `created` property — the timeline
  updates to match.
- **Local only.** No network requests, no telemetry, no account. Your journal
  never leaves your vault.

## Storage

```
Journal/
└── 2026/
    └── 08/
        ├── 2026-08-12-09-34-21.md
        ├── 2026-08-12-14-17-03.md
        └── 2026-08-12-22-41-52.md
```

Each file carries a single `created` property and your text. No heading is
added. Two entries created in the same second get a numeric suffix
(`-2`, `-3`, ...) rather than overwriting each other.

## Commands

| Command | What it does |
| --- | --- |
| `Open journal` | Opens the timeline (also available from the ribbon icon) |
| `New journal entry` | Returns to today and focuses a fresh entry |
| `Go to today` | Scrolls the timeline back to the top |
| `Open calendar` | Reveals the calendar in the sidebar |

`obsidian://simple-journal-new` starts a new entry too, so a phone
home-screen shortcut can capture a thought in one tap.

An entry is not written to disk until you actually type something in a fresh
composer — an empty composer that never receives text leaves no file behind.

## Calendar

A compact month calendar sits in the right sidebar, placed there automatically.
Days that hold entries are marked with a dot; today is emphasised. Only marked
days are clickable — an empty square does nothing, because being thrown months
back by an accidental tap is worse than nothing happening.

Clicking a day **anchors** the timeline to it: that day and everything older.
It anchors rather than filters, so the journal stays one continuous timeline
that you can keep scrolling into the past.

## Entry actions

Hover an entry (or long-press it on mobile) to reveal its actions menu:
open the source note, copy a link to the entry, change its time, or delete it.
Deletion goes through Obsidian's own trash/delete-confirmation flow, so it
respects your vault's configured trash behaviour.

**Change entry time** exists because the timestamp is what places an entry in
the timeline, and the timeline deliberately hides the properties panel — so a
wrong timestamp would otherwise have no remedy from where you are reading. It
rewrites only the `created` property, leaving every other property you have
added exactly as it was, and renames the file to match when the file still
follows the plugin's own naming convention.

## Settings

**Journal folder** — the vault folder that holds journal entries. Defaults to
`Journal`, and is created automatically when the first entry is written.

## Platforms

Works on both desktop and mobile — the same timeline and the same code paths,
with larger touch targets, an earlier incremental-loading threshold, and a
lower cap on simultaneously mounted editors on mobile.

## A note on the editor

Obsidian exposes no public API for an editable editor embedded in a custom
view. To give entries the full Obsidian editing experience — not an
approximation — this plugin uses an internal mechanism
(`app.embedRegistry.embedByExtension`), isolated behind an `EntryEditor`
interface in a single file, `src/views/ObsidianEmbedEditor.ts`.

This is a deliberate, narrow exception to an otherwise strict "no undocumented
internals" rule. Two things make it safe:

- **Feature detection with fallback.** The internal API is probed once at
  plugin load. If it's unavailable, the plugin falls back to a plain
  `<textarea>` editor and shows a one-time notice — the journal keeps working
  either way, and no journal data is ever put at risk.
- **One-file confinement.** All internal API usage lives behind the
  `EntryEditor` interface in that one file, so a future Obsidian change, or a
  future public API, is a one-file change to adapt to.

See `docs/editor-embed-api.md` for the empirical contract this was built
against.

## Development

```bash
npm install
npm run dev       # watch build
npm test          # unit tests
npm run test:tz   # unit tests under a non-local timezone (America/New_York)
npm run build     # typecheck + production build
```

`npm run sync` copies the built plugin into a vault's plugins folder for
manual testing (`OBSIDIAN_VAULT="/path/to/vault" npm run sync`).

See `docs/manual-testing.md` and `docs/manual-testing-editor.md` for the
checks that need a real Obsidian instance rather than the unit test suite.

## License

MIT
