// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { App, TFile } from "obsidian";
import { ObsidianEmbedEditor } from "../src/views/ObsidianEmbedEditor";
import { replaceBody, splitFrontmatter } from "../src/journal/markdownDoc";

/**
 * Same rationale as tests/textareaEditor.test.ts: plain jsdom has neither
 * `createEl`/`createDiv` nor `.doc`, both of which Obsidian patches onto
 * HTMLElement/Node at runtime. ObsidianEmbedEditor calls `el.createDiv()`
 * (mount) and `containerEl.doc` (hasFocus), so both need a minimal,
 * obsidian.d.ts-faithful stand-in here too.
 */
function installObsidianDomHelpers(win: typeof globalThis): void {
  const elementProto = win.HTMLElement.prototype as any;

  const makeCreator =
    (defaultTag: string) =>
    function (this: HTMLElement, tagOrOptions?: unknown, options?: { cls?: string | string[] }): HTMLElement {
      const tag = typeof tagOrOptions === "string" ? tagOrOptions : defaultTag;
      const opts = typeof tagOrOptions === "string" ? options : (tagOrOptions as { cls?: string | string[] } | undefined);
      const child = this.ownerDocument.createElement(tag);
      const cls = opts?.cls;
      if (cls) {
        const classes = Array.isArray(cls) ? cls : cls.split(" ").filter(Boolean);
        child.classList.add(...classes);
      }
      this.appendChild(child);
      return child;
    };

  if (!elementProto.createEl) elementProto.createEl = makeCreator("div");
  if (!elementProto.createDiv) elementProto.createDiv = makeCreator("div");

  const nodeProto = win.Node.prototype as Node & { doc?: Document };
  if (!Object.getOwnPropertyDescriptor(nodeProto, "doc")) {
    Object.defineProperty(nodeProto, "doc", {
      configurable: true,
      get(this: Node): Document {
        return this.ownerDocument ?? (win.document as Document);
      },
    });
  }
}

installObsidianDomHelpers(globalThis as unknown as typeof globalThis);

/**
 * A fake `embedByExtension.md` creator standing in for Obsidian's real one.
 * Models exactly the shape docs/editor-embed-api.md measured: `editMode` is
 * undefined until `showEditor()` runs, `get()` returns the whole document
 * (frontmatter included), and `set()` replaces it wholesale. `initialDoc`
 * stands in for "the embed loaded this file's current disk content itself".
 *
 * On a successful `showEditor()` it also builds the two `.markdown-embed-content`
 * panes docs/editor-embed-api.md found (preview + editor, only the latter
 * containing `.cm-editor`) inside whatever `containerEl` the creator was
 * invoked with — real enough for `tagEditorPane()` to find and tag the right
 * one, the same as any other mount test exercises. `opts.noEditorDom` skips
 * this, to exercise the "never finds a pane at all" failure path.
 *
 * `opts.throwOnLoad`/`throwOnShowEditor` model a shape change or a runtime
 * error partway through construction. `breakGet()` flips `get()` from
 * "working" to "throws" after the fact, for the failure-after-mount case.
 * `simulateReload(diskDoc)` models the embed reloading its own buffer from
 * disk on a vault `modify` event — the self-reload race this file's
 * `onFileChanged` neutralisation and `notifyWritten`/`pendingWrite` guard
 * both defend against — without needing a real vault or a real
 * `onFileChanged` (which this test's embed also has, and which the code
 * under test neutralises).
 */
