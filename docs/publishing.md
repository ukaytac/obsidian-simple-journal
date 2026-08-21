# Cutting a release, and submitting to the community directory

## Releasing a version

`manifest.json`'s `version` is the source of truth. The tag must equal it
exactly — the workflow refuses to publish a mismatch, because a release whose
assets disagree with the tag installs the wrong thing.

```bash
# 1. bump manifest.json and package.json, and add the version to versions.json
#    mapped to the minimum Obsidian version it needs
# 2. commit that bump on main
git tag 1.0.0
git push origin 1.0.0
```

Pushing the tag runs `.github/workflows/release.yml`, which type-checks, runs
the suite, builds, and opens a **draft** release carrying `main.js`,
`manifest.json` and `styles.css`. Draft on purpose: look at the three assets
before anyone can download them. Publish the draft from the GitHub releases page.

Those three files are what Obsidian installs. `main.js` is deliberately
gitignored and built in CI, so the release is the only place it exists.

## First submission to the directory

Submission is **not** a pull request against `obsidian-releases`. That was the
old flow, and following it wastes an afternoon: `community-plugins.json` is 1.9 MB,
past the size at which GitHub refuses to open its web editor, which is a good
early hint that hand-editing it is no longer the intended path.

The current flow: sign in to the Obsidian Community directory with an Obsidian
account, link the GitHub account that owns the repository to prove ownership,
and submit from there. `community-plugins.json` is then written by Obsidian's
own automation, not by the author.

What it validates, and where it looks:

- **`manifest.json` at the HEAD of the default branch** — not the release. Both
  have to be right, for different reasons: the directory reads the branch, and
  Obsidian installs the release assets.
- **A published release** whose tag equals the manifest version, carrying
  `main.js`, `manifest.json` and `styles.css` as individual assets.
- **An `id` that does not contain the word "obsidian"**, and is unique across the
  directory. `simple-journal` satisfies both. The repository name may contain it
  — only the id is constrained.
- **`README.md` and `LICENSE` at the repository root**, in a public repository.

Submission status lives on the author's community profile. A pending submission
does not appear in `community-plugins.json`: that file is the published output,
so absence there means "not listed yet", not "rejected".

Newly listed plugins carry `- This plugin has not been manually reviewed by
Obsidian staff.` appended to their description, so listing is self-service and
manual review is a later, separate thing. Do not write that sentence into the
manifest — the automation appends it, and the manifest must stay under the
description length limit without it.

## What review will ask about

**The internal editor API.** This plugin mounts a real Obsidian Markdown editor
through `app.embedRegistry.embedByExtension["md"]`, which is not public API.
Reviewers look for exactly this, so lead with it rather than letting them find
it. The defence, which is real and worth stating plainly in the PR:

- It buys editing fidelity nothing public can: live preview, `[[` autocomplete,
  editor commands, vim mode, theme parity. `MarkdownRenderer.render()` is
  read-only and `Editor` is reachable only from an active `MarkdownView`.
- It is probed at load and falls back to a plain `<textarea>` editor with a
  one-time notice if absent, so a future Obsidian release cannot break the
  journal or endanger anyone's notes.
- It is confined to one file behind an `EntryEditor` interface, so retreating to
  the fallback permanently is a one-file change.
- The observed behaviour it relies on is documented in
  `docs/editor-embed-api.md`.

Expect to be asked to justify it, and be willing to ship the fallback as the
default if the answer is no.
