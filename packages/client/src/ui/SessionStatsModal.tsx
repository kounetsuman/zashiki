import type { SessionEvent } from "@zashiki/shared";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  filterCounts,
  fmtClock,
  fmtEventDuration,
  isHighlighted,
  isRunning,
  type RowFilter,
  type StatsGroup,
  summarize,
  TIMELINE_FILTERS,
  type TimelineFilter,
  timelineEvents,
} from "../session/session-stats.js";
import { fmtTokens } from "../session/status-footer.js";
import { Modal } from "./Modal.js";
import "./SessionStatsModal.css";

export interface SessionStatsModalProps {
  /** Another Cockpit Terminal starts the view over on its Summary. */
  cockpitTerminalId: string;
  /** The Cockpit Terminal's display title, shown beside the modal title. */
  sessionTitle: string;
  /** `null` until the first answer arrives. */
  events: readonly SessionEvent[] | null;
  onOpenLinks(): void;
  /** Copies a row's full text (its key on the Summary, its text on the Timeline). */
  onCopy(text: string): void;
  onClose(): void;
}

type Mode = "summary" | "timeline";

const MODES: readonly Mode[] = ["summary", "timeline"];

const FILTER_LABEL_KEYS: Record<TimelineFilter, string> = {
  all: "sessionStats.filterAll",
  files: "sessionStats.filterFiles",
  commands: "sessionStats.filterCommands",
  external: "sessionStats.filterExternal",
  denials: "sessionStats.filterDenials",
};

/**
 * What the current Claude Session did: per-group counts (Summary) and the same activity in time
 * order (Timeline). Picking a Summary row opens the Timeline narrowed to that row.
 */
export function SessionStatsModal(props: SessionStatsModalProps) {
  return <SessionStatsView key={props.cockpitTerminalId} {...props} />;
}

