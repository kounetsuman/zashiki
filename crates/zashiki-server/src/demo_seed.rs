//! Demo-sandbox seeding for `zashiki --demo` (gated by the `ZK_DEMO_SEED` env, whose value is the path
//! to a seed JSON written by the CLI). Seeds the [`SessionRegistry`] with state- and title-annotated
//! sessions **without ever launching real Claude**, so the org cockpit can be manually screen-recorded
//! (Screen Studio, etc.) for the README hero video / screenshots.
//!
//! How each state is produced (real Claude is never started):
//! - `running` / `waiting_input` / `idle` / `running_bg_agent`: a shell that prints a static claude-pane
//!   screen ([`demo_screen`]) and then blocks. Its `argv` carries `claude --session-id <uuid>` so the
//!   poller's process-tree scan ([`zashiki_core::process_tree`]) marks the pane claude-backed
//!   (`has_claude = true`); the printed screen text is what `detect_state` keys on for the state. A tiny
//!   transcript is written to the isolated `ZK_PROJECTS_ROOT` so the SESSION LIST shows the configured title.
//! - `no_claude`: a plain interactive login shell (no claude in the tree, no transcript, no title).
//!
//! Everything lives under the CLI-provided isolated temp dir, so real user data (`~/.zashiki` / `~/.claude`)
//! is never touched. The source of truth for the screen→state mapping is the `tests` below (each screen is
//! asserted to drive `detect_state` to its intended state, so the demo can't silently drift from detection).

use std::ffi::OsStr;
use std::path::Path;

use portable_pty::CommandBuilder;
use serde::Deserialize;
use uuid::Uuid;

use crate::jsonl::claude_project_dir_name;
use crate::pty_host::PtyConfig;
use crate::session_launch::{plan_new_session, plan_to_config, resolve_cwd};
use crate::session_registry::{SessionMeta, SessionRegistry};

/// The claude-session keepalive: render the screen once (from `$ZK_DEMO_SCREEN`), then block so the
/// process persists in the tree (keeping `has_claude = true`). Passing the screen via env (not argv)
/// keeps the multi-line text out of `ps`, so the single-line command stays parseable by the ps scanner.
const KEEPALIVE: &str = r#"printf '%s' "$ZK_DEMO_SCREEN"; while :; do sleep 86400; done"#;

/// A seeded session's state (the wire `SessionState` values the CLI/user writes in the seed JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DemoState {
    Running,
    WaitingInput,
    Idle,
    RunningBgAgent,
    NoClaude,
}

/// One seeded session: an absolute `cwd` (its basename is the repo, its parent the org), a display
/// `title` (shown in the SESSION LIST; ignored for `no_claude`), and the `state` to stage it in.
#[derive(Debug, Clone, Deserialize)]
pub struct DemoSession {
    pub cwd: String,
    #[serde(default)]
    pub title: String,
    pub state: DemoState,
}

/// The seed JSON the CLI writes and points `ZK_DEMO_SEED` at.
#[derive(Debug, Clone, Deserialize)]
pub struct DemoSeed {
    pub sessions: Vec<DemoSession>,
}

// The static claude-pane screens. Each is asserted against `detect_state` in the tests, so they are the
// spec for "what a demo session looks like". They stay within 80 columns (the default PTY width).
const RUNNING_SCREEN: &str = "⏺ Refactoring the checkout flow…\n\n✻ Cogitating… (esc to interrupt · ctrl+t · 12s · ↓ 2.3k tokens)\n\n╭────────────────────────────────────────────╮\n│ ❯                                          │\n╰────────────────────────────────────────────╯";

const WAITING_SCREEN: &str = "Do you want to proceed with the database migration?\n\n❯ 1. Yes\n  2. No, tell Claude what to do differently";

const IDLE_SCREEN: &str = "⏺ Done — all 42 tests pass.\n\n╭────────────────────────────────────────────╮\n│ ❯                                          │\n╰────────────────────────────────────────────╯\n  ? for shortcuts";

