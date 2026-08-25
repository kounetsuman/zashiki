# zashiki Positioning (One-Pager)

The canonical source for the product's positioning, grounded in competitive GTM research on AI-cockpit peers (Conductor / Claude Squad / Sculptor / Vibe Kanban / Devin / Cursor, etc.) and the `marketing/` strategy set. All README, Show HN, and X copy follows this one-pager.

## In One Line

> **An AI cockpit that orchestrates parallel Claude Code sessions with the best possible UI/UX. It detects and notifies you of "which one is waiting" and lets you run everything from a single screen.**

## Persona (The One Person We Target)

A developer running 3–5 Claude Code sessions in parallel, unsure which one is waiting for a response, hopping between tabs and worn out by the constant checking. Heavy Claude Code users are the same crowd most likely to press the GitHub star button.

## The Core Pain

The category's biggest unsolved pain point is **overwhelm / observability**—"I can add more parallelism, but I can't tell which one to look at." zashiki specializes solely in this.

## Category Map (Where We Fight, Where We Don't)

- **Where we don't fight (the mainstream)**: "Run/isolate agents in parallel." This is occupied by Conductor (worktree), Sculptor (containers), and Devin (cloud)—a killing field fought over with capital and features, with heavy churn (Vibe Kanban sunset / Crystal rename / Terragon exit).
- **Where we fight (the niche)**: **After** you've launched them—**detecting, notifying, and giving an overview of** "which one is waiting for you." This space is thin. zashiki stands alongside the mainstream as a **complementary layer** ("You already run them in parallel. zashiki tells you which one needs you.").

## Differentiation (What Only zashiki Has)

1. **Detecting waits → notifying**: Not just lining up states, but a desktop notification the moment a session becomes waiting. Kills "babysitting / neglect."
2. **AI cockpit UI/UX**: Integrates the list, unified terminal, viewer, and notifications into a single screen, orchestrating Claude Code with the best possible ergonomics. An overview-focused experience that a hand-rolled multiplexing setup can't reach.
3. **Single-process PTY ownership**: The server solely owns the PTY and reconstructs it via vt100. No hand-rolled multiplexing setup required.

## Messaging

- **English hero**: *"Running several Claude Codes at once? Stop tab-hopping to find which one is waiting. zashiki is an AI cockpit that puts every session on one screen and pings you the moment one needs you."*
- **Japanese**: "Running Claude Code in parallel and losing track of which one is waiting for a response? zashiki lines up every session on one screen and notifies you the moment one starts waiting."
- **Shared vocabulary**: cockpit / riding the fleet (the category's vocabulary). Frame it as "eliminating unmanageable parallelism" rather than "adding more parallelism."

## What We Won't Do (Scope Boundaries)

- Don't chase competitors on the mainstream features of parallel execution and work isolation (be honest and show ⚠️ even in comparison tables).
- Don't invest in a polished standalone landing page yet. The foundation is GitHub README + demo GIF + Show HN. LP/brand investment is an amplification layer for **after** we can see hundreds of stars plus a team edition (the Linear model: pour design investment in all at once once the substance exists).

## Survival Conditions

In a high-churn category, **the specificity of the pain matters more than star count for survival**. Avoid turning into a multi-feature orchestrator and keep the specificity of "wait detection, notification, and single-screen orchestration with the best possible UI/UX" strong and concentrated.

## Rationale (Research Summary)

- The category's center of gravity is GitHub + Show HN + a one-liner led by the pain (Conductor's tagline *"Run a bunch of Claude Codes in parallel."*). Many high-scoring threads on HN, git worktrees are the de facto standard, and the vocabulary is cockpit / fleet / orchestra / squad / hive.
- The winning GTM pattern is hybrid (an OSS/community foundation + refined brand/social amplification). But amplification only works to the extent it is **subordinate** to the actual product (a former Warp PMM: "Developers aren't anti-marketing; ultimately they judge on the quality of the creative" / Linear reached $1.25B on ~$35k of cumulative paid ads).
- Cursor grew rapidly with almost no marketing—product plus word of mouth—corroborating that substance comes first.

> For detailed tactics, see the `marketing/` strategy set (A–G). This file focuses on the single question of "where to fight."