function fakeEmbedCreator(
  initialDoc: string,
  opts: {
    noEditMode?: boolean;
    throwOnLoad?: boolean;
    throwOnShowEditor?: boolean;
    noEditorDom?: boolean;
  } = {},
) {
  let doc = initialDoc;
  let getShouldThrow = false;
  let hostContainerEl: HTMLElement | null = null;

  // Obsidian's real requestSave is very likely a Debouncer function object
  // carrying its own .cancel()/.run(), not a plain function — see
  // neutralise()'s doc in the source file for why that matters.
  const requestSave = vi.fn() as unknown as (() => void) & {
    cancel: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  requestSave.cancel = vi.fn();
  requestSave.run = vi.fn();

  const spies = {
    save: vi.fn(async () => {}),
    requestSave,
    requestSaveFolds: vi.fn(),
    onFileChanged: vi.fn(),
    load: vi.fn(() => {
      if (opts.throwOnLoad) throw new Error("load boom");
    }),
    showEditor: vi.fn(),
    unload: vi.fn(),
    onunload: vi.fn(),
    set: vi.fn((value: string) => {
      doc = value;
    }),
  };

  const embed: Record<string, unknown> = {
    editable: false,
    save: spies.save,
    requestSave: spies.requestSave,
    requestSaveFolds: spies.requestSaveFolds,
    onFileChanged: spies.onFileChanged,
    load: spies.load,
    unload: spies.unload,
    onunload: spies.onunload,
    showEditor: () => {
      if (opts.throwOnShowEditor) throw new Error("showEditor boom");
      spies.showEditor();
      if (opts.noEditMode) return;
      embed.editMode = {
        get: () => {
          if (getShouldThrow) throw new Error("get boom");
          return doc;
        },
        set: (value: string, _clearHistory: boolean) => spies.set(value),
        cm: { focus: vi.fn(), requestMeasure: vi.fn() },
      };

      if (!opts.noEditorDom && hostContainerEl) {
        const ownerDoc = hostContainerEl.ownerDocument;

        const preview = ownerDoc.createElement("div");
        preview.className = "markdown-embed-content";
        hostContainerEl.appendChild(preview);

        const editorPane = ownerDoc.createElement("div");
        editorPane.className = "markdown-embed-content";
        const cmEditor = ownerDoc.createElement("div");
        cmEditor.className = "cm-editor";
        editorPane.appendChild(cmEditor);
        hostContainerEl.appendChild(editorPane);
      }
    },
  };

  const creator = (context: { containerEl: HTMLElement }) => {
    hostContainerEl = context.containerEl;
    return embed;
  };

  return {
    creator,
    embed,
    spies,
    getDoc: () => doc,
    setDoc: (v: string) => (doc = v),
    simulateReload: (diskDoc: string) => (doc = diskDoc),
    breakGet: () => {
      getShouldThrow = true;
    },
  };
}

/**
 * Some scenarios (remounting) need the creator to hand back a *fresh* embed
 * on each call, exactly like the real `embedByExtension.md` does for a fresh
 * `creator(context, file, subpath)` invocation. This tracks every embed it
 * creates so a test can assert on the first one after a second mount() has
 * moved on to a new one.
 */
function fakeEmbedCreatorFactory() {
  const created: Array<ReturnType<typeof fakeEmbedCreator>> = [];
  let nextDoc = "";

  const creator = (context: { containerEl: HTMLElement }) => {
    const instance = fakeEmbedCreator(nextDoc);
    created.push(instance);
    return instance.creator(context);
  };

  return {
    creator,
    setNextDoc: (doc: string) => {
      nextDoc = doc;
    },
    created,
  };
}

function fakeApp(mdCreator: unknown = undefined): App {
  return {
    embedRegistry: { embedByExtension: mdCreator ? { md: mdCreator } : {} },
  } as unknown as App;
}

const SEEDED_DOC =
  '---\ncreated: "2026-01-01T00:00:00+03:00"\nmood: "probe"\n---\n\nORIGINAL BODY.\n';
// Derived, not hand-typed: splitFrontmatter's body includes the blank line
// after the closing delimiter (see tests/markdownDoc.test.ts), so a
// hand-typed constant here would silently drift from what the translation
// layer actually produces.
const SEEDED_BODY = splitFrontmatter(SEEDED_DOC).body;

function fakeFile(): TFile {
  return { path: "Journal/2026/01/entry.md" } as unknown as TFile;
}

/** Focuses the mounted `.journal-entry-embed` container so hasFocus() reports true. */
function focusEmbedContainer(container: HTMLElement): HTMLElement {
  const embedContainer = container.querySelector(".journal-entry-embed") as HTMLElement;
  embedContainer.tabIndex = -1;
  embedContainer.focus();
  return embedContainer;
}

/**
 * Every editor that reaches a successful mount() starts a real
 * `window.setInterval` poll (unless the test opted into `vi.useFakeTimers()`).
 * A real interval is a live Node timer handle that keeps running — and keeps
 * its closure alive — after the test body returns, so every editor
 * constructed via `tracked()` gets `destroy()`d in `afterEach`, exactly as a
 * real caller (JournalView) is required to do before discarding one.
 */
const trackedEditors: ObsidianEmbedEditor[] = [];
function tracked(editor: ObsidianEmbedEditor): ObsidianEmbedEditor {
  trackedEditors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of trackedEditors.splice(0)) editor.destroy();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ObsidianEmbedEditor: availability and mount failures", () => {
  it("isUsable() is false and nothing is rendered when the internal API is absent", () => {
    const editor = tracked(new ObsidianEmbedEditor(fakeApp()));
    const container = document.createElement("div");

    editor.mount(container, fakeFile(), SEEDED_BODY);

    expect(editor.isUsable()).toBe(false);
    expect(container.children.length).toBe(0);
  });

  it("isUsable() is false when file is null (an uncommitted composer)", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    editor.mount(container, null, "");

    expect(editor.isUsable()).toBe(false);
    expect(container.children.length).toBe(0);
  });

  it("isUsable() is false when editMode never materializes (a shape change)", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC, { noEditMode: true });
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    editor.mount(container, fakeFile(), SEEDED_BODY);

    expect(editor.isUsable()).toBe(false);
  });

  it("a mount() that throws is caught and leaves isUsable() false", () => {
    const creator = () => {
      throw new Error("boom");
    };
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    expect(() => editor.mount(container, fakeFile(), SEEDED_BODY)).not.toThrow();
    expect(editor.isUsable()).toBe(false);
  });

  it("a throw from showEditor() (after load() already ran) still tears down the leaked embed", () => {
    // Regression test: this.embed was previously assigned only after
    // showEditor() succeeded, so a throw from showEditor() itself left the
    // catch block's `if (this.embed)` false — the already-constructed,
    // already-load()ed embed was never unload()ed, and its Component kept
    // whatever it registered running against detached DOM.
    const { creator, spies } = fakeEmbedCreator(SEEDED_DOC, { throwOnShowEditor: true });
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    expect(() => editor.mount(container, fakeFile(), SEEDED_BODY)).not.toThrow();

    expect(editor.isUsable()).toBe(false);
    expect(spies.load).toHaveBeenCalled();
    expect(spies.unload).toHaveBeenCalled();
    expect(spies.onunload).toHaveBeenCalled();
  });

  it("calls onUnusable and flips isUsable() false when no CM6 editor pane is ever found", () => {
    vi.useFakeTimers();
    const { creator } = fakeEmbedCreator(SEEDED_DOC, { noEditorDom: true });
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    let unusableFired = false;
    editor.onUnusable(() => (unusableFired = true));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    // Still true synchronously: the safety-net check is deferred to the
    // next tick specifically to tolerate a CM6 DOM built asynchronously.
    expect(editor.isUsable()).toBe(true);
    expect(unusableFired).toBe(false);

    vi.advanceTimersByTime(0);

    expect(editor.isUsable()).toBe(false);
    expect(unusableFired).toBe(true);
  });

  it("tags exactly the pane containing .cm-editor, not both panes", () => {
    // Guards the positive case: the noEditorDom test above only proves
    // tagEditorPane() fails safely when it finds NOTHING. It would still
    // pass unchanged if tagEditorPane() ever dropped its ".cm-editor" check
    // and tagged both panes — which would make the CSS reveal the preview
    // pane too, alongside the editor.
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const panes = Array.from(container.querySelectorAll(".markdown-embed-content"));
    expect(panes.length).toBe(2); // sanity: the fake really built both panes

    const tagged = panes.filter((pane) => pane.classList.contains("journal-entry-embed-editor-pane"));
    expect(tagged.length).toBe(1);
    expect(tagged[0].querySelector(".cm-editor")).not.toBeNull();

    const untagged = panes.filter((pane) => !pane.classList.contains("journal-entry-embed-editor-pane"));
    expect(untagged.length).toBe(1);
    expect(untagged[0].querySelector(".cm-editor")).toBeNull();
  });
});

