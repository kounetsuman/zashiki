type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** How Tab / Shift+Tab indent lines in the editable editors (the clipboard-edit modal and the Memo). */
export interface IndentSetting {
  useTab: boolean;
  /** Spaces per indent level; also the width Shift+Tab strips from space-indented lines. */
  spaceCount: number;
}

/** localStorage keys for the indent unit ("1"/"0") and the space width (an integer). */
export const CLIPBOARD_INDENT_USE_TAB_KEY = "zk.clipboardEdit.indentUseTab";
export const CLIPBOARD_INDENT_SPACE_COUNT_KEY =
  "zk.clipboardEdit.indentSpaceCount";

export const MIN_SPACE_COUNT = 1;
export const MAX_SPACE_COUNT = 8;
export const DEFAULT_INDENT_SETTING: IndentSetting = {
  useTab: false,
  spaceCount: 2,
};

const clampSpaceCount = (n: number): number =>
  Math.min(MAX_SPACE_COUNT, Math.max(MIN_SPACE_COUNT, n));

export function indentUnit(setting: IndentSetting): string {
  return setting.useTab ? "\t" : " ".repeat(setting.spaceCount);
}

export function loadIndentSetting(storage: StoragePart | null): IndentSetting {
  const useTab = storage?.getItem(CLIPBOARD_INDENT_USE_TAB_KEY) === "1";
  const raw = storage?.getItem(CLIPBOARD_INDENT_SPACE_COUNT_KEY);
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  const spaceCount = Number.isFinite(parsed)
    ? clampSpaceCount(parsed)
    : DEFAULT_INDENT_SETTING.spaceCount;
  return { useTab, spaceCount };
}

export function saveIndentSetting(
  storage: StoragePart | null,
  setting: IndentSetting,
): void {
  storage?.setItem(CLIPBOARD_INDENT_USE_TAB_KEY, setting.useTab ? "1" : "0");
  storage?.setItem(
    CLIPBOARD_INDENT_SPACE_COUNT_KEY,
    String(clampSpaceCount(setting.spaceCount)),
  );
}
