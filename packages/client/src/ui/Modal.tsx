import { type ReactNode, useEffect, useRef } from "react";

import { useModalEscape } from "./useModalEscape.js";
import "./Modal.css";

export interface ModalProps {
  /** Accessible dialog label, also shown as the header title. */
  title: string;
  /** Localized label for the close button (aria-label / title). */
  closeLabel: string;
  /** Dismiss the modal (Escape, backdrop click, or the close button). */
  onClose(): void;
  /** Extra class on the dialog box for per-modal sizing/variants. */
  className?: string;
  children: ReactNode;
}

/**
 * The shared modal frame: a centered dialog over a dimming backdrop, with a slim header
 * (title + close) echoing the native title bar. Dismisses on Escape (topmost modal only),
 * a backdrop click, or the close button, and moves focus into the dialog on open so keyboard
 * users land inside it rather than on the trigger behind. The body is supplied by the caller.
 */
export function Modal({
  title,
  closeLabel,
  onClose,
  className,
  children,
}: ModalProps) {
  useModalEscape(onClose);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => dialogRef.current?.focus(), []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by useModalEscape)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={className ? `modal-box ${className}` : "modal-box"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
      >
        <header className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button
            type="button"
            className="modal-close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
