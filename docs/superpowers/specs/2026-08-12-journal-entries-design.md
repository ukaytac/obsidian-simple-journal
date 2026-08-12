# Journal Entries — MVP Design

Date: 2026-08-12
Status: Approved

## 1. Scope

An Obsidian community plugin providing a continuous, reverse-chronological journal
timeline where **one journal entry is one Markdown file**. Product principles,
storage layout, and non-goals are defined in `CLAUDE.md` and are not repeated here.
This document specifies the architecture chosen to implement the MVP.

Target platforms: desktop **and** mobile.
Starting state: empty vault, no migration required.

## 2. Decisions taken during brainstorming

These override or extend `CLAUDE.md`; `CLAUDE.md` will be updated to match.

1. **Editing uses Obsidian's internal embedded editor.** The primary editor
   implementation mounts a real Obsidian Markdown editor via
   `app.embedRegistry.embedByExtension["md"]` — the same mechanism Obsidian uses
   for Canvas cards and callout editing. This gives live preview, `[[` autocomplete,
   editor commands, embeds, vim mode, and theme parity.

   This is a deliberate exception to the `CLAUDE.md` rule "do not depend on
   undocumented internal APIs". Rationale: full Obsidian editing fidelity is a
   product requirement, and no public API provides an editable embedded editor
   (`MarkdownRenderer.render()` is read-only; `Editor` is reachable only from an
   active `MarkdownView`).

2. **Feature detection with fallback is mandatory.** At plugin load the internal
   API is probed. If unavailable, the plugin falls back to a plain `<textarea>`
   editor and shows a one-time `Notice`. The journal never becomes unusable and
   no data is at risk.

3. **All loaded entries are live editors**, not click-to-edit, bounded by a mount
   limit (see §5).

## 3. Module structure

Dependencies flow in one direction only.

```
JournalView ──► JournalService ──► EntryRepository ──► Vault / MetadataCache
     │                                    ▲
     └──► EntryEditor (interface)         │
              ├─ ObsidianEmbedEditor      │  primary
              └─ TextareaEditor           │  fallback
```

```
src/
  main.ts                      plugin lifecycle, commands, editor feature detection
  journal/
    entry.ts                   JournalEntry type
    entryDate.ts               TFile -> Date resolution (isolated, pure)
    entryRepository.ts         file discovery, CRUD, reverse-chronological queries
  services/
    journalService.ts          in-memory index, vault event handling, debouncing
  views/
    JournalView.ts             timeline, day groups, paging, scroll, mount window
    DayGroup.ts                one calendar day's DOM
    EntryEditor.ts             editor interface + factory
    ObsidianEmbedEditor.ts     internal embedded editor implementation
    TextareaEditor.ts          fallback implementation
  settings/
    settings.ts                settings type + defaults
    SettingsTab.ts             settings UI
  utils/
    dates.ts                   formatting, day keys, filename timestamps
```

### 3.1 `entryDate.ts`

Single responsibility: resolve a `TFile` to its entry timestamp.

Resolution order:

1. Valid `created` frontmatter property (ISO 8601, read from `MetadataCache`).
2. Timestamp parsed from the plugin's filename convention.
3. `file.stat.ctime` as a last resort.

A malformed or missing `created` never drops an entry from the timeline.

### 3.2 `entryRepository.ts`

Knows about files. Knows nothing about UI.

- Discovers entry files under the configured journal folder.
- `getEntries({ before?: Date, limit?: number })` — reverse-chronological paging.
- Creates entries: writes `Journal/YYYY/MM/YYYY-MM-DD-HH-mm-ss.md` with only a
  `created` frontmatter property and no heading.
- Reads/writes entry body via `vault.process()` (atomic read-modify-write).
- Deletes via `fileManager.trashFile()` so Obsidian's trash setting is respected.

Writes touch the body region only. Unknown frontmatter properties are preserved
byte-for-byte; nothing is normalized or reordered.

### 3.3 `journalService.ts`

Holds a sorted in-memory index of `{ path, created }` — never entry content, so
the index stays cheap at tens of thousands of entries.

Subscribes to `vault.on('create' | 'modify' | 'delete' | 'rename')` and
`metadataCache.on('changed')`, debounced at 300 ms, and emits granular change
notifications to the view.

Self-write loop prevention: paths written by the plugin are marked before the
write and the corresponding `modify` event is ignored once.

### 3.4 `EntryEditor`

```ts
interface EntryEditor {
  mount(el: HTMLElement, file: TFile | null): void;
  getValue(): string;
  setValue(content: string): void;
  focus(): void;
  destroy(): void;
  onChange(cb: (value: string) => void): void;
}
```

Two implementations selected once at load time. All internal-API usage is confined
to `ObsidianEmbedEditor.ts`, so a future public API — or a forced retreat to the
fallback — is a single-file change.

## 4. Timeline rendering

The DOM mirrors the logical order exactly: newest day first, newest entry first
within each day. No `column-reverse` or other CSS reversal.

```
.journal-timeline
  .journal-month-header          AUGUST 2026        (only when the month changes)
  .journal-day        [data-date="2026-08-12"]
    .journal-day-header          WEDNESDAY, 12 AUGUST
    .journal-entry    [data-path="..."]
      .journal-entry-time        22:41
      .journal-entry-body        <- editor mounts here
```

