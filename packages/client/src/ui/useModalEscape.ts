import { useEffect, useRef } from "react";

const stack: symbol[] = [];

/** Dismiss on Escape, but only for the topmost mounted modal (a nested modal doesn't collapse its parent). */
export function useModalEscape(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol();
    stack.push(id);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (stack[stack.length - 1] !== id) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
