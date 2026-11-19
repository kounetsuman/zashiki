import { FileTooLargeError } from "../api/files.js";

/** The size problem that keeps the Viewer from showing a repo file's text. */
export type TooLargeFile =
  /** Over the confirmation size: shown only once the user chooses to open it anyway. */
  | { reason: "confirm"; size: number }
  /** Over the maximum the Viewer opens at all. */
  | { reason: "overMax"; size: number; maxBytes: number }
  /** Opened anyway, but the read did not finish. */
  | { reason: "failedAfterConfirm" };

/** How a failed repo text read is shown: as a size problem, or as the read's own error. */
export type ReadFailure =
  | { tooLarge: TooLargeFile }
  | { tooLarge: null; error: unknown };

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** fetch and a body stream that breaks off both reject with a TypeError. */
function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError;
}

/**
 * Reads past the confirmation size that time out, lose the connection or are refused all mean the file
 * is too large to open. Before that, a refusal carrying the file's size asks for confirmation, unless
 * the file is over the maximum too: the server's when the refusal names it, else `maxBytes`.
 */
export function classifyReadFailure(
  e: unknown,
  openedAnyway: boolean,
  maxBytes: number,
): ReadFailure {
  if (openedAnyway) {
    return e instanceof FileTooLargeError || isAbort(e) || isNetworkFailure(e)
      ? { tooLarge: { reason: "failedAfterConfirm" } }
      : { tooLarge: null, error: e };
  }
  if (!(e instanceof FileTooLargeError) || e.size === null) {
    return { tooLarge: null, error: e };
  }
  const max = e.maxBytes ?? maxBytes;
  return e.size > max
    ? { tooLarge: { reason: "overMax", size: e.size, maxBytes: max } }
    : { tooLarge: { reason: "confirm", size: e.size } };
}

const MIB = 1024 * 1024;

/** A size in MB (1024 × 1024 bytes): whole when exact, otherwise to one decimal place. */
export function formatFileSize(bytes: number): string {
  const mib = bytes / MIB;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
}
