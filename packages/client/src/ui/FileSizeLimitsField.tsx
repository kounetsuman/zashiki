import {
  FILE_SIZE_LIMIT_CEILING_BYTES,
  FILE_SIZE_LIMIT_FLOOR_BYTES,
  type FileSizeLimits,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUnsavedField } from "./unsaved-changes.js";

const MIB = 1024 * 1024;
const MIN_MIB = FILE_SIZE_LIMIT_FLOOR_BYTES / MIB;
const MAX_MIB = FILE_SIZE_LIMIT_CEILING_BYTES / MIB;

interface DraftMib {
  confirm: number;
  max: number;
}

const toMib = (bytes: number): number =>
  Math.max(MIN_MIB, Math.round(bytes / MIB));

const draftOf = (limits: FileSizeLimits): DraftMib => ({
  confirm: toMib(limits.confirmBytes),
  max: toMib(limits.maxBytes),
});

const parseWholeMib = (text: string, max: number): number | null => {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= MIN_MIB ? Math.min(n, max) : null;
};

export interface FileSizeLimitsFieldProps {
  value: FileSizeLimits;
  onSave(limits: FileSizeLimits): void;
}

/**
 * Editor for how large a file the Viewer opens, in whole MB: the size over which it asks before
 * opening, and the maximum it opens at all. The confirmation size never passes the maximum.
 */
export function FileSizeLimitsField({
  value,
  onSave,
}: FileSizeLimitsFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DraftMib>(() => draftOf(value));
  const persisted = JSON.stringify(draftOf(value));
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized persisted value, not the object identity
  useEffect(() => setDraft(draftOf(value)), [persisted]);

  const dirty = JSON.stringify(draft) !== persisted;
  const save = () =>
    onSave({ confirmBytes: draft.confirm * MIB, maxBytes: draft.max * MIB });
  useUnsavedField("file-size-limits", dirty, {
    save,
    discard: () => setDraft(draftOf(value)),
  });

  return (
    <div className="settings-field settings-field-column file-size-limits">
      <span className="settings-label">
        {t("settings.fileSizeLimits.section")}
      </span>
      <span className="settings-hint">{t("settings.fileSizeLimits.hint")}</span>
      <label className="file-size-limits-row">
        <span className="file-size-limits-name">
          {t("settings.fileSizeLimits.confirm")}
        </span>
        <input
          type="number"
          className="file-size-limits-input"
          min={MIN_MIB}
          max={draft.max}
          step={1}
          value={draft.confirm}
          onChange={(e) => {
            const n = parseWholeMib(e.target.value, draft.max);
            if (n !== null) setDraft((d) => ({ ...d, confirm: n }));
          }}
        />
        <span className="file-size-limits-unit">MB</span>
      </label>
      <label className="file-size-limits-row">
        <span className="file-size-limits-name">
          {t("settings.fileSizeLimits.max")}
        </span>
        <input
          type="number"
          className="file-size-limits-input"
          min={MIN_MIB}
          max={MAX_MIB}
          step={1}
          value={draft.max}
          onChange={(e) => {
            const n = parseWholeMib(e.target.value, MAX_MIB);
            if (n !== null) {
              setDraft((d) => ({ max: n, confirm: Math.min(d.confirm, n) }));
            }
          }}
        />
        <span className="file-size-limits-unit">MB</span>
      </label>
      <button
        type="button"
        className="settings-save"
        disabled={!dirty}
        onClick={save}
      >
        {t("settings.save")}
      </button>
    </div>
  );
}
