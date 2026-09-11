// @vitest-environment jsdom
import { openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { afterEach, describe, expect, it } from "vitest";

import { editorSearch } from "./editor-search-panel.js";

let view: EditorView | null = null;

function mountView(options?: { findOnly?: boolean }): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "hello hello world",
      // basicSetup carries CodeMirror's own Mod-f binding, and is listed first so the toggle only
      // wins by precedence — not by happening to be registered earlier.
      extensions: [basicSetup, editorSearch(options)],
    }),
  });
  return view;
}

function openPanel(mounted: EditorView): HTMLElement {
  openSearchPanel(mounted);
  const panel = mounted.dom.querySelector<HTMLElement>(".cm-find");
  if (panel === null) throw new Error("search panel did not open");
  return panel;
}

function mountPanel(options?: { findOnly?: boolean }): HTMLElement {
  return openPanel(mountView(options));
}

function findInput(panel: HTMLElement): HTMLElement {
  const input = panel.querySelector<HTMLElement>(".cm-find-input");
  if (input === null) throw new Error("find field is missing");
  return input;
}

// jsdom reports no platform, so CodeMirror resolves the binding's "Mod-" prefix to Ctrl here.
// keyCode carries the US-layout key, which is how CodeMirror recognises the shortcut when the
// active layout produces a non-Latin character.
function pressKey(
  target: HTMLElement,
  key: string,
  extra?: KeyboardEventInit,
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: "KeyF",
      keyCode: 70,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    } as KeyboardEventInit),
  );
}

function pressFind(target: HTMLElement): void {
  pressKey(target, "f");
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

  it("focuses the find field when the panel opens", () => {
    const panel = mountPanel();
    expect(document.activeElement).toBe(findInput(panel));
  });

  it("opens the panel on the find shortcut", () => {
    const mounted = mountView();
    pressFind(mounted.contentDOM);
    expect(searchPanelOpen(mounted.state)).toBe(true);
  });

  it("closes an open panel when the shortcut is pressed from the editor", () => {
    const mounted = mountView();
    const panel = openPanel(mounted);
    mounted.contentDOM.focus();
    pressFind(mounted.contentDOM);
    expect(searchPanelOpen(mounted.state)).toBe(false);
    expect(panel.isConnected).toBe(false);
    expect(mounted.hasFocus).toBe(true);
  });

  it("closes an open panel and refocuses the editor when the shortcut is pressed from the find field", () => {
    const mounted = mountView();
    pressFind(findInput(openPanel(mounted)));
    expect(searchPanelOpen(mounted.state)).toBe(false);
    expect(mounted.hasFocus).toBe(true);
  });

  it("leaves an open panel alone when Shift is held", () => {
    const mounted = mountView();
    const panel = openPanel(mounted);
    pressKey(mounted.contentDOM, "F", { shiftKey: true });
    expect(searchPanelOpen(mounted.state)).toBe(true);
    pressKey(findInput(panel), "F", { shiftKey: true });
    expect(searchPanelOpen(mounted.state)).toBe(true);
  });

  it("toggles on a layout whose shortcut key types a non-Latin character", () => {
    const mounted = mountView();
    pressKey(mounted.contentDOM, "\u0430");
    expect(searchPanelOpen(mounted.state)).toBe(true);
    pressKey(findInput(openPanel(mounted)), "\u0430");
    expect(searchPanelOpen(mounted.state)).toBe(false);
  });
});
