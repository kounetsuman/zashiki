import { describe, expect, it } from "vitest";

import {
  countRunningSubagents,
  DEFAULT_MENU_MARKERS,
  detectState,
  fallbackState,
  hasBgAgent,
  isLimitReached,
  isMenuOpen,
  isRunning,
  isWizard,
  openTasksRemaining,
  subagentFreshWithinSec,
} from "./session-state.js";

// Fixtures don't read the real environment; they are faithfully synthesized from
// known screen output patterns. Verification against real captures is done in the
// PR's manual checklist.

// ---- Normal-width fixtures ----

const CAP_RUN = `古い履歴行
✻ Simmering… (esc to interrupt · ctrl+t)
╭───╮
│ ❯ │
╰───╯`;

const CAP_RUN_TRAILING_BLANKS = `${CAP_RUN}\n\n\n\n\n\n\n\n`;

const CAP_MARKER_AT_8TH = `(esc to interrupt)
1行
2行
3行
4行
5行
6行
7行`;

const CAP_MARKER_AT_9TH_HISTORY_QUOTE = `引用: (esc to interrupt を検出する話
1行
2行
3行
4行
5行
6行
7行
8行`;

const CAP_SHORT_RUN = `a
(esc to interrupt)`;

// New UI running spinner: drops "(esc to interrupt", and the only clue is the
// elapsed timer `(<elapsed> · ↓ <tokens>)` (synthesized from a real capture).
const CAP_RUN_NEW_TIMER = `⏺ Reading 1 file… (ctrl+o to expand)
  ⎿  ~/workspace/kilo/zashiki/crates/zashiki-server/src/lib.rs
  ⎿  Loaded ../zashiki/CLAUDE.md
✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
───
❯
───
  19.0M token/per | 186.1M token/session | 15% usage/5h(-13m) | 46% usage/week
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

// New UI completion line: past tense "for <duration>", no paren. Not misdetected as running.
const CAP_DONE_NEW = `  補足の説明行
  いまコンフリクト解消まで進めましょうか？
✻ Sautéed for 1m 10s
※ recap: 何かの要約テキスト (disable recaps in /config)
───
❯
───
  806.8k token/per | 806.8k token/session | 7% usage/5h(-1h11m) | 44% usage/week
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

// bg agent: the spinner text loses "(esc to interrupt", and the only clue that
// it's running is the agents panel at the very bottom (⏺ main heading + line-leading ◯ lines).
const CAP_BG = `✻ Waiting for 1 background agent to finish

───
❯
───
  1.4Mトークン/回
  ⏵⏵ bypass ... ← for agents

  ⏺ main
  ◯ general-purpose  作業  29s · ↓ 9.7k tokens`;

const CAP_BG_TRAILING_BLANKS = `${CAP_BG}\n\n\n`;

const CAP_BG_MULTI = `  ⏺ main
  ◯ general-purpose  A  1s
  ◯ Explore  B  2s`;

// A ◯ within a line typed into the input box (not line-leading). No heading either.
const CAP_BG_INPUT_BOX = `✻ Brewed for 1m
───
❯ これは ◯ について
───
  token
  ⏵⏵ bypass ... ← for agents`;

// Even if the ⏺ main heading is within the window, a ◯ that is not line-leading is not picked up.
const CAP_BG_HEADING_BUT_INLINE_CIRCLE = `  ⏺ main
  作業中です ◯ 印について
───
❯
───`;

// Even a line-leading ◯ is not picked up without the ⏺ main heading (radio/TODO).
const CAP_BG_RADIO = `質問？
● はい
◯ いいえ
◯ 常に許可`;

// A ◯ quoted in the body text (no heading; the normal bottom after completion).
const CAP_BG_HISTORY_QUOTE = `過去メッセージ ◯ を含む
✻ Brewed for 1m
───
❯
───
  token
  ⏵⏵ bypass ... ← for agents`;

const CAP_BG_SHORT = `  ⏺ main
  ◯ x`;

const CAP_WIZARD_TWO_CHOICE = `❯ 1. Yes
  2. No`;

const CAP_WIZARD_SINGLE = "❯ 1. Yes";

