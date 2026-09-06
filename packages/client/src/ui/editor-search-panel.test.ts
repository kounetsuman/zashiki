// @vitest-environment jsdom
import { openSearchPanel } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { editorSearch } from "./editor-search-panel.js";

let view: EditorView | null = null;

function mountPanel(options?: { findOnly?: boolean }): HTMLElement {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "hello hello world",
      extensions: [editorSearch(options)],
    }),
  });
  openSearchPanel(view);
  const panel = view.dom.querySelector<HTMLElement>(".cm-find");
  if (panel === null) throw new Error("search panel did not open");
  return panel;
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

describe("editorSearch", () => {
  it("shows the find field and flag toggles in both modes", () => {
    for (const options of [undefined, { findOnly: true }]) {
      const panel = mountPanel(options);
      expect(panel.querySelector(".cm-find-input")).not.toBeNull();
      expect(panel.querySelectorAll(".cm-find-toggle")).toHaveLength(3);
      view?.destroy();
      view = null;
    }
  });

  it("includes the replace row and expander by default (editable surfaces)", () => {
    const panel = mountPanel();
    expect(panel.querySelector(".cm-find-replace-row")).not.toBeNull();
    expect(panel.querySelector(".cm-find-expand")).not.toBeNull();
  });

  it("drops the replace row and expander when findOnly (read-only Viewer)", () => {
    const panel = mountPanel({ findOnly: true });
    expect(panel.querySelector(".cm-find-replace-row")).toBeNull();
    expect(panel.querySelector(".cm-find-expand")).toBeNull();
  });
});
