# Journal Search — Design

Date: 2026-09-01
Status: Approved

## 1. Scope

How the user finds an entry they half-remember, and how they read everything they
wrote about one thing.

Product principles, storage layout, and non-goals are defined in `CLAUDE.md` and are
not repeated here, except where this design changes them (§9).

Starting state: `Search journal` is the one command named in `CLAUDE.md`'s
`# Navigation` list and not built. Nothing in `src/` reads an entry's body text for
any purpose other than rendering it — `EntryRepository` reads a file to save it, and
the timeline mounts a real editor over it; no code path asks "what does this entry
say".

## 2. The question this design answers

The journal has two shapes of recall, and today it serves neither.

The first is **find one**. "I wrote about that coffee place." The user knows the
entry exists and wants to be standing in front of it. The calendar answers this only
if they also remember roughly *when*, which is exactly the thing a titleless journal
does not help you remember.

The second is **read all**. "What did I write about the move?" This is not
navigation; it is reading. The tag scope answers it, but only for something the user
had the foresight to tag at the time. Most of a journal is untagged prose, and
`CLAUDE.md` forbids automatic tagging on purpose.

Both are the same question asked of the same text. They differ only in what the user
wants to be looking at afterwards — one entry, or all of them.

## 3. Rules

### Rule 1 — One reader, source-blind

A single module, `journal/entrySearch.ts`, owns every decision about what matches
what. This is the same shape `entryDate.ts` holds for chronology, `entryTags.ts` for
tags, and `mentions/mentionQuery.ts` for links: case folding, term splitting,
matching, and snippet extraction live there and nowhere else. Nothing downstream
re-derives any of them.

The module is pure. It takes text and a query and returns matches; it never reads a
file, never touches Obsidian, and is therefore testable without a DOM.

### Rule 2 — The body, and only the body

Search reads what the timeline shows: the entry's Markdown body. Frontmatter is not
searched. Neither is the filename.

The reason is the same one that decides which tags get chips (`CLAUDE.md` § Tags Rule
3): the timeline hides `.metadata-container`, so a result that matched on a
frontmatter property would appear with no visible cause. "Nothing appears twice, and
nothing appears zero times" applies to search results too — a result the user cannot
see the reason for is worse than no result.

Tags are reachable already, exactly and case-insensitively, through
`Filter journal by tag`. Search does not duplicate that with a looser guarantee.

### Rule 3 — Two exits, one door

`Search journal` opens one modal. It leaves by one of two doors, and which one the
user takes decides what they are looking at afterwards:

| | choosing an entry | choosing "Show all N matches" |
| --- | --- | --- |
| Timeline | **anchors** to that entry | **scopes** to the query |
| Continuity | unbroken — the whole journal is still there, older entries below | filtered to matches |
| Mechanism | `goToDateInJournal(entry.created)` | a new scope kind |
| Precedent | the calendar's day click, and the mentions panel's entry click | the tag scope |

Neither is a new concept. Anchoring and scoping both already exist, are both already
documented, and search only opens a new door onto them.

### Rule 4 — One scope at a time

A text scope and a tag scope are never both active. Setting either replaces the
other.

This is the line that keeps search on the right side of `CLAUDE.md`'s
`advanced filters` non-goal. One scope, from one command, never persisted, is the
same shape the tag scope was granted. The intersection of two filters is a query
builder, and a query builder is the thing that bullet forbids.

### Rule 5 — A scope is never persisted

Inherited wholesale from `CLAUDE.md` § Tags. Not to view state, not to settings, not
to the saved workspace layout. A restored search at startup would hide most of a
user's journal with no visible cause.

`New journal entry` clears the scope and any anchor before opening the composer, for
the reason already written down: a new entry contains none of the query and would be
written safely to disk and be invisible.

## 4. Matching

### 4.1 Substring, not fuzzy

`prepareFuzzySearch` is what every sibling Obsidian suggester uses, and
`TagScopeModal` already declines it with a written argument. Search declines it for a
different reason with the same conclusion: the user is recalling a phrase they
themselves wrote, so fuzzy recall solves a problem this list does not have and adds
noise to a result set that is supposed to be an answer.

### 4.2 Terms are ANDed, and there is no syntax