// wizard takes priority over the spinner (still waiting for input even if a spinner quote remains below the permission wait).
const CAP_WIZARD_WITH_MARKER = `Do you want to proceed?
❯ 1. Yes
  2. No
✻ Simmering… (esc to interrupt · ctrl+t)`;

// A numbered list merely present in the body (the ❯ cursor line does not point at a number) is not a wizard.
const CAP_NUMBERED_LIST_NO_CURSOR = `手順:
1. ビルドする
2. テストする
───
❯
───`;

const CAP_IDLE_PLAIN = "待機画面";

// A window with no claude (the leftmost pane is just a shell).
const CAP_SHELL_ONLY = `~/workspace/charlie % ls
README.md
~/workspace/charlie %`;

// ---- 80-column-width fixtures (undisplayed windows shrink to the default size 80x24) ----

const CAP_IDLE_80 = `⏺ 完了しました。テストは全て green です。

╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  ? for shortcuts`;

// The info following the spinner line (token count, etc.) wraps at 80 columns, but the marker part stays within the line.
const CAP_RUN_80_WRAPPED_TAIL = `⏺ Bash(pnpm build && pnpm lint && pnpm test)
  ⎿  Running…

✻ Cogitating… (esc to interrupt · ctrl+t to hide todos · 123s · ↓ 2.3k tokens ·
esc to undo)

╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯`;

// The body of choice 2 wraps at 80 columns and the continuation line does not
// start with a number (the numbered-line count stays at the 2 lines ❯ 1. / 2., satisfying >= 2).
const CAP_WIZARD_80_WRAPPED_OPTION = `Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for pnpm build && pnpm lint && pnpm test commands
     in /Users/kilo/workspace/kilo/zashiki`;

// A case where a wrapped continuation line happens to start with a number ("2." lands at line start).
// The drift is in the direction of increasing the count, so the waiting_input determination is preserved.
const CAP_WIZARD_80_WRAP_STARTS_WITH_NUMBER = `Do you want to proceed?
❯ 1. Yes, and remember this choice for the current session and also for version
2. 0 of the config file
  2. No, and tell Claude what to do differently (esc)`;

// An 80-column idle screen with an old spinner quote in the history (confirming
// the meaning of the bottom-only limit; the quote line falls outside the window
// because there are 8 non-empty lines of input box, status, etc. below it).
const CAP_IDLE_80_WITH_OLD_SPINNER_QUOTE = `⏺ ログに "✻ Simmering… (esc to interrupt · ctrl+t)" と出ていたのは実行中の表示
  です。検出ロジックは末尾 8 非空行だけを見ます。

⏺ 修正が完了しました。
  1行目の説明
  2行目の説明
  3行目の説明

╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  ? for shortcuts`;

// A full 80-column screen where the normal spinner has been pushed out by the bg agent panel.
// The spinner text has no "(esc to interrupt"; the only clue is the panel (⏺ main + line-leading ◯).
const CAP_BG_80_FULL = `⏺ サブエージェントに調査を委譲しました。

✻ Waiting for 1 background agent to finish… (ctrl+t to view)

╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
  1.4M トークン/回 · ⏵⏵ bypass permissions

  ⏺ main
  ◯ general-purpose  zashiki の設計調査と既存実装の依存関係の洗い出しをする長い
    説明が折り返されている  29s · ↓ 9.7k tokens`;

const claude = { hasClaude: true };
const noClaude = { hasClaude: false };

const CAP_TASKS_OPEN =
  "⏺ 別セッションの完了を待ちます。\n\n  1 tasks (0 done, 1 open)\n  □ Stand by, then review/test/PR #279 after other session finishes\n\n╭───╮\n│ ❯ │\n╰───╯\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
const CAP_TASKS_ALL_DONE =
  "⏺ 完了しました。\n\n  3 tasks (3 done, 0 open)\n  ✔ 済みタスク\n╭───╮\n│ ❯ │\n╰───╯\n  ? for shortcuts";
const CAP_TASKS_QUOTED_IN_HISTORY =
  '⏺ 過去ログに "5 tasks (2 done, 3 open)" と出ていた話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行';
