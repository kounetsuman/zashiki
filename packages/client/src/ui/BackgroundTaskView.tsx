import type {
  BackgroundTask,
  BackgroundTaskStatus,
  StallReason,
  StallRules,
} from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BACKGROUND_TASK_FILTERS,
  type BackgroundTaskRow,
  backgroundTaskRows,
  commandHead,
  countByFilter,
  DEFAULT_STATUS_SELECTION,
  filterRows,
  formatAgo,
  formatElapsed,
  isFilterSelected,
  liveNowMs,
  toggleFilter,
} from "../session/background-task-rows.js";
import {
  IdleCockpitTerminalGroup,
  type IdleCockpitTerminalGroupProps,
} from "./IdleCockpitTerminalGroup.js";
import { useNow } from "./useNow.js";
import { ViewEmpty } from "./ViewEmpty.js";
import { ViewHeader } from "./ViewHeader.js";

export interface BackgroundTaskViewProps {
  tasks: readonly BackgroundTask[];
  /** When `tasks` were fetched (epoch ms); the live clock stops a while after this. */
  fetchedAt: number;
  rules: StallRules;
  onOpenCockpitTerminal: (cockpitTerminalId: string) => void;
  /** Shown above the filters while any Cockpit Terminal is idle. */
  idleCockpitTerminals?: Omit<
    IdleCockpitTerminalGroupProps,
    "onOpenCockpitTerminal"
  >;
}

type Tone = "stalled" | "running" | "ok" | "failed" | "muted";

function toneOf(status: BackgroundTaskStatus): Tone {
  switch (status.kind) {
    case "stalled":
      return "stalled";
    case "running":
      return "running";
    case "disconnected":
      return "muted";
    case "ended":
      if (status.exitCode === 0) return "ok";
      if (status.exitCode !== undefined || status.endStatus === "failed")
        return "failed";
      return "muted";
  }
}

function useStatusLabel(): (status: BackgroundTaskStatus) => string {
  const { t } = useTranslation();
  return (status) => {
    if (status.kind !== "ended")
      return t(`backgroundTasks.status.${status.kind}`);
    if (status.exitCode !== undefined)
      return t("backgroundTasks.status.exit", { code: status.exitCode });
    return status.endStatus === "killed" || status.endStatus === "stopped"
      ? t(`backgroundTasks.status.${status.endStatus}`)
      : t("backgroundTasks.status.ended");
  };
}

function useReasonText(): (reason: StallReason) => string {
  const { t } = useTranslation();
  return (reason) => {
    switch (reason.kind) {
      case "launch_age":
        return t("backgroundTasks.reason.launchAge", {
          age: formatAgo(reason.ageMs),
          min: reason.limitMin,
        });
      case "quiet":
        return t("backgroundTasks.reason.quiet", {
          age: formatAgo(reason.quietMs),
          min: reason.limitMin,
        });
      case "repeat":
        return t("backgroundTasks.reason.repeat", {
          count: reason.count,
          line: commandHead(reason.line, 60),
        });
    }
  };
}

/** A drag that selected this row's text is a copy, not a request to open the terminal. */
function hasTextSelectedIn(el: HTMLElement): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    selection.toString() !== "" &&
    el.contains(selection.anchorNode)
  );
}

