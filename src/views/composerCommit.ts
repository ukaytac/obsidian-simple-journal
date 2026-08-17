/**
 * Pure decision logic behind `JournalView.commitComposer` — kept separate,
 * and free of any Obsidian/DOM dependency, so it's directly testable the
 * same way `mountWindow.ts`, `applyChange.ts` and `entrySave.ts` keep their
 * own decisions independent of the view.
 */

/**
 * Whether `value` holds anything worth committing, per CLAUDE.md's "Lazy
 * Creation": whitespace-only content (an empty composer, or one the user
 * typed into and then fully deleted again) is never meaningful. Shared by
 * every place that needs this same check — the composer's own onChange, the
 * re-check `commitComposer` does once its turn in the mutation chain
 * actually arrives (content can be deleted again while queued behind
 * another mutation), and `discardEmptyComposer` — so the definition can't
 * drift between them.
 */
export function isMeaningful(value: string): boolean {
  return value.trim().length > 0;
}

/** What `commitComposer` should do once the entry's file exists. */
export interface ComposerMountPlan {
  /** The value to seed the real editor with. Always the freshest read. */
  seed: string;
  /**
   * True when `seed` is not yet known to be on disk. The caller must
   * schedule a save for `seed` rather than treating the mount as already in
   * sync with disk: the real editor is always seeded with `seed` regardless
   * (never less than what the user actually typed), so silently treating it
   * as saved here would leave `savedBody` claiming a disk state that isn't
   * real, and the next unmount/flush would find nothing left to write.
   */
  needsSave: boolean;
}

/** `seed` vs. `confirmedDisk` -> what the caller should do about it. */
export function planComposerMount(confirmedDisk: string, seed: string): ComposerMountPlan {
  return { seed, needsSave: seed !== confirmedDisk };
}

/**
 * Resolves what to seed the real editor with, and whether a save is still
 * needed, once the composer's file has just been created holding
 * `confirmedDisk` as its body.
 *
 * A keystroke can land in the composer's still-mounted textarea at two
 * points this doesn't itself see: while `createEntry` was in flight (already
 * reflected in `readCurrent()` by the time this is called), and — the one
 * naive single-read code missed — while `persist` below is awaited. This
 * re-reads AFTER the persist too, rather than trusting a value snapshotted
 * before that await: skipping that second read is exactly the bug where a
 * fast typist's last few characters are seeded stale into the real editor
 * and then flushed right back out over what persist just wrote.
 *
 * `persist` mirrors `saveIfChanged`'s own contract — given the value to
 * write and the value currently confirmed on disk, it returns whatever is
 * now actually confirmed on disk (the new value on success, the original
 * unchanged on failure) — so a failed write here still lets the caller catch
 * up correctly instead of wrongly declaring `seed` saved.
 */
export async function resolveComposerContent(
  confirmedDisk: string,
  readCurrent: () => string,
  persist: (value: string, confirmedDisk: string) => Promise<string>,
): Promise<ComposerMountPlan> {
  const afterCreate = readCurrent();

  if (afterCreate !== confirmedDisk) {
    confirmedDisk = await persist(afterCreate, confirmedDisk);
  }

  const seed = readCurrent();
  return planComposerMount(confirmedDisk, seed);
}
