import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

export interface UnsavedFieldActions {
  /** Persist this field's draft (same effect as its own Save button). */
  save(): void;
  /** Revert this field's draft back to the last persisted value. */
  discard(): void;
}

interface RegisteredField extends UnsavedFieldActions {
  dirty: boolean;
}

export interface UnsavedSummary {
  dirtyCount: number;
  saveAll(): void;
  discardAll(): void;
}

/** Reduce the registered fields to the aggregate the bar acts on (only the dirty ones are touched). */
export function summarizeUnsaved(
  fields: ReadonlyMap<string, RegisteredField>,
): UnsavedSummary {
  const dirty = [...fields.values()].filter((f) => f.dirty);
  return {
    dirtyCount: dirty.length,
    saveAll: () => {
      for (const f of dirty) f.save();
    },
    discardAll: () => {
      for (const f of dirty) f.discard();
    },
  };
}

interface RegistryApi {
  register(id: string, field: RegisteredField): void;
  unregister(id: string): void;
}

const RegistryContext = createContext<RegistryApi | null>(null);
const SummaryContext = createContext<UnsavedSummary>({
  dirtyCount: 0,
  saveAll: () => {},
  discardAll: () => {},
});

/**
 * Collects the dirty/save/discard state of every field rendered beneath it so a single bar can show
 * "unsaved changes" and Save-all / Discard-all across fields that otherwise persist independently.
 * Fields opt in with {@link useUnsavedField}; a field rendered outside a provider simply does nothing.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [fields, setFields] = useState<ReadonlyMap<string, RegisteredField>>(
    () => new Map(),
  );

  const register = useCallback((id: string, field: RegisteredField) => {
    setFields((prev) => {
      const next = new Map(prev);
      next.set(id, field);
      return next;
    });
  }, []);
  const unregister = useCallback((id: string) => {
    setFields((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const api = useMemo<RegistryApi>(
    () => ({ register, unregister }),
    [register, unregister],
  );
  const summary = useMemo(() => summarizeUnsaved(fields), [fields]);

  return (
    <RegistryContext.Provider value={api}>
      <SummaryContext.Provider value={summary}>
        {children}
      </SummaryContext.Provider>
    </RegistryContext.Provider>
  );
}

/**
 * Register this field's unsaved state with the surrounding {@link UnsavedChangesProvider}. The latest
 * save/discard closures are always used (kept in a ref), so only a change of `dirty` re-registers.
 */
export function useUnsavedField(
  id: string,
  dirty: boolean,
  actions: UnsavedFieldActions,
): void {
  const registry = useContext(RegistryContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (registry === null) return;
    return () => registry.unregister(id);
  }, [registry, id]);

  useEffect(() => {
    registry?.register(id, {
      dirty,
      save: () => actionsRef.current.save(),
      discard: () => actionsRef.current.discard(),
    });
  }, [registry, id, dirty]);
}

/** Headless registrar for a field whose draft state lives in the parent (renders nothing). */
export function UnsavedField({
  id,
  dirty,
  save,
  discard,
}: { id: string; dirty: boolean } & UnsavedFieldActions) {
  useUnsavedField(id, dirty, { save, discard });
  return null;
}

/** Floating bar shown while any registered field is dirty, offering Save-all / Discard-all. */
export function UnsavedChangesBar() {
  const { t } = useTranslation();
  const { dirtyCount, saveAll, discardAll } = useContext(SummaryContext);
  if (dirtyCount === 0) return null;
  return (
    <div className="unsaved-bar" role="status" aria-live="polite">
      <span className="unsaved-bar-message">
        <span className="unsaved-bar-dot" aria-hidden="true" />
        {t("settings.unsavedChanges")}
      </span>
      <div className="unsaved-bar-actions">
        <button
          type="button"
          className="unsaved-bar-discard"
          onClick={discardAll}
        >
          {t("settings.discardAll")}
        </button>
        <button type="button" className="unsaved-bar-save" onClick={saveAll}>
          {t("settings.saveAll")}
        </button>
      </div>
    </div>
  );
}
