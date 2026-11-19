import type {
  BackgroundTaskStatus,
  StallReason,
  StallRules,
} from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BACKGROUND_TASK_FILTERS,
  type BackgroundTaskFilter,
  type BackgroundTaskRow,
  commandHead,
  countByFilter,
  filterRows,
  formatAgo,
  formatElapsed,
} from "../session/background-task-rows.js";
import { ViewEmpty } from "./ViewEmpty.js";
import { ViewHeader } from "./ViewHeader.js";

export interface BackgroundTaskViewProps {
  rows: readonly BackgroundTaskRow[];
  /** The moment the rows were judged at (epoch ms); ages are measured from here. */
  nowMs: number;
  rules: StallRules;
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
        return t("backgroundTasks.reason.launchAge", { min: reason.limitMin });
      case "quiet":
        return t("backgroundTasks.reason.quiet", { min: reason.limitMin });
      case "repeat":
        return t("backgroundTasks.reason.repeat", {
          count: reason.count,
          line: commandHead(reason.line, 60),
        });
    }
  };
}

function TaskRow({ row, nowMs }: { row: BackgroundTaskRow; nowMs: number }) {
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
    <li
      className={`background-task-row background-task-${tone}`}
      data-task-id={task.taskId}
    >
      <div className="background-task-head">
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
      </div>
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
 * with the stalled ones first and the rules that flagged them.
 */
export function BackgroundTaskView({
  rows,
  nowMs,
  rules,
}: BackgroundTaskViewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BackgroundTaskFilter>("all");
  const counts = countByFilter(rows);
  const shown = filterRows(rows, filter);
  return (
    <section className="background-task-view" data-view="backgroundTasks">
      <ViewHeader title="BACKGROUND TASKS" />
      <div className="background-task-filters" role="tablist">
        {BACKGROUND_TASK_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`background-task-filter background-task-filter-${f}${filter === f ? " is-active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {t(`backgroundTasks.filter.${f}`)} {counts[f]}
          </button>
        ))}
      </div>
      <div className="background-task-rules">
        {t("backgroundTasks.rulesSummary", {
          launch: rules.launchLimitMin,
          quiet: rules.quietLimitMin,
          repeat: rules.repeatLimit,
        })}
      </div>
      {shown.length === 0 ? (
        <ViewEmpty>{t("backgroundTasks.empty")}</ViewEmpty>
      ) : (
        <ul className="background-task-list">
          {shown.map((row) => (
            <TaskRow
              key={`${row.task.sid}/${row.task.taskId}`}
              row={row}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