const BG_AGENT_SCREEN: &str = "⏺ Delegated the dependency audit to subagents.\n\n✻ Waiting for 1 background agent to finish…\n\n  ⏺ main\n  ◯ general-purpose  auditing the dependency graph  29s";

/// The static screen that drives `detect_state` to `state`, or `None` for `no_claude` (a plain shell).
pub fn demo_screen(state: DemoState) -> Option<&'static str> {
    match state {
        DemoState::Running => Some(RUNNING_SCREEN),
        DemoState::WaitingInput => Some(WAITING_SCREEN),
        DemoState::Idle => Some(IDLE_SCREEN),
        DemoState::RunningBgAgent => Some(BG_AGENT_SCREEN),
        DemoState::NoClaude => None,
    }
}

/// Reads and parses the seed JSON at `path` (the `ZK_DEMO_SEED` value). Errors are stringified for logging.
pub fn load_seed(path: &OsStr) -> Result<DemoSeed, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The repo label = the last non-empty path segment of `cwd` (its basename).
fn repo_name(cwd: &str) -> String {
    cwd.split('/').rfind(|s| !s.is_empty()).unwrap_or(cwd).to_string()
}

/// Builds the PTY config for a claude-backed demo session: a shell that prints `screen` and blocks,
/// with `claude --session-id <sid>` in its argv so the poller sees it as claude-backed.
fn claude_demo_config(shell: &str, screen: &str, sid: &str, cwd: &str) -> PtyConfig {
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-c");
    cmd.arg(KEEPALIVE);
    // The operands after the `-c` script become the process's positional params ($0, $1, …), so `ps`
    // shows `claude --session-id <sid>`. The script itself does not use them; they exist purely so the
    // process-tree scan tags this pane as claude-backed without a real Claude launch.
    cmd.arg("claude");
    cmd.arg("--session-id");
    cmd.arg(sid);
    cmd.env("ZK_DEMO_SCREEN", screen);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd);
    PtyConfig::new(cmd)
}

/// Writes a minimal transcript so the SESSION LIST title resolves to `title` and an idle pane stays idle.
/// The first line is the user utterance (→ `first_user_title`); the trailing assistant line makes the last
/// event non-user, so `fallback_state` leaves a hint-less idle pane as `idle` rather than rescuing to running.
fn write_demo_transcript(projects_root: &Path, cwd: &str, sid: &str, title: &str) {
    let dir = projects_root.join(claude_project_dir_name(cwd));
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let user = serde_json::json!({ "type": "user", "message": { "content": title } });
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": { "content": [{ "type": "text", "text": "ok" }] }
    });
    let body = format!("{user}\n{assistant}\n");
    let _ = std::fs::write(dir.join(format!("{sid}.jsonl")), body);
}

/// Seeds every session from `seed` into `registry`, returning how many were created. Claude-backed states
/// get a fresh UUID sid (keyed into the registry by that sid) plus a title transcript under `projects_root`;
/// `no_claude` gets a plain login shell keyed by a synthetic non-UUID id. Failures are skipped (best-effort).
pub async fn seed_demo_sessions(
    registry: &SessionRegistry,
    projects_root: &Path,
    shell: &str,
    seed: &DemoSeed,
) -> usize {
    let mut created = 0;
    for (i, session) in seed.sessions.iter().enumerate() {
        let cwd = resolve_cwd(&session.cwd);
        let wname = repo_name(&cwd);
        let meta = SessionMeta {
            cwd: cwd.clone(),
            wname: wname.clone(),
        };
        let (id, config) = match demo_screen(session.state) {
            Some(screen) => {
                let sid = Uuid::new_v4().to_string();
                write_demo_transcript(projects_root, &cwd, &sid, &session.title);
                (sid.clone(), claude_demo_config(shell, screen, &sid, &cwd))
            }
            None => {
                // A real, interactive login shell (intentional — the human can touch this pane during the
                // demo). It sources the user's shell rc, but only inside the isolated sandbox cwd; it never
                // writes real user data. no_claude comes from the empty process tree, so a UUID id (required
                // by windowIdSchema, else the client drops the whole state.sync) never reads as claude.
                let plan = plan_new_session(&format!("demo-shell-{i}"), &cwd, &wname, false, shell, "claude");
                (Uuid::new_v4().to_string(), plan_to_config(&plan))
            }
        };
        if registry.create_with_meta(id, config, meta).await.is_ok() {
            created += 1;
        }
    }
    created
}

