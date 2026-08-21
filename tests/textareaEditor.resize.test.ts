// @vitest-environment jsdom
/**
 * The fallback editor's resize decision, which had no automated coverage at
 * all: jsdom reports `offsetParent` as null and `scrollHeight` as 0, so
 * `resize()` returned at its first guard and every mutation to the logic below
 * it survived. `textareaEditor.test.ts` says as much and leaves it to a human.
 *
 * The part worth pinning is not the arithmetic, it is the asymmetry the code is
 * built around: `scrollHeight` can prove that content GREW, but it cannot prove
 * that content SHRANK — a box taller than its text simply reports its own
 * height back. So the cheap path is only allowed for an edit that provably
 * cannot have shrunk, and everything else must remeasure. Get that backwards
 * and deleting a paragraph leaves a blank gap under the text, which is a
 * user-visible bug no type checker will catch.
 *
 * Layout is faked only as far as that decision needs: whether the element is
 * laid out, and what height it reports.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextareaEditor } from "../src/views/TextareaEditor";

interface Harness {
  editor: TextareaEditor;
  textarea: HTMLTextAreaElement;
  /** Every `height` this run has written, in order. */
  writes: string[];
  /** What `scrollHeight` reports next. Set before firing an edit. */
  setContentHeight: (px: number) => void;
  /** Sets `value` and fires an input event; no `inputType` means a bare Event. */
  edit: (value: string, inputType?: string) => void;
}

let installed = false;

function installShims(): void {
  if (installed) return;
  installed = true;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;

  // Obsidian patches these onto HTMLElement at runtime; plain jsdom has neither.
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options?: { cls?: string }) {
      const child = this.ownerDocument.createElement(tag);
      if (options?.cls) child.classList.add(...options.cls.split(" ").filter(Boolean));
      this.appendChild(child);
      return child;
    };
  }
  if (!proto.setCssStyles) {
    proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
      for (const [key, value] of Object.entries(styles)) {
        this.style.setProperty(key, value);
      }
    };
  }
  const nodeProto = Node.prototype as Node & { doc?: Document };
  if (!Object.getOwnPropertyDescriptor(nodeProto, "doc")) {
    Object.defineProperty(nodeProto, "doc", {
      configurable: true,
      get(this: Node) {
        return this.ownerDocument ?? document;
      },
    });
  }
}

function mount(initialValue: string, initialHeight: number): Harness {
  installShims();

  const container = document.createElement("div");
  document.body.appendChild(container);

  const editor = new TextareaEditor();
  editor.mount(container, null, initialValue);

  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("no textarea mounted");

  let contentHeight = initialHeight;

  // Laid out, unlike anything in bare jsdom.
  Object.defineProperty(textarea, "offsetParent", { configurable: true, get: () => container });
  Object.defineProperty(textarea, "clientWidth", { configurable: true, get: () => 600 });
  // Models the asymmetry the production code is built around, which is the
  // whole point of this file:
  //
  //   - `height: auto` lets the box collapse, so scrollHeight reports exactly
  //     what the content needs — the truth, in both directions.
  //   - pinned to an explicit height, scrollHeight reports the LARGER of the
  //     two. Content taller than the box overflows and is counted, which is
  //     how growth is detectable without collapsing first. Content shorter
  //     than the box is invisible: the box reports its own height back, and a
  //     shrink cannot be seen at all.
  //
  // That last line is why a shrink must never be allowed down the cheap path.
  // If it were, this stub would hand back the stale height and the test would
  // catch it — which is exactly what should happen.
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => {
      const pinned = textarea.style.height;
      if (!pinned || pinned === "auto") return contentHeight;
      return Math.max(parseInt(pinned, 10), contentHeight);
    },
  });

  const writes: string[] = [];
  const style = textarea.style;
  const realSetProperty = style.setProperty.bind(style);
  style.setProperty = (name: string, value: string | null, priority?: string) => {
    if (name === "height") writes.push(value ?? "");
    return realSetProperty(name, value, priority);
  };

  // Settle the initial measurement so the assertions below start from a known
  // pinned height, then forget the writes it took to get there.
  editor.remeasure();
  writes.length = 0;

  return {
    editor,
    textarea,
    writes,
    setContentHeight: (px: number) => {
      contentHeight = px;
    },
    edit: (value: string, inputType?: string) => {
      textarea.value = value;
      // A real InputEvent for a real edit; a bare Event for the synthetic case,
      // which is exactly what an `input` event with no inputType looks like.
      textarea.dispatchEvent(
        inputType === undefined
          ? new Event("input")
          : new InputEvent("input", { inputType }),
      );
    },
  };
}

