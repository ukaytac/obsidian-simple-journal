import { Plugin, WorkspaceLeaf } from "obsidian";
import { EntryRepository } from "./journal/entryRepository";
import { DEFAULT_SETTINGS, type JournalSettings } from "./settings/settings";
import { JournalSettingsTab } from "./settings/SettingsTab";
import { JournalView, VIEW_TYPE_JOURNAL } from "./views/JournalView";

export default class JournalEntriesPlugin extends Plugin {
  settings: JournalSettings = { ...DEFAULT_SETTINGS };
  repository!: EntryRepository;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.repository = new EntryRepository(this.app, () => this.settings.journalFolder);

    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));
    this.addSettingTab(new JournalSettingsTab(this));

    this.addRibbonIcon("book-open", "Open journal", () => {
      void this.openJournal();
    });

    this.addCommand({
      id: "open-journal",
      name: "Open journal",
      callback: () => void this.openJournal(),
    });

    this.addCommand({
      id: "new-journal-entry",
      name: "New journal entry",
      callback: () => void this.newEntry(),
    });

    this.addCommand({
      id: "go-to-today",
      name: "Go to today",
      callback: () => void this.goToToday(),
    });

    this.registerProbeCommand();
  }

  /**
   * TEMPORARY — Task 8 spike. Probes the internal embedded-editor registry so
   * its real shape can be recorded in docs/editor-embed-api.md before the
   * editor layer is built on it. Removed once the spike is done.
   */
  private registerProbeCommand(): void {
    this.addCommand({
      id: "probe-embed-api",
      name: "DEBUG: probe embedded editor API",
      callback: () => void this.runProbe(),
    });

    this.addCommand({
      id: "probe-embed-cleanup",
      name: "DEBUG: clean up embed probe",
      callback: () => void this.cleanupProbe(),
    });
  }

  /**
   * TEMPORARY — Task 8 spike, second pass.
   *
   * Binds the embed to a scratch file this plugin owns rather than whatever
   * note happens to be active: the embed exposes `save()` and `requestSave()`,
   * so typing into it can write through to the underlying file.
   */
  private async runProbe(): Promise<void> {
    const registry = (
      this.app as unknown as {
        embedRegistry?: { embedByExtension?: Record<string, unknown> };
      }
    ).embedRegistry?.embedByExtension;

    console.log("--- Journal Entries embed probe (pass 2) ---");
    console.log("md creator type:", typeof registry?.md);

    if (typeof registry?.md !== "function") {
      console.log("NO md CREATOR — the internal API is absent on this version.");
      return;
    }

    const scratchPath = "Journal/_probe-scratch.md";
    const seed =
      '---\ncreated: "2026-01-01T00:00:00+03:00"\nmood: "probe"\n---\n\nORIGINAL BODY LINE ONE.\n\nORIGINAL BODY LINE TWO.\n';

    if (!this.app.vault.getFolderByPath("Journal")) {
      await this.app.vault.createFolder("Journal");
    }

    let file = this.app.vault.getFileByPath(scratchPath);
    if (file) {
      await this.app.vault.modify(file, seed);
      console.log("reset scratch file:", scratchPath);
    } else {
      file = await this.app.vault.create(scratchPath, seed);
      console.log("created scratch file:", scratchPath);
    }

    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;bottom:20px;right:20px;width:420px;max-height:320px;overflow:auto;z-index:9999;" +
      "background:var(--background-primary);border:1px solid var(--background-modifier-border);" +
      "border-radius:8px;padding:12px";
    document.body.appendChild(host);

    const creator = registry.md as (
      context: unknown,
      file: unknown,
      subpath: string,
    ) => Record<string, unknown>;

    try {
      const embed = creator(
        { app: this.app, containerEl: host, showInline: true, depth: 0 },
        file,
        "",
      );

      const call = (name: string): void => {
        const fn = (embed as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
          console.log(`  ${name}(): not a function`);
          return;
        }
        try {
          (fn as () => void).call(embed);
          console.log(`  ${name}(): ok`);
        } catch (error) {
          console.log(`  ${name}() threw:`, error);
        }
      };

      console.log("setting editable = true, then load(), then showEditor()");
      (embed as Record<string, unknown>).editable = true;
      call("load");
      call("showEditor");

      const globals = window as unknown as Record<string, unknown>;
      globals.__journalEmbed = embed;
      globals.__journalEmbedHost = host;

      const e = embed as Record<string, unknown>;
      const editMode = () => e.editMode as { get?: () => string; set?: (v: string, c: boolean) => void } | undefined;
      const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
      const show = (label: string, value: unknown) =>
        console.log(`${label}:`, JSON.stringify(value));
      const readFile = async (): Promise<string> => {
        const f = this.app.vault.getFileByPath(scratchPath);
        return f ? await this.app.vault.read(f) : "<FILE GONE>";
      };

      await wait(400);

      console.log("=== A. after load + showEditor ===");
      console.log("_loaded:", e._loaded, "| editMode present:", "editMode" in e);
      console.log("editor.cm present:", Boolean((e.editor as Record<string, unknown> | undefined)?.cm));
      show("editMode.get()", editMode()?.get?.());
      show("embed.text", e.text);
      show("embed.data", e.data);
      show("embed.rawFrontmatter", e.rawFrontmatter);
      show("embed.lastSavedData", e.lastSavedData);
      console.log("dirty:", e.dirty);

      console.log("=== B. DOM chrome that must be hidden ===");
      console.log("has .cm-editor:", Boolean(host.querySelector(".cm-editor")));
      console.log("has .inline-title:", Boolean(host.querySelector(".inline-title")));
      console.log("has .metadata-container:", Boolean(host.querySelector(".metadata-container")));
      console.log("has .markdown-embed-title:", Boolean(host.querySelector(".markdown-embed-title")));
      console.log("has .markdown-embed-link:", Boolean(host.querySelector(".markdown-embed-link")));
      console.log("host child classes:", Array.from(host.children).map((c) => c.className));

      console.log("=== C. writing through editMode.set() ===");
      editMode()?.set?.("REPLACED BODY VIA SET.\n", false);
      await wait(300);
      show("editMode.get() after set", editMode()?.get?.());
      console.log("dirty after set:", e.dirty);
      show("file on disk right after set", await readFile());

      console.log("=== D. did it autosave? waiting 2.5s, no explicit save() ===");
      await wait(2500);
      console.log("dirty after wait:", e.dirty);
      show("file on disk after wait", await readFile());

      console.log("=== E. does real typing trigger the embed's own save? ===");
      // Reset to a body-only buffer, the shape our EntryEditor would install.
      editMode()?.set?.("BODY ONLY, NO FRONTMATTER.\n", false);
      await wait(200);

      const cm = (e.editor as { cm?: Record<string, unknown> } | undefined)?.cm;
      if (cm && typeof (cm as { dispatch?: unknown }).dispatch === "function") {
        // A real CodeMirror transaction is as close to a keystroke as we can
        // get without a human at the keyboard.
        (cm as { dispatch: (tr: unknown) => void }).dispatch({
          changes: { from: 0, insert: "TYPED. " },
          userEvent: "input.type",
        });
        console.log("dispatched a CM input transaction");
      } else {
        console.log("NO cm.dispatch — cannot simulate typing");
      }

      await wait(2500);
      console.log("dirty after typing:", e.dirty);
      show("editMode.get() after typing", editMode()?.get?.());
      show("file on disk after typing", await readFile());

      console.log("=== F. explicit save() with a body-only buffer ===");
      console.log("If this writes the buffer verbatim, frontmatter is destroyed.");
      call("save");
      await wait(800);
      show("file on disk after save()", await readFile());

      console.log("=== G. unload ===");
      call("unload");
      call("onunload");
      await wait(600);
      show("file on disk after unload", await readFile());

      host.remove();
      console.log("=== probe finished. Scratch file left in place. ===");
    } catch (error) {
      console.error("creator() threw:", error);
      host.remove();
    }
  }

  /** TEMPORARY — Task 8 spike. Unloads the probe embed and removes its host. */
  private async cleanupProbe(): Promise<void> {
    const globals = window as unknown as Record<string, unknown>;
    const embed = globals.__journalEmbed as Record<string, unknown> | undefined;
    const host = globals.__journalEmbedHost as HTMLElement | undefined;

    if (embed) {
      const value =
        (embed.editMode as { get?: () => string } | undefined)?.get?.() ?? embed.text ?? embed.data;
      console.log("value the editor held at cleanup:", value);

      for (const name of ["unload", "onunload"]) {
        const fn = embed[name];
        if (typeof fn === "function") {
          try {
            (fn as () => void).call(embed);
            console.log(`${name}(): ok`);
          } catch (error) {
            console.log(`${name}() threw:`, error);
          }
        }
      }
    }

    host?.remove();
    delete globals.__journalEmbed;
    delete globals.__journalEmbedHost;

    const scratch = this.app.vault.getFileByPath("Journal/_probe-scratch.md");
    if (scratch) {
      console.log("scratch file contents now:", await this.app.vault.read(scratch));
      console.log("Delete it yourself if you want it gone: Journal/_probe-scratch.md");
    }

    console.log("probe cleaned up");
  }

  onunload(): void {
    // Obsidian detaches views of a plugin's registered types automatically.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (typeof this.settings.journalFolder !== "string" || this.settings.journalFolder.trim() === "") {
      this.settings.journalFolder = DEFAULT_SETTINGS.journalFolder;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Opens the journal view, reusing an existing leaf when one exists. Returns
   * null if the leaf's view isn't a JournalView by the time this resolves —
   * for example if the plugin was disabled mid-await, which detaches the
   * leaf and leaves it with an empty view.
   */
  async openJournal(): Promise<JournalView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
    }

    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof JournalView ? view : null;
  }

  async newEntry(): Promise<void> {
    const view = await this.openJournal();
    if (view) await view.startNewEntry();
  }

  async goToToday(): Promise<void> {
    const view = await this.openJournal();
    if (view) view.scrollToTop();
  }

  refreshJournal(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
      // A deferred leaf's view is a DeferredView, not a JournalView — its
      // onOpen rebuilds it when it loads, so it needs no refresh here. Skip
      // rather than throw, or one deferred leaf would abort the whole loop.
      const view = leaf.view;
      if (view instanceof JournalView) void view.reload();
    }
  }
}
