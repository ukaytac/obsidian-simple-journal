# Adding a tag from the timeline

Date: 2026-11-16. Status: built. The rule lives in `CLAUDE.md`, `# Tags` Rule 2;
this note records the request and the alternatives that were turned down.

## The request

A user who prefers frontmatter tags (shown as muted chips in the timeline)
over inline `#tags` had to do this for every entry: entry menu, Open source
note, Add property, `tags`, type the tag, close the note, back to the stream.
They asked to be able to type a tag in the header, between the time and the
`⋯` button, where frontmatter tags already appear.

## Why it was accepted

Rule 2 used to say the plugin never writes a tag, for two reasons: the
frontmatter belongs to the user, and the body needs no help. The second reason
still holds. The first ran into Rule 3: the timeline hides the properties
panel, so the plugin already has to show frontmatter tags for the user. The
same gap on the writing side is what this request describes. It adds no
concept: the user still chooses every tag, and the write is one line.

## Decisions

- **Where.** The control is a muted `+ tag` beside the time. Frontmatter
  tags, which used to sit in the header, moved to a chip row under the
  entry's text. The author settled on this in a real vault after trying two
  other layouts. The first was a lone `+` among the chips in the header, the
  spot the requester suggested. The second was `+ tag` under the text. The
  chosen layout keeps the header to the time, this control and the menu, and
  puts tags where they describe the text. The control is its own element,
  outside `.journal-entry-tags`: that row is rebuilt on every metadata change,
  including the one this write causes. The chip row sits outside `bodyEl`,
  so a refresh cannot reach the editor, and it collapses while empty. The
  control is revealed like the actions button (hover/focus, dimmed on
  mobile), is excluded from the long-press menu gesture, and is hidden on the
  uncommitted composer.
- **Suggestions.** The journal's tags (`collectTags`), minus the ones the
  entry already has. The typed text is offered first whenever it is not an
  existing tag, so Enter on `trav` writes `trav`, not a highlighted `travel`.
  An empty field suggests nothing, so Enter there closes it rather than
  writing whatever happened to be first.
- **New tags are allowed.** Obsidian has no tag registry; a tag exists once it
  is written. The rule is `validateNewTag`.
- **Blur.** An empty field closes on blur. A field with text in it stays open
  until Enter or Escape. That way a stray tap neither writes the tag nor loses
  the text, and a click on a suggestion still finds the field there.
- **The write.** `addFrontmatterTag` (line level) inside `vault.process`,
  after flushing a pending body save, with the same Obsidian-parse cross-check
  as `setEntryCreated`. Chips update from the write's own metadata event.

## Rejected

- **`fileManager.processFrontMatter`.** It re-serializes the whole block. That
  is the reason the date property has its own writer.
- **Converting `tags: life` to a list.** It would rewrite a line the user
  wrote. Refused with a Notice instead.
- **Committing on blur.** On mobile, focus changes that nobody intended are
  common (see the focus-race case study), and a tag written by accident is a
  file change the user did not ask for.
- **Removing a tag from a chip.** A chip click already means "scope to this
  tag". A second gesture on the same element is its own decision, and was
  not asked for.
- **Vault-wide tag suggestions.** `metadataCache.getTags()` is not in the
  public type definitions, so it falls under the internals rule. The journal's
  own tags are the relevant set anyway.
