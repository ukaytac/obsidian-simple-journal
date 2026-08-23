# Journal Tags — Design

Date: 2026-08-23
Status: Approved

## 1. Scope

How Simple Journal treats tags: how it reads them, whether it writes them, how it
shows them in the timeline, and what clicking one does.

Product principles, storage layout, and non-goals are defined in `CLAUDE.md` and are
not repeated here, except where this design changes them (§8).

Starting state: the plugin has no tag handling at all. `tags` appears in the codebase
only as test fixture frontmatter and as the "frontmatter survives editing" manual
check.

## 2. The question this design answers

Obsidian indexes two kinds of tag:

| | inline `#tag` (mid-sentence or at the end) | frontmatter `tags:` |
| --- | --- | --- |
| Where indexed | `CachedMetadata.tags` → `TagCache[]`, with `position` | `CachedMetadata.frontmatter.tags` |
| Leading `#` | required | must be absent (`#` starts a YAML comment) |
| Search / tag pane / graph / `tag:#x` | identical | identical |
| Combined read | `getAllTags(cache)` merges both into one array | same function |

**Obsidian itself draws no semantic distinction between them**, and none between a
tag mid-sentence and one at the end of an entry — both land in the same `cache.tags`
array, differing only in `position`.

For this plugin exactly one difference matters: **visibility**. `styles.css:247`
hides `.metadata-container` inside `.journal-entry-embed`, because the timeline
deliberately has no properties panel. So a frontmatter tag is invisible in the
timeline and cannot be removed there, while an inline tag renders as a clickable
pill in live preview like any other note.

The three rules in §3 follow from that single asymmetry.

## 3. Decisions taken during brainstorming

### Rule 1 — One reader, source-blind

A single module resolves tags, mirroring how `entryDate.ts` isolates chronology
resolution. Nothing in the timeline asks whether a tag came from frontmatter or from
the body. Obsidian does not ask; neither do we.

### Rule 2 — The plugin never writes a tag

Writing to frontmatter is already forbidden outside `created`
(`fileManager.processFrontMatter` re-serializes the user's other properties — see
`setCreatedProperty`). Writing into the body is unnecessary: the embedded editor is a
*real* Obsidian editor, so Obsidian's own `#` tag autocomplete fires when the user
types. No tag-entry UI is built.

This keeps the "automatic tagging" non-goal intact. Consequence: `#` autocomplete
inside the embedded editor is an **unverified assumption** and gets a manual-testing
item (§7). It will not work in the `<textarea>` fallback; that is accepted.

### Rule 3 — The timeline shows only what it hides

