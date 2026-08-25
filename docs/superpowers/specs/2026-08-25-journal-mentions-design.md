# Journal Mentions — Design

Date: 2026-08-25
Status: Approved

## 1. Scope

How a note learns which journal entries mention it, and how those entries are shown
with their content — inside the note, beside it, or both.

Product principles, storage layout, and non-goals are defined in `CLAUDE.md` and are
not repeated here, except where this design changes them (§10).

Starting state: the plugin has no link handling at all. `resolvedLinks`,
`registerMarkdownCodeBlockProcessor` and `registerMarkdownPostProcessor` appear
nowhere in `src/`. The only `MarkdownRenderer` use is the timeline's static
fallback for unmounted entries.

## 2. The question this design answers

A journal entry has no title. That is a North Star principle, and everywhere inside
the timeline it works, because the timestamp identifies the entry and the content is
right there.

Outside the timeline it stops working. Obsidian's own backlinks pane lists a
backlink by **filename**, and this plugin's filenames are `2026-08-12-14-17-03`.
So a person note like `Ekin Arslan Aytaç.md` shows a column of identical-looking
timestamps and a truncated snippet each — the one view of the journal where
titlelessness costs the user something instead of saving them something.

What the user wants is not a list of links. It is the entries themselves, with their
content, in the journal's own reverse-chronological shape, under the note that
they are about.

That is the gap. Everything below follows from it.

## 3. Rules

### Rule 1 — One query, source-blind

A single module, `mentions/mentionQuery.ts`, resolves which entries mention a note.
It draws no distinction between a link in the body, an embed, and a link in
frontmatter:

| | body `[[X]]` | body `![[X]]` | frontmatter `people: "[[X]]"` |
| --- | --- | --- | --- |
| Cached as | `CachedMetadata.links` | `CachedMetadata.embeds` | `CachedMetadata.frontmatterLinks` (`@since 1.4.0`) |
| Graph / backlinks pane | identical | identical | identical |
| This plugin | identical | identical | identical |

This mirrors `entryTags.ts` Rule 1 exactly, and for the same reason: Obsidian does
not ask which kind a reference is, so neither do we. Nothing downstream may ask.

An **unresolved** link (pointing at a note that does not exist) is not a mention.
Neither is a plain-text occurrence of the note's name. Full-text matching is
semantic search by another name, and that is a documented non-goal.

### Rule 2 — Query the journal, not the vault

The question is never "what links to this note?" It is "which *journal entries* link
to this note?" — a much smaller question, and one the plugin can already answer
cheaply, because `JournalService` keeps a sorted index of every entry.

So: iterate the entry index, and for each entry ask
`metadataCache.resolvedLinks[entry.file.path]?.[target.path]`.

`resolvedLinks` is `@public` and documented in the installed `obsidian.d.ts`. It
maps source path → destination path → count, so alias resolution
(`[[Ekin Arslan Aytaç|Ekin]]`), relative paths and shortest-path links are all
handled by Obsidian before we look.

**`getFileBacklinks` is deliberately not used.** It appears in Obsidian's published
developer docs but is **absent from the installed type definitions**, which makes it
an undocumented internal by this project's standard. It would also answer the wrong
question — vault-wide — at greater cost.

*Implementation note:* a unit test pins the expectation that `resolvedLinks`
includes frontmatter links. If that ever regresses, the fallback is an explicit
per-entry scan of `cache.links` + `cache.embeds` + `cache.frontmatterLinks`, each
resolved through `metadataCache.getFirstLinkpathDest`. That fallback is a change to
one function in one module.

### Rule 3 — One renderer, three shells

Three surfaces show the same thing. They are not three features.

`mentions/MentionsPanel.ts` is the single renderer:

```ts
createMentionsPanel({ app, plugin, container, target }): {
  render(): Promise<void>;
  destroy(): void;
}
```

It owns the header, the day grouping, the read-only rendered entry content, the
"Show more" control, and the subscriptions that keep it current. It knows nothing
about *why* it was mounted.

The three shells each do one job — obtain a container and a target `TFile` — and
delegate. A change to how mentions look or behave is a change to one file.

### Rule 4 — Read-only, with a way back to the timeline

Entry content is rendered with `MarkdownRenderer.render`, so wikilinks, embeds,
inline tags and formatting all work exactly as they do anywhere else. It is not
editable.

Editing is what the timeline is for. Clicking an entry's timestamp calls the
existing `plugin.goToDateInJournal(entry.created)` — the same path the calendar
uses — which anchors the journal to that entry's day. No new `JournalView` API is
introduced.

This is a deliberate limit, not an oversight. Mounting N live embedded editors
inside an arbitrary note would put the most expensive and most data-critical code in
this plugin (mount cap, debounced saves, self-write suppression, save tokens) behind
a code-block lifecycle nobody controls. The stated need is *seeing* the content.