let harness: Harness | null = null;

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  harness?.editor.destroy();
  document.body.innerHTML = "";
});

describe("TextareaEditor resize decision", () => {
  it("settles on the content's height when first measured", () => {
    harness = mount("one line", 40);
    expect(harness.textarea.style.height).toBe("40px");
  });

  it("skips the remeasure for a growth-only edit whose height did not change", () => {
    harness = mount("hello", 40);

    // Typing one more character: same line count, longer text, and the box
    // still reports the height it is pinned to.
    harness.edit("hello!", "insertText");

    expect(harness.writes).toEqual([]);
    expect(harness.textarea.style.height).toBe("40px");
  });

  /** The case the whole asymmetry exists for. */
  it("remeasures when the edit could have shrunk the content", () => {
    harness = mount("line one\nline two\nline three", 120);
    expect(harness.textarea.style.height).toBe("120px");

    harness.setContentHeight(40);
    harness.edit("line one", "deleteContentBackward");

    expect(harness.textarea.style.height).toBe("40px");
    expect(harness.writes).toContain("auto");
  });

  /**
   * The newline count cannot catch this one, and it is the commonest shrink
   * there is: one long line wrapped across several visual rows, then shortened.
   * No newline is added or removed — the text simply stops wrapping — so only
   * the length check stands between this and a box left at its old height with
   * a blank gap under the text.
   */
  it("remeasures when a wrapped single line is shortened", () => {
    harness = mount("a very long single line that wraps across three visual rows", 120);
    expect(harness.textarea.style.height).toBe("120px");

    harness.setContentHeight(40);
    harness.edit("a very long", "deleteContentBackward");

    expect(harness.textarea.style.height).toBe("40px");
  });

  /**
   * `inputType` is spec'd as a string, but an `input` event can be dispatched
   * by anything, with anything on it. Treating a non-string as "present" would
   * send an unknown edit down the path reserved for edits known not to have
   * shrunk; the conservative direction is the only safe one.
   */
  it("treats a non-string inputType as no inputType at all", () => {
    harness = mount("hello", 40);

    const event = new Event("input");
    Object.defineProperty(event, "inputType", { value: null });
    harness.textarea.value = "hello!";
    harness.setContentHeight(40);
    harness.textarea.dispatchEvent(event);

    expect(harness.writes).toContain("auto");
  });

  it("remeasures an edit that grows in length but loses a line", () => {
    harness = mount("a\nb", 80);

    // Longer, so a length check alone would wave it through; one line fewer,
    // so it can have shrunk.
    harness.setContentHeight(40);
    harness.edit("aaaaaa", "insertText");

    expect(harness.textarea.style.height).toBe("40px");
  });

  /**
   * An `input` event carrying no `inputType` is not necessarily a user edit —
   * it can be dispatched by anything — so nothing about the value's history is
   * known and the cheap path must not apply. This is the branch the removed
   * `as InputEvent` assertion used to sit on.
   */
  it("remeasures an edit with no inputType, even when it only grew", () => {
    harness = mount("hello", 40);

    harness.setContentHeight(40);
    harness.edit("hello!");

    expect(harness.writes).toContain("auto");
  });

  it("grows the box when content gets taller", () => {
    harness = mount("one", 40);

    harness.setContentHeight(160);
    harness.edit("one\ntwo\nthree\nfour", "insertLineBreak");

    expect(harness.textarea.style.height).toBe("160px");
  });

  it("leaves the box alone and asks to retry when it is not laid out", () => {
    harness = mount("hello", 40);
    Object.defineProperty(harness.textarea, "offsetParent", {
      configurable: true,
      get: () => null,
    });

    harness.edit("hello there", "insertText");

    expect(harness.writes).toEqual([]);
  });
});
