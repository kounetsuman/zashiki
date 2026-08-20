export type RefreshState = "idle" | "loading" | "error";

export interface RefreshButtonProps {
  state: RefreshState;
  /** aria-label (invariant regardless of state). Doubles as the tooltip when idle. */
  label: string;
  /** Message shown in the tooltip (title) when in the error state. */
  error?: string | null;
  onClick(): void;
}

/**
 * Refresh button in the view header (shared by SESSION LIST / SOURCE CONTROL).
 * Three states: normal `refresh`, a spinner while fetching, and `warning` on error
 * with the error content shown as a tooltip on hover.
 * The aria-label does not change with state (keeping the operation's identity stable);
 * the error content is carried in the title.
 */
export function RefreshButton({
  state,
  label,
  error,
  onClick,
}: RefreshButtonProps) {
  const title = state === "error" && error ? error : label;
  return (
    <button
      type="button"
      className={`view-refresh view-refresh-${state}`}
      aria-label={label}
      aria-busy={state === "loading" ? true : undefined}
      title={title}
      onClick={onClick}
    >
      {state === "loading" ? (
        <span className="view-refresh-spinner" aria-hidden="true" />
      ) : state === "error" ? (
        <span
          className="view-refresh-alert material-symbols-outlined"
          aria-hidden="true"
        >
          warning
        </span>
      ) : (
        <span className="material-symbols-outlined" aria-hidden="true">
          refresh
        </span>
      )}
    </button>
  );
}