function SessionStatsView({
  sessionTitle,
  events,
  onOpenLinks,
  onCopy,
  onClose,
}: SessionStatsModalProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("summary");
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [row, setRow] = useState<RowFilter | null>(null);

  const showRow = (picked: RowFilter) => {
    setRow(picked);
    setFilter(picked.group);
    setMode("timeline");
  };
  const pickFilter = (picked: TimelineFilter) => {
    setFilter(picked);
    setRow(null);
  };

  const header = (
    <div className="sst-header">
      <span className="sst-session-title">{sessionTitle}</span>
      <div
        className="sst-modes"
        role="radiogroup"
        aria-label={t("sessionStats.modes")}
      >
        {MODES.map((m) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form radio
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="sst-mode"
            onClick={() => setMode(m)}
          >
            {t(
              m === "summary"
                ? "sessionStats.modeSummary"
                : "sessionStats.modeTimeline",
            )}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      title={t("sessionStats.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      className="session-stats-modal"
      headerContent={header}
    >
      <div className="sst-body scrollbar-persistent">
        {events === null ? (
          <p className="sst-empty">{t("common.loading")}</p>
        ) : events.length === 0 ? (
          <p className="sst-empty">{t("sessionStats.empty")}</p>
        ) : mode === "summary" ? (
          <Summary
            events={events}
            onPick={showRow}
            onCopy={onCopy}
            onOpenLinks={onOpenLinks}
          />
        ) : (
          <Timeline
            events={events}
            filter={filter}
            row={row}
            onFilter={pickFilter}
            onClearRow={() => setRow(null)}
            onCopy={onCopy}
          />
        )}
      </div>
    </Modal>
  );
}

interface CardRow {
  key: string;
  counters: ReactNode;
}

function SummaryCard({
  group,
  label,
  totals,
  rows,
  onPick,
  onCopy,
  footer,
}: {
  group: StatsGroup;
  label: string;
  totals: string[];
  rows: CardRow[];
  onPick(row: RowFilter): void;
  onCopy(text: string): void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className={`sst-card sst-card-${group}`} aria-label={label}>
      <header className="sst-card-header">
        <h3 className="sst-card-title">{label}</h3>
        <span className="sst-card-totals">{totals.join(" · ")}</span>
      </header>
      {rows.length === 0 ? (
        <p className="sst-card-empty">{t("sessionStats.noRows")}</p>
      ) : (
        <ul className="sst-rows">
          {rows.map(({ key, counters }) => (
            <li key={key} className="sst-row-item">
              <button
                type="button"
                className="sst-row"
                onClick={() => onPick({ group, key })}
              >
                <span className="sst-row-key" title={key}>
                  {key}
                </span>
                <span className="sst-row-counters">{counters}</span>
              </button>
              <CopyButton text={key} onCopy={onCopy} />
            </li>
          ))}
        </ul>
      )}
      {footer}
    </section>
  );
}

function CopyButton({
  text,
  onCopy,
}: {
  text: string;
  onCopy(text: string): void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="sst-copy"
      aria-label={t("sessionStats.copyRow", { text })}
      title={t("sessionStats.copy")}
      onClick={() => onCopy(text)}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        content_copy
      </span>
    </button>
  );
}

function Counter({ text, bad = false }: { text: string; bad?: boolean }) {
  return (
    <span className={bad ? "sst-counter sst-counter-bad" : "sst-counter"}>
      {text}
    </span>
  );
}

function Summary({
  events,
  onPick,
  onCopy,
  onOpenLinks,
}: {
  events: readonly SessionEvent[];
  onPick(row: RowFilter): void;
  onCopy(text: string): void;
  onOpenLinks(): void;
}) {
  const { t } = useTranslation();
  const { files, commands, external, denials } = useMemo(
    () => summarize(events),
    [events],
  );
  return (
    <div className="sst-summary">
      <SummaryCard
        group="files"
        label={t("sessionStats.groupFiles")}
        totals={[
          t("sessionStats.files", { count: files.rows.length }),
          t("sessionStats.reads", { count: files.reads }),
          t("sessionStats.edits", { count: files.edits }),
        ]}
        rows={files.rows.map((r) => ({
          key: r.key,
          counters: (
            <>
              <Counter text={t("sessionStats.reads", { count: r.reads })} />
              <Counter text={t("sessionStats.edits", { count: r.edits })} />
            </>
          ),
        }))}
        onPick={onPick}
        onCopy={onCopy}
      />
      <SummaryCard
        group="commands"
        label={t("sessionStats.groupCommands")}
        totals={[
          t("sessionStats.commands", { count: commands.rows.length }),
          t("sessionStats.runs", { count: commands.runs }),
          t("sessionStats.failures", { count: commands.failures }),
        ]}
        rows={commands.rows.map((r) => ({
          key: r.key,
          counters: (
            <>
              <Counter text={t("sessionStats.runs", { count: r.runs })} />
              {r.failures > 0 && (
                <Counter
                  text={t("sessionStats.failures", { count: r.failures })}
                  bad
                />
              )}
            </>
          ),
        }))}
        onPick={onPick}
        onCopy={onCopy}
      />
      <SummaryCard
        group="external"
        label={t("sessionStats.groupExternal")}
        totals={[
          t("sessionStats.domains", { count: external.rows.length }),
          t("sessionStats.visits", { count: external.visits }),
        ]}
        rows={external.rows.map((r) => ({
          key: r.key,
          counters: (
            <>
              <Counter text={r.tools.join(", ")} />
              <Counter text={t("sessionStats.visits", { count: r.visits })} />
            </>
          ),
        }))}
        onPick={onPick}
        onCopy={onCopy}
        footer={
          <button type="button" className="sst-card-link" onClick={onOpenLinks}>
            {t("sessionStats.allLinks")}
          </button>
        }
      />
      <SummaryCard
        group="denials"
        label={t("sessionStats.groupDenials")}
        totals={[t("sessionStats.denials", { count: denials.count })]}
        rows={denials.rows.map((r) => ({
          key: r.key,
          counters: (
            <>
              {r.deniedBy.map((by) => (
                <Counter key={by} text={t(`sessionStats.deniedBy.${by}`)} />
              ))}
              <Counter
                text={t("sessionStats.denials", { count: r.count })}
                bad
              />
            </>
          ),
        }))}
        onPick={onPick}
        onCopy={onCopy}
      />
    </div>
  );
}

function Timeline({
  events,
  filter,
  row,
  onFilter,
  onClearRow,
  onCopy,
}: {
  events: readonly SessionEvent[];
  filter: TimelineFilter;
  row: RowFilter | null;
  onFilter(filter: TimelineFilter): void;
  onClearRow(): void;
  onCopy(text: string): void;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => filterCounts(events), [events]);
  const shown = useMemo(
    () => timelineEvents(events, filter, row),
    [events, filter, row],
  );
  return (
    <div className="sst-timeline">
      <div
        className="sst-chips"
        role="toolbar"
        aria-label={t("sessionStats.filters")}
      >
        {TIMELINE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="sst-chip"
            aria-pressed={f === filter && row === null}
            onClick={() => onFilter(f)}
          >
            {t(FILTER_LABEL_KEYS[f])}
            <span className="sst-chip-count">{counts[f]}</span>
          </button>
        ))}
        {row !== null && (
          <button
            type="button"
            className="sst-chip sst-chip-row"
            aria-pressed="true"
            aria-label={t("sessionStats.removeRowFilter", { key: row.key })}
            onClick={onClearRow}
          >
            <span className="sst-chip-row-key">{row.key}</span>
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="sst-empty">{t("sessionStats.noEvents")}</p>
      ) : (
        <ol className="sst-events">
          {shown.map((event, index) => (
            <TimelineRow
              // biome-ignore lint/suspicious/noArrayIndexKey: events carry no id; the transcript only grows
              key={`${event.at}-${index}`}
              event={event}
              onCopy={onCopy}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function TimelineRow({
  event,
  onCopy,
}: {
  event: SessionEvent;
  onCopy(text: string): void;
}) {
  const { t } = useTranslation();
  if (event.kind === "compaction") {
    return <li className="sst-divider">{compactionLabel(event, t)}</li>;
  }
  const classes = ["sst-event", `sst-kind-${event.kind}`];
  if (isHighlighted(event)) classes.push("sst-event-flagged");
  if (event.outcome === "interrupted") classes.push("sst-event-interrupted");
  return (
    <li className={classes.join(" ")}>
      <span className="sst-time">{fmtClock(event.at)}</span>
      <span className="sst-kind">{t(`sessionStats.kind.${event.kind}`)}</span>
      <span className="sst-text" title={event.text}>
        {event.text}
      </span>
      <span className="sst-meta">{eventMeta(event, t)}</span>
      <CopyButton text={event.text} onCopy={onCopy} />
    </li>
  );
}

function eventMeta(event: SessionEvent, t: (key: string) => string): string {
  if (isRunning(event)) return t("sessionStats.running");
  const parts: string[] = [];
  if (event.outcome === "denied" && event.deniedBy !== undefined)
    parts.push(t(`sessionStats.deniedBy.${event.deniedBy}`));
  if (event.outcome === "failed") parts.push(t("sessionStats.failed"));
  if (event.outcome === "interrupted")
    parts.push(t("sessionStats.interrupted"));
  if (event.durationMs !== undefined)
    parts.push(fmtEventDuration(event.durationMs));
  return parts.join(" · ");
}

function compactionLabel(
  { preTokens, postTokens }: SessionEvent,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (preTokens !== undefined && postTokens !== undefined)
    return t("sessionStats.compacted", {
      pre: fmtTokens(preTokens),
      post: fmtTokens(postTokens),
    });
  if (preTokens !== undefined)
    return t("sessionStats.compactedFrom", { pre: fmtTokens(preTokens) });
  if (postTokens !== undefined)
    return t("sessionStats.compactedTo", { post: fmtTokens(postTokens) });
  return t("sessionStats.compactedBare");
}
