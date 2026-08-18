# The internal embedded-editor API

Findings from the Task 8 spike. This file is the contract `ObsidianEmbedEditor`
is written against. Obsidian does not document any of it, so everything here is
empirical — measured, not read from a reference.

**Tested on:** Obsidian 1.8.9, macOS, desktop.
**Not yet tested:** mobile, popout windows.

## Availability

`app.embedRegistry.embedByExtension` exists and holds 25 extensions:
`md`, image formats, audio, video, `pdf`, `canvas`, `base`.

`embedByExtension.md` is a **function**. That is the feature-detection probe
`hasEmbeddedEditorApi()` performs.

## Constructing an editable embed

```ts
const creator = app.embedRegistry.embedByExtension.md;
const embed = creator({ app, containerEl, showInline: true, depth: 0 }, file, "");

embed.editable = true;
embed.load();
embed.showEditor();
```

Order matters. `editMode` does **not** exist on a freshly created embed — it is
constructed lazily by `showEditor()`. Reading `embed.editMode` before that
returns undefined, which is what made the first spike pass look like the API had
a different shape than it does.

After that sequence:

| Path | What it is |
| --- | --- |
| `embed.editMode` | The edit-mode component |
| `embed.editMode.cm` | A real CodeMirror 6 `EditorView` |
| `embed.editMode.get()` | Current document text |
| `embed.editMode.set(value, clearHistory)` | Replaces the document |
| `embed.editor` | A real Obsidian `Editor` (`{ editorComponent, cm, containerEl }`) |
| `embed.editMode.editorSuggest` | The `[[` autocomplete engine |
| `embed.editMode.livePreviewPlugin` | Live preview |
| `embed.editMode.clipboardManager`, `.search` | Paste handling, in-editor search |

Confirmed working by hand in a real window: typing, live preview, and `[[`
autocomplete listing real vault files with the "Type # to link to a heading"
hint. This is the full Obsidian editing surface, not an approximation.

## get() and set() operate on the whole document

This is the most important finding, and it diverges from what the plan assumed.

`editMode.get()` returns the **entire file including the frontmatter block**:

```
---
created: "2026-01-01T00:00:00+03:00"
mood: "probe"
---

ORIGINAL BODY LINE ONE.
```

`editMode.set("REPLACED BODY.\n", false)` replaces the **entire document**, so
the frontmatter is gone from the editor's buffer afterwards — `get()` then
returns only `"REPLACED BODY.\n"`.

Related fields:

| Field | Value observed |
| --- | --- |
| `embed.text` | The full file, same as `get()` |
| `embed.rawFrontmatter` | Frontmatter body without the `---` delimiters |
| `embed.data` | Empty string |
| `embed.lastSavedData` | The full file as last loaded or saved |
| `embed.dirty` | `false` after `set()` — a programmatic set does not dirty it |

`embed.metadataEditor` manages the properties panel separately, driven by
`rawFrontmatter`.

**Consequence for this plugin.** `EntryEditor`'s contract is body-only: the view
passes `readBody()` output in and writes `writeBody()` output back, and
`replaceBody` is what guarantees a user's arbitrary frontmatter survives. So
`ObsidianEmbedEditor.mount` must overwrite the embed's self-loaded full-document
buffer with the body alone, and every later `get()` then returns the body.

That leaves a hazard: with a body-only buffer, anything that makes the **embed
itself** write the file would persist a document with no frontmatter — the
`created` property would be destroyed and the entry would lose its place in the
timeline. See the next section.

## The embed does not autosave

Measured directly. After `editMode.set(...)`, then a 2.5 second wait with no
call of any kind, then `unload()` and `onunload()`:

- `dirty` stayed `false` throughout
- the file on disk was **byte-identical** to its seeded contents at every check

So the embed does not write the file on its own, and unloading does not flush.
This plugin's own debounced `vault.process` + `replaceBody` path remains the
single writer, exactly as the plan assumed. There is no two-writer conflict.

