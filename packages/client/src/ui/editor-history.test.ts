// @vitest-environment jsdom
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEditorHistory } from "./editor-history.js";

const execCommand = vi.fn(() => true);

beforeEach(() => {
  execCommand.mockClear();
  Object.defineProperty(document, "execCommand", {
    value: execCommand,
    configurable: true,
  });
});

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

/** An editor with an edit already made, as the Memo and the clipboard editor both have one. */
function mountEdited(doc: string, appended: string): EditorView {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [history()] }),
  });
  view.dispatch({
    changes: { from: view.state.doc.length, insert: appended },
    userEvent: "input.type",
  });
  return view;
}

function mountField(
  tag: "input" | "textarea",
  inTerminal: boolean,
): HTMLElement {
  const field = document.createElement(tag);
  const host = document.createElement("div");
  if (inTerminal) host.className = "xterm";
  host.append(field);
  document.body.append(host);
  return field;
}

describe("runEditorHistory", () => {
  it("undoes the edit in the editor holding the caret", () => {
    const editor = mountEdited("claude", " --resume");

    runEditorHistory(editor.contentDOM, "undo");

    expect(editor.state.doc.toString()).toBe("claude");
  });

  it("redoes what it just undid", () => {
    const editor = mountEdited("claude", " --resume");
    runEditorHistory(editor.contentDOM, "undo");

    runEditorHistory(editor.contentDOM, "redo");

    expect(editor.state.doc.toString()).toBe("claude --resume");
  });

  it("leaves the editors alone while nothing has focus", () => {
    const editor = mountEdited("claude", " --resume");

    runEditorHistory(document.body, "undo");

    expect(editor.state.doc.toString()).toBe("claude --resume");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("hands a plain text field to the browser's own history", () => {
    runEditorHistory(mountField("input", false), "undo");

    expect(execCommand).toHaveBeenCalledWith("undo");
  });

  it("leaves the terminal alone: its hidden textarea is not an editor", () => {
    runEditorHistory(mountField("textarea", true), "undo");

    expect(execCommand).not.toHaveBeenCalled();
  });

  it("does nothing when the caret sits outside anything editable", () => {
    document.body.innerHTML = "<div id='tabs'></div>";

    runEditorHistory(document.getElementById("tabs"), "undo");
    runEditorHistory(null, "undo");

    expect(execCommand).not.toHaveBeenCalled();
  });
});
