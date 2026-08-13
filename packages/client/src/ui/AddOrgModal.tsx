import type { FsValidateResponse, OrgRoot } from "@zashiki/shared";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { ReposAddError, type ReposApi } from "../api/repos.js";
import "./AddOrgModal.css";

export interface AddOrgModalProps {
  api: ReposApi;
  onClose(): void;
  /** Called after a successful add with the new org name (e.g. to toast). */
  onAdded?(org: string): void;
}

/** Replaces the in-progress last path segment with a chosen dir, leaving a trailing `/` to drill in. */
function withPicked(current: string, name: string): string {
  const base = current.trim();
  const parent = base.endsWith("/")
    ? base
    : base.slice(0, base.lastIndexOf("/") + 1);
  return `${parent}${name}/`;
}

/**
 * Modal for registering a new org into repos.conf. A single directory-path input with directory
 * completion: typing lists matching subdirectories (scoped to HOME + registered roots) to pick from,
 * and the path is validated inline so submit is gated on a would-be-successful add. The server remains
 * authoritative — a submit that still fails (e.g. a race) surfaces its error inline.
 */
export function AddOrgModal({ api, onClose, onAdded }: AddOrgModalProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [validity, setValidity] = useState<FsValidateResponse | null>(null);
  const [orgs, setOrgs] = useState<OrgRoot[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the sole input on open (without relying on the autoFocus attribute).
  useEffect(() => inputRef.current?.focus(), []);

  // Load the currently registered orgs once, so the modal shows what already exists.
  useEffect(() => {
    const controller = new AbortController();
    api
      .list(controller.signal)
      .then((res) => setOrgs(res.orgs))
      .catch(() => {});
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced completion + validation. A per-run AbortController drops stale in-flight responses so a
  // slow earlier request can never overwrite a newer one.
  useEffect(() => {
    const value = path.trim();
    if (value === "") {
      setSuggestions([]);
      setValidity(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .browse(value, controller.signal)
        .then((res) => {
          setSuggestions(res.entries.map((e) => e.name));
          setActiveIndex(-1);
        })
        .catch(() => setSuggestions([]));
      void api
        .validate(value, controller.signal)
        .then((res) => setValidity(res))
        .catch(() => {});
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, api]);

  const pick = (name: string): void => {
    setPath(withPicked(path, name));
    setSuggestions([]);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      pick(suggestions[activeIndex] as string);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSuggestions([]);
    }
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const value = path.trim();
    if (value === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { org } = await api.add(value);
      onAdded?.(org);
      onClose();
    } catch (err) {
      const fallback =
        err instanceof Error ? err.message : t("addOrg.errorGeneric");
      const code = err instanceof ReposAddError ? err.code : undefined;
      setError(
        code ? t(`addOrg.error.${code}`, { defaultValue: fallback }) : fallback,
      );
      setSubmitting(false);
    }
  };

  // Only affirm "ready" and warn on an already-registered path; the other statuses are transient while
  // typing a partial path, so they merely keep submit disabled without a noisy inline message.
  const validityHint =
    validity?.status === "ok"
      ? { ok: true, text: t("addOrg.valid", { org: validity.org }) }
      : validity?.status === "duplicate"
        ? { ok: false, text: t("addOrg.error.duplicate") }
        : null;

  const blockedByValidity = validity !== null && validity.status !== "ok";

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay only captures outside clicks (Escape is handled by the window keydown above)
    // biome-ignore lint/a11y/noStaticElementInteractions: receiver for outside clicks, not an interactive widget
    <div className="add-org-backdrop" onClick={onClose}>
      <div
        className="add-org-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("addOrg.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit}>
          <h2 className="add-org-title">{t("addOrg.title")}</h2>
          <label className="add-org-field">
            <span className="add-org-label">{t("addOrg.pathLabel")}</span>
            <input
              ref={inputRef}
              className="add-org-input"
              type="text"
              value={path}
              placeholder={t("addOrg.pathPlaceholder")}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="off"
              aria-autocomplete="list"
            />
          </label>
          {suggestions.length > 0 && (
            <ul className="add-org-suggestions">
              {suggestions.map((name, i) => (
                <li key={name}>
                  <button
                    type="button"
                    className={
                      i === activeIndex
                        ? "add-org-suggestion is-active"
                        : "add-org-suggestion"
                    }
                    aria-current={i === activeIndex}
                    onClick={() => pick(name)}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="add-org-hint">{t("addOrg.hint")}</p>
          {error !== null ? (
            <p className="add-org-error" role="alert">
              {error}
            </p>
          ) : validityHint !== null ? (
            <p
              className={validityHint.ok ? "add-org-valid" : "add-org-error"}
              role={validityHint.ok ? "status" : "alert"}
            >
              {validityHint.text}
            </p>
          ) : null}
          <div className="add-org-actions">
            <button type="button" className="add-org-cancel" onClick={onClose}>
              {t("addOrg.cancel")}
            </button>
            <button
              type="submit"
              className="add-org-submit"
              disabled={path.trim() === "" || submitting || blockedByValidity}
            >
              {submitting ? t("addOrg.adding") : t("addOrg.submit")}
            </button>
          </div>
        </form>
        <section className="add-org-current">
          <h3 className="add-org-current-title">{t("addOrg.currentTitle")}</h3>
          {orgs.length === 0 ? (
            <p className="add-org-current-empty">{t("addOrg.currentEmpty")}</p>
          ) : (
            <table className="add-org-table">
              <thead>
                <tr>
                  <th>{t("addOrg.colOrg")}</th>
                  <th>{t("addOrg.colPath")}</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.path}>
                    <td className="add-org-cell-org">{o.org}</td>
                    <td className="add-org-cell-path">{o.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