describe("ObsidianEmbedEditor: the body/document translation", () => {
  it("getValue() strips frontmatter that the embed's buffer holds", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    editor.mount(container, fakeFile(), SEEDED_BODY);

    expect(editor.isUsable()).toBe(true);
    expect(editor.getValue()).toBe(SEEDED_BODY);
  });

  it("mount() does not force a document replace when the loaded body already matches initialValue", () => {
    const { creator, spies } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    editor.mount(container, fakeFile(), SEEDED_BODY);

    expect(spies.set).not.toHaveBeenCalled();
  });

  it("mount() corrects the buffer via replaceBody when the loaded body differs from initialValue", () => {
    const { creator, getDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");

    const newBody = "DIFFERENT SEED.\n";
    editor.mount(container, fakeFile(), newBody);

    // Frontmatter survives the correction; only the body changed.
    expect(getDoc()).toBe(replaceBody(SEEDED_DOC, newBody));
    expect(editor.getValue()).toBe(newBody);
  });

  it("setValue(body) preserves the frontmatter already in the embed's buffer", () => {
    const { creator, getDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const newBody = "REPLACED BODY.\n";
    editor.setValue(newBody);

    expect(getDoc()).toBe(replaceBody(SEEDED_DOC, newBody));
    expect(editor.getValue()).toBe(newBody);
  });

  it("round-trips correctly when the file has no frontmatter at all", () => {
    const noFrontmatterDoc = "JUST A BODY, NO FRONTMATTER.\n";
    const { creator, getDoc } = fakeEmbedCreator(noFrontmatterDoc);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), noFrontmatterDoc);

    editor.setValue("STILL NO FRONTMATTER.\n");

    expect(getDoc()).toBe("STILL NO FRONTMATTER.\n");
    expect(editor.getValue()).toBe("STILL NO FRONTMATTER.\n");
  });
});

