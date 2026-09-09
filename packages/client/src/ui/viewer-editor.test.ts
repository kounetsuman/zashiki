// @vitest-environment jsdom
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { viewerEditorExtensions } from "./viewer-editor.js";

let view: EditorView | null = null;

function mountViewer(): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "hello world",
      extensions: viewerEditorExtensions(new Compartment()),
    }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("viewerEditorExtensions", () => {
  it("stays read-only and non-editable", () => {
    const v = mountViewer();
    expect(v.state.readOnly).toBe(true);
    expect(v.state.facet(EditorView.editable)).toBe(false);
  });

  it("keeps the content focusable so the Cmd+F keymap can reach it", () => {
    // CodeMirror only delivers keymaps to a focused content element, and an
    // editable:false content div is unfocusable without an explicit tabindex.
    const v = mountViewer();
    expect(v.contentDOM.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("wires in the find panel", () => {
    const v = mountViewer();
    openSearchPanel(v);
    expect(v.dom.querySelector(".cm-find")).not.toBeNull();
  });
});
