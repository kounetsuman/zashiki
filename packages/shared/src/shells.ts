// Pure functions for detecting resident background shells.
// Side effects (running lsof, reading transcripts) are the responsibility of
// server/infra. Here we only reconcile lsof output strings against the set of
// backgroundTaskIds.
//
// Detection essentials: Claude Code's Bash wrapper (whether fg or bg) points
// stdout (fd1) at <sid>/tasks/<ID>.output. fg vs bg cannot be distinguished via
// ps/lsof; the only thing that separates them is whether <ID> appears in the
// transcript's toolUseResult.backgroundTaskId (it is absent for fg). Liveness is
// simply "a live wrapper holding that fd being visible in lsof".

/** sid and bg task ID extracted from the output file that the live wrapper's fd1 points to. */
export interface ShellOutput {
  sid: string;
  taskId: string;
}

/**
 * Identifies Claude Code's Bash execution wrapper (whether fg or bg) from its args.
 * It has a distinctive shape that sources the shell-snapshot while running the
 * actual command via eval. Requiring both snapshot and eval to be present narrows
 * out false positives from ordinary zsh/vim etc.
 */
export function isBashWrapperArgs(args: string): boolean {
  return (
    args.includes("shell-snapshots/snapshot-") &&
    /\beval\b/.test(args) &&
    args.startsWith("/bin/zsh -c")
  );
}

const OUTPUT_PATH_RE =
  /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tasks\/([A-Za-z0-9]+)\.output$/;

/**
 * From the machine-readable output of `lsof -F pfn -a -d 1`, extracts the
 * {sid, taskId} of entries whose fd1 points to <sid>/tasks/<ID>.output.
 * Entries other than fd1, and non-output files, are ignored.
 */
export function parseLsofFdOutputs(lsofOutput: string): ShellOutput[] {
  const outputs: ShellOutput[] = [];
  let fd: string | null = null;
  for (const line of lsofOutput.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      fd = null;
    } else if (tag === "f") {
      fd = rest;
    } else if (tag === "n") {
      if (fd !== "1") continue;
      const m = OUTPUT_PATH_RE.exec(rest);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        outputs.push({ sid: m[1], taskId: m[2] });
      }
    }
  }
  return outputs;
}

/**
 * Reconciles the live wrappers' {sid, taskId} entries against the per-sid set of
 * backgroundTaskIds, and counts, per sid, the shells confirmed as resident bg
 * (fg = IDs not in the set are excluded).
 * A sid with a count of 0 gets no key at all (so it resolves to undefined when served).
 */
export function countRunningShellsBySid(
  outputs: readonly ShellOutput[],
  bgTaskIdsBySid: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { sid, taskId } of outputs) {
    if (bgTaskIdsBySid.get(sid)?.has(taskId)) {
      counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
  }
  return counts;
}
