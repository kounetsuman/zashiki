// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef, type ReactNode, type RefObject, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoViewState } from "../memo/memo-view-state.js";
import { MemoEditor } from "./MemoEditor.js";

// The indent spec itself lives in editor-indent.test.ts; this suite only pins that the Memo editor
// carries the binding.

afterEach(cleanup);

function renderMemo(
  text: string,
  viewState?: RefObject<MemoViewState | null>,
  wrap: (editor: ReactNode) => ReactNode = (editor) => editor,
) {
  const onChange = vi.fn<(text: string) => void>();
  const memo = (text: string) =>
    wrap(
      <MemoEditor
        buffer={{ text, savedText: text }}
        onChange={onChange}
        onSave={vi.fn()}
        viewState={viewState}
      />,
    );
  const utils = render(memo(text));
  const content = utils.container.querySelector<HTMLElement>(".cm-content");
  const scroller = utils.container.querySelector<HTMLElement>(".cm-scroller");
  if (content === null || scroller === null)
    throw new Error("the Memo editor did not mount");
  return {
    onChange,
    content,
    scroller,
    unmount: utils.unmount,
    /** Delivers text from the server, as a memo.sync does for a clean buffer. */
    sync: (incoming: string) => utils.rerender(memo(incoming)),
  };
}

/** Long enough that the scroller has somewhere to scroll to. */
const LONG_TEXT = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");

function editorOf(content: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error("the Memo editor did not mount");
  return view;
}

function caretAt(content: HTMLElement, pos: number): void {
  editorOf(content).dispatch({ selection: { anchor: pos } });
}

function rangesOf(content: HTMLElement): { anchor: number; head: number }[] {
  return editorOf(content).state.selection.ranges.map(({ anchor, head }) => ({
    anchor,
    head,
  }));
}

function caretOf(content: HTMLElement): number {
  return editorOf(content).state.selection.main.head;
}

function pressTab(content: HTMLElement, extra?: KeyboardEventInit): void {
  content.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

describe("MemoEditor", () => {
  it("indents at the caret on Tab instead of moving focus away", () => {
    const { onChange, content } = renderMemo("one");
    pressTab(content);
    expect(onChange).toHaveBeenCalledWith("  one");
  });

  it("outdents on Shift+Tab", () => {
    const { onChange, content } = renderMemo("    one");
    pressTab(content, { shiftKey: true });
    expect(onChange).toHaveBeenCalledWith("  one");
  });

  it("reopens where it was left instead of at the top of the document", async () => {
    const viewState = createRef<MemoViewState | null>();
    const first = renderMemo(LONG_TEXT, viewState);
    first.scroller.scrollTop = 420;
    caretAt(first.content, 30);
    first.unmount();

    const second = renderMemo(LONG_TEXT, viewState);
    expect(caretOf(second.content)).toBe(30);
    await waitFor(() => expect(second.scroller.scrollTop).toBe(420));
  });

  it("starts at the top when nothing has been remembered", () => {
    const { scroller, content } = renderMemo(LONG_TEXT, createRef());
    expect(scroller.scrollTop).toBe(0);
    expect(caretOf(content)).toBe(0);
  });

  it("keeps the remembered offset through StrictMode's discarded first mount", async () => {
    const viewState = createRef<MemoViewState | null>();
    const first = renderMemo(LONG_TEXT, viewState);
    first.scroller.scrollTop = 420;
    first.unmount();

    // StrictMode mounts, tears that mount down, and mounts again; the editor thrown away in between
    // never scrolled anywhere, and must not report its zero as where the reader was.
    const second = renderMemo(LONG_TEXT, viewState, (editor) => (
      <StrictMode>{editor}</StrictMode>
    ));
    await waitFor(() => expect(second.scroller.scrollTop).toBe(420));
  });

  it("keeps a remembered caret inside a document that shrank while away", () => {
    const viewState = createRef<MemoViewState | null>();
    const first = renderMemo(LONG_TEXT, viewState);
    caretAt(first.content, 60);
    first.unmount();

    const { content } = renderMemo("tiny", viewState);
    expect(caretOf(content)).toBe(4);
  });

  it("mounts with a remembered caret that CRLF pairs put past the end of the document", () => {
    const viewState = createRef<MemoViewState | null>();
    viewState.current = { scrollTop: 0, anchor: 7, head: 7 };

    // "a\r\nb\r\nc" is 7 characters of text, but CodeMirror stores the breaks as \n: a 5 character doc.
    expect(() => renderMemo("a\r\nb\r\nc", viewState)).not.toThrow();
  });

  describe("text arriving from the server", () => {
    it("keeps every caret range where it was", () => {
      const memo = renderMemo("one two three\nfour");
      editorOf(memo.content).dispatch({
        selection: EditorSelection.create(
          [EditorSelection.cursor(2), EditorSelection.range(14, 18)],
          1,
        ),
      });

      memo.sync("one 2 three\nfour");
      expect(rangesOf(memo.content)).toEqual([
        { anchor: 2, head: 2 },
        { anchor: 12, head: 16 },
      ]);
      expect(editorOf(memo.content).state.selection.mainIndex).toBe(1);
    });

    it("clamps a caret to text that shrank", () => {
      const memo = renderMemo(LONG_TEXT);
      caretAt(memo.content, 600);
      memo.sync("tiny");
      expect(caretOf(memo.content)).toBe(4);
    });

    it("keeps the scroll offset", async () => {
      const memo = renderMemo(LONG_TEXT);
      memo.scroller.scrollTop = 420;
      memo.sync(`${LONG_TEXT}\nappended`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(memo.scroller.scrollTop).toBe(420);
    });

    it("cannot be undone, so undo never brings back the text it replaced", () => {
      const memo = renderMemo("mine");
      memo.sync("theirs");
      const view = editorOf(memo.content);
      undo(view);
      expect(view.state.doc.toString()).toBe("theirs");
      expect(memo.onChange).not.toHaveBeenCalled();
    });

    it("does not report the server's text back as a local edit", () => {
      const memo = renderMemo("a");
      memo.sync("b");
      expect(memo.onChange).not.toHaveBeenCalled();
    });
  });

  it("leaves a CRLF memo untouched on mount", () => {
    const { onChange, content } = renderMemo("a\r\nb");
    expect(onChange).not.toHaveBeenCalled();
    expect(undo(editorOf(content))).toBe(false);
  });
});
