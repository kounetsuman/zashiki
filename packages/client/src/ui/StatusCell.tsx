import type { Severity } from "../session/status-footer.js";

/** A value with a small uppercase caption, tinted by severity; the footers' shared display unit. */
export function StatusCell({
  value,
  caption,
  severity,
}: {
  value: string;
  caption: string;
  severity?: Severity;
}) {
  const cls = severity ? `ss-val ss-${severity}` : "ss-val";
  return (
    <span className={cls}>
      {value}
      <span className="ss-cap">{caption}</span>
    </span>
  );
}