Still open, being measured in the next spike pass: whether a **real keystroke**
(as opposed to a programmatic `set()`) marks the embed dirty and schedules its
own `requestSave()`. `editMode`'s prototype has an `onUpdate` hook and the embed
has `requestSave`, `saving` and `saveAgain` fields, so the machinery exists.
If typing does trigger it, `ObsidianEmbedEditor` must neutralise that path
rather than let it write a frontmatter-less document.

## DOM chrome that must be hidden

The embed renders more than an editor. All five of these were present:

```
.markdown-embed-title      the embed's own title bar
.inline-title              the note's editable inline title
.metadata-container        the properties panel
.markdown-embed-link       the "open this note" arrow
.cm-editor                 the actual editor — the one thing we want
```

The host's direct children come out as:

```
embed-title markdown-embed-title
markdown-embed-content node-insert-event    (preview)
markdown-embed-content node-insert-event    (editor)
markdown-embed-link
```

Two `markdown-embed-content` nodes exist because preview and edit modes are both
constructed. Only the editor one should be visible.

Hiding the title and the properties panel is not cosmetic: `CLAUDE.md`'s "no
titles" rule is a core product decision, and the inline title is **editable** —
the embed has `inlineTitleEl`, `saveTitle`, `onTitleChange` and
`fileBeingRenamed`, so text typed there renames the underlying file. A journal
entry's filename is an internal identifier and must never be user-editable from
the timeline.

## Things that did not work, so nobody retries them

- Reading `embed.editMode` before calling `showEditor()`. It is undefined.
- Expecting `embed.data` to hold the body. It is an empty string.
- Expecting `get()` to return the body without frontmatter. It does not.

## Mobile (Task 18) — not yet measured on a device

Everything above was measured on desktop only. Task 18 added mobile-only
timing and gesture code in `JournalView.createEntryEl` (the keyboard-scroll
correction and the long-press menu) reasoning from documented, public
behaviour — `Platform.isMobile`, `focusin`/`focusout`, `touchstart`/`touchmove`
/`touchend`/`touchcancel`, `scrollIntoView` — rather than anything in this
file's undocumented-internals territory. Still, none of it has run against a
real phone or tablet, so the following need a device before they can be
trusted rather than merely reasoned about:

- **The 300ms keyboard-scroll delay and the 500ms long-press threshold** are
  both guesses, not measurements. If the on-screen keyboard's open animation
  takes meaningfully longer than 300ms on a real device, the correction fires
  before the viewport has actually finished shrinking and undershoots; if
  500ms reads as too fast or too slow against the platform's own long-press
  convention, it will feel wrong next to the OS's other long-press gestures.
- **Whether `window.visualViewport`'s `resize` event fires on keyboard open
  inside Obsidian's mobile shell** — a WKWebView on iOS, a different WebView
  on Android — was deliberately left unused rather than guessed at (see the
  "KNOWN LIMITATION" comment on the `focusin` listener in
  `JournalView.createEntryEl`). If it turns out to fire reliably on both, a
  future pass could scroll the actual caret into view above the keyboard
  instead of `scrollIntoView`-ing the whole entry element, which is a no-op
  once the entry already spans the scrollport (the long-entry case this
  exists for).
- **The long-press gesture's feel against the platform's own scroll and
  text-selection gestures.** The bail on `.journal-entry-body` and the
  `touchmove`/`touchend`/`touchcancel` cancellation are reasoned to avoid
  fighting native scrolling and the editor's own selection handling, but
  whether a real 500ms hold ever gets far enough to register before a
  scroll's own `touchmove` cancels it — or, conversely, whether it ever
  fires unwantedly during an intended scroll — is unverified.
- **The `hover: none` vs. `.is-mobile` opacity stacking** (see `styles.css`):
  the entry-actions button is expected to render at 0.5 opacity at rest and
  1 while focused on the real mobile app, and at full opacity (the older
  `hover: none` rule) on any other touch device that isn't `.is-mobile`
  (e.g. a touchscreen laptop running desktop Obsidian). Only measured by
  reading the CSS cascade, not by looking at a rendered page.

See `docs/manual-testing.md`'s mobile section for the checklist items these
map to.