function TaskRow({
  row,
  nowMs,
  onOpen,
}: {
  row: BackgroundTaskRow;
  nowMs: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const statusLabel = useStatusLabel();
  const reasonText = useReasonText();
  const { task, status } = row;
  const tone = toneOf(status);
  const elapsedUntil =
    status.kind === "ended" ? (task.endedAt ?? nowMs) : nowMs;
  const meta = [`${task.org} / ${task.repo}`];
  if (task.title !== undefined) meta.push(task.title);
  if (status.kind === "running" || status.kind === "stalled") {
    meta.push(
      task.outputModifiedAt !== undefined
        ? t("backgroundTasks.outputAgo", {
            ago: formatAgo(nowMs - task.outputModifiedAt),
          })
        : t("backgroundTasks.noOutput"),
    );
  } else if (status.kind === "ended" && task.endedAt !== undefined) {
    meta.push(
      t("backgroundTasks.endedAgo", { ago: formatAgo(nowMs - task.endedAt) }),
    );
  } else if (status.kind === "ended") {
    meta.push(t("backgroundTasks.noNotice"));
  } else {
    meta.push(t("backgroundTasks.disconnectedNote"));
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the head button is the keyboard path; a click anywhere else on the row is a pointer shortcut to it.
    <li
      className={`background-task-row background-task-${tone}`}
      data-task-id={task.taskId}
      onClick={(e) => {
        const byPointer = e.detail > 0;
        if (byPointer && hasTextSelectedIn(e.currentTarget)) return;
        onOpen();
      }}
    >
      <button type="button" className="background-task-head">
        <span className="background-task-badge">{statusLabel(status)}</span>
        <span className="background-task-description">
          {task.description !== ""
            ? task.description
            : commandHead(task.command)}
        </span>
        {task.startedAt !== undefined && (
          <span className="background-task-elapsed">
            {formatElapsed(elapsedUntil - task.startedAt)}
          </span>
        )}
      </button>
      <div className="background-task-command" title={task.command}>
        $ {commandHead(task.command)}
      </div>
      <div className="background-task-meta" title={task.cwd}>
        {meta.join(" · ")}
      </div>
      {status.kind === "stalled" && (
        <div className="background-task-reason">
          {status.reasons.map(reasonText).join(" · ")}
        </div>
      )}
    </li>
  );
}

/**
 * The background Bash tasks of every Cockpit Terminal's most recent Claude Session, one row each,
 * with the stalled ones first and the rules that flagged them. Re-judged every second so the
 * elapsed times keep moving between polls.
 */
export function BackgroundTaskView({
  tasks,
  fetchedAt,
  rules,
  onOpenCockpitTerminal,
  idleCockpitTerminals,
}: BackgroundTaskViewProps) {
  const { t } = useTranslation();
  const nowMs = liveNowMs(useNow(1_000), fetchedAt);
  const [selection, setSelection] = useState(DEFAULT_STATUS_SELECTION);
  const rows = backgroundTaskRows(tasks, nowMs, rules);
  const counts = countByFilter(rows);
  const shown = filterRows(rows, selection);
  return (
    <section className="background-task-view" data-view="backgroundTasks">
      <ViewHeader title="BACKGROUND TASKS" />
      {idleCockpitTerminals !== undefined && (
        <IdleCockpitTerminalGroup
          {...idleCockpitTerminals}
          onOpenCockpitTerminal={onOpenCockpitTerminal}
        />
      )}
      <div className="background-task-filters">
        {BACKGROUND_TASK_FILTERS.map((f) => {
          const selected = isFilterSelected(selection, f);
          return (
            <button
              key={f}
              type="button"
              aria-pressed={selected}
              className={`background-task-filter background-task-filter-${f}${selected ? " is-active" : ""}`}
              onClick={() => setSelection((s) => toggleFilter(s, f))}
            >
              {t(`backgroundTasks.filter.${f}`)} {counts[f]}
            </button>
          );
        })}
      </div>
      <div className="background-task-rules">
        {t("backgroundTasks.rulesSummary", {
          launch: rules.launchLimitMin,
          quiet: rules.quietLimitMin,
          repeat: rules.repeatLimit,
        })}
      </div>
      {shown.length === 0 ? (
        <ViewEmpty>
          {rows.length === 0
            ? t("backgroundTasks.empty")
            : t("backgroundTasks.noneSelected")}
        </ViewEmpty>
      ) : (
        <ul className="background-task-list">
          {shown.map((row) => (
            <TaskRow
              key={`${row.task.sid}/${row.task.taskId}`}
              row={row}
              nowMs={nowMs}
              onOpen={() => onOpenCockpitTerminal(row.task.cockpitTerminalId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
