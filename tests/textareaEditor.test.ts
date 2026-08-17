// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { TextareaEditor } from "../src/views/TextareaEditor";

/**
 * Obsidian patches `HTMLElement.prototype.createEl` and `Node.prototype.doc`
 * at runtime (see obsidian.d.ts); plain jsdom has neither. TextareaEditor
 * calls both (`createEl` in mount(), `.doc` in hasFocus()), so a bare jsdom
 * `HTMLElement` can't run it as-is. This installs minimal, obsidian.d.ts-
 * faithful stand-ins on a given window's prototypes — just enough for these
 * lifecycle tests. It intentionally does NOT model layout: `offsetParent`,
 * `scrollHeight` etc. stay at jsdom's unconditional zero/null, which is
 * exactly why resize() itself is not exercised here (see
 * docs/manual-testing-editor.md for that).
 */
function installObsidianDomHelpers(win: typeof globalThis): void {
  // Cast to `any`: obsidian.d.ts globally augments HTMLElement.createEl with
  // an overloaded, tag-name-generic signature (pulled in ambiently because
  // src/ imports types from "obsidian"). A plain shim can't structurally
  // satisfy that overload, and doesn't need to — this is a test-only stand-in.
  const elementProto = win.HTMLElement.prototype as any;

  if (!elementProto.createEl) {
    elementProto.createEl = function (
      this: HTMLElement,
      tag: string,
      options?: { cls?: string | string[] }
    ): HTMLElement {
      const child = this.ownerDocument.createElement(tag);
      const cls = options?.cls;
      if (cls) {
        const classes = Array.isArray(cls) ? cls : cls.split(" ").filter(Boolean);
        child.classList.add(...classes);
      }
      this.appendChild(child);
      return child;
    };
  }

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

function mountEditor(initialValue = ""): {
  editor: TextareaEditor;
  container: HTMLElement;
  textarea: HTMLTextAreaElement;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new TextareaEditor();
  editor.mount(container, null, initialValue);
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("mount() did not create a textarea");
  return { editor, container, textarea };
}

/** Dispatches a real input event with `inputType` set, as a live editor produces. */
function typeInto(textarea: HTMLTextAreaElement, value: string, inputType = "insertText"): void {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { inputType }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TextareaEditor value and lifecycle", () => {
  it("getValue() returns the current text while mounted", () => {
    const { editor, textarea } = mountEditor("hello");
    typeInto(textarea, "hello world");
    expect(editor.getValue()).toBe("hello world");
  });

  it("getValue() stays truthful after destroy(), even for a focused editor holding unsaved text", () => {
    const { editor, textarea } = mountEditor("hello");
    typeInto(textarea, "hello unsaved");
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    editor.destroy();

    // Chromium fires no blur when a focused element is removed; getValue()
    // must not fall through to "" just because the textarea is gone.
    expect(editor.getValue()).toBe("hello unsaved");
  });

  it("buffers a setValue() that arrives before mount() and applies it as the seed", () => {
    const editor = new TextareaEditor();
    editor.setValue("buffered externally");

    const container = document.createElement("div");
    editor.mount(container, null, "initial value, should be overridden");

    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe("buffered externally");
    expect(editor.getValue()).toBe("buffered externally");
  });

  it("mount() without a prior setValue() uses initialValue and fires no change callback", () => {
    const editor = new TextareaEditor();
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, null, "seeded content");

    expect(editor.getValue()).toBe("seeded content");
    expect(changes).toEqual([]);
  });

  it("flush() before mount() is a no-op", () => {
    const editor = new TextareaEditor();
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    editor.flush();

    expect(changes).toEqual([]);
  });

  it("flush() after edits commits the current value through the change callback", () => {
    const editor = new TextareaEditor();
    const changes: string[] = [];
    editor.onChange((value) => changes.push(value));

    const container = document.createElement("div");
    editor.mount(container, null, "hello");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "hello there");
    expect(changes).toEqual(["hello there"]);

    editor.flush();

    expect(changes).toEqual(["hello there", "hello there"]);
  });

  it("mount() is idempotent: a second call replaces the first textarea instead of appending a duplicate", () => {
    const editor = new TextareaEditor();
    const container = document.createElement("div");

    editor.mount(container, null, "first");
    editor.mount(container, null, "second");

    const textareas = container.querySelectorAll("textarea");
    expect(textareas.length).toBe(1);
    expect(textareas[0].value).toBe("second");
    expect(editor.getValue()).toBe("second");
  });

  it("hasFocus() resolves against the textarea's own document, not the ambient global one", () => {
    // Stands in for a popout window: a second, independent Document/Window,
    // exactly like Workspace.moveLeafToPopout gives a leaf its own document.
    const popout = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
    installObsidianDomHelpers(popout.window as unknown as typeof globalThis);

    const popoutContainer = popout.window.document.createElement("div");
    popout.window.document.body.appendChild(popoutContainer);

    const editor = new TextareaEditor();
    editor.mount(popoutContainer as unknown as HTMLElement, null, "in a popout");
    const textarea = popoutContainer.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();

    // The ambient (main-window) document never saw this element focused.
    expect(document.activeElement).not.toBe(textarea);
    // But the popout's own document did — and hasFocus() must consult that.
    expect(popout.window.document.activeElement).toBe(textarea);
    expect(editor.hasFocus()).toBe(true);

    popout.window.close();
  });

  it("hasFocus() returns false when the editor is not focused", () => {
    const { editor } = mountEditor("hello");
    expect(editor.hasFocus()).toBe(false);
  });

  it("setValue() after mount() updates the value and getValue() reflects it", () => {
    const { editor, textarea } = mountEditor("hello");

    editor.setValue("changed from another pane");

    expect(textarea.value).toBe("changed from another pane");
    expect(editor.getValue()).toBe("changed from another pane");
  });

  it("remeasure() on an unmounted editor does not throw", () => {
    const editor = new TextareaEditor();
    expect(() => editor.remeasure()).not.toThrow();
  });

  it("focus('end') moves the caret to the end of the current text", () => {
    // Exercises the composer-swap handover (JournalView.commitComposer):
    // the real editor is seeded with whatever the user already typed, and
    // the caret must land after it, not at the start of the document.
    const { editor, textarea } = mountEditor("already typed this");
    editor.focus("end");

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("already typed this".length);
    expect(textarea.selectionEnd).toBe("already typed this".length);
  });

  it("plain focus() (no caret argument) does not move an existing selection", () => {
    const { editor, textarea } = mountEditor("hello world");
    textarea.setSelectionRange(2, 2);

    editor.focus();

    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
  });
});
