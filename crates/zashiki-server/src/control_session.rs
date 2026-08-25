use axum::extract::ws::WebSocket;

use crate::control::{fail_session_create, report_error, trigger_refresh, ControlServices};

/// Validates the org and creates a new session. Spawns an owned PTY and registers it. A `resume_sid` forks
/// that Claude session into the new terminal (duplicate); it is ignored unless it is a valid UUID.
pub(crate) async fn handle_session_new(
    socket: &mut WebSocket,
    services: &ControlServices,
    org: &str,
    resume_sid: Option<&str>,
) -> bool {
    // Resolve to an owned String before any await: the read guard must not be held across await points.
    let root = {
        let guard = services.repos.read().unwrap();
        let roots: Vec<&str> = guard.roots.iter().map(String::as_str).collect();
        zashiki_core::repos::org_root(org, &roots).map(str::to_string)
    };
    let Some(root) = root else {
        let message = format!("org {org} is not in repos.conf");
        return report_error(socket, &services.hub, "unknown_org", &message).await;
    };
    let name = basename(&root);
    let resume_sid = resume_sid.filter(|s| zashiki_core::save_file::is_uuid_sid(s));
    new_owned_session(socket, services, &root, &name, resume_sid).await
}

/// Spawns an owned PTY and registers it in `SessionRegistry` (owned mode). Since the PTY's command
/// itself is set to launch claude, no key injection is needed (the
/// canonical spec is `session_launch`'s tests).
async fn new_owned_session(
    socket: &mut WebSocket,
    services: &ControlServices,
    root: &str,
    name: &str,
    resume_sid: Option<&str>,
) -> bool {
    let sid = uuid::Uuid::new_v4().to_string();
    let shell = crate::session_restore::login_shell();
    // A missing cwd falls back to $HOME, and claude is resolved to an absolute path before launch to guard against a thin PATH.
    let cwd = crate::session_launch::resolve_cwd(root);
    let claude = crate::session_launch::resolve_program_path("claude");
    if services.launch_claude && claude.is_none() {
        services.hub.record_boundary_failure(
            crate::notifications::BoundaryFailure::ClaudeMissing,
            crate::now_ms(),
        );
    }
    let claude = claude.unwrap_or_else(|| "claude".to_string());
    let settings =
        crate::session_launch::account_usage_settings(services.hub.account_usage_enabled());
    let plan = crate::session_launch::plan_new_session(
        &sid,
        &cwd,
        name,
        services.launch_claude,
        resume_sid,
        &shell,
        &claude,
        settings.as_deref(),
    );
    match services
        .sessions
        .create_with_meta(
            plan.sid.clone(),
            crate::session_launch::plan_to_config(&plan),
            crate::session_launch::plan_to_meta(&plan),
        )
        .await
    {
        Ok(_) => {
            trigger_refresh(services).await;
            true
        }
        Err(err) => fail_session_create(socket, services, &err).await,
    }
}

/// The last segment of a path (org name / window name).
fn basename(path: &str) -> String {
    path.split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}
