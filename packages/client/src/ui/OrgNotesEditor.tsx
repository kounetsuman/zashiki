import { ORG_NOTE_MAX_CHARS, resolveOrgName } from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface OrgNotesEditorProps {
  /** Orgs to choose from (display order from state.sync). */
  orgs: string[];
  /** org → stored Markdown note (from notes.sync). */
  notes: Record<string, string>;
  /** org → display alias, for labeling the picker. */
  aliases: Record<string, string>;
  /** Persist the note for `org` (a blank `text` removes it). */
  onSave(org: string, text: string): void;
}

/**
 * A per-org Markdown memo editor for the SETTINGS → Organizations section: pick an org, edit its
 * note, and Save. The draft reloads only when you switch orgs; a notes.sync (an external edit, or
 * the echo of your own save) never overwrites what you are currently typing.
 */
export function OrgNotesEditor({
  orgs,
  notes,
  aliases,
  onSave,
}: OrgNotesEditorProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(() => orgs[0] ?? "");
  const [draft, setDraft] = useState(() => notes[orgs[0] ?? ""] ?? "");

  // Keep the selection pointing at a still-present org as the org list changes.
  if (orgs.length > 0 && !orgs.includes(selected)) {
    setSelected(orgs[0] ?? selected);
  }

  // Load the selected org's stored note on switch (render-phase reset-on-change, so it fires even
  // between two orgs holding identical text). Keyed on the org alone — not the note value — so an
  // inbound notes.sync does not reset the textarea mid-edit.
  const [loadedOrg, setLoadedOrg] = useState(selected);
  if (loadedOrg !== selected) {
    setLoadedOrg(selected);
    setDraft(notes[selected] ?? "");
  }

  if (orgs.length === 0) {
    return <span className="settings-hint">{t("settings.orgNotesEmpty")}</span>;
  }
  return (
    <div className="settings-org-notes">
      <select
        className="settings-org-notes-picker"
        value={selected}
        aria-label={t("settings.orgNotesPicker")}
        onChange={(e) => setSelected(e.target.value)}
      >
        {orgs.map((org) => (
          <option key={org} value={org}>
            {resolveOrgName(org, aliases)}
          </option>
        ))}
      </select>
      <textarea
        className="settings-org-notes-text"
        value={draft}
        maxLength={ORG_NOTE_MAX_CHARS}
        placeholder={t("settings.orgNotesPlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className="settings-save"
        onClick={() => onSave(selected, draft)}
      >
        {t("settings.orgNotesSave")}
      </button>
    </div>
  );
}