describe("ObsidianEmbedEditor: the frontmatter guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("a genuinely broken frontmatter delimiter suppresses reporting until it's restored", () => {
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    // The user deletes the closing "---": splitFrontmatter now finds no
    // frontmatter at all, and the whole document becomes "the body".
    const broken = 'created: "2026-01-01T00:00:00+03:00"\nmood: "probe"\n\nORIGINAL BODY.\n';
    setDoc(broken);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([]);
    expect(editor.getValue()).toBe(SEEDED_BODY); // falls back to the last known-good body

    // Restoring the delimiter self-heals. The body itself never changed
    // from SEEDED_BODY throughout, so there is still nothing new to report.
    setDoc(SEEDED_DOC);
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([]);
  });

  it("a legitimate frontmatter property addition does not stop future body edits from being reported", () => {
    // Regression test: the guard used to bail on ANY difference from the
    // snapshot taken at mount, not only a genuinely broken delimiter — so a
    // single legitimate property addition made every later body edit
    // unreportable for the rest of the session.
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const withNewProperty =
      '---\ncreated: "2026-01-01T00:00:00+03:00"\nmood: "probe"\ntag: "life"\n---\n\nORIGINAL BODY.\n';
    setDoc(withNewProperty);
    vi.advanceTimersByTime(300);
    // The body itself hasn't changed, so nothing is reported yet — but the
    // frontmatter snapshot must have refreshed rather than latching onto the
    // old one and rejecting everything from here on.
    expect(changes).toEqual([]);

    setDoc(replaceBody(withNewProperty, "A NEW BODY EDIT.\n"));
    vi.advanceTimersByTime(300);

    expect(changes).toEqual(["A NEW BODY EDIT.\n"]);
  });

  it("also catches a false-negative closing delimiter hidden by a thematic break in the body", () => {
    // Regression test: the guard only checked `frontmatter === ""`, which
    // misses this case entirely. If the body itself contains its own "---"
    // (an ordinary Markdown thematic break) and the user deletes the
    // frontmatter's REAL closing "---", the document still starts with
    // "---", so splitFrontmatter closes the block on the body's thematic
    // break instead: "frontmatter" silently swallows everything up to and
    // including that break, and "body" becomes only the text after it — a
    // strict suffix of what the body used to be, with everything before the
    // break missing. Reporting that truncated tail as the whole body would
    // have the view write it as such, deleting the earlier text from disk
    // while it's still visible on screen.
    const RULE_DOC =
      '---\ncreated: "2026-01-01T00:00:00+03:00"\nmood: "probe"\n---\n\nBefore the rule.\n\n---\n\nAfter the rule.\n';
    const ruleBody = splitFrontmatter(RULE_DOC).body;

    const { creator, setDoc } = fakeEmbedCreator(RULE_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), ruleBody);
    expect(editor.getValue()).toBe(ruleBody);

    // Delete the frontmatter's closing "---" (but leave the thematic break
    // further down untouched).
    const closingDelimiterDeleted =
      '---\ncreated: "2026-01-01T00:00:00+03:00"\nmood: "probe"\n\nBefore the rule.\n\n---\n\nAfter the rule.\n';
    setDoc(closingDelimiterDeleted);
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([]);
    expect(editor.getValue()).toBe(ruleBody);
  });
});

