// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoEditor } from "./MemoEditor.js";

// The indent spec itself lives in editor-indent.test.ts; this suite only pins that the Memo editor
// carries the binding.

afterEach(cleanup);

function renderMemo(text: string) {
  const onChange = vi.fn<(text: string) => void>();
  const utils = render(
    <MemoEditor
      buffer={{ text, savedText: text }}
      onChange={onChange}
      onSave={vi.fn()}
    />,
  );
  const content = utils.container.querySelector<HTMLElement>(".cm-content");
  if (content === null) throw new Error("the Memo editor did not mount");
  return { onChange, content };
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
});