Inline tags already render as clickable pills in live preview, so rendering them
again as chips would show the same information twice ("avoid excessive borders,
shadows, cards"). Frontmatter tags render nowhere. Therefore:

> Chips are rendered for **frontmatter tags only**.

Nothing then appears twice, and nothing appears zero times.

### Rule 4 — Clicking a tag scopes the timeline

Chosen over deferring navigation to Obsidian's own search. There is no public API for
opening the search pane (`internalPlugins` → `global-search` is internal, and the
sanctioned internal-API exception covers the editor only and nothing else), so a
clickable chip has to mean something *inside* the timeline.

The calendar's day click anchors rather than filters, because a day is a point on the
chronological axis. A tag is not on that axis, so anchoring has no meaning for it: the
options are filter or nothing. This design filters, and calls it a **scope**.

Cost, accepted knowingly: this is the first breach of the continuous-timeline
principle, and `CLAUDE.md` lists "advanced filters" as a non-goal. §8 records it as a
product decision rather than letting the code contradict the document silently. The
"single-day filtering" rejection stands unchanged.

### Rule 5 — A scope is never persisted

Not to view state, not to settings, not to the saved workspace layout.

Precedent: the calendar section's "permanently locked out" failure. A saved layout
that restored a filter would hide most of the user's journal at startup with no
visible cause. A scope lives only as long as the user keeps it.

## 4. Module structure

| File | Change |
| --- | --- |
| `journal/entryTags.ts` *(new)* | `resolveTags(cache): string[]` over `getAllTags()`. Strips the leading `#`, dedupes case-insensitively keeping first-seen casing, preserves nested form (`work/project`). Source-blind (Rule 1). Also `frontmatterTags(cache): string[]` via `parseFrontMatterTags`, for chips only (Rule 3). |
| `journal/entry.ts` | `JournalEntry` becomes `{ file, created, tags: string[] }`. |
| `journal/entryRepository.ts` | `entryFor` fills `tags` from `resolveTags(metadataCache.getFileCache(file))`. An unavailable cache yields `[]` — the timeline must not break for one entry, same principle as the `created` fallback chain. |
| `services/journalService.ts` | `applyUpsert`'s "content" branch assigns `existing.tags = entry.tags`, alongside its existing `existing.file` write-back. Without it an externally-changed tag never reaches the index. **No new `JournalChange` kind**: a tag change is already `content`. |
| `views/applyChange.ts` | The pure decision function gains a scope predicate. Per change it decides `insert` / `remove` / `refresh`: an entry that left the scope is removed, one that entered is inserted, one that never matched is ignored. Still DOM-free and unit-tested directly. |
| `views/TagScopeModal.ts` *(new)* | `SuggestModal<string>` over the union of tags across journal entries, alphabetical. First item is **"Clear filter"**, present only while a scope is active. |
| `views/JournalView.ts` | Owns `tagScope: string \| null`, the scope bar, and scope-aware index derivation (§5). |
| `main.ts` | Registers the `Filter journal by tag` command. |

## 5. Scope state and paging

`JournalView.index` currently aliases the service's live array
(`JournalView.ts:566`, documented in `JournalService`'s class comment). A scope makes
that alias impossible, but it does not require fragile incremental syncing:

> While a scope is active, `this.index` is re-derived as `live.filter(matches)` at the
> start of every change batch and in every `reloadNow`. There is no incremental
> maintenance.

Why this is safe rather than merely convenient:

- `pageAfter` tracks its cursor **by path**, and `insertEntryInPlace` locates its
  target **by reference** (`this.index.indexOf(entry)`). `filter` preserves the same
  entry objects, so both keep working unchanged.
- Cost is one O(n) pass per debounced batch (300 ms) over a metadata-only array —
  negligible even at tens of thousands of entries.
- Two lists cannot drift apart, and the `generation` / `timelineMutationChain` guards
  gain no new corner. Correctness over cleverness, as `CLAUDE.md` asks.

The re-derivation and `applyChange`'s scope predicate (§4) are not duplicates of each
other and neither replaces the other: re-derivation keeps *paging* correct, while the
predicate decides what happens to a *rendered row* for each change in the batch.

## 6. Interactions

- **Entry points.** Primary: the `Filter journal by tag` command → `TagScopeModal`.
  It covers both tag kinds and hijacks no native interaction. Secondary: clicking one
  of our own frontmatter chips enters that tag's scope. Obsidian's inline tag pill is
  left exactly as it is — it opens Obsidian's own search, and intercepting it would
  make the same pill behave differently inside the timeline than in the source note.
- **Scope bar.** One line at the top of the timeline: `#tag` and a `✕`. Same visual
  weight as the existing month header, not new chrome. `Esc` also clears it, when
  focus is not in an editor. The bar is not optional: it is the only explanation a
  user has for why entries are missing.
- **`New journal entry`.** Clears the scope, returns to today, focuses the composer —
  the existing flow, unchanged. A new entry has no tags and would otherwise vanish
  the moment it was created. The plugin does not pre-fill the scope's tag (Rule 2),
  which would also collide with lazy creation's "has meaningful content yet" test.
- **Calendar.** Dots stay scope-independent, and anchor composes with scope
  ("#therapy, from March backwards"). `CalendarView` is untouched: scope stays
  view-local, with no cross-view state surface.
- **`Go to today`.** Keeps the scope and moves to the newest matching entry.
  Navigation, not creation.
- **Journal folder setting changed, or a `reload` change arrives.** The scope is
  cleared; its tag set belonged to a different folder.
- **Empty result.** A single line — "No entries tagged #x" — instead of a blank
  timeline. Blank space would conceal that a filter is on.

## 7. Failure modes

- The only entry carrying the scoped tag is deleted → scope stays active, list empty →
  the empty-result line, not a crash.
- An entry loses its tag externally → its row disappears. **Intended, and not data
  loss**: the file is untouched. The scope bar is what makes this legible.
- Mounted before the metadata cache is ready → `tags: []`. `metadataCache.on("changed")`
  already queues an upsert, so the entry enters the scope shortly after.
- `<textarea>` fallback → identical scope behaviour; the scope reads the metadata
  index, not the editor.
- Manual-testing additions: `#` autocomplete inside the embedded editor; scope
  surviving an external edit; scope + anchor together; `New journal entry` clearing a
  scope.

## 8. `CLAUDE.md` changes

A new `# Tags` section, written as a reasoned product decision in the style of the
calendar section, recording: the three visibility rules, the single resolution point,
that the plugin never writes tags, why a tag is scoped rather than anchored, and that
a scope is never persisted.

The non-goal list keeps its "single-day filtering" rejection verbatim and notes the
tag-scope exception under "advanced filters".

## 9. Out of scope

Tag-entry UI, tag rename, tag hierarchy browsing, multiple simultaneous tags
(AND/OR), tag counts, automatic tagging.

## 10. Test priorities

1. `entryTags`: frontmatter-only, inline-only, both, missing `#`, nested, mixed case,
   malformed frontmatter, absent cache.
2. `applyChange` scope branches: entry entering the scope, entry leaving it, `added`
   that never matched.
3. `journalService`: a `content` change updates `tags` on the existing index entry.
4. Paging under a scope: `pageAfter` with a scoped list, a lost cursor, and a scope
   combined with an anchor.
5. Scope cleared on `New journal entry`, on a folder change, and on a `reload` change.