describe("ObsidianEmbedEditor: hazard 1 — neutralising the embed's writer and self-reload hooks", () => {
  it("save(), requestSave(), requestSaveFolds() and onFileChanged() are no-ops on the mounted instance", () => {
    const { creator, embed, spies } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const record = embed as Record<string, unknown>;
    expect(() => (record.save as () => void)()).not.toThrow();
    expect(() => (record.requestSave as () => void)()).not.toThrow();
    expect(() => (record.requestSaveFolds as () => void)()).not.toThrow();
    expect(() => (record.onFileChanged as () => void)()).not.toThrow();

    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.requestSave).not.toHaveBeenCalled();
    expect(spies.requestSaveFolds).not.toHaveBeenCalled();
    expect(spies.onFileChanged).not.toHaveBeenCalled();
  });

  it("save()'s replacement still returns a Promise, matching the real API", async () => {
    const { creator, embed } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const save = (embed as Record<string, unknown>).save as () => unknown;
    const result = save();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it("requestSave's replacement still carries the original's own properties (e.g. a Debouncer's cancel()/run())", () => {
    const { creator, embed } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const requestSave = (embed as Record<string, unknown>).requestSave as {
      cancel?: () => void;
      run?: () => void;
    };
    expect(typeof requestSave.cancel).toBe("function");
    expect(typeof requestSave.run).toBe("function");
    expect(() => requestSave.cancel?.()).not.toThrow();
    expect(() => requestSave.run?.()).not.toThrow();
  });
});

describe("ObsidianEmbedEditor: change polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("polling notices an external change to the embed's buffer and reports the body only", () => {
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);
    expect(changes).toEqual([]); // mount() itself must not fire onChange

    setDoc(replaceBody(SEEDED_DOC, "TYPED BY THE EMBED.\n"));
    vi.advanceTimersByTime(300);

    expect(changes).toEqual(["TYPED BY THE EMBED.\n"]);
  });

  it("stops polling after destroy(): no onChange fires for a later buffer change", () => {
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);
    editor.destroy();

    setDoc("this change happens after destroy and must be ignored\n");
    vi.advanceTimersByTime(1000);

    expect(changes).toEqual([]);
  });

  it("a get() failure discovered by the poll flips isUsable() false, fires onUnusable, and stops polling", () => {
    const { creator, breakGet, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));
    let unusableFired = false;
    editor.onUnusable(() => (unusableFired = true));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);
    expect(editor.isUsable()).toBe(true);

    // Simulates a shape change or a runtime failure discovered only after a
    // successful mount (e.g. the file was deleted out from under it).
    breakGet();
    vi.advanceTimersByTime(300);

    expect(editor.isUsable()).toBe(false);
    expect(unusableFired).toBe(true);

    // Polling must actually have stopped, not just gone quiet because
    // get() keeps throwing: a later, unrelated buffer change (impossible in
    // practice once get() itself is broken, but proves the interval is
    // really gone) must not resurrect it.
    setDoc(replaceBody(SEEDED_DOC, "SHOULD NEVER BE SEEN.\n"));
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
  });
});

