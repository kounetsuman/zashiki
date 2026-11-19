import {
  type CockpitTerminalInfo,
  isClaudeRunning,
  resolveOrgColor,
  resolveOrgName,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppControl, AppSession } from "../App.js";
import {
  effectiveCustomTitle,
  loadConversationTitles,
  resolveTitle,
} from "../lib/conversation-title.js";
import { recoverTerm } from "../session/term-recovery.js";
import { TerminalView } from "./TerminalView.js";
import { TAB_ICON } from "./tab-bar-model.js";
import { useBrowserLinks } from "./useBrowserLinks.js";
import { useClipboardEditEnabled } from "./useClipboardEditEnabled.js";
import { useEditMenuHistory } from "./useEditMenuHistory.js";
import { useTerminalFontSize } from "./useTerminalFontSize.js";
import { useXtermRenderer } from "./useXtermRenderer.js";

interface Roster {
  cockpitTerminals: readonly CockpitTerminalInfo[];
  orgColors: Record<string, string>;
  orgAliases: Record<string, string>;
}

function titleStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * The page of a pop-out window: one Cockpit Terminal and a header to send it back, nothing else of
 * the cockpit. The terminal attaches on its own connection, so `session` must already have selected
 * `cockpitTerminalId` before this mounts. The window closes itself once the terminal is gone.
 */
export function PopOutApp({
  control,
  session,
  cockpitTerminalId,
  onReturn,
}: {
  control: Pick<AppControl, "onMessage">;
  session: AppSession;
  cockpitTerminalId: string;
  /** Closes this window, which puts the terminal back in the main window. */
  onReturn(): void;
}) {
  const { t } = useTranslation();
  const terminalFont = useTerminalFontSize();
  const terminalRenderer = useXtermRenderer();
  const clipboardEdit = useClipboardEditEnabled();
  useBrowserLinks();
  useEditMenuHistory();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(
    () =>
      control.onMessage((m) => {
        if (recoverTerm(m, session)) return;
        if (m.t !== "state.sync") return;
        setRoster({
          cockpitTerminals: m.cockpitTerminals,
          orgColors: m.orgColors,
          orgAliases: m.orgAliases,
        });
        if (
          !m.cockpitTerminals.some(
            (s) => s.cockpitTerminalId === cockpitTerminalId,
          )
        ) {
          onReturn();
        }
      }),
    [control, session, cockpitTerminalId, onReturn],
  );

  const terminal = roster?.cockpitTerminals.find(
    (s) => s.cockpitTerminalId === cockpitTerminalId,
  );
  const title =
    terminal === undefined
      ? ""
      : resolveTitle(
          effectiveCustomTitle(
            loadConversationTitles(titleStorage()),
            terminal,
          ),
          terminal,
        );

  useEffect(() => {
    if (title !== "") document.title = title;
  }, [title]);

  return (
    <div className="pop-out-app">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click menu only; its one item is also the Return button */}
      <header
        className="pop-out-header"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {terminal !== undefined && roster !== null && (
          <span
            className="tab-org-dot"
            role="img"
            style={{
              backgroundColor: resolveOrgColor(terminal.org, roster.orgColors),
            }}
            aria-label={`org: ${resolveOrgName(terminal.org, roster.orgAliases)}`}
          />
        )}
        <span className="material-symbols-outlined" aria-hidden="true">
          {TAB_ICON.session}
        </span>
        <span className="pop-out-title">{title}</span>
        <button type="button" className="pop-out-button" onClick={onReturn}>
          <span className="material-symbols-outlined" aria-hidden="true">
            arrow_back
          </span>
          {t("popOut.returnToMain")}
        </button>
      </header>
      <div className="tab-view">
        <TerminalView
          session={session}
          fontSize={terminalFont.fontSize}
          renderer={terminalRenderer.renderer}
          clipboardEditEnabled={clipboardEdit.enabled}
          onSetClipboardEditEnabled={clipboardEdit.setEnabled}
          cockpitTerminalId={cockpitTerminalId}
          claudeTerminalId={
            terminal !== undefined && isClaudeRunning(terminal.state)
              ? cockpitTerminalId
              : null
          }
        />
        {roster !== null && terminal === undefined && (
          <div className="empty-main-area">
            <p className="empty-main-area-title">{t("popOut.gone")}</p>
          </div>
        )}
      </div>
      {menu !== null && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: overlay solely for capturing clicks (same as the tab menu)
        // biome-ignore lint/a11y/noStaticElementInteractions: same as above (an outside-click catcher, not a widget)
        <div
          className="session-context-backdrop"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="session-context-menu"
            role="menu"
            style={{ top: menu.y, left: menu.x }}
          >
            <button
              type="button"
              role="menuitem"
              className="session-context-item"
              onClick={() => {
                setMenu(null);
                onReturn();
              }}
            >
              {t("popOut.returnToMainWindow")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
