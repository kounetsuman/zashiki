import type { TranscriptEvent } from "./session-state.js";

// Pure-function reading of jsonl (Claude transcripts)
// (file I/O is the server/infra's responsibility; this file only takes the
// content string and parses it).

/**
 * Tail window of 50: so that user/assistant can still be picked up even when
 * noise lines (attachment/ai-title, etc.) fill the tail (equivalent to cw's
 * tail -50).
 */
const LAST_EVENT_TAIL_LINES = 50;

const INTERRUPT_MARKER = "[Request interrupted by user]";

/** Extracts text from message.content (arrays concatenate only text elements; strings pass through). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Skip a broken JSON line by itself without discarding the rest
    return null;
  }
}

function contentOf(event: Record<string, unknown>): unknown {
  const message = event.message;
  if (typeof message !== "object" || message === null) return undefined;
  return (message as { content?: unknown }).content;
}

/**
 * The last user/assistant event in the transcript (null if none).
 * interrupted = the body text contains the interrupt marker (not looked for
 * inside tool_result).
 * @param jsonlTail the tail portion of the jsonl (the whole file is fine; only the last 50 lines are examined)
 */
export function lastUserOrAssistantEvent(
  jsonlTail: string,
): TranscriptEvent | null {
  const lines = jsonlTail
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-LAST_EVENT_TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = parseLine(line);
    if (!event) continue;
    const type = event.type;
    if (type !== "user" && type !== "assistant") continue;
    const text = textOfContent(contentOf(event));
    return { type, interrupted: text.includes(INTERRUPT_MARKER) };
  }
  return null;
}

/** A human-typed user line: a `user` event whose content is not solely a tool_result block. */
function isHumanPrompt(event: Record<string, unknown>): boolean {
  if (event.type !== "user") return false;
  const content = contentOf(event);
  if (!Array.isArray(content)) return true;
  return !content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result",
  );
}

/** Whether an assistant message carries a `ScheduleWakeup` tool_use block. */
function hasScheduleWakeup(event: Record<string, unknown>): boolean {
  const content = contentOf(event);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_use" &&
      (b as { name?: unknown }).name === "ScheduleWakeup",
  );
}

/**
 * Classifies an event as a loop turn boundary: true schedules a wakeup, false ends the
 * loop (human prompt or fired wakeup), null is noise the scan skips.
 */
function classifyLoopBoundary(event: Record<string, unknown>): boolean | null {
  if (event.type === "assistant" && hasScheduleWakeup(event)) return true;
  if (event.type === "user" && isHumanPrompt(event)) return false;
  if (event.type === "system" && event.subtype === "scheduled_task_fire")
    return false;
  return null;
}

/**
 * Whether the transcript tail shows a pending self-paced `/loop` wakeup: the newest turn boundary
 * is a `ScheduleWakeup`, not yet superseded by a human prompt or a fired wakeup. Between iterations
 * the pane looks identical to a completed session, so the poller uses this to keep it off the
 * "completed" read. See the tests for the boundary cases.
 * @param jsonlTail the tail portion of the jsonl (the whole file is fine; only the last 50 lines are examined)
 */
export function loopWakeupPending(jsonlTail: string): boolean {
  const lines = jsonlTail
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-LAST_EVENT_TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = parseLine(line);
    if (!event) continue;
    const boundary = classifyLoopBoundary(event);
    if (boundary !== null) return boundary;
  }
  return false;
}

/** Strips the meta tags added when running a skill/slash command (command-name keeps its inner /foo). */
function stripCommandTags(text: string): string {
  return text
    .replace(/<command-args>[^<]*<\/command-args>/g, "")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(
      /<local-command-(?:caveat|stdout|stderr)>[^<]*<\/local-command-(?:caveat|stdout|stderr)>/g,
      "",
    )
    .replace(/<\/?command-name>/g, "");
}

/**
 * Builds a summary title from the first user utterance (collapses newlines/runs
 * of whitespace and takes the first 30 characters).
 * @param jsonlHead the head portion of the jsonl (the whole file is fine)
 */
export function firstUserTitle(
  jsonlHead: string,
  maxChars = 30,
): string | null {
  for (const line of jsonlHead.split("\n")) {
    if (line.length === 0 || !line.includes('"type":"user"')) continue;
    const event = parseLine(line);
    if (event?.type !== "user") continue;
    // The restore caveat inserted at the top on resume is isMeta:true and becomes
    // empty after tag removal. Stopping here would leave the title unset and cause
    // a false "fresh" verdict, so keep reading until the real utterance.
    if (event.isMeta === true) continue;
    const title = stripCommandTags(textOfContent(contentOf(event)))
      .replace(/\s+/g, " ")
      .trim();
    if (title.length === 0) continue;
    return [...title].slice(0, maxChars).join("");
  }
  return null;
}

/** cwd -> the project directory name under ~/.claude/projects (`/` replaced with `-`). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

/**
 * Collects every background shell launch ID (toolUseResult.backgroundTaskId) in
 * the transcript (present only for Bash run_in_background, not for foreground).
 * Keeps things lightweight even on huge transcripts by JSON-parsing only the
 * candidate lines.
 */
export function backgroundTaskIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const line of content.split("\n")) {
    if (line.length === 0 || !line.includes('"backgroundTaskId"')) continue;
    const event = parseLine(line);
    const result = event?.toolUseResult;
    if (typeof result !== "object" || result === null) continue;
    const id = (result as { backgroundTaskId?: unknown }).backgroundTaskId;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return ids;
}
