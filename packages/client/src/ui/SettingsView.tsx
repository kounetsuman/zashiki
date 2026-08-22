import type {
  HooksStatusMessage,
  UpdateCheckResultMessage,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { type Locale, SUPPORTED_LOCALES } from "../i18n/detect.js";
import { OrgNotesEditor } from "./OrgNotesEditor.js";
import { ViewHeader } from "./ViewHeader.js";
import { viewClass } from "./views.js";
import {
  DEFAULT_XTERM_RENDERER,
  type XtermRenderer,
} from "./xterm-renderer.js";

type UpdateCheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string | null }
  | { phase: "upToDate" }
  | { phase: "error" };

export interface SettingsViewProps {
  /** Current display language (i18n.language). */
  language: string;
  /** Apply the language and persist it to config.json (Save). */
  onSaveLanguage(language: Locale): void;
  /**
   * Current terminal font size (px). When omitted, the font-size field is not shown
   * (keeps the view usable without the terminal font-size wiring, e.g. in isolated tests).
   */
  fontSize?: number;
  /** Enlarge the terminal font by one step (A+). */
  onIncreaseFontSize?(): void;
  /** Shrink the terminal font by one step (A-). */
  onDecreaseFontSize?(): void;
  /** Reset the terminal font to the default size. */
  onResetFontSize?(): void;
  /** Whether A+ is still available (false at the maximum). */
  canIncreaseFontSize?: boolean;
  /** Whether A- is still available (false at the minimum). */
  canDecreaseFontSize?: boolean;
  /** Whether Reset is meaningful (false when already at the default size). */
  canResetFontSize?: boolean;
  /** Open the "add org" modal (shared with the SESSION LIST header). Omit to hide the entry. */
  onAddOrg?(): void;
  /** Orgs available for note editing (display order). Omit to hide the org-notes editor. */
  orgs?: string[];
  /** org → stored Markdown note (from notes.sync). */
  orgNotes?: Record<string, string>;
  /** org → display alias, for labeling the note picker. */
  orgAliases?: Record<string, string>;
  /** Persist an org's note (a blank value removes it). Omit (with `orgs`) to hide the editor. */
  onSaveNote?(org: string, text: string): void;
  /**
   * Run an on-demand update check (sends `update.check` and resolves with the server's reply).
   * Omit to hide the entry (e.g. in isolated tests without a control channel).
   */
  onCheckForUpdates?(): Promise<UpdateCheckResultMessage>;
  /** Whether the clipboard-edit modal appears on a multi-line Cmd+C. Omit to hide the toggle. */
  clipboardEditModal?: boolean;
  onSetClipboardEditModal?(enabled: boolean): void;
  /** Whether the account-usage footer bridge is opted in. Omit to hide the toggle. */
  accountUsage?: boolean;
  onSetAccountUsage?(enabled: boolean): void;
  /** Current external editor command (config.json `editor`; empty when unset). Omit to hide the field. */
  editor?: string;
  /** Persist the editor command (Save). A blank value clears it back to the ZK_EDITOR / cursor -g fallback. */
  onSaveEditor?(command: string): void;
  /** Current Claude Code integration status (from hooks.status). Omit to hide the toggle. */
  hooksStatus?: Omit<HooksStatusMessage, "t">;
  /** Install (true) or remove (false) the integration (hooks.register / hooks.unregister). */
  onSetHooksRegistered?(register: boolean): void;
  /** Current xterm renderer. Omit to hide the Developer mode section (e.g. in isolated tests). */
  renderer?: XtermRenderer;
  onSetRenderer?(renderer: XtermRenderer): void;
  /** Open the WebView inspector. Omit outside Tauri (the button is then hidden). */
  onOpenDevtools?(): void;
  /** Open the in-app debug panel. Omit to hide the entry. */
  onOpenDebugPanel?(): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

function toLocale(lang: string): Locale {
  return lang === "ja" ? "ja" : "en";
}

/**
 * Settings view (the gear in NAVIGATION): display language, terminal font size, updates, orgs,
 * and a Developer mode section (renderer switch, DevTools, debug panel). Save applies the language
 * selection and persists it to config.json (while unsaved, the draft is kept and Save stays enabled).
 */
export function SettingsView({
  language,
  onSaveLanguage,
  fontSize,
  onIncreaseFontSize,
  onDecreaseFontSize,
  onResetFontSize,
  canIncreaseFontSize = true,
  canDecreaseFontSize = true,
  canResetFontSize = true,
  onAddOrg,
  orgs,
  orgNotes,
  orgAliases,
  onSaveNote,
  onCheckForUpdates,
  clipboardEditModal,
  onSetClipboardEditModal,
  accountUsage,
  onSetAccountUsage,
  editor,
  onSaveEditor,
  hooksStatus,
  onSetHooksRegistered,
  renderer,
  onSetRenderer,
  onOpenDevtools,
  onOpenDebugPanel,
  inactive,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const current = toLocale(language);
  const [draft, setDraft] = useState<Locale>(current);
  // Follow the draft when the language changes externally (config.sync).
  useEffect(() => setDraft(current), [current]);

  const currentEditor = editor ?? "";
  const [editorDraft, setEditorDraft] = useState(currentEditor);
  // Follow the persisted value when it changes externally (config.sync echoes the trimmed/cleared value).
  useEffect(() => setEditorDraft(currentEditor), [currentEditor]);

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({
    phase: "idle",
  });
  const runUpdateCheck = (): void => {
    if (onCheckForUpdates === undefined || updateCheck.phase === "checking") {
      return;
    }
    setUpdateCheck({ phase: "checking" });
    onCheckForUpdates().then(
      (result) =>
        setUpdateCheck(
          result.status === "available"
            ? { phase: "available", version: result.version }
            : { phase: result.status },
        ),
      () => setUpdateCheck({ phase: "error" }),
    );
  };

  return (
    <section
      className={viewClass("settings-view", inactive)}
      data-view="settings"
    >
      <ViewHeader title="SETTINGS" />
      <div className="settings-body">
        <label className="settings-field">
          <span className="settings-label">{t("settings.language")}</span>
          <select
            className="settings-select"
            value={draft}
            onChange={(e) => setDraft(toLocale(e.target.value))}
          >
            {SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {t(`settings.languageOption.${loc}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="settings-save"
          disabled={draft === current}
          onClick={() => onSaveLanguage(draft)}
        >
          {t("settings.save")}
        </button>
        {fontSize !== undefined && (
          <fieldset className="settings-field font-size-field">
            <legend className="settings-label">{t("settings.fontSize")}</legend>
            <div className="font-size-controls">
              <button
                type="button"
                className="font-size-button"
                aria-label={t("settings.fontSizeDecrease")}
                title={t("settings.fontSizeDecrease")}
                disabled={!canDecreaseFontSize}
                onClick={onDecreaseFontSize}
              >
                A-
              </button>
              <span className="font-size-value" aria-live="polite">
                {fontSize}px
              </span>
              <button
                type="button"
                className="font-size-button"
                aria-label={t("settings.fontSizeIncrease")}
                title={t("settings.fontSizeIncrease")}
                disabled={!canIncreaseFontSize}
                onClick={onIncreaseFontSize}
              >
                A+
              </button>
              <button
                type="button"
                className="font-size-reset"
                disabled={!canResetFontSize}
                onClick={onResetFontSize}
              >
                {t("settings.fontSizeReset")}
              </button>
            </div>
          </fieldset>
        )}
        {onCheckForUpdates !== undefined && (
          <div className="settings-field">
            <span className="settings-label">
              {t("settings.updateSection")}
            </span>
            <button
              type="button"
              className="settings-save"
              disabled={updateCheck.phase === "checking"}
              onClick={runUpdateCheck}
            >
              {t("settings.checkForUpdates")}
            </button>
            {updateCheck.phase !== "idle" && (
              <span className="settings-update-status" aria-live="polite">
                {updateCheck.phase === "checking" &&
                  t("settings.updateChecking")}
                {updateCheck.phase === "available" &&
                  t("settings.updateAvailable", {
                    version: updateCheck.version ?? "",
                  })}
                {updateCheck.phase === "upToDate" &&
                  t("settings.updateUpToDate")}
                {updateCheck.phase === "error" && t("settings.updateError")}
              </span>
            )}
          </div>
        )}
        {onAddOrg !== undefined && (
          <div className="settings-field">
            <span className="settings-label">{t("settings.orgSection")}</span>
            <button type="button" className="settings-save" onClick={onAddOrg}>
              {t("settings.addOrg")}
            </button>
          </div>
        )}
        {onSaveNote !== undefined && orgs !== undefined && (
          <div className="settings-field settings-field-column">
            <span className="settings-label">
              {t("settings.orgNotesLabel")}
            </span>
            <OrgNotesEditor
              orgs={orgs}
              notes={orgNotes ?? {}}
              aliases={orgAliases ?? {}}
              onSave={onSaveNote}
            />
          </div>
        )}
        {onSetClipboardEditModal !== undefined && (
          <label className="settings-field settings-toggle">
            <input
              type="checkbox"
              checked={clipboardEditModal ?? true}
              onChange={(e) => onSetClipboardEditModal(e.target.checked)}
            />
            <span className="settings-label">
              {t("settings.clipboardEditModal")}
            </span>
          </label>
        )}
        {onSetAccountUsage !== undefined && (
          <label className="settings-field settings-toggle">
            <input
              type="checkbox"
              checked={accountUsage ?? false}
              onChange={(e) => onSetAccountUsage(e.target.checked)}
            />
            <span className="settings-label">{t("settings.accountUsage")}</span>
          </label>
        )}
        {onSaveEditor !== undefined && (
          <div className="settings-field">
            <label className="settings-field">
              <span className="settings-label">{t("settings.editor")}</span>
              <input
                type="text"
                className="settings-input"
                value={editorDraft}
                placeholder="cursor -g"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setEditorDraft(e.target.value)}
              />
            </label>
            <span className="settings-hint">{t("settings.editorHint")}</span>
            <button
              type="button"
              className="settings-save"
              disabled={editorDraft.trim() === currentEditor}
              onClick={() => onSaveEditor(editorDraft.trim())}
            >
              {t("settings.save")}
            </button>
          </div>
        )}
        {onSetHooksRegistered !== undefined && hooksStatus !== undefined && (
          <div className="settings-field">
            <label className="settings-field settings-toggle">
              <input
                type="checkbox"
                checked={
                  hooksStatus.hooksRegistered &&
                  hooksStatus.statusLineRegistered
                }
                onChange={(e) => onSetHooksRegistered(e.target.checked)}
              />
              <span className="settings-label">
                {t("settings.hooksIntegration")}
              </span>
            </label>
            <span className="settings-hint">
              {hooksStatus.statusLineConflict
                ? t("settings.hooksConflictHint")
                : t("settings.hooksIntegrationHint")}
            </span>
          </div>
        )}
        {onSetRenderer !== undefined && (
          <div className="settings-field settings-dev-section">
            <span className="settings-label">{t("settings.devSection")}</span>
            <label className="settings-field">
              <span className="settings-label">{t("settings.renderer")}</span>
              <select
                className="settings-select"
                value={renderer ?? DEFAULT_XTERM_RENDERER}
                onChange={(e) =>
                  onSetRenderer(e.target.value === "dom" ? "dom" : "webgl")
                }
              >
                <option value="webgl">{t("settings.rendererWebgl")}</option>
                <option value="dom">{t("settings.rendererDom")}</option>
              </select>
            </label>
            {onOpenDevtools !== undefined && (
              <button
                type="button"
                className="settings-save"
                onClick={onOpenDevtools}
              >
                {t("settings.openDevtools")}
              </button>
            )}
            {onOpenDebugPanel !== undefined && (
              <button
                type="button"
                className="settings-save"
                onClick={onOpenDebugPanel}
              >
                {t("settings.openDebugPanel")}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
