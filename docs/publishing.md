# Cutting a release, and submitting to the community directory

## Releasing a version

`manifest.json`'s `version` is the source of truth. The tag must equal it
exactly — the workflow refuses to publish a mismatch, because a release whose
assets disagree with the tag installs the wrong thing.

```bash
# 1. bump manifest.json and package.json, and add the version to versions.json
#    mapped to the minimum Obsidian version it needs
# 2. commit that bump on main
git tag 0.1.0
git push origin 0.1.0
```

Pushing the tag runs `.github/workflows/release.yml`, which type-checks, runs
the suite, builds, and opens a **draft** release carrying `main.js`,
`manifest.json` and `styles.css`. Draft on purpose: look at the three assets
before anyone can download them. Publish the draft from the GitHub releases page.

Those three files are what Obsidian installs. `main.js` is deliberately
gitignored and built in CI, so the release is the only place it exists.

## First submission to the directory

Only the first version is submitted; after that, users get new versions from the
GitHub releases directly.

1. A published (not draft) release must exist, tagged with the manifest version.
2. The repository must be public, with `README.md`, `LICENSE` and
   `manifest.json` at the root.
3. Fork `obsidianmd/obsidian-releases` and append this object to the end of
   `community-plugins.json`:

   ```json
   {
     "id": "journal-entries",
     "name": "Journal Entries",
     "author": "Utku Aytaç",
     "description": "A continuous, reverse-chronological journal where every entry is its own Markdown note.",
     "repo": "ukaytac/obsidian-journal-plugin"
   }
   ```

   `id`, `name`, `author` and `description` must match `manifest.json` exactly.
   The id `journal-entries` was free as of the last check against the directory.

4. Open a pull request and fill in the checklist template honestly.

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
