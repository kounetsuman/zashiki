import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";

export type HistoryCommand = "undo" | "redo";

/** xterm keeps a hidden textarea to receive keystrokes; its history is not the terminal's. */
function isTextField(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement) &&
    element.closest(".xterm") === null
  );
}

/**
 * Applies `command` to whatever holds `target`: the CodeMirror editor it sits in (the Memo, the
 * clipboard editor), or the browser's own history for a plain text field. Anything else is left
 * alone — including `document.body`, which is what has focus between one element losing it and the
 * next taking it. `findFromDOM` resolves an editor from any ancestor of it, so the caret has to be
 * confirmed inside the editor's document; otherwise a body-wide lookup would undo the first editor
 * on the page (here the Memo, whose text is saved to disk) for a caret that was never in it.
 */
export function runEditorHistory(
  target: Element | null,
  command: HistoryCommand,
): void {
  if (!(target instanceof HTMLElement)) return;
  const view = EditorView.findFromDOM(target);
  if (view?.contentDOM.contains(target)) {
    const run = command === "undo" ? undo : redo;
    run(view);
    return;
  }
  if (isTextField(target)) document.execCommand(command);
}