The query is split on whitespace. Every term must appear somewhere in the entry, in
any order. There are no quotes, no `OR`, no `-exclusion`, no field prefixes.

Adding syntax is the first step onto the road `advanced filters` fences off. Entries
are short, so an AND of terms behaves close to a phrase search in practice while
being far more forgiving of half-remembered word order.

A query shorter than two characters matches nothing and shows no "Show all" row:
scoping the journal to everything is the same thing as having no scope.

### 4.3 Case folding: Turkish casing pairs, no locale

Both sides are folded with:

```ts
s.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase()
```

Two fixed character substitutions, then ordinary lowercasing. Deterministic, no ICU,
identical on every platform — which is what `compareEntries` gave up `localeCompare`
to get, and for the same reason: a synced vault must not behave differently on
different devices.

What this buys, measured:

| entry text | query | result |
| --- | --- | --- |
| `İstanbul` | `istanbul` | match |
| `İSTANBUL` | `istanbul` | match |
| `Işık` | `ışık` | match |
| `IŞIK` | `ışık` | match |
| `ilik` | `ılık` | **no match** |
| `açık` | `acik` | **no match** |
| `Kâr` | `kar` | **no match** |

`İ` and `i` are the same letter; `I` and `ı` are the same letter; `i` and `ı` are
not. `ö/o`, `ç/c`, `ş/s`, `ğ/g`, `ü/u`, `â/a` all stay distinct. Plain
`toLowerCase()` was rejected because it turns `İ` into `i` plus a combining dot,
so `istanbul` would not find `İstanbul` — a daily failure in a Turkish journal, not
a preference.

**The known cost, accepted deliberately:** English text in the same journal loses the
capital `I`. `"I am happy"` folds to `"ı am happy"` and is not found by `"i am"`.
This is the price of Turkish casing being correct, it was weighed, and it is pinned
by a test so it stays a decision rather than becoming a bug report.

## 5. The modal

A `SuggestModal`, sibling to `TagScopeModal`.

Each row is one matching entry: its time, formatted exactly as the timeline formats
it, and a short excerpt taken from around the first match, with the matched text
emphasised. The excerpt is what makes the row identifiable — the timestamp alone is
the very problem `CLAUDE.md` § Mentions was written to solve.

The first row, present only when the query is two or more characters and at least one
entry matched, is **"Show all N matches"**. A synthetic first row is the shape
`TagScopeModal` already uses for `kind: "clear"`, and it is first for the same reason
that one is: it must not be possible for the list to scroll it out of reach.

Rows are ordered newest first. It is the journal's order, everywhere, always.

## 6. Reading entry bodies

The index holds `JournalEntry` — file, date, nothing else. Search needs text, so text
has to be read.

**One read per search session, not per keystroke.** Opening the modal reads every
entry once through `vault.cachedRead` into an in-memory snapshot keyed by path.
Filtering as the user types is then pure string work over that snapshot. At the
author's own 348 entries this is milliseconds; `cachedRead` is Obsidian's cached
path, so a second search in the same session pays almost nothing.

**The growth path is named and not built.** `CLAUDE.md` § Performance asks for
architecture that does not assume everything stays mounted, and warns against
obviously unscalable decisions while deferring optimisation. A per-keystroke scan
would be obviously unscalable; a one-shot read per session is not. If a journal ever
grows large enough for that read to be felt, the answer is an incrementally
maintained text index fed by `JournalService`'s existing change batching — and Rule 1
is what keeps that a one-file change.

**A file that cannot be read** is logged with `console.error` and treated as
non-matching. If any entry failed during a session, the modal says so in one line
(*"3 entries could not be read."*). Silently returning an incomplete answer is the
worst thing a search can do, and `CLAUDE.md` § Error Handling asks to fail visibly.
Search performs no writes, so there is no data at risk either way.

## 7. Where the scope lives

`JournalView.tagScope: string | null` becomes one discriminated union:

```ts
type Scope =
  | { kind: "tag"; tag: string }
  | { kind: "text"; query: string; paths: ReadonlySet<string> };
```

**`matchesScope` stays synchronous.** For a text scope it is
`paths.has(entry.file.path)`. This is the load-bearing decision of §7: the modal has
already resolved which entries match, so the view never has to read a file to decide
whether to render something. Every hot path that calls `matchesScope` today —
`scopedIndex`, `insertEntryInPlace` — is untouched in shape.