Visual treatment: no cards, borders, shadows, or gradients. Entries are separated
by whitespace and a muted timestamp. All colors and typography come from Obsidian
CSS variables so light/dark themes work without plugin-specific theming.

## 5. Loading, paging, and the mount window

**Initial load:** `getEntries({ limit: 40 })`.

**Paging:** an `IntersectionObserver` watches a sentinel element at the bottom of
the timeline. When it becomes visible, the next page is fetched with
`getEntries({ before: oldestLoaded, limit: 40 })` and appended **below**. Appending
below does not shift content above it, so scroll position is preserved naturally
with no manual correction — this is the structural benefit of reverse chronology.

**Mount window:** every loaded entry is a live editor, capped at ~60 mounted
editors on desktop and ~25 on mobile. When the cap is exceeded, the editors
furthest down the list (oldest, furthest from the viewport) are destroyed and
replaced by static `MarkdownRenderer.render()` output. Scrolling back up remounts
them. The focused editor is never unmounted.

**Height stability:** editor and static render share the same typography variables
(`--font-text`, `--line-height-normal`). The measured height is applied as
`min-height` before unmounting and removed after remounting, so the swap does not
shift the scroll position.

## 6. Entry creation

`New journal entry`:

1. Open the journal view if it is not already open.
2. Scroll to the top of the timeline.
3. Mount an empty composer at the top of today's day group. **No file is created yet.**
4. Focus the composer.
5. On the first meaningful content, `EntryRepository` creates the Markdown file
   and the composer binds to it, becoming an ordinary entry.

The user is never asked for a filename, title, folder, or date.

If today is already at the top of the viewport, no scroll jump occurs. If the user
is viewing older history, the view returns to today.

**Lazy creation:** an empty composer never produces a file. Once a file exists it is
never auto-deleted, even if its text is temporarily emptied. Deletion is always explicit.

## 7. Saving

Editor `onChange` → 500 ms debounce → `vault.process(file, ...)` replacing only the
body region. The write is marked so the resulting `modify` event does not trigger a
re-render of the entry being typed in.

## 8. External change handling

For an entry inside the loaded window:

- Content changed externally → the editor value is updated, unless that editor is
  currently focused.
- `created` changed externally → the entry is removed from the DOM and reinserted
  at its correct reverse-chronological position, moving between day groups if needed.
- Deleted or renamed → the DOM node is removed or its `data-path` updated.

For an entry outside the loaded window, only the in-memory index is updated.

## 9. Commands and settings

Commands (all hotkey-assignable): `Open journal`, `New journal entry`, `Go to today`.
One ribbon icon, which opens the journal.

Settings (V1): **`Journal folder`** only, default `Journal`. The folder is created
silently when the first entry is written. Folder structure (`YYYY/MM/`) and filename
format (`YYYY-MM-DD-HH-mm-ss.md`) are fixed in V1. No premature configurability.

## 10. Entry actions

A single `⋯` button appears to the right of the timestamp on hover (opacity 0 → 1);
long-press on mobile. Menu: `Open source note`, `Copy link`, `Delete entry`.
Deletion asks for confirmation and uses `fileManager.trashFile()`.

No permanently visible action buttons on entries.

## 11. Mobile

Same timeline and same code paths. Differences:

- Larger padding on the entry body for touch targets.
- Earlier `IntersectionObserver` threshold to compensate for slower scrolling.
- On editor focus, `scrollIntoView({ block: 'nearest' })` keeps the focused entry
  visible when the on-screen keyboard opens.
- Lower editor mount cap (~25).

`manifest.json` sets `isDesktopOnly: false`.

## 12. Error handling

Never risk data loss. When uncertain: preserve the Markdown file, fail visibly,
log a useful developer error, avoid destructive automatic recovery.

- **Filename collision** (two entries within the same second): deterministic suffix,
  `...-22-41-52-2.md`. Guarded twice — an `exists` check plus `vault.create`'s own
  failure on an existing path. A file is never overwritten.
- **Write failure:** the editor keeps its content in the DOM, a visible
  "could not save" marker appears on the entry, and details go to the console.
  Failures are never swallowed silently.
- **Malformed or missing `created`:** the entry is kept and `entryDate` falls back.
  The timeline does not break.
- **Frontmatter:** never normalized. Only the body region is written.
- **Internal editor API missing:** textarea fallback plus a one-time `Notice`.

## 13. Testing

`vitest` with a thin mock of the Obsidian API.

Automated — cases 1–9 and 17–20 from `CLAUDE.md` (repository, `entryDate`, and
ordering are pure logic and fully mockable):

- create one entry; several on one day; several within one second
- entries across multiple days
- valid / missing / malformed `created`
- arbitrary frontmatter preserved through an edit
- days ordered newest → oldest; entries within a day ordered newest → oldest
- a new entry appears at the top
- an externally changed timestamp repositions the entry

Manual, documented in `docs/manual-testing.md` — cases 10–16 and 21, which require
a real Obsidian instance:

- editing from another pane updates the journal
- deleting an entry updates the timeline
- restarting Obsidian preserves everything
- an empty composer creates no file
- Unicode and Turkish characters, wikilinks, Markdown formatting survive a round trip
- loading older entries does not disturb scroll position

## 14. Definition of done

The MVP is complete when the seven-step flow in `CLAUDE.md` § MVP Definition works
reliably on both desktop and mobile: open journal → see entries → create → edit →
persist → reflect external changes → entries remain ordinary Markdown notes.
