#!/usr/bin/env bash
# Copies the built plugin into a vault's plugins folder.
#
# Files are copied rather than symlinked on purpose: a vault synced through
# iCloud or Obsidian Sync carries the plugin folder to other devices, and a
# symlink that resolves on this Mac is a dead link everywhere else.
#
# Usage:
#   OBSIDIAN_VAULT="/path/to/vault" npm run sync
#
# Set OBSIDIAN_VAULT in your shell profile to avoid repeating it.

set -euo pipefail

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  echo "OBSIDIAN_VAULT is not set." >&2
  echo 'Usage: OBSIDIAN_VAULT="/path/to/vault" npm run sync' >&2
  exit 1
fi

if [[ ! -d "$OBSIDIAN_VAULT/.obsidian" ]]; then
  echo "Not an Obsidian vault (no .obsidian folder): $OBSIDIAN_VAULT" >&2
  exit 1
fi

if [[ ! -f main.js ]]; then
  echo "main.js not found. Run 'npm run build' first." >&2
  exit 1
fi

target="$OBSIDIAN_VAULT/.obsidian/plugins/journal-entries"
mkdir -p "$target"
cp main.js manifest.json styles.css "$target/"

echo "Synced to $target"
echo "Reload the plugin in Obsidian: disable and re-enable it under Community plugins."
