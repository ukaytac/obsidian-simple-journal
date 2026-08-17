/**
 * The guard behind `JournalView`'s save-on-unmount path, factored out so it
 * can be exercised directly with a fake `write`/`onError` — the same
 * dependency-injection shape `mountWindow.ts` uses — rather than only through
 * a live `JournalView` (which needs a DOM and Obsidian internals this test
 * environment doesn't provide).
 */

/**
 * Writes `value` via `write` unless it already matches `savedBody`.
 *
 * Neither `EntryEditor` implementation has a dirty check — `flush()` always
 * fires its change callback — so without this guard, every unmount
 * (including a plain scroll past an entry nobody edited, since
 * `mountObserver` flushes on every exit) would call `write` unconditionally:
 * a real mtime bump, a real vault `modify` event, a real sync upload, for
 * zero actual change. `vault.process` itself is not documented to skip an
 * identical write, so this can't be left to it.
 *
 * Never rejects: a failure from `write` is reported via `onError` rather
 * than thrown, so a caller flushing on unmount/teardown (`JournalView`'s
 * `flushSave`, and transitively `clearTimeline`/`unmountEditor`) can always
 * proceed regardless of whether the write behind it succeeded. Proper
 * user-facing failure handling is a later, dedicated task; this is only
 * about the write never being able to reject the caller's teardown.
 *
 * Returns the body now known to be on disk: `value` on a skip or a
 * successful write, or the original `savedBody` unchanged if `write` failed
 * — so a later save attempt with the same value is retried rather than
 * wrongly treated as already-saved.
 */
export async function saveIfChanged(
  value: string,
  savedBody: string,
  write: (value: string) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<string> {
  if (value === savedBody) return savedBody;

  try {
    await write(value);
    return value;
  } catch (error) {
    onError(error);
    return savedBody;
  }
}