describe("ObsidianEmbedEditor: write-echo guard (notifyWritten)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("a stale reload racing ahead of typing does not clobber newer keystrokes", () => {
    // Reproduces the exact trace from review: user types "B1"; the poll
    // reports it; a caller's debounced write of "B1" starts; the user types
    // on to "B2" while that write is still in flight; the "B1" write
    // finally resolves (modelled by the explicit notifyWritten("B1") call —
    // the real JournalView calls this immediately after its vault.process
    // write resolves, which can easily be after the user has moved on, as
    // here) and its vault `modify` event reloads the embed's buffer back to
    // (now stale) "B1" — modelled here via simulateReload() directly,
    // standing in for a real onFileChanged-triggered reload (which the code
    // under test neutralises; this test proves the SECOND, independent
    // guard also holds, regardless of whether that neutralisation is what's
    // doing the work in a real Obsidian window). The reload arrives one
    // poll tick after notifyWritten, well inside WRITE_ECHO_WINDOW_MS.
    const { creator, setDoc, simulateReload } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);
    // The restore-on-echo path only engages while the user is still here.
    focusEmbedContainer(container);

    setDoc(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1"]);

    setDoc(replaceBody(SEEDED_DOC, "B2"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1", "B2"]);

    editor.notifyWritten("B1"); // the view's debounced write of "B1" only resolves now

    simulateReload(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);

    // The bug: "B1" gets reported again and "B2" is gone. The fix: this
    // exact body was confirmed written a moment ago, so the reload is
    // recognised as that write's echo — nothing new is reported, and the
    // buffer is restored to "B2".
    expect(changes).toEqual(["B1", "B2"]);
    expect(editor.getValue()).toBe("B2");
  });

  it("a legitimate revert to a previously emitted body (e.g. undo) is reported as a normal edit, not suppressed", () => {
    // Regression test for the FIRST version of this guard, which was
    // content-keyed against a history of everything this editor had ever
    // emitted: typing "Today I ran.", then " Fast", then undoing/backspacing
    // back to "Today I ran." reverted to a body the guard had seen before
    // and — with no provenance check — misread as a stale reload, silently
    // retyping " Fast" back in under the user mid-undo. The provenance-based
    // guard has no pending write to match here (notifyWritten is never
    // called in this test), so it must not suppress anything.
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);
    focusEmbedContainer(container);

    setDoc(replaceBody(SEEDED_DOC, "Today I ran."));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["Today I ran."]);

    setDoc(replaceBody(SEEDED_DOC, "Today I ran. Fast"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["Today I ran.", "Today I ran. Fast"]);

    // Undo/backspace back to a body already seen once before.
    setDoc(replaceBody(SEEDED_DOC, "Today I ran."));
    vi.advanceTimersByTime(300);

    expect(changes).toEqual(["Today I ran.", "Today I ran. Fast", "Today I ran."]);
    expect(editor.getValue()).toBe("Today I ran.");
  });

  it("an echo outside the write-echo window is treated as a normal edit", () => {
    const { creator, setDoc, simulateReload } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);
    focusEmbedContainer(container);

    setDoc(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1"]);

    editor.notifyWritten("B1");

    setDoc(replaceBody(SEEDED_DOC, "B2"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1", "B2"]);

    // Well past WRITE_ECHO_WINDOW_MS (300ms): the pending record must have
    // lapsed, so this reload back to "B1" is no longer explained by it and
    // is reported like any other edit.
    vi.advanceTimersByTime(5000);
    simulateReload(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);

    expect(changes).toEqual(["B1", "B2", "B1"]);
  });

  it("a revert arriving after the (now short) window is reported as a normal edit, not suppressed", () => {
    // Regression test for Important 1: with the previous ~1s window, a
    // quick type-then-revert of exactly the just-written text — timed at
    // ~700ms after notifyWritten, comfortably inside that window — was
    // misread as a stale echo and silently undone. Shrinking the window to
    // ~300ms (a genuine echo lands within roughly one poll tick of the
    // write resolving, so it doesn't need to be any wider) lets this same
    // timing through as an ordinary edit instead.
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);
    focusEmbedContainer(container);

    setDoc(replaceBody(SEEDED_DOC, "Today I ran."));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["Today I ran."]);

    editor.notifyWritten("Today I ran."); // the write of exactly this text just resolved

    // The user types a space; reported normally (doesn't match the pending
    // write's exact body).
    setDoc(replaceBody(SEEDED_DOC, "Today I ran. "));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["Today I ran.", "Today I ran. "]);

    // ~700ms have now passed since notifyWritten — past the 300ms window.
    vi.advanceTimersByTime(300);

    // The user backspaces the space, reverting to exactly the body that
    // was written. Because the window has lapsed, this is an ordinary edit.
    setDoc(replaceBody(SEEDED_DOC, "Today I ran."));
    vi.advanceTimersByTime(300);

    expect(changes).toEqual(["Today I ran.", "Today I ran. ", "Today I ran."]);
    expect(editor.getValue()).toBe("Today I ran.");
  });

  it("an echo is corrected in the buffer even when the editor is unfocused, so a teardown flush never writes stale text", () => {
    // Regression test for Important 2: the restore used to be gated on
    // hasFocus(), so when a genuine echo arrived while nobody was focused
    // on this editor, the change stream stayed correct but the buffer and
    // lastBody were left diverged from it — getValue()/flush() kept
    // reporting the stale echoed body, and a teardown flush would have
    // written it over the user's actual, newer text.
    const { creator, setDoc, simulateReload } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    // Deliberately not appended to document.body / not focused: hasFocus()
    // must report false throughout this test.
    editor.mount(container, fakeFile(), SEEDED_BODY);

    setDoc(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1"]);

    setDoc(replaceBody(SEEDED_DOC, "B2"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["B1", "B2"]);

    editor.notifyWritten("B1");
    simulateReload(replaceBody(SEEDED_DOC, "B1"));
    vi.advanceTimersByTime(300);

    // Still correctly suppressed: no spurious "B1" reported.
    expect(changes).toEqual(["B1", "B2"]);
    // The regression: this used to return "B1" here because the buffer was
    // never corrected without focus.
    expect(editor.getValue()).toBe("B2");

    // flush() unconditionally re-emits the current value — must be "B2",
    // not a stale "B1" written over the user's actual text at teardown.
    editor.flush();
    expect(changes).toEqual(["B1", "B2", "B2"]);
  });
});