const CAP_TASKS_WITH_SPINNER =
  "✻ Simmering… (esc to interrupt · ctrl+t)\n  1 tasks (0 done, 1 open)\n╭───╮\n│ ❯ │\n╰───╯";

describe("openTasksRemaining (task-list footer parsing)", () => {
  it("parses footer variants; only total > done counts as remaining", () => {
    expect(openTasksRemaining("1 tasks (0 done, 1 open)")).toBe(1);
    expect(openTasksRemaining("  1 task (0 done, 1 open)")).toBe(1);
    expect(openTasksRemaining("3 tasks (1 done, 1 in progress, 1 open)")).toBe(
      2,
    );
    // An unknown segment label must not kill the detection (Claude Code wording additions).
    expect(openTasksRemaining("5 tasks (2 done, 3 skipped)")).toBe(3);
    // All done (or a corrupt done >= total) must not read as busy.
    expect(openTasksRemaining("3 tasks (3 done)")).toBeNull();
    expect(openTasksRemaining("3 tasks (3 done, 0 open)")).toBeNull();
    expect(openTasksRemaining("3 tasks (5 done)")).toBeNull();
    // The footer owns its whole line: mid-sentence quotes and trailing prose do not match.
    expect(openTasksRemaining("status: 15 tasks (2 done) remain")).toBeNull();
    expect(openTasksRemaining("15 tasks (2 done) remain")).toBeNull();
    expect(openTasksRemaining("8 tasks (mostly done)")).toBeNull();
    expect(openTasksRemaining("12 tasks (3 done")).toBeNull();
    expect(openTasksRemaining("tasks (2 done)")).toBeNull();
  });

  it("the bottom-most footer decides (an all-done footer is not skipped for a staler open one above)", () => {
    expect(
      openTasksRemaining("5 tasks (2 done, 3 open)\n3 tasks (3 done)"),
    ).toBeNull();
    expect(
      openTasksRemaining("3 tasks (3 done)\n5 tasks (2 done, 3 open)"),
    ).toBe(3);
  });
});

