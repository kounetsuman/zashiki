import { shouldOpenClipboardEditModal } from "../lib/clipboard-edit-modal.js";

export interface TerminalKeyDeps {
  getSelection(): string;
  input(data: string): void;
  clipboardEditEnabled: boolean;
  openFind(): void;
  openClipboardEdit(text: string): void;
}

/** Custom xterm keydown policy: returns false to intercept (skip xterm's default), true to pass through. */
export function handleTerminalKey(
  e: KeyboardEvent,
  deps: TerminalKeyDeps,
): boolean {
  if (e.type !== "keydown") return true;
  if (e.isComposing || e.keyCode === 229) return true;
  if (
    (e.key === "f" || e.key === "F") &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    e.preventDefault();
    deps.openFind();
    return false;
  }
  if (
    (e.key === "c" || e.key === "C") &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    const selection = deps.getSelection();
    if (shouldOpenClipboardEditModal(deps.clipboardEditEnabled, selection)) {
      e.preventDefault();
      deps.openClipboardEdit(selection);
      return false;
    }
    return true;
  }
  if (
    e.key === "Enter" &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey
  ) {
    deps.input("\x1b\r");
    return false;
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (e.key === "ArrowRight") {
      deps.input("\x05");
      return false;
    }
    if (e.key === "ArrowLeft") {
      deps.input("\x01");
      return false;
    }
  }
  return true;
}
