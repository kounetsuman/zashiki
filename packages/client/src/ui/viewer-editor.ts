import type { Compartment } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";

import { editorSearch } from "./editor-search-panel.js";

/** Read-only, height-bounded CodeMirror config for the file Viewer. */
export function viewerEditorExtensions(language: Compartment) {
  return [
    editorSearch({ findOnly: true }),
    basicSetup,
    oneDark,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    // A tabindex keeps the read-only content focusable; CodeMirror only routes
    // keymaps (Cmd+F find) to a focused content element.
    EditorView.contentAttributes.of({ tabindex: "0" }),
    language.of([]),
    // The base theme pins .cm-editor to position:relative !important, so bound the
    // height here and let .cm-scroller own the scroll; hide the caret so the
    // focusable editor still reads as read-only.
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": { overflow: "auto" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { display: "none" },
    }),
  ];
}