describe("detectState (table test for the primary capture-based decision)", () => {
  const table: {
    name: string;
    capture: string;
    opts?: Parameters<typeof detectState>[1];
    expected: ReturnType<typeof detectState>;
  }[] = [
    // -- running: spinner (limited to the last 8 non-empty lines) --
    {
      name: "running when the spinner marker is within the last 8 non-empty lines",
      capture: CAP_RUN,
      expected: "running",
    },
    {
      name: "trailing blank lines do not count as decision lines (render padding)",
      capture: CAP_RUN_TRAILING_BLANKS,
      expected: "running",
    },
    {
      name: "running when the marker is 8th from the end (within the boundary)",
      capture: CAP_MARKER_AT_8TH,
      expected: "running",
    },
    {
      name: "idle when the marker is 9th from the end (outside the boundary = history quote)",
      capture: CAP_MARKER_AT_9TH_HISTORY_QUOTE,
      expected: "idle",
    },
    {
      name: "detects running even for a capture shorter than the decision window",
      capture: CAP_SHORT_RUN,
      expected: "running",
    },
    {
      name: "new UI: running from the elapsed-timer line even without a marker",
      capture: CAP_RUN_NEW_TIMER,
      expected: "running",
    },
    {
      name: "new UI: the completion line 'for <duration>' (no paren) is idle",
      capture: CAP_DONE_NEW,
      expected: "idle",
    },
    // -- running_bg_agent: bg agent panel (the normal spinner has been pushed out) --
    {
      name: "running_bg_agent from the ⏺ main heading + a line-leading ◯ line",
      capture: CAP_BG,
      expected: "running_bg_agent",
    },
    {
      name: "running_bg_agent even with the bg panel + trailing blank lines",
      capture: CAP_BG_TRAILING_BLANKS,
      expected: "running_bg_agent",
    },
    {
      name: "running_bg_agent even with multiple agent lines",
      capture: CAP_BG_MULTI,
      expected: "running_bg_agent",
    },
    {
      name: "running_bg_agent even for a bg panel shorter than the decision window",
      capture: CAP_BG_SHORT,
      expected: "running_bg_agent",
    },
    {
      name: "an inline ◯ in the input box (not line-leading, no heading) is idle",
      capture: CAP_BG_INPUT_BOX,
      expected: "idle",
    },
    {
      name: "idle when the ⏺ main heading exists but there is only an inline ◯",
      capture: CAP_BG_HEADING_BUT_INLINE_CIRCLE,
      expected: "idle",
    },
    {
      name: "a line-leading ◯ without a heading (radio/TODO) is idle",
      capture: CAP_BG_RADIO,
      expected: "idle",
    },
    {
      name: "a ◯ quoted in the body text is idle",
      capture: CAP_BG_HISTORY_QUOTE,
      expected: "idle",
    },
    // -- waiting_input: numbered-choice wizard --
    {
      name: "waiting_input from a cursor ❯ 1. + two choices",
      capture: CAP_WIZARD_TWO_CHOICE,
      expected: "waiting_input",
    },
    {
      name: "a single choice is not treated as a wizard (idle)",
      capture: CAP_WIZARD_SINGLE,
      expected: "idle",
    },
    {
      name: "the wizard takes priority over the spinner (waiting_input even when a marker coexists)",
      capture: CAP_WIZARD_WITH_MARKER,
      expected: "waiting_input",
    },
    {
      name: "a numbered list in the body (no ❯ cursor) is not treated as a wizard",
      capture: CAP_NUMBERED_LIST_NO_CURSOR,
      expected: "idle",
    },
    // -- no_claude / idle --
    {
      name: "no clue + claude present is idle",
      capture: CAP_IDLE_PLAIN,
      expected: "idle",
    },
    {
      name: "no clue + no claude is no_claude",
      capture: CAP_SHELL_ONLY,
      opts: noClaude,
      expected: "no_claude",
    },
    {
      name: "an empty capture + claude present is idle",
      capture: "",
      expected: "idle",
    },
    {
      name: "an empty capture + no claude is no_claude",
      capture: "",
      opts: noClaude,
      expected: "no_claude",
    },
    {
      name: "the wizard takes priority over claude-process detection (follows the priority order)",
      capture: CAP_WIZARD_TWO_CHOICE,
      opts: noClaude,
      expected: "waiting_input",
    },
    // -- watching: open tasks remain after the turn --
    {
      name: "watching when the open-task footer sits on an otherwise idle screen",
      capture: CAP_TASKS_OPEN,
      expected: "watching",
    },
    {
      name: "idle when the task footer says all done",
      capture: CAP_TASKS_ALL_DONE,
      expected: "idle",
    },
    {
      name: "idle when a footer-like phrase is only quoted mid-sentence in the history",
      capture: CAP_TASKS_QUOTED_IN_HISTORY,
      expected: "idle",
    },
    {
      name: "running wins over the open-task footer (priority order)",
      capture: CAP_TASKS_WITH_SPINNER,
      expected: "running",
    },
    {
      name: "no_claude wins over the open-task footer (a dead pane must not read as watching)",
      capture: CAP_TASKS_OPEN,
      opts: noClaude,
      expected: "no_claude",
    },
    // -- 80-column wrapping --
    {
      name: "80 columns: the idle screen is idle",
      capture: CAP_IDLE_80,
      expected: "idle",
    },
    {
      name: "80 columns: running from the marker line even when the spinner line's tail wraps",
      capture: CAP_RUN_80_WRAPPED_TAIL,
      expected: "running",
    },
    {
      name: "80 columns: waiting_input even when a choice body wraps (the continuation line has no number)",
      capture: CAP_WIZARD_80_WRAPPED_OPTION,
      expected: "waiting_input",
    },
    {
      name: "80 columns: waiting_input is preserved because the drift is toward over-counting even when a wrapped continuation line starts with a number",
      capture: CAP_WIZARD_80_WRAP_STARTS_WITH_NUMBER,
      expected: "waiting_input",
    },
    {
      name: "80 columns: an old spinner quote in the history (outside the bottom 8 lines) is idle",
      capture: CAP_IDLE_80_WITH_OLD_SPINNER_QUOTE,
      expected: "idle",
    },
    {
      name: "80 columns: running_bg_agent for a full screen where the bg panel pushed out the spinner (markerless spinner)",
      capture: CAP_BG_80_FULL,
      expected: "running_bg_agent",
    },
  ];

  it.each(table)("$name", ({ capture, opts, expected }) => {
    expect(detectState(capture, opts ?? claude)).toBe(expected);
  });

  it("runMarker can be overridden via opts (ZK_RUN_MARKER escape hatch)", () => {
    const cap = "✻ 走行中 [RUNNING-NOW]\n❯ ";
    expect(detectState(cap, { hasClaude: true })).toBe("idle");
    expect(
      detectState(cap, { hasClaude: true, runMarker: "[RUNNING-NOW]" }),
    ).toBe("running");
  });

  it("bgAgentMarker can be overridden via opts (ZK_BG_AGENT_MARKER escape hatch)", () => {
    const cap = "  ⏺ main\n  ● general-purpose  作業  1s";
    expect(detectState(cap, { hasClaude: true })).toBe("idle");
    expect(detectState(cap, { hasClaude: true, bgAgentMarker: "●" })).toBe(
      "running_bg_agent",
    );
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: zsh notation in the description text (not a template literal)
  it("an empty-string marker falls back to the default (zsh ${VAR:-default} compatible; guards against misconfiguring every window as running)", () => {
    // includes("") is always true, so letting an empty string through would make the idle screen running
    expect(
      detectState("待機画面", {
        hasClaude: true,
        runMarker: "",
        bgAgentMarker: "",
      }),
    ).toBe("idle");
  });
});

describe("isRunning / hasBgAgent / isWizard (unit checks of the boundaries)", () => {
  it("isRunning: false without a marker", () => {
    expect(isRunning(CAP_IDLE_PLAIN, "(esc to interrupt")).toBe(false);
  });

  it("isRunning: true on the new UI's elapsed-timer line (across spinner variants)", () => {
    expect(isRunning("✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)")).toBe(
      true,
    );
    expect(isRunning("✽ Skedaddling… (1m 58s · ↓ 5.1k tokens)")).toBe(true);
    expect(
      isRunning("✢ Whirring… (2m 14s · ↓ 5.5k tokens · thought for 2s)"),
    ).toBe(true);
    expect(isRunning("✻ Cogitating… (123s · ↓ 2.3k tokens)")).toBe(true);
  });

  it("isRunning: false on the new UI's completion line 'for <duration>'", () => {
    expect(isRunning("✻ Worked for 5m 42s")).toBe(false);
    expect(isRunning("✻ Sautéed for 1m 10s")).toBe(false);
    expect(isRunning("✻ Brewed for 1m")).toBe(false);
  });

  it("isRunning: false for a non-time paren right after an ellipsis (e.g. ctrl+o)", () => {
    expect(isRunning("⏺ Reading 1 file… (ctrl+o to expand)")).toBe(false);
  });

  it("isRunning: false for `…(Ns)` in the body text (closes without a `·`/`↓` separator)", () => {
    // A live timer is always followed by a separator like `(8m 10s · ↓ …)`. Distinguish it from a quote in natural text.
    expect(isRunning("処理は… (30s で完了しました)")).toBe(false);
    expect(isRunning("ログに (30s) と表示された")).toBe(false);
    expect(isRunning("完了… (5s)ago")).toBe(false);
  });

  it("isRunning: stays linear on many repeated timer-paren openings (ReDoS guard)", () => {
    // Many `…(0s` starts are the pump that makes the live-timer scan quadratic
    // unless its trailing class excludes `(`/`…`; assert it now runs in linear time.
    const line = "…(0s".repeat(100000);
    const start = performance.now();
    expect(isRunning(line)).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("hasBgAgent: the marker requires a line-start match + an immediately following space (does not pick up '◯x')", () => {
    expect(hasBgAgent("  ⏺ main\n  ◯x詰めた行", "◯")).toBe(false);
    expect(hasBgAgent("  ⏺ main\n  ◯ x", "◯")).toBe(true);
  });

  it("isWizard: counts the cursor line itself as a numbered line (prevents missing a two-choice permission prompt)", () => {
    // Not counting ❯ 1. made two choices come out as 1 and misdetected running (a cw regression)
    expect(isWizard("❯ 1. Yes\n  2. No")).toBe(true);
  });
});

describe("isLimitReached (detecting the limit banners)", () => {
  const CAP_LIMIT =
    "⏺ 直前の応答\n✗ Claude usage limit reached · /upgrade to increase your limit\n╭───╮\n│ ❯ │\n╰───╯";
  const CAP_LIMIT_RETRY =
    "✳ Session limit reached  Retrying in 20m (6:30pm) · attempt 1/15\n╭───╮\n│ ❯ │\n╰───╯";
  const CAP_LIMIT_HISTORY_QUOTE =
    "過去ログ: Claude usage limit reached の話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
  const CAP_RUN_WITH_USAGE_STATUS =
    "✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)\n───\n❯\n───\n  15% usage/5h(-13m) | 46% usage/week";

  it("true for the lockout banner at the bottom of the screen", () => {
    expect(isLimitReached(CAP_LIMIT)).toBe(true);
  });

  it("true for the session auto-retry banner", () => {
    expect(isLimitReached(CAP_LIMIT_RETRY)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLimitReached("✗ Claude Usage Limit Reached")).toBe(true);
  });

  it("false outside the last 8 non-empty lines (history quote)", () => {
    expect(isLimitReached(CAP_LIMIT_HISTORY_QUOTE)).toBe(false);
  });

  it("false for a quoted marker mid-line inside the bottom window", () => {
    const cap =
      '⏺ 出力\n  "limitReached": "Usage limit reached",\n  the phrase Session limit reached appears quoted\n╭───╮\n│ ❯ │\n╰───╯';
    expect(isLimitReached(cap)).toBe(false);
  });

  it("false for a usage-rate status line ('... usage/5h')", () => {
    expect(isLimitReached(CAP_RUN_WITH_USAGE_STATUS)).toBe(false);
  });

  it("an empty marker list is always false (prevents false positives matching every window)", () => {
    expect(isLimitReached(CAP_LIMIT, [])).toBe(false);
    expect(isLimitReached(CAP_LIMIT, [""])).toBe(false);
  });

  it("the markers can be overridden with line-head semantics (ZK_LIMIT_MARKER escape hatch)", () => {
    const cap = "✗ RATE_CAP_HIT\n───\n❯\n───";
    expect(isLimitReached(cap)).toBe(false);
    expect(isLimitReached(cap, ["rate_cap_hit"])).toBe(true);
    expect(
      isLimitReached('quoted "RATE_CAP_HIT" mid line', ["rate_cap_hit"]),
    ).toBe(false);
  });
});

describe("isMenuOpen (Claude Code menu/overlay detection)", () => {
  it("true when a default marker heads an indented line", () => {
    const cap =
      "\n   Select login method\n   1. Claude account\n   2. Console\n";
    expect(isMenuOpen(cap, DEFAULT_MENU_MARKERS)).toBe(true);
  });

  it("true when a marker sits behind a box border", () => {
    expect(
      isMenuOpen("│ Claude Code Status         │", DEFAULT_MENU_MARKERS),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMenuOpen("  claude code status", DEFAULT_MENU_MARKERS)).toBe(true);
  });

  it("false when a marker is quoted mid-sentence in the body", () => {
    const cap = "⏺ Run /model to open the Select Model menu\n───\n❯\n───";
    expect(isMenuOpen(cap, DEFAULT_MENU_MARKERS)).toBe(false);
  });

  it("false for an ordinary conversation screen", () => {
    const cap = "⏺ 完了しました。\n╭───╮\n│ ❯ │\n╰───╯\n  ? for shortcuts";
    expect(isMenuOpen(cap, DEFAULT_MENU_MARKERS)).toBe(false);
  });

  it("an empty marker list never matches", () => {
    expect(isMenuOpen("Select login method", [])).toBe(false);
  });

  it("ignores empty markers in the list", () => {
    expect(isMenuOpen("Select login method", [""])).toBe(false);
  });

  it("markers are overridable", () => {
    const cap = "│ CUSTOM MENU OPEN │";
    expect(isMenuOpen(cap, DEFAULT_MENU_MARKERS)).toBe(false);
    expect(isMenuOpen(cap, ["CUSTOM MENU OPEN"])).toBe(true);
  });

  it("defaults to DEFAULT_MENU_MARKERS when markers are omitted", () => {
    expect(isMenuOpen("Manage MCP servers")).toBe(true);
  });
});

describe("fallbackState (jsonl fallback when the capture has no clues)", () => {
  it("user, not interrupted, fresh → running (rescues the race before the spinner renders right after sending)", () => {
    expect(fallbackState({ type: "user", interrupted: false }, 5, 2)).toBe(
      "running",
    );
  });

  it("interrupted user → idle", () => {
    expect(fallbackState({ type: "user", interrupted: true }, 5, 2)).toBe(
      "idle",
    );
  });

  it("stale user → idle (guards against sticking on API errors or kills)", () => {
    expect(fallbackState({ type: "user", interrupted: false }, 120, 2)).toBe(
      "idle",
    );
  });

  it("assistant → idle", () => {
    expect(fallbackState({ type: "assistant", interrupted: false }, 5, 2)).toBe(
      "idle",
    );
  });

  it("no event → idle", () => {
    expect(fallbackState(null, 5, 2)).toBe("idle");
  });

  it("unknown mtime (no jsonl) → idle", () => {
    expect(fallbackState({ type: "user", interrupted: false }, null, 2)).toBe(
      "idle",
    );
  });

  it("freshness boundary: at poll=2, max(2×2,30)=30 seconds (30 is fresh / 31 is stale)", () => {
    const ev = { type: "user", interrupted: false } as const;
    expect(fallbackState(ev, 30, 2)).toBe("running");
    expect(fallbackState(ev, 31, 2)).toBe("idle");
  });

  it("freshness boundary: at poll=20, max(2×20,30)=40 seconds (40 is fresh / 41 is stale)", () => {
    const ev = { type: "user", interrupted: false } as const;
    expect(fallbackState(ev, 40, 20)).toBe("running");
    expect(fallbackState(ev, 41, 20)).toBe("idle");
  });

  it("treats an invalid poll (0/negative/NaN) as the default 2 seconds", () => {
    const ev = { type: "user", interrupted: false } as const;
    expect(fallbackState(ev, 30, 0)).toBe("running");
    expect(fallbackState(ev, 31, -1)).toBe("idle");
    expect(fallbackState(ev, 30, Number.NaN)).toBe("running");
  });
});

describe("subagentFreshWithinSec: mtime freshness threshold", () => {
  it("poll=2 gives max(2*2,30)=30 seconds", () => {
    expect(subagentFreshWithinSec(2)).toBe(30);
  });

  it("poll=20 gives max(2*20,30)=40 seconds", () => {
    expect(subagentFreshWithinSec(20)).toBe(40);
  });

  it("an invalid poll (0/negative/NaN) uses the default 2 seconds, giving 30 seconds", () => {
    expect(subagentFreshWithinSec(0)).toBe(30);
    expect(subagentFreshWithinSec(-1)).toBe(30);
    expect(subagentFreshWithinSec(Number.NaN)).toBe(30);
  });
});

describe("countRunningSubagents: counting running agents by mtime freshness", () => {
  it("counts only mtimes within the threshold as running", () => {
    expect(countRunningSubagents([1, 5, 29, 30], 30)).toBe(4);
    expect(countRunningSubagents([31, 60, 120], 30)).toBe(0);
  });

  it("boundary = exactly the threshold is fresh (<=), +1 is stale", () => {
    expect(countRunningSubagents([30, 31], 30)).toBe(1);
  });

  it("returns the total (the fresh portion of the array length) even with a mix of children, grandchildren, and great-grandchildren", () => {
    expect(countRunningSubagents([2, 3, 4, 100, 5], 30)).toBe(4);
  });

  it("an empty array is 0", () => {
    expect(countRunningSubagents([], 30)).toBe(0);
  });
});
