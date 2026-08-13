import { describe, expect, it } from "vitest";

import {
  backgroundTaskIds,
  claudeProjectDirName,
  firstUserTitle,
  lastUserOrAssistantEvent,
} from "./jsonl.js";

const user = (content: unknown): string =>
  JSON.stringify({ type: "user", message: { content } });
const assistant = (content: unknown): string =>
  JSON.stringify({ type: "assistant", message: { content } });

describe("lastUserOrAssistantEvent (port of inf_jsonl_last_event)", () => {
  it("picks up the trailing user event", () => {
    expect(lastUserOrAssistantEvent(user("作業して"))).toEqual({
      type: "user",
      interrupted: false,
    });
  });

  it("picks up a user event across 40 lines of noise (tail window 50)", () => {
    const noise = Array.from({ length: 40 }, () =>
      JSON.stringify({ type: "ai-title", title: "x" }),
    );
    const content = [user("作業して"), ...noise].join("\n");
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "user",
      interrupted: false,
    });
  });

  it("does not pick up a user event pushed outside the tail window of 50", () => {
    const noise = Array.from({ length: 50 }, () =>
      JSON.stringify({ type: "ai-title", title: "x" }),
    );
    const content = [user("作業して"), ...noise].join("\n");
    expect(lastUserOrAssistantEvent(content)).toBeNull();
  });

  it("interrupted user -> interrupted=true", () => {
    const content = user([
      { type: "text", text: "[Request interrupted by user]" },
    ]);
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "user",
      interrupted: true,
    });
  });

  it("assistant -> assistant with interrupted=false", () => {
    const content = assistant([{ type: "text", text: "ok" }]);
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "assistant",
      interrupted: false,
    });
  });

  it("a tool_result user is not treated as interrupted (only text elements are inspected)", () => {
    const content = user([
      {
        type: "tool_result",
        content: "[Request interrupted by user] という文字列を含む出力",
      },
    ]);
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "user",
      interrupted: false,
    });
  });

  it("skips a broken JSON line individually without discarding the rest", () => {
    const content = [user("作業して"), '{"type":"ai-title","broken'].join("\n");
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "user",
      interrupted: false,
    });
  });

  it("returns null when there is no user/assistant event", () => {
    expect(
      lastUserOrAssistantEvent('{"type":"summary","summary":"x"}'),
    ).toBeNull();
    expect(lastUserOrAssistantEvent("")).toBeNull();
  });

  it("takes the last user/assistant among multiple events", () => {
    const content = [user("最初"), assistant("応答"), user("次の依頼")].join(
      "\n",
    );
    expect(lastUserOrAssistantEvent(content)).toEqual({
      type: "user",
      interrupted: false,
    });
  });
});

describe("firstUserTitle (port of inf_jsonl_title)", () => {
  it("uses the first 30 characters of the first user utterance as the title", () => {
    const long = "あ".repeat(40);
    const content = [user(long), assistant("応答")].join("\n");
    expect(firstUserTitle(content)).toBe("あ".repeat(30));
  });

  it("concatenates and reads content even when it is an array of text elements", () => {
    const content = user([
      { type: "text", text: "前半" },
      { type: "text", text: "後半" },
    ]);
    expect(firstUserTitle(content)).toBe("前半 後半");
  });

  it("collapses newlines and runs of whitespace into a single space", () => {
    const content = user("一行目\n二行目   三行目");
    expect(firstUserTitle(content)).toBe("一行目 二行目 三行目");
  });

  it("strips slash-command meta tags (keeps the contents of command-name)", () => {
    const content = user(
      "<command-name>/day-closing</command-name>\n" +
        "<command-message>day-closing</command-message>\n" +
        "<command-args>今日の分</command-args>",
    );
    expect(firstUserTitle(content)).toBe("/day-closing");
  });

  it("removes local-command-caveat/stdout/stderr blocks", () => {
    const content = user(
      "<local-command-caveat>注意書き</local-command-caveat>実行結果を見て" +
        "<local-command-stdout>出力</local-command-stdout>" +
        "<local-command-stderr>エラー</local-command-stderr>",
    );
    expect(firstUserTitle(content)).toBe("実行結果を見て");
  });

  it("ignores assistant events (etc.) before the first user", () => {
    const content = [
      JSON.stringify({ type: "summary", summary: "前セッション要約" }),
      user("本題の依頼"),
    ].join("\n");
    expect(firstUserTitle(content)).toBe("本題の依頼");
  });

  it("returns null when there is no user", () => {
    expect(firstUserTitle(assistant("応答のみ"))).toBeNull();
    expect(firstUserTitle("")).toBeNull();
  });

  it("skips a user line that becomes empty after tag removal and looks for the next user", () => {
    const content = [
      user("<command-args>引数だけ</command-args>"),
      user("本題の依頼"),
    ].join("\n");
    expect(firstUserTitle(content)).toBe("本題の依頼");
  });

  it("returns null when there are only empty user lines", () => {
    const content = user("<command-args>引数だけ</command-args>");
    expect(firstUserTitle(content)).toBeNull();
  });

  it("skips isMeta:true user lines (such as the resume restore caveat)", () => {
    // The restore-context caveat inserted at the top by `claude --resume` is
    // isMeta:true and becomes empty after tag removal. Stopping here would leave
    // the title unset and cause a false "fresh" verdict.
    const caveat = JSON.stringify({
      type: "user",
      isMeta: true,
      message: {
        content:
          "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
      },
    });
    const content = [caveat, user("元の会話の最初の依頼")].join("\n");
    expect(firstUserTitle(content)).toBe("元の会話の最初の依頼");
  });
});

describe("claudeProjectDirName (~/.claude/projects directory naming convention)", () => {
  it("replaces / with - in the cwd", () => {
    expect(claudeProjectDirName("/Users/kilo/workspace/charlie")).toBe(
      "-Users-kilo-workspace-charlie",
    );
  });
});

describe("backgroundTaskIds (extracts unique IDs of background shell launches)", () => {
  const bg = (id: string): string =>
    JSON.stringify({ type: "user", toolUseResult: { backgroundTaskId: id } });

  it("returns toolUseResult.backgroundTaskId as a set (deduplicated)", () => {
    const jsonl = [
      bg("bush20ok3"),
      JSON.stringify({ type: "user", toolUseResult: { stdout: "x" } }),
      bg("b48tqxha9"),
      bg("bush20ok3"),
    ].join("\n");
    expect(backgroundTaskIds(jsonl)).toEqual(
      new Set(["bush20ok3", "b48tqxha9"]),
    );
  });

  it("a transcript without backgroundTaskId (foreground only) yields an empty set", () => {
    const jsonl = JSON.stringify({
      type: "user",
      toolUseResult: { stdout: "ok" },
    });
    expect(backgroundTaskIds(jsonl)).toEqual(new Set());
  });

  it("skips broken JSON lines and continues", () => {
    const jsonl = `not json\n${bg("bcyiin1lh")}\n{"broken`;
    expect(backgroundTaskIds(jsonl)).toEqual(new Set(["bcyiin1lh"]));
  });

  it("an empty string yields an empty set", () => {
    expect(backgroundTaskIds("")).toEqual(new Set());
  });
});
