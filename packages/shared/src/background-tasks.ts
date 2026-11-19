import type { BackgroundTask } from "./protocol.js";

/** A per-command launch limit: applies when the command contains `match`. */
export interface LaunchLimitOverride {
  match: string;
  launchLimitMin: number;
}

/** When a running background task counts as stalled. Any one rule is enough. */
export interface StallRules {
  launchLimitMin: number;
  quietLimitMin: number;
  repeatLimit: number;
  overrides: LaunchLimitOverride[];
}

export const DEFAULT_STALL_RULES: StallRules = {
  launchLimitMin: 20,
  quietLimitMin: 5,
  repeatLimit: 5,
  overrides: [],
};

export type StallReason =
  | { kind: "launch_age"; limitMin: number }
  | { kind: "quiet"; limitMin: number }
  | { kind: "repeat"; line: string; count: number };

export type BackgroundTaskStatus =
  | { kind: "running" }
  | { kind: "stalled"; reasons: StallReason[] }
  | { kind: "ended"; endStatus?: string; exitCode?: number }
  | { kind: "disconnected" };

export type BackgroundTaskFacts = Pick<
  BackgroundTask,
  | "command"
  | "phase"
  | "startedAt"
  | "outputModifiedAt"
  | "lastLine"
  | "lastLineRepeats"
  | "endStatus"
  | "exitCode"
>;

const MINUTE_MS = 60_000;

export function launchLimitMinFor(command: string, rules: StallRules): number {
  const override = rules.overrides.find(
    (o) => o.match.trim() !== "" && command.includes(o.match.trim()),
  );
  return override?.launchLimitMin ?? rules.launchLimitMin;
}

function stallReasons(
  task: BackgroundTaskFacts,
  nowMs: number,
  rules: StallRules,
): StallReason[] {
  const reasons: StallReason[] = [];
  const launchLimitMin = launchLimitMinFor(task.command, rules);
  if (
    task.startedAt !== undefined &&
    nowMs - task.startedAt > launchLimitMin * MINUTE_MS
  ) {
    reasons.push({ kind: "launch_age", limitMin: launchLimitMin });
  }
  const lastOutputAt = task.outputModifiedAt ?? task.startedAt;
  if (
    lastOutputAt !== undefined &&
    nowMs - lastOutputAt > rules.quietLimitMin * MINUTE_MS
  ) {
    reasons.push({ kind: "quiet", limitMin: rules.quietLimitMin });
  }
  if (
    task.lastLine !== undefined &&
    task.lastLineRepeats >= rules.repeatLimit
  ) {
    reasons.push({
      kind: "repeat",
      line: task.lastLine,
      count: task.lastLineRepeats,
    });
  }
  return reasons;
}

export function backgroundTaskStatus(
  task: BackgroundTaskFacts,
  nowMs: number,
  rules: StallRules,
): BackgroundTaskStatus {
  switch (task.phase) {
    case "disconnected":
      return { kind: "disconnected" };
    case "ended":
      return {
        kind: "ended",
        ...(task.endStatus !== undefined && { endStatus: task.endStatus }),
        ...(task.exitCode !== undefined && { exitCode: task.exitCode }),
      };
    case "running": {
      const reasons = stallReasons(task, nowMs, rules);
      return reasons.length > 0
        ? { kind: "stalled", reasons }
        : { kind: "running" };
    }
  }
}