## 4. The query

`mentions/mentionQuery.ts` — no DOM, no Obsidian view types, directly unit tested,
in the manner of `mountWindow.ts` and `entryIndex.ts`.

```ts
export function findMentions(
  entries: readonly JournalEntry[],
  target: TFile,
  resolvedLinks: Record<string, Record<string, number>>,
): JournalEntry[];
```

* `entries` arrives already sorted newest → oldest (the service's index is), so the
  result preserves that order and no sort happens here.
* An entry linking to the target more than once appears once. `resolvedLinks` gives
  a count; the count is ignored.
* The target itself is excluded, so a journal entry that links to itself does not
  list itself.
* Notes outside the journal folder never appear, because only entries are iterated.

## 5. Surface A — the code block

Registered language: **`simple-journal`**.

Like the plugin id and the two view types, this string is effectively permanent
once published — it lives inside users' notes. It is namespaced to the plugin to
avoid colliding with other plugins' processors.

````markdown
```simple-journal
```
````

An empty body means "entries that mention the note this block is in";
`ctx.sourcePath` supplies the target. One optional directive is understood:

```
note: [[Some Other Note]]
```

Anything else in the body is ignored rather than treated as an error — a code block
that renders an error message in the middle of someone's note is worse than one
that renders the obvious default. A `note:` link that resolves to nothing falls
back to the same empty state as a note with no mentions, for the same reason.

**Lifecycle.** `registerMarkdownCodeBlockProcessor` hands us a `div`; we wrap the
panel in a `MarkdownRenderChild` and pass it to `ctx.addChild()`, so Obsidian
unloads the panel — and with it every subscription — when the block leaves the DOM.
Both APIs are documented and stable.

**No setting gates this.** A toggle that turns the processor off would leave raw
```` ```simple-journal ```` fences visible in notes the user had already written,
reading as breakage. The block is already opt-in per note: the way to not have one
is to not write one.

A command, **`Insert journal mentions block`**, writes the fence at the cursor.

**Empty state:** "No journal entries mention this note yet." The user put the block
there deliberately; silence would read as a bug.

**Recursion guard.** The panel renders entry markdown, and an entry could itself
contain a `simple-journal` block, which would render a panel, which would render
entry markdown. A module-level depth flag makes the processor draw an inert
placeholder instead of a panel whenever it fires inside a panel's own render.

## 6. Surface B — the sidebar

`mentions/MentionsView.ts`, view type **`simple-journal-mentions`** — fixed forever,
for the same reason the other two view types are: saved workspace layouts refer to
it.

It follows the active file (`workspace.on("file-open")`) and renders the same panel
for it. Placement follows the calendar's policy in `main.ts`: when enabled, a leaf
is ensured in the right sidebar on load without stealing focus and without revealing
the sidebar.

The view type is registered unconditionally, whatever the setting says. A saved
layout that references an unregistered view type is a broken layout.

Unlike the footer, it does not exclude journal entries: the user opened this panel
deliberately and it costs nothing to answer honestly for whatever file is active.
Recursion is not a concern here — no note renders this view inside itself.

## 7. Surface C — the automatic footer, as a guarded exception

### Why this needs an exception

There is no documented Obsidian API for appending content to the end of a note's
*content flow* — the part that scrolls with the note. Appending to the public
`view.contentEl` puts the panel below the scroll container, pinned to the bottom of
the pane, which is not what was asked for.

The only way to sit at the end of the content is to inject into Obsidian's own
layout elements: `.markdown-preview-sizer` in reading view, `.cm-sizer` in live
preview. Those are internal DOM structures, not public API.

`CLAUDE.md`'s **Editing** section already carves out one internals exception, and
says of it, in terms: *"It does NOT license internal API usage anywhere else in the
codebase."* So this needs its own written exception, granted on its own merits, with
its own safety rules — not an extension of the editor's.

### The two rules that make it safe

They are the same two rules that make the editor exception safe.

1. **Feature detection with silent fallback is mandatory.**
   `containerEl.querySelector(".markdown-preview-sizer, .cm-sizer")`. If it returns
   nothing, the footer does nothing at all — no throw, no notice, no console noise.
   Should a future Obsidian change this structure, the feature disappears; no note
   is altered and no journal data is at risk. Unlike the editor exception, no
   one-time notice is shown: this surface is optional and off by default, so its
   absence is not a degradation of anything the user depends on.

2. **All DOM assumptions live in `mentions/mentionsFooter.ts` and nowhere else.**
   The two class names appear in exactly one `querySelector` call in the codebase.
   Retreating from this surface permanently, or moving to a future public API, is a
   one-file change.

### Behaviour

Triggered by `workspace.on("layout-change")` and `workspace.on("active-leaf-change")`,
over **visible** `MarkdownView`s only.

It does not attach when:

* the note is inside the journal folder — an entry's own timeline covers it, and it
  would invite the recursion the code block already has to guard against;
* the note has zero mentions. Nothing is drawn, not even a header. Unlike the code
  block, the user did not ask for anything here, so an empty panel would be pure
  noise.

## 8. Settings

```ts
export interface JournalSettings {
  journalFolder: string;
  /** Show a mentions panel at the bottom of notes that journal entries link to. */
  showMentionsUnderNotes: boolean;   // default: false
  /** Keep a journal mentions panel in the sidebar. */
  mentionsSidebar: boolean;          // default: false
}
```

Both default **off**. The riskier surface is not enabled by anyone's accident, and a
fresh install changes nothing about how the user's existing notes render.

`mentionsSidebar` governs *automatic placement*, exactly as the calendar's placement
policy does — not registration, and not the command. `Open journal mentions` works
regardless of the setting, because a command is how you reach a thing.

New commands:

```text
Open journal mentions
Insert journal mentions block
```

Deliberately **not** settings, per `CLAUDE.md`'s "avoid premature configurability":
how many entries to show initially (5), how many "Show more" adds (20), the sort
order (reverse chronological — a North Star principle, not a preference), and the
grouping.

## 9. Rendering, reactivity, performance

**Shape.** The panel repeats the timeline's visual language: day headers, timestamps,
the same typography. A user does not learn a second interface; they see the journal
filtered to this note.

```text
── Journal mentions ────────── 12 ──

MONDAY, 24 AUGUST

21:40
Ekin'le [[Ekin Arslan Aytaç]] akşam yemekte konuştuk…

09:12
Sabah [[Ekin Arslan Aytaç]] aradı, haftasonu planı için.


THURSDAY, 20 AUGUST

17:03
[[Ekin Arslan Aytaç]] ile doğum günü hediyesini konuştuk…

                                        Show 9 more ▾
```

(Abridged for the sketch: the real initial count is 5, per §8.)

**CSS.** A new root class `.journal-mentions`. Day-header and timestamp typography is
shared with the timeline; the timeline's container-dependent rules are not, because
this panel lives inside an arbitrary note rather than inside a view.

**Reactivity.** Two subscriptions, debounced at 200 ms:

| Source | Covers |
| --- | --- |
| `journal.onChange` (existing) | entry created, deleted, retimed, moved |
| `metadataCache.on("resolve")` | a link to this note added or removed |

`resolve` fires often while typing, which is why the debounce is not optional.

**Cost.** The query is one object lookup per entry: sub-millisecond at 10,000
entries. Rendering is the real cost, and it is bounded the way the timeline bounds
it — 5 entries initially, +20 per explicit "Show more" click. A note mentioned by
500 entries never renders 500 markdown blocks on its own.

The footer walks visible `MarkdownView`s only, never every leaf.

## 10. Changes to CLAUDE.md

* A new `# Mentions` section: the source-blind query rule, the one-renderer rule,
  the three surfaces, read-only and why, and the setting semantics.
* Beside `# Editing`: the second internals exception, its justification, and its two
  safety rules — stated, as the first one is, so that it licenses nothing else.
* `# Non-Goals`: the list in §12 below.
* `# Navigation`: the two new commands.

## 11. Tests

`mentionQuery.ts` carries the weight, in the pattern of `entryTags.test.ts`:

1. A body `[[link]]` is a mention
2. A body `![[embed]]` is a mention
3. A frontmatter link (`people: "[[Ekin]]"`) is a mention — all three alike
4. An aliased link (`[[Ekin Arslan Aytaç|Ekin]]`) is a mention
5. An unresolved link is not
6. A plain-text occurrence of the note's name is not
7. An entry linking twice is listed once
8. Results are reverse chronological
9. Notes outside the journal folder never appear
10. The target note does not list itself

Shell-level:

11. The code block writes its empty state at zero mentions
12. The footer writes nothing at zero mentions
13. **With no sizer element present, the footer does nothing and throws nothing** —
    this is the exception's safety test, and it is the one that must never be
    deleted
14. A nested `simple-journal` block draws a placeholder and does not recurse
15. `destroy()` releases every subscription

Manual (`docs/manual-testing.md`): live preview ↔ reading view switching, the sidebar
following the active file, and footer behaviour on mobile.

**The mobile case is unverified**, and is recorded as such — the same status
`CLAUDE.md`'s `# Target Platforms` already assigns to the rest of the mobile code.

## 12. Non-goals

Not in this design, and to be recorded as non-goals:

* filtering mentions by tag, or by date range
* querying more than one note at a time
* a sort-order option for the panel
* editing an entry from inside the panel
* a "new entry mentioning this note" button
* counting plain-text occurrences as mentions
* replacing or modifying Obsidian's own backlinks pane
