/**
 * The settings tab writes the one value that decides where every journal entry
 * lives, and `EntryRepository` reads it live and *creates* that folder on the
 * next write. So the property under test is not "the field works" — it is that
 * a value only reaches `plugin.settings` once the user has stopped typing.
 * Without that, typing "Journal" one letter at a time would leave `J`, `Jo`,
 * `Jou`... behind as real folders in the vault.
 *
 * Obsidian 1.13 added a declarative settings API, so there are now two paths
 * into that same commit. These tests cover the declarative one, since it is
 * the path a current Obsidian takes.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { JournalSettingsTab } from "../src/settings/SettingsTab";
import { DEFAULT_SETTINGS } from "../src/settings/settings";

const DEBOUNCE_MS = 500;

interface FakePlugin {
  app: unknown;
  settings: { journalFolder: string };
  saveSettings: () => Promise<void>;
  refreshJournal: () => void;
}

function setup(initialFolder = DEFAULT_SETTINGS.journalFolder) {
  const saveSettings = vi.fn(() => Promise.resolve());
  const refreshJournal = vi.fn();
  const plugin: FakePlugin = {
    app: {},
    settings: { journalFolder: initialFolder },
    saveSettings,
    refreshJournal,
  };
  // The tab only ever touches app/settings/saveSettings/refreshJournal.
  const tab = new JournalSettingsTab(plugin as never);
  return { tab, plugin, saveSettings, refreshJournal };
}

describe("JournalSettingsTab, declarative path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares one searchable text control bound to the journal folder", () => {
    const { tab } = setup();

    const items = tab.getSettingDefinitions();

    expect(items).toHaveLength(1);
    const item = items[0] as { name: string; desc: string; control: { type: string; key: string } };
    expect(item.name).toBe("Journal folder");
    expect(item.desc).toContain("Created when the first entry is written");
    expect(item.control.type).toBe("text");
    expect(item.control.key).toBe("journalFolder");
  });

  it("reads the live setting, and answers undefined for a key it does not own", () => {
    const { tab, plugin } = setup("Diary");

    expect(tab.getControlValue("journalFolder")).toBe("Diary");
    // Must not reach `super`: the base implementation does not exist before
    // Obsidian 1.13, which `minAppVersion: 1.7.2` still admits.
    expect(tab.getControlValue("somethingElse")).toBeUndefined();

    plugin.settings.journalFolder = "Notes";
    expect(tab.getControlValue("journalFolder")).toBe("Notes");
  });

  /** The whole reason the debounce exists. */
  it("does not touch plugin.settings while the user is still typing", () => {
    const { tab, plugin, saveSettings } = setup("Journal");

    for (const partial of ["D", "Di", "Dia", "Diar", "Diary"]) {
      tab.setControlValue("journalFolder", partial);
      vi.advanceTimersByTime(100); // each keystroke well inside the window
    }

    expect(plugin.settings.journalFolder).toBe("Journal");
    expect(saveSettings).not.toHaveBeenCalled();

    // Only the settled value ever lands.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(plugin.settings.journalFolder).toBe("Diary");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("saves and refreshes once the value settles", async () => {
    const { tab, plugin, saveSettings, refreshJournal } = setup();

    tab.setControlValue("journalFolder", "Diary");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(plugin.settings.journalFolder).toBe("Diary");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // The refresh is chained off the save, so let the promise settle.
    await vi.runAllTimersAsync();
    expect(refreshJournal).toHaveBeenCalledTimes(1);
  });

  it("treats a blank field as the default rather than the vault root", () => {
    const { tab, plugin } = setup("Diary");

    tab.setControlValue("journalFolder", "   ");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(plugin.settings.journalFolder).toBe(DEFAULT_SETTINGS.journalFolder);
  });

  it("falls back to the default for a value that is not a string", () => {
    const { tab, plugin } = setup("Diary");

    // `setControlValue` receives `unknown`; nothing guarantees the control
    // handed back a string.
    tab.setControlValue("journalFolder", undefined);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(plugin.settings.journalFolder).toBe(DEFAULT_SETTINGS.journalFolder);
  });

  it("ignores a key it does not own instead of committing it", () => {
    const { tab, plugin, saveSettings } = setup("Journal");

    tab.setControlValue("someOtherKey", "Diary");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(plugin.settings.journalFolder).toBe("Journal");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  /**
   * Closing the tab mid-debounce must commit the last edit, not drop it —
   * flushing rather than cancelling, and before the plugin might be disabled.
   */
  it("flushes a pending edit when the tab closes", () => {
    const { tab, plugin, saveSettings } = setup("Journal");

    tab.setControlValue("journalFolder", "Diary");
    expect(plugin.settings.journalFolder).toBe("Journal"); // still pending

    tab.hide();

    expect(plugin.settings.journalFolder).toBe("Diary");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("does not commit twice when the debounce would also have fired", () => {
    const { tab, saveSettings } = setup();

    tab.setControlValue("journalFolder", "Diary");
    tab.hide();
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("is harmless to close with nothing pending", () => {
    const { tab, plugin, saveSettings } = setup("Journal");

    tab.hide();

    expect(plugin.settings.journalFolder).toBe("Journal");
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
