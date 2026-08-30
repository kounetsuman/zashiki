import type { FileEntry } from "@zashiki/shared";
import {
  filterFiles,
  parseQuickOpenQuery,
  resolveOrgColor,
  resolveOrgName,
} from "@zashiki/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useModalEscape } from "./useModalEscape.js";
import "./QuickOpen.css";

/** Max rows rendered for one query (the fuzzy filter is cheap; the DOM is the cost). */
const RESULT_LIMIT = 200;

export interface QuickOpenProps {
  files: readonly FileEntry[];
  /** org whose files rank first; null when there is no active Cockpit Terminal. */
  activeOrg: string | null;
  orgColors?: Record<string, string>;
  orgAliases?: Record<string, string>;
  /** True when the server listing was capped (a hint is shown). */
  truncated?: boolean;
  onOpen(file: FileEntry, line: number | null): void;
  onClose(): void;
}

function basenameStart(relPath: string): number {
  return relPath.lastIndexOf("/") + 1;
}

function Highlighted({
  text,
  matches,
}: {
  text: string;
  matches: readonly number[];
}) {
  if (matches.length === 0) return <>{text}</>;
  const set = new Set(matches);
  const out: React.ReactNode[] = [];
  let run = "";
  let runHit = false;
  const flush = (key: number): void => {
    if (run === "") return;
    out.push(
      runHit ? (
        <mark key={key} className="quickopen-hit">
          {run}
        </mark>
      ) : (
        <span key={key}>{run}</span>
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== runHit) {
      flush(i);
      runHit = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export function QuickOpen({
  files,
  activeOrg,
  orgColors = {},
  orgAliases = {},
  truncated = false,
  onOpen,
  onClose,
}: QuickOpenProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  useModalEscape(onClose);
  useEffect(() => inputRef.current?.focus(), []);

  // While the palette is open, keep the app's window-level Cmd shortcuts (Cmd+W/N/P/… in
  // useAppKeyboardShortcuts) from firing behind it — React's stopPropagation can't reach native
  // window listeners. Text-editing combos (Cmd+A/C/V/X/Z) and non-letter combos pass through.
  useEffect(() => {
    const editKeys = new Set(["a", "c", "v", "x", "z"]);
    const shield = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k.length === 1 && !editKeys.has(k)) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", shield, true);
    return () => window.removeEventListener("keydown", shield, true);
  }, []);

  const { name, line } = parseQuickOpenQuery(query);
  const results = useMemo(
    () => filterFiles(files, name, activeOrg, RESULT_LIMIT),
    [files, name, activeOrg],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the result set changes.
  useEffect(() => setSelected(0), [results]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const commit = (index: number): void => {
    const hit = results[index];
    if (hit !== undefined) onOpen(hit.file, line);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(selected);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by useModalEscape)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="quickopen-backdrop" onClick={onClose}>
      <div
        className="quickopen-box"
        role="dialog"
        aria-modal="true"
        aria-label={t("quickOpen.ariaLabel")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
      >
        <input
          ref={inputRef}
          className="quickopen-input"
          type="text"
          aria-label={t("quickOpen.ariaLabel")}
          placeholder={t("quickOpen.placeholder")}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.length === 0 ? (
          <div className="quickopen-empty">{t("quickOpen.noResults")}</div>
        ) : (
          <div className="quickopen-list" ref={listRef}>
            {results.map((r, index) => {
              const { relPath } = r.file;
              const start = basenameStart(relPath);
              const dir = relPath.slice(0, start);
              const nameText = relPath.slice(start);
              const nameMatches = r.matches
                .filter((m) => m >= start)
                .map((m) => m - start);
              const dirMatches = r.matches.filter((m) => m < start);
              return (
                <button
                  type="button"
                  key={r.file.path}
                  className="quickopen-row"
                  data-selected={index === selected ? "true" : "false"}
                  onMouseMove={(e) => {
                    // Ignore mousemoves synthesized by the keyboard-driven scrollIntoView (same
                    // coordinates) so hover doesn't override the arrow-key selection.
                    const prev = lastPointer.current;
                    if (prev?.x === e.clientX && prev.y === e.clientY) return;
                    lastPointer.current = { x: e.clientX, y: e.clientY };
                    setSelected(index);
                  }}
                  onClick={() => commit(index)}
                >
                  <span className="quickopen-name">
                    <Highlighted text={nameText} matches={nameMatches} />
                  </span>
                  {dir !== "" && (
                    <span className="quickopen-dir">
                      <Highlighted text={dir} matches={dirMatches} />
                    </span>
                  )}
                  <span className="quickopen-meta">
                    <span
                      className="org-dot"
                      role="img"
                      style={{
                        backgroundColor: resolveOrgColor(r.file.org, orgColors),
                      }}
                      aria-label={`org: ${resolveOrgName(r.file.org, orgAliases)}`}
                    />{" "}
                    {r.file.repo}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {truncated && (
          <div className="quickopen-truncated">{t("quickOpen.truncated")}</div>
        )}
      </div>
    </div>
  );
}
