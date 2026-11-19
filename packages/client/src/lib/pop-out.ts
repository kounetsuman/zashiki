import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The query parameter that turns the page into the pop-out window of one Cockpit Terminal. */
const POP_OUT_PARAM = "popOut";

/** Sent by the desktop shell to the main window once a pop-out window has gone. */
export const POP_OUT_CLOSED_EVENT = "zashiki:popout-closed";

/** A point on the screen, in the same units the shell positions windows in. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The Cockpit Terminal this page shows on its own, or null for the main window. */
export function popOutCockpitTerminalId(search: string): string | null {
  const id = new URLSearchParams(search).get(POP_OUT_PARAM);
  return id === null || id === "" ? null : id;
}

/** Carries the token too: the token lives in sessionStorage, which a new window does not share. */
export function popOutUrl(
  page: { origin: string; pathname: string },
  cockpitTerminalId: string,
  token: string,
): string {
  const params = new URLSearchParams({
    [POP_OUT_PARAM]: cockpitTerminalId,
    token,
  });
  return `${page.origin}${page.pathname}?${params.toString()}`;
}

/** The fields of a `dragend` event that tell where a dragged tab was let go. */
export interface DragEndPosition {
  dropEffect: string;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

/**
 * Where a dragged tab was let go outside the window, or null when it landed inside it or nothing
 * took it. WebKit can report a drag end at all-zero coordinates; that reads as "unknown", not as a
 * drop at the screen's corner.
 */
export function dropOutsideWindow(
  end: DragEndPosition,
  viewport: { width: number; height: number },
): ScreenPoint | null {
  if (end.dropEffect !== "none") return null;
  if (
    end.clientX === 0 &&
    end.clientY === 0 &&
    end.screenX === 0 &&
    end.screenY === 0
  ) {
    return null;
  }
  const inside =
    end.clientX >= 0 &&
    end.clientY >= 0 &&
    end.clientX <= viewport.width &&
    end.clientY <= viewport.height;
  return inside ? null : { x: end.screenX, y: end.screenY };
}

/** The desktop shell's pop-out windows, keyed by the Cockpit Terminal each one shows. */
export interface PopOutApi {
  /** Opens the terminal's window, or brings it to the front when it is already open. */
  open(
    cockpitTerminalId: string,
    title: string,
    at: ScreenPoint | null,
  ): Promise<void>;
  focus(cockpitTerminalId: string): Promise<void>;
  /** Closes the terminal's window; the main window hears about it through `onClosed`. */
  close(cockpitTerminalId: string): Promise<void>;
  /** The terminals whose window is open now (the main page may have reloaded since they opened). */
  list(): Promise<string[]>;
  onClosed(fn: (cockpitTerminalId: string) => void): () => void;
}

/** Pop-out windows exist only in the desktop app. */
export function popOutSupported(): boolean {
  return isTauri();
}

export function createTauriPopOutApi(
  urlFor: (cockpitTerminalId: string) => string,
): PopOutApi {
  return {
    async open(cockpitTerminalId, title, at) {
      await invoke("open_popout", {
        cockpitTerminalId,
        url: urlFor(cockpitTerminalId),
        title,
        x: at?.x ?? null,
        y: at?.y ?? null,
      });
    },
    async focus(cockpitTerminalId) {
      await invoke("focus_popout", { cockpitTerminalId });
    },
    async close(cockpitTerminalId) {
      await invoke("close_popout", { cockpitTerminalId });
    },
    list() {
      return invoke<string[]>("list_popouts");
    },
    onClosed(fn) {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      void listen<{ cockpitTerminalId: string }>(POP_OUT_CLOSED_EVENT, (e) =>
        fn(e.payload.cockpitTerminalId),
      ).then((off) => {
        if (disposed) off();
        else unlisten = off;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}