describe("ObsidianEmbedEditor: blur handling", () => {
  it("does not fire onBlur when focus moves to a relatedTarget still inside the container", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const embedContainer = container.querySelector(".journal-entry-embed") as HTMLElement;
    const innerWidget = document.createElement("div");
    embedContainer.appendChild(innerWidget);

    let blurred = false;
    editor.onBlur(() => (blurred = true));

    // Models CM6's own in-editor search panel, or clicking a widget: focus
    // moves within the container, so `focusout` bubbles even though this
    // editor never actually lost focus.
    embedContainer.dispatchEvent(new FocusEvent("focusout", { relatedTarget: innerWidget }));

    expect(blurred).toBe(false);
  });

  it("fires onBlur when focus moves outside the container", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const embedContainer = container.querySelector(".journal-entry-embed") as HTMLElement;
    const outsideEl = document.createElement("div");
    document.body.appendChild(outsideEl);

    let blurred = false;
    editor.onBlur(() => (blurred = true));

    embedContainer.dispatchEvent(new FocusEvent("focusout", { relatedTarget: outsideEl }));

    expect(blurred).toBe(true);
  });

  it("fires onBlur when relatedTarget is null (focus left the document/window)", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);

    const embedContainer = container.querySelector(".journal-entry-embed") as HTMLElement;

    let blurred = false;
    editor.onBlur(() => (blurred = true));

    embedContainer.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));

    expect(blurred).toBe(true);
  });
});

