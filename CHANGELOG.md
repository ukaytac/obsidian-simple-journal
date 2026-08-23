# Changelog

The text of each GitHub release is taken from here. Starts at 1.1.0 — earlier
versions were released without written notes.

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