#[cfg(test)]
mod tests {
    use super::*;
    use zashiki_core::session_state::{
        detect_state, DetectStateOptions, SessionState, DEFAULT_BG_AGENT_MARKER, DEFAULT_RUN_MARKER,
    };

    fn claude() -> DetectStateOptions<'static> {
        DetectStateOptions {
            has_claude: true,
            run_marker: None,
            bg_agent_marker: None,
        }
    }

    #[test]
    fn each_screen_drives_its_intended_state() {
        assert_eq!(
            detect_state(demo_screen(DemoState::Running).unwrap(), &claude()),
            SessionState::Running
        );
        assert_eq!(
            detect_state(demo_screen(DemoState::WaitingInput).unwrap(), &claude()),
            SessionState::WaitingInput
        );
        assert_eq!(
            detect_state(demo_screen(DemoState::Idle).unwrap(), &claude()),
            SessionState::Idle
        );
        assert_eq!(
            detect_state(demo_screen(DemoState::RunningBgAgent).unwrap(), &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn screens_carry_the_canonical_markers() {
        assert!(RUNNING_SCREEN.contains(DEFAULT_RUN_MARKER));
        assert!(BG_AGENT_SCREEN.contains("⏺ main"));
        assert!(BG_AGENT_SCREEN.contains(DEFAULT_BG_AGENT_MARKER));
    }

    #[test]
    fn no_claude_has_no_screen() {
        assert!(demo_screen(DemoState::NoClaude).is_none());
    }

    #[test]
    fn repo_name_is_the_basename() {
        assert_eq!(repo_name("/tmp/web-app/storefront"), "storefront");
        assert_eq!(repo_name("/tmp/web-app/storefront/"), "storefront");
        assert_eq!(repo_name("solo"), "solo");
    }

    #[test]
    fn load_seed_parses_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed.json");
        std::fs::write(
            &path,
            r#"{"sessions":[
                {"cwd":"/tmp/web-app/storefront","title":"Refactor checkout","state":"running"},
                {"cwd":"/tmp/api/gateway","state":"no_claude"}
            ]}"#,
        )
        .unwrap();
        let seed = load_seed(path.as_os_str()).unwrap();
        assert_eq!(seed.sessions.len(), 2);
        assert_eq!(seed.sessions[0].state, DemoState::Running);
        assert_eq!(seed.sessions[0].title, "Refactor checkout");
        assert_eq!(seed.sessions[1].state, DemoState::NoClaude);
        // title defaults to empty when omitted.
        assert_eq!(seed.sessions[1].title, "");
    }

    #[test]
    fn write_transcript_yields_the_title_and_keeps_idle_idle() {
        use crate::jsonl::{first_user_title, last_user_or_assistant_event};
        use zashiki_core::session_state::TranscriptKind;

        let dir = tempfile::tempdir().unwrap();
        let cwd = "/tmp/web-app/storefront";
        let sid = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
        write_demo_transcript(dir.path(), cwd, sid, "Refactor the checkout flow");
        let path = dir
            .path()
            .join(claude_project_dir_name(cwd))
            .join(format!("{sid}.jsonl"));
        let content = std::fs::read_to_string(path).unwrap();
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("Refactor the checkout flow")
        );
        // The last event is the assistant line → fallback_state keeps a hint-less pane idle.
        assert_eq!(
            last_user_or_assistant_event(&content).unwrap().kind,
            TranscriptKind::Assistant
        );
    }

    /// End-to-end: seed a mix of states, then drive the real poller (PTY capture + ps scan + transcript
    /// read) and assert each session lands in its state with its title and org, proving the fake-claude
    /// mechanism works without real Claude.
    #[cfg(unix)]
    #[tokio::test]
    async fn seeds_states_titles_and_orgs_end_to_end() {
        use std::collections::BTreeMap;
        use std::sync::Arc;
        use std::time::Duration;

        use crate::claude_projects::ClaudeProjectsAdapter;
        use crate::poller_ports_pty::PtyPollerPorts;
        use crate::status_poller::{PollConfig, StatusPoller};

        let tmp = tempfile::tempdir().unwrap();
        let org = tmp.path().join("web-app");
        let cwd = |repo: &str| org.join(repo).to_string_lossy().into_owned();
        for repo in ["storefront", "checkout", "gateway", "legacy"] {
            std::fs::create_dir_all(org.join(repo)).unwrap();
        }
        let projects = tmp.path().join("projects");

        let seed = DemoSeed {
            sessions: vec![
                DemoSession { cwd: cwd("storefront"), title: "Refactor checkout".into(), state: DemoState::Running },
                DemoSession { cwd: cwd("checkout"), title: "Approve migration".into(), state: DemoState::WaitingInput },
                DemoSession { cwd: cwd("gateway"), title: "Investigate flake".into(), state: DemoState::Idle },
                DemoSession { cwd: cwd("legacy"), title: "unused".into(), state: DemoState::NoClaude },
            ],
        };

        let registry = Arc::new(SessionRegistry::new());
        let shell = crate::session_restore::login_shell();
        let created = seed_demo_sessions(&registry, &projects, &shell, &seed).await;
        assert_eq!(created, 4);

        let ports = PtyPollerPorts::new(registry.clone(), ClaudeProjectsAdapter::new(projects.clone()));
        let config = PollConfig {
            repos_roots: vec![org.to_string_lossy().into_owned()],
            org_colors: BTreeMap::new(),
            poll_sec: 2.0,
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
        };
        let mut poller = StatusPoller::new();

        // The screens need a moment to render; poll until the three claude-backed states settle.
        let mut by_repo = std::collections::HashMap::new();
        let mut window_ids: Vec<String> = Vec::new();
        for _ in 0..50 {
            let (snap, _) = poller.evaluate(&ports, &config).await;
            window_ids = snap.sessions.iter().map(|s| s.window_id.clone()).collect();
            by_repo = snap
                .sessions
                .iter()
                .map(|s| (s.repo.clone(), (s.state.clone(), s.title.clone(), s.org.clone())))
                .collect::<std::collections::HashMap<_, _>>();
            let settled = matches!(by_repo.get("storefront"), Some((st, ..)) if st == "running")
                && matches!(by_repo.get("checkout"), Some((st, ..)) if st == "waiting_input")
                && matches!(by_repo.get("gateway"), Some((st, ..)) if st == "idle");
            if settled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        assert_eq!(by_repo["storefront"].0, "running");
        assert_eq!(by_repo["storefront"].1.as_deref(), Some("Refactor checkout"));
        assert_eq!(by_repo["storefront"].2, "web-app");
        assert_eq!(by_repo["checkout"].0, "waiting_input");
        assert_eq!(by_repo["gateway"].0, "idle");
        assert_eq!(by_repo["gateway"].1.as_deref(), Some("Investigate flake"));
        // no_claude is a plain shell: it carries no title (no transcript).
        assert!(by_repo.contains_key("legacy"));
        assert_eq!(by_repo["legacy"].1, None);

        // Every windowId must satisfy the wire windowIdSchema (a UUID here); a non-conforming id (e.g. the
        // no_claude shell) fails the client's zod parse and drops the entire state.sync, blanking the list.
        assert_eq!(window_ids.len(), 4);
        assert!(window_ids.iter().all(|w| Uuid::parse_str(w).is_ok()));

        registry.shutdown_all().await;
    }
}