describe("ObsidianEmbedEditor: lifecycle", () => {
  it("getValue() stays truthful after destroy()", () => {
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    setDoc(replaceBody(SEEDED_DOC, "UNSAVED EDIT.\n"));
    editor.destroy();

    expect(editor.getValue()).toBe("UNSAVED EDIT.\n");
  });

  it("flush() before any mount() is a no-op", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    editor.flush();

    expect(changes).toEqual([]);
  });

  it("flush() commits the editor's current value through the change callback", () => {
    const { creator, setDoc } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);
    setDoc(replaceBody(SEEDED_DOC, "IN-FLIGHT EDIT.\n"));

    editor.flush();

    expect(changes).toEqual(["IN-FLIGHT EDIT.\n"]);
  });

  it("remeasure() does not throw, mounted or not", () => {
    const editor = tracked(new ObsidianEmbedEditor(fakeApp()));
    expect(() => editor.remeasure()).not.toThrow();

    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const mounted = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    mounted.mount(container, fakeFile(), SEEDED_BODY);
    expect(() => mounted.remeasure()).not.toThrow();
  });

  it("a second mount() discards the first embed's teardown hooks without flushing it", () => {
    const factory = fakeEmbedCreatorFactory();
    factory.setNextDoc(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(factory.creator)));
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, fakeFile(), SEEDED_BODY);

    // A real remount would embed a (possibly different) file; here the same
    // creator hands back a brand-new embed, exactly as it would for any
    // fresh creator(context, file, subpath) call.
    const secondDoc = '---\ncreated: "2026-02-02T00:00:00+03:00"\n---\n\nSECOND.\n';
    const secondBody = splitFrontmatter(secondDoc).body;
    factory.setNextDoc(secondDoc);
    editor.mount(container, fakeFile(), secondBody);

    expect(factory.created[0].spies.unload).toHaveBeenCalled();
    expect(changes).toEqual([]); // discard-without-flush: no onChange for the first embed
    expect(editor.getValue()).toBe(secondBody);
  });
});

describe("ObsidianEmbedEditor: hasFocus()", () => {
  it("resolves against the container's own document, not the ambient global one", () => {
    const popout = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
    installObsidianDomHelpers(popout.window as unknown as typeof globalThis);

    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));

    const popoutContainer = popout.window.document.createElement("div");
    popout.window.document.body.appendChild(popoutContainer);
    editor.mount(popoutContainer as unknown as HTMLElement, fakeFile(), SEEDED_BODY);

    // The mounted .journal-entry-embed container itself, in the popout's own
    // document. A plain div needs a tabIndex to be focusable at all; the
    // real embed's CM6 content DOM provides its own focusable element, but
    // that's exactly the internal shape this test must not depend on —
    // `container.contains(activeElement)` includes the container itself.
    const focusTarget = popoutContainer.querySelector(".journal-entry-embed") as HTMLElement;
    focusTarget.tabIndex = -1;
    focusTarget.focus();

    expect(document.activeElement).not.toBe(focusTarget);
    expect(editor.hasFocus()).toBe(true);

    popout.window.close();
  });

  it("returns false when nothing inside the container is focused", () => {
    const { creator } = fakeEmbedCreator(SEEDED_DOC);
    const editor = tracked(new ObsidianEmbedEditor(fakeApp(creator)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container, fakeFile(), SEEDED_BODY);

    expect(editor.hasFocus()).toBe(false);
  });

  it("returns false before any mount()", () => {
    const editor = tracked(new ObsidianEmbedEditor(fakeApp()));
    expect(editor.hasFocus()).toBe(false);
  });
});