Everything that reads `tagScope` today (`scopedIndex`, `renderScopeBar`,
`renderEmptyState`, `insertEntryInPlace`) moves to the union. This is a targeted
refactor, not a drive-by one: it is the change that makes a second scope kind
possible, and it takes the name `tagScope` out of places that were never about tags.

The scope bar renders the query in place of the `#tag` chip, with the match count
beside it. Clearing works exactly as it does for a tag scope.

## 8. Live updates while scoped

A text scope stays **live**, matching the tag scope's behaviour.

When an entry changes while a text scope is active, that one entry is re-read and
re-evaluated: it leaves the timeline if it no longer matches, and enters if it now
does. The cost is bounded to a single small file per change, and the composer case
does not arise — `New journal entry` clears the scope before opening (Rule 5).

The alternative, a frozen snapshot answering "whatever matched when you searched",
was rejected. It is less code, but it makes two scopes that share one scope bar
behave differently, and that is the class of inconsistency this codebase writes
paragraphs about rather than ships.

Deletion and rename need nothing new: they already remove the entry from the index.

A change to the journal folder setting is the one event that **clears** a text scope
rather than updating it. `refreshJournal()` replaces the index wholesale, and a
resolved set of paths from the old folder describes nothing in the new one. Clearing
is also the honest reading: the user changed which journal they are looking at, so
the answer to a question asked of the previous one no longer stands.

## 9. Changes to CLAUDE.md

1. `# Navigation` — `Search journal` moves out of the "Still later" block into the
   implemented list.
2. A new `# Search` section, placed after `# Tags`, carrying Rules 1–5, the case
   folding decision with its table and its accepted English cost, and the reading
   model from §6.
3. `# Non-Goals` — the `advanced filters` bullet is amended to name this second
   exception explicitly and to say what still stays out: query syntax, combining a
   text scope with a tag scope, saved searches, searching frontmatter, and searching
   the vault rather than the journal. `semantic search` stays where it is; this is
   substring matching and nothing else.

`CLAUDE.md` says not to change established product decisions silently. §9.3 is that
change, made loudly, and it was decided by the user during this design.

## 10. Tests

**`entrySearch.ts`, pure, no DOM:**

- the folding table in §4.3 in full, including the three deliberate non-matches
- the English `I` cost, pinned as intended behaviour
- term splitting, and AND semantics across terms in any order
- queries under two characters matching nothing
- snippet extraction: match at the start, in the middle, at the end, and a match
  longer than the excerpt window

**`JournalView.textScope.test.ts`, sibling to `JournalView.tagScope.test.ts`:**

- scoping, clearing, and the scope bar's contents
- composing with an anchor, in both orders
- `New journal entry` clearing the scope
- an entry edited into and out of the match set while scoped (§8)
- an entry deleted while scoped
- setting a text scope clears a tag scope and the reverse (Rule 4)

**The modal, sibling to `tagScopeModal.test.ts`:**

- the "Show all" row appears only with a two-character query and at least one match,
  and is always first
- choosing an entry anchors; choosing the first row scopes
- the unreadable-entry line appears only when something failed

**Not covered by any of these, so it goes to `docs/manual-testing-open.md`:** that
the excerpt is legible in both themes, that the modal is usable on a phone, and that
a search over a real vault feels immediate rather than merely being fast in a test.

## 11. Non-goals

Specific to search, and to be written into `CLAUDE.md` § Non-Goals:

- query syntax of any kind — quotes, `OR`, exclusion, field prefixes
- regular expressions
- a text scope and a tag scope active at once
- saved or recent searches
- searching frontmatter, filenames, or anything outside the entry body
- searching the vault rather than the journal — `Filter journal by tag`'s sibling
  boundary, and the same one `# Mentions` Rule 2 draws
- a sort order for results; it is the journal's order, which is a North Star
  principle and not a preference
- replacing or competing with Obsidian's own search, which keeps working exactly as
  it did and answers a wider question
- highlighting matches inside the timeline itself; the scope is the answer, and
  painting the entries would mean writing into a live editor's DOM
