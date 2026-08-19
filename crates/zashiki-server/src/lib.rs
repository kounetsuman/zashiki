//! A standalone Rust server that replaces the Node server (Phase A).
//!
//! Current state of this crate: the wire endpoints (`/healthz`, `token-probe`, `/api/fs/repos`) +
//! Host/Origin verification middleware + token auth for `/api/*` + static serving of the client dist + pure security functions.
//! Porting of git status/WS/PTY and the poller comes later. Not yet wired into Tauri (non-destructive).
//! The source of truth for the wire contract to preserve is `packages/shared/src/protocol.ts`.

pub mod claude_projects;
pub mod config;
pub mod control;
pub mod demo_seed;
pub mod file;
pub mod fs;
pub mod git;
pub mod hooks;
pub mod jsonl;
pub mod launchd;
pub mod mac_notifier;
pub mod notifications;
pub mod orphan_detector;
pub mod poller_driver;
pub mod poller_ports_pty;
pub mod protocol;
pub mod ps;
pub mod pty_host;
pub mod repos;
pub mod repos_watch;
pub mod runtime;
pub mod scrollback_monitor;
pub mod search;
pub mod session_launch;
pub mod session_persist;
pub mod session_registry;
pub mod session_restore;
pub mod session_status;
pub mod status_poller;
pub mod term_attach_pty;
pub mod token;
pub mod term_registry;
pub mod update_checker;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, Request, State, WebSocketUpgrade},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use crate::control::{ControlServices, RefreshRequest};
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

/// Editor launch for `POST /api/git/open` (injected so tests can replace it; equivalent to TS's openFile).
/// Arguments are (repoPath, file). Side-effect only; success/failure is ignored (TS likewise only checks spawn success and doesn't block).
pub type OpenFile = Arc<dyn Fn(String, String) + Send + Sync>;

/// Server configuration. Passed to `build_router` from tests and main.
#[derive(Default)]
pub struct ServerConfig {
    /// Expected token. If unset, token-required routes always return 401 (fail-safe).
    pub expected_token: Option<String>,
    /// Client dist (no static serving if None).
    pub client_dist: Option<PathBuf>,
    /// Path to repos.conf (if None, `/api/fs/repos` returns empty).
    pub repos_conf: Option<PathBuf>,
    /// Control services (if None, `/ws/control` is not wired = REST only).
    pub control: Option<ControlServices>,
    /// Editor command (ZK_EDITOR). Default `cursor -g` (TS DEFAULT_EDITOR).
    pub editor: Option<String>,
    /// Replacement for the `POST /api/git/open` editor launch (for test injection; spawns the editor if None).
    pub open_file: Option<OpenFile>,
    /// Maximum bytes per file for `/api/file` (for test injection; FILE_MAX_BYTES if None).
    pub file_max_bytes: Option<u64>,
    /// Destination for session save/restore (ZK_SAVES_DIR; `~/.zashiki/saves` if None).
    pub saves_dir: Option<PathBuf>,
}

/// Response for `GET /healthz`. Beyond `status`, it returns build identifiers (`version` / `git_sha`)
/// so the desktop shell can avoid piggybacking on a stale server.
#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    git_sha: &'static str,
    /// The pid of this server process. Lets a desktop that judged the server stale aim a precise
    /// SIGTERM at whoever holds the port (avoiding pid misidentification via lsof and hitting the wrong target).
    pid: u32,
}

/// Response for `GET /api/zk-shell/token-probe` (TS: `{ ok: true }`).
#[derive(Serialize)]
struct TokenProbeResponse {
    ok: bool,
}

/// Response for `GET /api/fs/repos` (TS: `FsReposResponse` in `packages/shared/src/fs-tree.ts`).
#[derive(Serialize)]
struct FsReposResponse {
    repos: Vec<FsRepo>,
}

#[derive(Serialize)]
struct FsRepo {
    org: String,
    repo: String,
    path: String,
}

/// TTL cache for repos.conf scan results. Reuses, for a short window, the FS walk that scan performs on
/// every file read/poll, explorer, git, and search request, killing the main cause of "Loading..." lingering for seconds.
/// Since the repo list rarely changes, this level of staleness causes no real harm to how the explorer etc. appear.
const SCAN_CACHE_TTL: Duration = Duration::from_secs(5);

/// The TTL cache body for scan (fetch time + scan results). `None` means not yet fetched.
type ScanCache = Arc<tokio::sync::Mutex<Option<(Instant, Vec<repos::ScannedRepo>)>>>;

#[derive(Clone)]
struct AppState {
    expected_token: Arc<Option<String>>,
    repos_conf: Arc<Option<PathBuf>>,
    control: Option<ControlServices>,
    editor: Arc<String>,
    open_file: Option<OpenFile>,
    file_max_bytes: u64,
    saves_dir: Arc<PathBuf>,
    /// Serializes save/restore (a series of destructive operations) within the server (equivalent to TS's `runPersistExclusive`).
    persist_lock: Arc<tokio::sync::Mutex<()>>,
    /// TTL cache for scan (the repos.conf walk).
    scan_cache: ScanCache,
}

/// Default destination for session save/restore (`~/.zashiki/saves`; matches TS's default).
/// The startup restore and shutdown save in main.rs use the same resolution.
pub fn default_saves_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".zashiki").join("saves")
}

/// Splits `ZK_EDITOR` into argv (whitespace-separated; quotes are not interpreted; TS `parseEditorCommand`).
fn parse_editor_command(editor: &str) -> Vec<String> {
    editor
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

/// Default editor launch (splits `ZK_EDITOR` into argv, appends `<file>` at the end, and spawns; does not wait for exit).
fn spawn_editor(editor: &str, repo_path: &str, file: &str) {
    let argv = parse_editor_command(editor);
    let Some((cmd, args)) = argv.split_first() else {
        return;
    };
    let abs = std::path::Path::new(repo_path).join(file);
    let _ = std::process::Command::new(cmd)
        .args(args)
        .arg(abs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// Builds the router. `/healthz` and static serving require no token, `/api/*` requires a token,
/// and Host/Origin verification applies to all routes.
pub fn build_router(config: ServerConfig) -> Router {
    let state = AppState {
        expected_token: Arc::new(config.expected_token),
        repos_conf: Arc::new(config.repos_conf),
        control: config.control,
        editor: Arc::new(config.editor.unwrap_or_else(|| "cursor -g".to_string())),
        open_file: config.open_file,
        file_max_bytes: config.file_max_bytes.unwrap_or(file::FILE_MAX_BYTES),
        saves_dir: Arc::new(config.saves_dir.unwrap_or_else(default_saves_dir)),
        persist_lock: Arc::new(tokio::sync::Mutex::new(())),
        scan_cache: Arc::new(tokio::sync::Mutex::new(None)),
    };

    // Token-required API group (/api/* has requireToken=true). `/ws/control` also requires a token.
    let mut authed_routes = Router::new()
        .route("/api/zk-shell/token-probe", get(token_probe))
        .route("/api/fs/repos", get(fs_repos))
        .route("/api/repos/add", post(repos_add))
        .route("/api/repos/list", get(repos_list))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/validate", get(fs_validate))
        .route("/api/fs/browse", get(fs_browse))
        .route("/api/git/status", get(git_status))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/open", post(git_open))
        .route("/api/git/stage-all", post(git_stage_all))
        .route("/api/git/unstage-all", post(git_unstage_all))
        .route("/api/git/commit", post(git_commit))
        // /api/file writes allow a larger body. TS passes maxBytes + 64KiB to parseBody
        // (content = max + slack for the JSON envelope). With axum's default 2MiB limit, a max-size
        // content would get a 413 at the transport layer, diverging from Node (200, or a content-based 413), so we align them.
        .route(
            "/api/file",
            get(file_read).post(file_write).layer(DefaultBodyLimit::max(
                (state.file_max_bytes + 64 * 1024) as usize,
            )),
        )
        .route("/api/search", post(search_route))
        .route("/api/sessions/save", post(sessions_save))
        .route("/api/sessions/restore", post(sessions_restore))
        .route("/api/hooks/event", post(hooks_event))
        .route("/api/focus", post(focus_session));
    if state.control.is_some() {
        authed_routes = authed_routes
            .route("/ws/control", get(ws_control))
            .route("/ws/term/:term_id", get(ws_term));
    }
    let authed = authed_routes
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state);

    let mut app = Router::new().route("/healthz", get(healthz)).merge(authed);

    if let Some(dist) = config.client_dist {
        // Serve GET / and extension-bearing assets from the client dist. No token required.
        app = app.fallback_service(ServeDir::new(dist).append_index_html_on_directories(true));
    }

    // Host/Origin verification applies to all routes, including static serving.
    // CORS sits outside that (the outermost layer). In dev, webview (localhost:5173) -> server (127.0.0.1:8790)
    // is cross-origin with x-zashiki-token (a non-safelisted header) = subject to preflight. Making CorsLayer
    // outermost handles OPTIONS ahead of token auth and host_origin_guard, so preflight isn't killed by 401/403.
    app.layer(middleware::from_fn(host_origin_guard))
        .layer(cors_layer())
}

/// A CORS layer that echoes Origin only for allowed origins (same check as `is_allowed_origin` = http(s) on the localhost family).
/// The wildcard `*` is not used because it is incompatible with Authorization/credentials.
fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _req| {
            origin
                .to_str()
                .map(|o| is_allowed_origin(Some(o)))
                .unwrap_or(false)
        }))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        // The client's authHeaders send x-zashiki-token (packages/client/src/lib/token.ts).
        // This is a non-safelisted header = it triggers preflight, so unless it's allowed, dev requests are blocked.
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-zashiki-token"),
        ])
}

/// No authentication (healthz requires no token).
async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        git_sha: env!("ZK_GIT_SHA"),
        pid: std::process::id(),
    })
}

/// token-probe. Since reaching here means it passed the auth middleware, it returns `{ ok: true }`.
async fn token_probe() -> Json<TokenProbeResponse> {
    Json(TokenProbeResponse { ok: true })
}

/// Upgrade for `/ws/control`. The token has already been handled by the require_token middleware.
async fn ws_control(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    match state.control.clone() {
        Some(services) => ws.on_upgrade(move |socket| control::handle_control(socket, services)),
        None => (StatusCode::NOT_FOUND, "control not available").into_response(),
    }
}

/// Upgrade for `/ws/term/<termId>`. If the termId was term.open'd, it is resolved in the registry and a PTY is attached
/// (unregistered ones get close 4404). The token has already been handled by the require_token middleware.
async fn ws_term(
    ws: WebSocketUpgrade,
    Path(term_id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    match state.control.clone() {
        Some(services) => ws
            .on_upgrade(move |socket| term_attach_pty::attach_owned_term(socket, term_id, services)),
        None => (StatusCode::NOT_FOUND, "control not available").into_response(),
    }
}

/// Scans repos.conf (run under spawn_blocking since it is blocking I/O). The result is reused only for the
/// duration of SCAN_CACHE_TTL (shared by file read/poll, explorer, git, and search to avoid an FS walk each time).
async fn scan(state: &AppState) -> Vec<repos::ScannedRepo> {
    let mut cache = state.scan_cache.lock().await;
    if let Some((at, repos)) = cache.as_ref() {
        if at.elapsed() < SCAN_CACHE_TTL {
            return repos.clone();
        }
    }
    let conf = state.repos_conf.as_ref().clone();
    let repos = tokio::task::spawn_blocking(move || match conf.as_deref() {
        Some(path) => repos::scan_repos(path),
        None => Vec::new(),
    })
    .await
    .unwrap_or_default();
    *cache = Some((Instant::now(), repos.clone()));
    repos
}

/// Response for `GET /api/repos/list` (TS: `ReposListResponse` in `packages/shared/src/repos-add.ts`).
#[derive(Serialize)]
struct ReposListResponse {
    orgs: Vec<OrgRootEntry>,
}

#[derive(Serialize)]
struct OrgRootEntry {
    org: String,
    path: String,
}

/// `GET /api/repos/list`. Lists the registered org roots from repos.conf as {org (root basename), path
/// (absolute)}, so the add-org modal can show what is already registered. Graceful (empty) when no conf.
async fn repos_list(State(state): State<AppState>) -> Json<ReposListResponse> {
    let conf = state.repos_conf.as_ref().clone();
    let roots = tokio::task::spawn_blocking(move || match conf.as_deref() {
        Some(path) => repos::read_repos_state(path).roots,
        None => Vec::new(),
    })
    .await
    .unwrap_or_default();
    let orgs = roots
        .into_iter()
        .filter_map(|path| {
            // Skip a degenerate root with no final segment (only `/`); its empty org would fail the
            // client's `org: min(1)` schema and blank the whole list.
            let org = std::path::Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())?;
            Some(OrgRootEntry { org, path })
        })
        .collect();
    Json(ReposListResponse { orgs })
}

/// All repos under repos.conf (org/repo/path).
async fn fs_repos(State(state): State<AppState>) -> Json<FsReposResponse> {
    let repos = scan(&state)
        .await
        .into_iter()
        .map(|r| FsRepo {
            org: r.org,
            repo: r.repo,
            path: r.path,
        })
        .collect();
    Json(FsReposResponse { repos })
}

/// git status for each repo (branch + staged/changed).
async fn git_status(State(state): State<AppState>) -> Json<git::GitStatusResponse> {
    let repos = git::git_status(scan(&state).await).await;
    Json(git::GitStatusResponse { repos })
}

// ---- git write REST + /api/file (ported from TS git-routes.ts / file-routes.ts) ----
//
// The error body is returned as `{"error": <msg>}` (JSON), same as TS's sendHttpError.

/// JSON error response of `{"error": msg}` (TS `sendHttpError`).
fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// JSON response of `{"ok": true}` (the success body of TS's stage/unstage/commit etc.).
fn json_ok() -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct AddRepoBody {
    path: String,
    color: Option<String>,
}

/// `POST /api/repos/add`. Registers a directory as a new org root: validates it, appends a line to
/// repos.conf (the path verbatim so `~` stays portable), then reloads the live repos state and nudges
/// the poller so the org appears in state.sync without a restart. Returns `{"org": <basename>}`.
async fn repos_add(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    // The error `code` is stable and localized by the client; the `error` string is a human-readable fallback.
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return json_error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "repos.conf path is not configured",
            "no_conf",
        );
    };
    let Ok(req) = serde_json::from_slice::<AddRepoBody>(&body) else {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "invalid request body",
            "invalid_body",
        );
    };
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "path must not be empty",
            "path_empty",
        );
    }
    if let Some(color) = req.color.as_deref() {
        if !repos::is_valid_color_token(color) {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "color must be a #rgb or #rrggbb token",
                "color_invalid",
            );
        }
    }
    let org = match repos::classify_add_path(&conf_path, &path) {
        repos::AddPathStatus::PathUnresolved => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path could not be resolved",
                "path_unresolved",
            );
        }
        repos::AddPathStatus::NotADirectory => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path is not an existing directory",
                "not_a_directory",
            );
        }
        repos::AddPathStatus::NoDirName => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path has no final directory name",
                "no_dir_name",
            );
        }
        repos::AddPathStatus::Duplicate => {
            return json_error_with_code(
                StatusCode::CONFLICT,
                "this path is already registered",
                "duplicate",
            );
        }
        repos::AddPathStatus::Ok(org) => org,
    };
    match repos::append_root_to_conf(&conf_path, &path, req.color.as_deref()) {
        Err(e) => {
            return json_error_with_code(
                StatusCode::INTERNAL_SERVER_ERROR,
                &e.to_string(),
                "io",
            )
        }
        Ok(repos::AddOutcome::Duplicate) => {
            return json_error_with_code(
                StatusCode::CONFLICT,
                "this path is already registered",
                "duplicate",
            );
        }
        Ok(repos::AddOutcome::Added(_)) => {}
    }
    // Reflect immediately: refresh the shared live set from the file, then re-evaluate the poller.
    if let Some(control) = &state.control {
        if let Ok(mut guard) = control.repos.write() {
            *guard = repos::read_repos_state(&conf_path);
        }
        let _ = control.refresh.send(RefreshRequest { reply: None }).await;
    }
    Json(serde_json::json!({ "org": org })).into_response()
}

// ---- session save/restore REST (the owned version of TS session-routes.ts) ----

#[derive(Deserialize)]
struct SessionsRestoreBody {
    file: Option<String>,
}

/// JSON error response of `{"error": msg, "code": code}` (TS session-routes also returns a `code` for
/// PersistError; unlike the git-side `json_error` that has `{error}` only, this is a persist-specific contract).
fn json_error_with_code(status: StatusCode, msg: &str, code: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": msg, "code": code })),
    )
        .into_response()
}

/// Maps `session_persist::PersistError` to an HTTP status + `code` (TS `PERSIST_ERROR_STATUS`).
fn persist_error_response(err: session_persist::PersistError) -> Response {
    use session_persist::PersistError::{Io, RestoreEmpty, RestoreFileNotFound, SaveEmpty};
    match err {
        SaveEmpty => json_error_with_code(
            StatusCode::CONFLICT,
            "no running claude session was found to save",
            "save_empty",
        ),
        RestoreFileNotFound(path) => json_error_with_code(
            StatusCode::NOT_FOUND,
            &format!("save file not found: {path}"),
            "restore_file_not_found",
        ),
        RestoreEmpty(path) => json_error_with_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("save file has no restorable entry: {path}"),
            "restore_empty",
        ),
        // TS also uses `sendHttpError` for 500 (no code).
        Io(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `POST /api/sessions/save`. Saves all claude sessions in the owned registry to last.tsv + a backup.
async fn sessions_save(State(state): State<AppState>) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    let _guard = state.persist_lock.lock().await;
    match session_persist::save_sessions(&control.sessions, state.saves_dir.as_path()).await {
        Ok(out) => Json(serde_json::json!({
            "saved": out.saved,
            "skipped": out.skipped,
            "path": out.path,
        }))
        .into_response(),
        Err(e) => persist_error_response(e),
    }
}

/// `POST /api/sessions/restore`. Rebuilds the owned registry from a save (destructive operations are serialized via persist_lock).
async fn sessions_restore(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    let parsed: SessionsRestoreBody = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };
    if let Some(file) = &parsed.file {
        if !session_persist::is_valid_save_filename(file) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "file must be a plain file name in saves/",
            );
        }
    }
    let shell = crate::session_restore::login_shell();
    let _guard = state.persist_lock.lock().await;
    match session_persist::restore_sessions(
        &control.sessions,
        state.saves_dir.as_path(),
        parsed.file.as_deref(),
        control.launch_claude,
        &shell,
    )
    .await
    {
        Ok(out) => Json(serde_json::json!({
            "restored": out.restored,
            "warnings": out.warnings,
            "backupPath": out.backup_path,
        }))
        .into_response(),
        Err(e) => persist_error_response(e),
    }
}

// ---- Claude Code hooks intake REST (the owned version of TS hooks-routes.ts) ----

/// Requests an immediate re-evaluation from the poller and receives the post-evaluation snapshot (None on no response =
/// TS's `poller.refresh().catch(()=>null)`). Used for the mac notification body (session title).
async fn hooks_refresh(control: &ControlServices) -> Option<crate::status_poller::StateSnapshot> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if control
        .refresh
        .send(crate::control::RefreshRequest { reply: Some(tx) })
        .await
        .is_err()
    {
        return None;
    }
    rx.await.ok()
}

/// Resolves the window for a hook event / focus request from the work window list and the ps snapshot.
/// The window is derived from the owned PTY's SessionRegistry.
async fn hooks_resolve(
    control: &ControlServices,
    sid: Option<&str>,
    cwd: Option<&str>,
) -> Option<hooks::ResolvedWindow> {
    let windows = crate::poller_ports_pty::owned_work_windows(&control.sessions).await;
    let ps = crate::ps::PsAdapter.snapshot().await;
    hooks::resolve_window(sid, cwd, &windows, &ps)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `POST /api/hooks/event`. refresh -> window resolution -> delivery (notify push / macOS) / accumulation / git.dirty.
/// Does not return 500 even if the window can't be resolved (the hook side is fire-and-forget).
async fn hooks_event(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "control not available");
    };
    let req: crate::protocol::HookEventRequest = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };

    let snap = hooks_refresh(control).await;
    let resolved = match req.kind {
        crate::protocol::HookKind::Waiting | crate::protocol::HookKind::Done => {
            hooks_resolve(control, req.sid.as_deref(), req.cwd.as_deref()).await
        }
        _ => None,
    };
    let snap_title = resolved.as_ref().and_then(|r| {
        snap.as_ref()?
            .sessions
            .iter()
            .find(|s| s.window_id == r.window_id)
            .and_then(|s| s.title.clone())
    });
    let actions = hooks::decide(
        req.kind,
        resolved.as_ref(),
        control.notify_mode,
        control.hub.client_count(),
        snap_title,
    );

    if actions.git_dirty {
        control.hub.broadcast(crate::protocol::ServerMessage::GitDirty);
    }
    if let Some((kind, name)) = actions.record {
        control
            .hub
            .record_activity(uuid::Uuid::new_v4().to_string(), kind, &name, now_ms());
    }
    if let Some((kind, window_id, title)) = actions.push {
        control.hub.broadcast(crate::protocol::ServerMessage::Notify {
            kind,
            window_id,
            title,
        });
    }
    if let Some(mac) = actions.mac {
        (control.mac_notify)(mac);
    }

    Json(crate::protocol::HookEventResponse {
        ok: true,
        matched: actions.matched,
    })
    .into_response()
}

/// `POST /api/focus`. Resolves the window (sid then cwd) and broadcasts a `select` so an
/// already-connected app brings that session to the front. The response reports whether it
/// resolved (and to which window) so the caller can decide how to raise the native window.
async fn focus_session(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "control not available");
    };
    let req: crate::protocol::FocusRequest = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };

    let window_id = hooks_resolve(control, req.sid.as_deref(), req.cwd.as_deref())
        .await
        .map(|r| r.window_id);
    if let Some(window_id) = window_id.clone() {
        control
            .hub
            .broadcast(crate::protocol::ServerMessage::Select { window_id });
    }

    Json(crate::protocol::FocusResponse {
        resolved: window_id.is_some(),
        window_id,
    })
    .into_response()
}

#[derive(Deserialize)]
struct GitFileBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    file: Option<String>,
}

#[derive(Deserialize)]
struct GitRepoBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
}

#[derive(Deserialize)]
struct GitCommitBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    message: Option<String>,
}

/// Shared 400 error (`(status, msg)` is mapped to `json_error` at the handler boundary; keeps Err small).
type GuardErr = (StatusCode, String);

fn bad(msg: &str) -> GuardErr {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

/// bytes to JSON. An empty body is treated as `{}` (TS `parseBody`). Failure is 400 `invalid JSON body`.
fn parse_json_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, GuardErr> {
    let trimmed = std::str::from_utf8(body).unwrap_or("").trim();
    let value: serde_json::Value = if trimmed.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(trimmed).map_err(|_| bad("invalid JSON body"))?
    };
    serde_json::from_value(value).map_err(|_| bad("request failed schema validation"))
}

/// Whether repoPath is in the scanned list (TS `isAllowedRepo`; judged by the scan at each request).
async fn is_allowed_repo(state: &AppState, repo_path: &str) -> bool {
    scan(state).await.iter().any(|r| r.path == repo_path)
}

/// Shared guard for file actions (stage/unstage/open). Order: schema -> safe path -> repo allowlist.
/// The first half of TS `handleFileAction` (open additionally calls realpath verification).
async fn guard_file_action(state: &AppState, body: &[u8]) -> Result<(String, String), GuardErr> {
    let parsed: GitFileBody = parse_json_body(body)?;
    // gitFileRequestSchema: repoPath.min(1) / file.min(1). Empty or missing is a schema violation.
    let (Some(repo_path), Some(file)) = (parsed.repo_path, parsed.file) else {
        return Err(bad("request failed schema validation"));
    };
    if repo_path.is_empty() || file.is_empty() {
        return Err(bad("request failed schema validation"));
    }
    if !zashiki_core::git::is_safe_repo_relative_path(&file) {
        return Err(bad("unsafe file path"));
    }
    if !is_allowed_repo(state, &repo_path).await {
        return Err(forbidden_repo());
    }
    Ok((repo_path, file))
}

fn forbidden_repo() -> GuardErr {
    (
        StatusCode::FORBIDDEN,
        "repoPath is not in the scanned repo list".to_string(),
    )
}

/// repoPath allowlist guard for repo actions (stage-all/unstage-all/commit).
async fn guard_repo(state: &AppState, repo_path: &str) -> Result<(), GuardErr> {
    if !is_allowed_repo(state, repo_path).await {
        return Err(forbidden_repo());
    }
    Ok(())
}

/// Maps a git mutation result to 200 `{ok:true}` / 500 `{error}` (TS: failures become 500 in the route's catch).
fn git_result(result: Result<(), git::GitError>) -> Response {
    match result {
        Ok(()) => json_ok(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn git_stage(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    match guard_file_action(&state, &body).await {
        Err((status, msg)) => json_error(status, &msg),
        Ok((repo_path, file)) => {
            git_result(git::stage(std::path::Path::new(&repo_path), &file).await)
        }
    }
}

async fn git_unstage(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    match guard_file_action(&state, &body).await {
        Err((status, msg)) => json_error(status, &msg),
        Ok((repo_path, file)) => {
            git_result(git::unstage(std::path::Path::new(&repo_path), &file).await)
        }
    }
}

async fn git_open(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let (repo_path, file) = match guard_file_action(&state, &body).await {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    // open only: reject deleted files and symlinks pointing outside the repo (blocking canonicalize runs under spawn_blocking).
    let (rp, f) = (repo_path.clone(), file.clone());
    let rejected = tokio::task::spawn_blocking(move || git::reject_open_target(&rp, &f))
        .await
        .unwrap_or(None);
    if let Some((status, msg)) = rejected {
        return json_error(status, &msg);
    }
    match state.open_file.clone() {
        Some(open) => open(repo_path, file),
        None => spawn_editor(&state.editor, &repo_path, &file),
    }
    json_ok()
}

async fn git_stage_all(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: GitRepoBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    let repo_path = match parsed.repo_path.filter(|p| !p.is_empty()) {
        None => return json_error(StatusCode::BAD_REQUEST, "request failed schema validation"),
        Some(p) => p,
    };
    if let Err((status, msg)) = guard_repo(&state, &repo_path).await {
        return json_error(status, &msg);
    }
    git_result(git::stage_all(std::path::Path::new(&repo_path)).await)
}

async fn git_unstage_all(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: GitRepoBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    let repo_path = match parsed.repo_path.filter(|p| !p.is_empty()) {
        None => return json_error(StatusCode::BAD_REQUEST, "request failed schema validation"),
        Some(p) => p,
    };
    if let Err((status, msg)) = guard_repo(&state, &repo_path).await {
        return json_error(status, &msg);
    }
    git_result(git::unstage_all(std::path::Path::new(&repo_path)).await)
}

async fn git_commit(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: GitCommitBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    // gitCommitRequestSchema: repoPath.min(1) / message uses isValidCommitMessage (rejects whitespace-only).
    let (Some(repo_path), Some(message)) = (parsed.repo_path, parsed.message) else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if repo_path.is_empty() || !zashiki_core::git::is_valid_commit_message(&message) {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    }
    if let Err((status, msg)) = guard_repo(&state, &repo_path).await {
        return json_error(status, &msg);
    }
    let path = std::path::Path::new(&repo_path);
    if !git::has_staged(path).await {
        return json_error(StatusCode::CONFLICT, "nothing staged to commit");
    }
    git_result(git::commit(path, &message).await)
}

#[derive(Deserialize)]
struct FileReadParams {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    file: Option<String>,
}

/// Allowlist + safe-path guard for `/api/file` (the first half of TS `guardedAbs`; from realpath onward it's file.rs).
async fn guard_file_path(state: &AppState, repo_path: &str, file: &str) -> Result<(), GuardErr> {
    if repo_path.is_empty() || file.is_empty() {
        return Err(bad("repoPath and file are required"));
    }
    if !zashiki_core::git::is_safe_repo_relative_path(file) {
        return Err(bad("unsafe file path"));
    }
    if !is_allowed_repo(state, repo_path).await {
        return Err(forbidden_repo());
    }
    Ok(())
}

async fn file_read(State(state): State<AppState>, Query(params): Query<FileReadParams>) -> Response {
    let repo_path = params.repo_path.unwrap_or_default();
    let file = params.file.unwrap_or_default();
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &file).await {
        return json_error(status, &msg);
    }
    let max = state.file_max_bytes;
    let result = tokio::task::spawn_blocking(move || file::read_within_repo(&repo_path, &file, max))
        .await
        .unwrap_or_else(|_| {
            Err((StatusCode::INTERNAL_SERVER_ERROR, "read task failed".to_string()))
        });
    match result {
        Ok(content) => Json(serde_json::json!({ "content": content })).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[derive(Deserialize)]
struct FileWriteBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    file: Option<String>,
    content: Option<String>,
}

async fn file_write(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: FileWriteBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    // fileWriteRequestSchema: repoPath.min(1) / file.min(1) / content: string.
    let (Some(repo_path), Some(file), Some(content)) =
        (parsed.repo_path, parsed.file, parsed.content)
    else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if repo_path.is_empty() || file.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    }
    if content.len() as u64 > state.file_max_bytes {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "content too large to save");
    }
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &file).await {
        return json_error(status, &msg);
    }
    let result =
        tokio::task::spawn_blocking(move || file::write_within_repo(&repo_path, &file, &content))
            .await
            .unwrap_or_else(|_| {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "write task failed".to_string(),
                ))
            });
    match result {
        Ok(()) => json_ok(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

/// Cross-repo text search (runs ripgrep in a single process across all scanned repos).
async fn search_route(
    State(state): State<AppState>,
    Json(req): Json<search::SearchRequest>,
) -> Response {
    if req.query.is_empty() {
        return (StatusCode::BAD_REQUEST, "query is required").into_response();
    }
    let roots: Vec<search::ScannedRoot> = scan(&state)
        .await
        .into_iter()
        .map(|r| search::ScannedRoot {
            org: r.org,
            repo: r.repo,
            path: r.path,
        })
        .collect();
    let paths: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
    let args = search::build_rg_args(&req, &search::DEFAULT_SEARCH_LIMITS);
    match search::run_ripgrep(&args, &paths).await {
        Ok(stdout) => Json(search::parse_rg_json(
            &stdout,
            &roots,
            &search::DEFAULT_SEARCH_LIMITS,
        ))
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "ripgrep unavailable").into_response(),
    }
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    dir: Option<String>,
}

/// Lists the immediate children of a directory within a repo. repoPath must be in the scanned list, and
/// dir is confined by is_safe_repo_relative_path + realpath containment to block escaping outside the repo.
async fn fs_list(State(state): State<AppState>, Query(params): Query<ListParams>) -> Response {
    let repo_path = params.repo_path.unwrap_or_default();
    let dir = params.dir.unwrap_or_default();
    if repo_path.is_empty() {
        return (StatusCode::BAD_REQUEST, "repoPath is required").into_response();
    }
    // dir="" is the repo root. Since is_safe_repo_relative_path rejects "", allow it first.
    if !dir.is_empty() && !zashiki_core::git::is_safe_repo_relative_path(&dir) {
        return (StatusCode::BAD_REQUEST, "unsafe dir path").into_response();
    }
    if !scan(&state).await.iter().any(|r| r.path == repo_path) {
        return (
            StatusCode::FORBIDDEN,
            "repoPath is not in the scanned repo list",
        )
            .into_response();
    }
    let result = tokio::task::spawn_blocking(move || {
        fs::list_within_repo(&repo_path, &dir, fs::DEFAULT_ENTRY_LIMIT)
    })
    .await
    .unwrap_or_else(|_| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "list task failed".to_string(),
        ))
    });
    match result {
        Ok((entries, truncated)) => Json(fs::FsListResponse { entries, truncated }).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

#[derive(Deserialize)]
struct ValidateParams {
    path: Option<String>,
}

/// `GET /api/fs/validate`. Previews whether `path` could be added as an org root, using the same
/// `classify_add_path` as `POST /api/repos/add` so the modal's inline hint never disagrees with the add.
/// Never enumerates a directory — it only reports the single path's status (and org name on `ok`).
async fn fs_validate(
    State(state): State<AppState>,
    Query(params): Query<ValidateParams>,
) -> Response {
    let path = params.path.unwrap_or_default().trim().to_string();
    if path.is_empty() {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "path must not be empty",
            "path_empty",
        );
    }
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return json_error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "repos.conf path is not configured",
            "no_conf",
        );
    };
    let Ok(status) =
        tokio::task::spawn_blocking(move || repos::classify_add_path(&conf_path, &path)).await
    else {
        return json_error_with_code(
            StatusCode::INTERNAL_SERVER_ERROR,
            "validate task failed",
            "io",
        );
    };
    let (code, org) = match status {
        repos::AddPathStatus::Ok(org) => ("ok", Some(org)),
        repos::AddPathStatus::PathUnresolved => ("path_unresolved", None),
        repos::AddPathStatus::NotADirectory => ("not_a_directory", None),
        repos::AddPathStatus::NoDirName => ("no_dir_name", None),
        repos::AddPathStatus::Duplicate => ("duplicate", None),
    };
    // Omit `org` (rather than null) when absent, so the client's `.optional()` schema accepts it.
    let mut body = serde_json::json!({ "status": code });
    if let Some(org) = org {
        body["org"] = serde_json::Value::String(org);
    }
    Json(body).into_response()
}

#[derive(Deserialize)]
struct BrowseParams {
    path: Option<String>,
}

/// `GET /api/fs/browse`. Directory-completion for the org-add input: lists the subdirectories of the
/// parent of the in-progress `path` whose names start with the typed segment. Enumeration is confined to
/// `browse_roots` (HOME + parents of registered roots); an empty/`/`-less input lists nothing.
async fn fs_browse(State(state): State<AppState>, Query(params): Query<BrowseParams>) -> Response {
    let (parent_input, prefix) = fs::split_parent_prefix(params.path.unwrap_or_default().trim());
    let empty = Json(fs::FsListResponse {
        entries: Vec::new(),
        truncated: false,
    });
    if parent_input.is_empty() {
        return empty.into_response();
    }
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return empty.into_response();
    };
    let Some(parent_abs) = repos::resolve_conf_path(&parent_input) else {
        return (StatusCode::BAD_REQUEST, "path could not be resolved").into_response();
    };
    let result = tokio::task::spawn_blocking(move || {
        let roots = repos::browse_roots(&conf_path);
        fs::browse_dirs(&parent_abs, &roots, &prefix, fs::DEFAULT_ENTRY_LIMIT)
    })
    .await
    .unwrap_or_else(|_| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "browse task failed".to_string(),
        ))
    });
    match result {
        Ok((entries, truncated)) => Json(fs::FsListResponse { entries, truncated }).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

/// Guard for token-required routes. Passes if either the query ?token= or x-zashiki-token matches.
async fn require_token(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let header = req
        .headers()
        .get("x-zashiki-token")
        .and_then(|v| v.to_str().ok());
    let query_token = token_from_query(req.uri().query());
    let ok = match state.expected_token.as_deref() {
        Some(expected) if !expected.is_empty() => {
            token_matches(query_token, expected) || token_matches(header, expected)
        }
        _ => false,
    };
    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

/// Verifies Host/Origin and rejects anything outside the localhost family with 403 (all routes, including static serving).
async fn host_origin_guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    if !is_allowed_host(host) {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !is_allowed_origin(origin) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    next.run(req).await
}

// ---- Pure security functions (ported from TS packages/server/src/security.ts) ----

const ALLOWED_HOSTNAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

fn is_allowed_hostname(hostname: &str) -> bool {
    ALLOWED_HOSTNAMES
        .iter()
        .any(|h| hostname.eq_ignore_ascii_case(h))
}

/// Whether it is `:` followed by only one or more digits (the suffix part of `(:\d+)?`).
fn is_port_suffix(s: &str) -> bool {
    matches!(s.strip_prefix(':'), Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Extracts the hostname from an authority (`host[:port]`). Equivalent to TS's Host regex
/// `/^(\[[^\]]+\]|[^:]+)(:\d+)?$/`, it accepts only a bracketed IPv6 or a colon-free host + an optional `:port`,
/// and returns None if there is extra content after `]` or at the port position (host/origin share the same rule).
fn hostname_of_authority(authority: &str) -> Option<&str> {
    if authority.is_empty() {
        return None;
    }
    if authority.starts_with('[') {
        // \[[^\]]+\] then optional :\d+
        let end = authority.find(']').filter(|&i| i > 1)?;
        let suffix = &authority[end + 1..];
        if !suffix.is_empty() && !is_port_suffix(suffix) {
            return None;
        }
        Some(&authority[..=end])
    } else {
        // [^:]+ then optional :\d+
        match authority.find(':') {
            None => Some(authority),
            Some(0) => None,
            Some(i) => {
                if !is_port_suffix(&authority[i..]) {
                    return None;
                }
                Some(&authority[..i])
            }
        }
    }
}

/// Host header verification (rejects anything outside the localhost family = DNS rebinding).
pub fn is_allowed_host(host: Option<&str>) -> bool {
    match host.and_then(hostname_of_authority) {
        Some(hostname) => is_allowed_hostname(hostname),
        None => false,
    }
}

/// Origin header verification (absent is allowed; if present, only http(s) on the localhost family).
/// TS uses `new URL(origin)`, but since an origin is the simple form `scheme://host[:port]`, we decompose it by hand.
/// Host extraction uses the same `hostname_of_authority` as `is_allowed_host` to keep the check consistent.
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    match hostname_of_authority(authority) {
        Some(hostname) => is_allowed_hostname(hostname),
        None => false,
    }
}

/// Extracts the first non-empty `token=` value from the query string (after `?`).
pub fn token_from_query(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .filter(|t| !t.is_empty())
}

/// Timing-attack-resistant token comparison (TS `tokenMatches`; length mismatch or None is false).
pub fn token_matches(provided: Option<&str>, expected: &str) -> bool {
    match provided {
        None => false,
        Some(p) => constant_time_eq(p.as_bytes(), expected.as_bytes()),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    async fn request(
        app: Router,
        uri: &str,
        host: Option<&str>,
        extra: &[(&str, &str)],
    ) -> (StatusCode, String) {
        let mut builder = HttpRequest::builder().uri(uri);
        if let Some(h) = host {
            builder = builder.header("host", h);
        }
        for (k, v) in extra {
            builder = builder.header(*k, *v);
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn router(token: Option<&str>) -> Router {
        build_router(ServerConfig {
            expected_token: token.map(str::to_string),
            ..Default::default()
        })
    }

    /// Requests with the given method + arbitrary headers, and returns the status and the selected response headers (None if absent).
    async fn request_full(
        app: Router,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        want: &[&str],
    ) -> (StatusCode, Vec<Option<String>>) {
        let mut builder = HttpRequest::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let picked = want
            .iter()
            .map(|name| {
                resp.headers()
                    .get(*name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            })
            .collect();
        (status, picked)
    }

    const ACAO: &str = "access-control-allow-origin";
    const ACAM: &str = "access-control-allow-methods";
    const ACAH: &str = "access-control-allow-headers";

    #[tokio::test]
    async fn cors_echoes_acao_for_allowed_origin() {
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "GET",
            "/healthz",
            &[("host", OK_HOST), ("origin", "http://localhost:5173")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(hs[0].as_deref(), Some("http://localhost:5173"));
    }

    #[tokio::test]
    async fn cors_omits_acao_for_disallowed_origin() {
        // A disallowed origin gets 403 from host_origin_guard. ACAO is not added either (the browser blocks it).
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "GET",
            "/healthz",
            &[("host", OK_HOST), ("origin", "http://evil.example")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(hs[0], None);
    }

    #[tokio::test]
    async fn cors_preflight_passes_without_token_and_returns_headers() {
        // preflight (OPTIONS) has no Authorization. Even on a token-required route it passes with 2xx before auth,
        // returning the required CORS headers (ACAO echo / methods / headers).
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "OPTIONS",
            "/api/git/status",
            &[
                ("host", OK_HOST),
                ("origin", "http://localhost:5173"),
                ("access-control-request-method", "GET"),
                // The auth header the client actually sends (token.ts's authHeaders).
                ("access-control-request-headers", "x-zashiki-token"),
            ],
            &[ACAO, ACAM, ACAH],
        )
        .await;
        assert!(status.is_success(), "preflight status = {status}");
        assert_eq!(hs[0].as_deref(), Some("http://localhost:5173"));
        let methods = hs[1].as_deref().unwrap_or("").to_ascii_uppercase();
        assert!(methods.contains("GET"), "methods = {methods:?}");
        assert!(methods.contains("POST"), "methods = {methods:?}");
        assert!(methods.contains("OPTIONS"), "methods = {methods:?}");
        let allow_headers = hs[2].as_deref().unwrap_or("").to_ascii_lowercase();
        assert!(allow_headers.contains("authorization"), "headers = {allow_headers:?}");
        assert!(allow_headers.contains("content-type"), "headers = {allow_headers:?}");
        // Unless the client's x-zashiki-token is allowed, the dev preflight is blocked by the browser.
        assert!(allow_headers.contains("x-zashiki-token"), "headers = {allow_headers:?}");
    }

    #[tokio::test]
    async fn cors_preflight_does_not_leak_to_disallowed_origin() {
        let (_status, hs) = request_full(
            router(Some("s3cret")),
            "OPTIONS",
            "/api/git/status",
            &[
                ("host", OK_HOST),
                ("origin", "http://evil.example"),
                ("access-control-request-method", "GET"),
            ],
            &[ACAO],
        )
        .await;
        assert_eq!(hs[0], None);
    }

    #[tokio::test]
    async fn token_auth_still_enforced_on_real_request_with_origin() {
        // Even after adding CORS, token auth on real GETs still holds (with an Origin but no token, it's 401).
        let (status, _) = request_full(
            router(Some("s3cret")),
            "GET",
            "/api/git/status",
            &[("host", OK_HOST), ("origin", "http://localhost:5173")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn healthz_returns_ok_json_without_auth() {
        let (status, body) = request(router(None), "/healthz", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#""status":"ok""#), "body={body}");
    }

    #[tokio::test]
    async fn healthz_carries_build_identifiers_for_stale_detection() {
        // Material for the desktop to distinguish a stale server. Since the values themselves are
        // determined at build time, we only hold the presence and non-emptiness of the keys as the contract.
        let (_status, body) = request(router(None), "/healthz", Some(OK_HOST), &[]).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("healthz is JSON");
        assert_eq!(v["status"], "ok");
        assert!(v["version"].as_str().is_some_and(|s| !s.is_empty()), "body={body}");
        assert!(v["git_sha"].as_str().is_some_and(|s| !s.is_empty()), "body={body}");
        assert!(v["pid"].as_u64().is_some_and(|p| p > 0), "body={body}");
    }

    #[tokio::test]
    async fn token_probe_accepts_valid_token_via_query_and_header() {
        let app = router(Some("s3cret"));
        let (s1, b1) = request(
            app.clone(),
            "/api/zk-shell/token-probe?token=s3cret",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(b1, r#"{"ok":true}"#);

        let (s2, _) = request(
            app,
            "/api/zk-shell/token-probe",
            Some(OK_HOST),
            &[("x-zashiki-token", "s3cret")],
        )
        .await;
        assert_eq!(s2, StatusCode::OK);
    }

    #[tokio::test]
    async fn api_requires_token() {
        let app = router(Some("s3cret"));
        // Wrong token or no token is 401
        let (s1, _) = request(
            app.clone(),
            "/api/zk-shell/token-probe?token=nope",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s1, StatusCode::UNAUTHORIZED);
        let (s2, _) = request(app, "/api/fs/repos", Some(OK_HOST), &[]).await;
        assert_eq!(s2, StatusCode::UNAUTHORIZED);
        // Always 401 if no token is configured
        let (s3, _) = request(
            router(None),
            "/api/fs/repos?token=anything",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s3, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn fs_repos_returns_scanned_repos_as_json() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("org1/repo-a/.git")).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", root.path().join("org1").display())).unwrap();

        let app = build_router(ServerConfig {
            expected_token: Some("s3cret".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let (status, body) = request(app, "/api/fs/repos?token=s3cret", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        let expected_path = root.path().join("org1/repo-a");
        assert_eq!(
            body,
            format!(
                r#"{{"repos":[{{"org":"org1","repo":"repo-a","path":"{}"}}]}}"#,
                expected_path.display()
            )
        );
    }

    #[tokio::test]
    async fn fs_list_lists_dir_and_enforces_repo_allowlist_and_safe_dir() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("org1/repo-a");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("README.md"), "r").unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", root.path().join("org1").display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let repo_path = repo.to_string_lossy().into_owned();

        // Normal: dir-first sort gives src(dir) -> README.md(file), and .git is excluded.
        let (status, body) = request(
            app.clone(),
            &format!("/api/fs/list?token=t&repoPath={repo_path}"),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            r#"{"entries":[{"name":"src","kind":"dir"},{"name":"README.md","kind":"file"}],"truncated":false}"#
        );

        // A repoPath outside the allowlist is 403
        let (s403, _) = request(
            app.clone(),
            "/api/fs/list?token=t&repoPath=/tmp/not-scanned",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s403, StatusCode::FORBIDDEN);

        // A dangerous dir (..) is 400
        let (s400, _) = request(
            app.clone(),
            &format!("/api/fs/list?token=t&repoPath={repo_path}&dir=../escape"),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s400, StatusCode::BAD_REQUEST);

        // Missing repoPath is 400, no token is 401
        let (s_req, _) = request(app.clone(), "/api/fs/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s_req, StatusCode::BAD_REQUEST);
        let (s401, _) = request(app, "/api/fs/list", Some(OK_HOST), &[]).await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn repos_list_returns_org_roots_with_names_and_paths() {
        let root = tempfile::tempdir().unwrap();
        let orgdir = root.path().join("myorg");
        std::fs::create_dir_all(&orgdir).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", orgdir.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        let (s, body) = request(app.clone(), "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""org":"myorg""#), "{body}");
        assert!(
            body.contains(&format!(r#""path":"{}""#, orgdir.to_string_lossy())),
            "{body}"
        );

        // No token is 401.
        let (s401, _) = request(app, "/api/repos/list", Some(OK_HOST), &[]).await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn repos_list_skips_a_rootless_slash_entry() {
        let root = tempfile::tempdir().unwrap();
        let orgdir = root.path().join("realorg");
        std::fs::create_dir_all(&orgdir).unwrap();
        let conf = root.path().join("repos.conf");
        // A degenerate `/` root must not blank the list (its empty org would fail the client schema).
        std::fs::write(&conf, format!("/\n{}\n", orgdir.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let (s, body) = request(app, "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""org":"realorg""#), "{body}");
        assert!(!body.contains(r#""org":"""#), "{body}");
    }

    #[tokio::test]
    async fn repos_list_is_empty_without_a_conf() {
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            ..Default::default()
        });
        let (s, body) = request(app, "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body, r#"{"orgs":[]}"#);
    }

    #[tokio::test]
    async fn fs_validate_reports_add_status_and_enforces_token() {
        let root = tempfile::tempdir().unwrap();
        let neworg = root.path().join("neworg");
        std::fs::create_dir_all(&neworg).unwrap();
        let dup = root.path().join("dup");
        std::fs::create_dir_all(&dup).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", dup.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        // An existing, unregistered directory validates as ok with org = basename.
        let (s, body) = request(
            app.clone(),
            &format!("/api/fs/validate?token=t&path={}", neworg.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""status":"ok""#), "{body}");
        assert!(body.contains(r#""org":"neworg""#), "{body}");

        // An already-registered path is duplicate; a missing path is not_a_directory (org omitted).
        let (_, dbody) = request(
            app.clone(),
            &format!("/api/fs/validate?token=t&path={}", dup.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert!(dbody.contains(r#""status":"duplicate""#), "{dbody}");
        assert!(!dbody.contains(r#""org""#), "{dbody}");
        let (_, nbody) = request(
            app.clone(),
            &format!(
                "/api/fs/validate?token=t&path={}",
                root.path().join("nope").to_string_lossy()
            ),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert!(nbody.contains(r#""status":"not_a_directory""#), "{nbody}");

        // Empty path is 400, no token is 401.
        let (s400, _) = request(app.clone(), "/api/fs/validate?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s400, StatusCode::BAD_REQUEST);
        let (s401, _) = request(
            app,
            &format!("/api/fs/validate?path={}", neworg.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn fs_browse_lists_scoped_subdirs_and_rejects_out_of_scope() {
        let root = tempfile::tempdir().unwrap();
        let ws = root.path().join("workspace");
        std::fs::create_dir_all(ws.join("workshop")).unwrap();
        std::fs::create_dir_all(ws.join("other")).unwrap();
        // Register an org under ws, so ws (the registered root's parent) becomes browseable.
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", ws.join("workshop").display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        // Browsing under ws with prefix "wo" returns only the matching subdir.
        let (s, body) = request(
            app.clone(),
            &format!("/api/fs/browse?token=t&path={}/wo", ws.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""name":"workshop""#), "{body}");
        assert!(!body.contains(r#""name":"other""#), "{body}");

        // A parent outside HOME and every registered-root parent is 403.
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("sub")).unwrap();
        let (s403, _) = request(
            app.clone(),
            &format!(
                "/api/fs/browse?token=t&path={}/su",
                outside.path().to_string_lossy()
            ),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s403, StatusCode::FORBIDDEN);

        // Empty input lists nothing (no error); no token is 401.
        let (s_empty, ebody) =
            request(app.clone(), "/api/fs/browse?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s_empty, StatusCode::OK);
        assert!(ebody.contains(r#""entries":[]"#), "{ebody}");
        let (s401, _) = request(
            app,
            &format!("/api/fs/browse?path={}/wo", ws.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn guard_rejects_bad_host_missing_host_and_bad_origin() {
        let (s1, _) = request(router(None), "/healthz", Some("evil.com"), &[]).await;
        assert_eq!(s1, StatusCode::FORBIDDEN);
        let (s2, _) = request(router(None), "/healthz", None, &[]).await;
        assert_eq!(s2, StatusCode::FORBIDDEN);
        let (s3, _) = request(
            router(None),
            "/healthz",
            Some(OK_HOST),
            &[("origin", "http://evil.example")],
        )
        .await;
        assert_eq!(s3, StatusCode::FORBIDDEN);
        let (s4, _) = request(
            router(None),
            "/healthz",
            Some(OK_HOST),
            &[("origin", "http://localhost:5173")],
        )
        .await;
        assert_eq!(s4, StatusCode::OK);
    }

    #[tokio::test]
    async fn serves_client_dist_index_at_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>zk").unwrap();
        let app = build_router(ServerConfig {
            client_dist: Some(dir.path().to_path_buf()),
            ..Default::default()
        });
        let (status, body) = request(app, "/", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<!doctype html>zk");
    }

    #[test]
    fn allowed_host_accepts_localhost_family() {
        assert!(is_allowed_host(Some("127.0.0.1:8790")));
        assert!(is_allowed_host(Some("localhost:8790")));
        assert!(is_allowed_host(Some("127.0.0.1")));
        assert!(is_allowed_host(Some("[::1]:8790")));
    }

    #[test]
    fn allowed_host_rejects_others_and_missing() {
        assert!(!is_allowed_host(Some("example.com:8790")));
        assert!(!is_allowed_host(Some("127.0.0.1.evil.com:8790")));
        assert!(!is_allowed_host(None));
        assert!(!is_allowed_host(Some("")));
        assert!(!is_allowed_host(Some(":8790")));
    }

    #[test]
    fn allowed_origin_accepts_localhost_http() {
        assert!(is_allowed_origin(Some("http://127.0.0.1:8790")));
        assert!(is_allowed_origin(Some("http://localhost:5173")));
        assert!(is_allowed_origin(None));
    }

    #[test]
    fn allowed_origin_rejects_external_and_invalid() {
        assert!(!is_allowed_origin(Some("http://evil.example")));
        assert!(!is_allowed_origin(Some("https://127.0.0.1.evil.com")));
        assert!(!is_allowed_origin(Some("null")));
        assert!(!is_allowed_origin(Some("not a url")));
        assert!(!is_allowed_origin(Some("ftp://127.0.0.1")));
    }

    #[test]
    fn allowed_origin_rejects_bracket_trailing_junk_and_bad_port() {
        assert!(!is_allowed_origin(Some("http://[::1]extra")));
        assert!(!is_allowed_origin(Some("http://[::1]@evil.com")));
        assert!(!is_allowed_origin(Some("http://[::1].evil.com")));
        assert!(!is_allowed_origin(Some("http://127.0.0.1:80extra")));
        assert!(is_allowed_origin(Some("http://[::1]")));
        assert!(is_allowed_origin(Some("http://[::1]:8790")));
        assert!(is_allowed_origin(Some("http://127.0.0.1:8790/path?x=1")));
    }

    #[test]
    fn token_from_query_takes_first_nonempty() {
        assert_eq!(token_from_query(Some("token=abc")), Some("abc"));
        assert_eq!(token_from_query(Some("token=xyz&x=1")), Some("xyz"));
        assert_eq!(token_from_query(Some("x=1")), None);
        assert_eq!(token_from_query(Some("token=")), None);
        assert_eq!(token_from_query(None), None);
    }

    #[test]
    fn token_matches_is_length_safe() {
        assert!(token_matches(Some("abc"), "abc"));
        assert!(!token_matches(Some("abcd"), "abc"));
        assert!(!token_matches(Some("abd"), "abc"));
        assert!(!token_matches(None, "abc"));
    }

    // ---- git write REST + /api/file wiring (real git repo + in-process HTTP) ----

    mod git_file_rest_tests {
        use super::{request, OK_HOST};
        use crate::{build_router, OpenFile, ServerConfig};
        use axum::body::{to_bytes, Body};
        use axum::http::{Request as HttpRequest, StatusCode};
        use std::path::Path;
        use std::sync::{Arc, Mutex};
        use tower::ServiceExt;

        fn git(dir: &Path, args: &[&str]) {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        }

        fn init_repo(p: &Path) {
            std::fs::create_dir_all(p).unwrap();
            git(p, &["init", "-q", "-b", "main"]);
            git(p, &["config", "user.email", "test@example.com"]);
            git(p, &["config", "user.name", "zashiki test"]);
            git(p, &["config", "commit.gpgsign", "false"]);
            std::fs::write(p.join("base.txt"), "base\n").unwrap();
            git(p, &["add", "base.txt"]);
            git(p, &["commit", "-q", "-m", "init"]);
        }

        struct Fixture {
            _root: tempfile::TempDir,
            repo_a: String,
            repo_b: String,
            outside: String,
            conf: std::path::PathBuf,
            opened: Arc<Mutex<Vec<(String, String)>>>,
        }

        fn fixture() -> Fixture {
            let root = tempfile::tempdir().unwrap();
            let base = root.path();
            let repo_a = base.join("org1/repo-a");
            let repo_b = base.join("org1/repo-b");
            let outside = base.join("outside");
            init_repo(&repo_a);
            init_repo(&repo_b);
            init_repo(&outside);
            std::fs::create_dir_all(repo_a.join("src")).unwrap();
            std::fs::write(repo_a.join("README.md"), "# hello\n").unwrap();
            std::fs::write(repo_a.join("src/app.ts"), "export {}\n").unwrap();
            let conf = base.join("repos.conf");
            std::fs::write(&conf, format!("{}\n", base.join("org1").display())).unwrap();
            Fixture {
                repo_a: repo_a.to_string_lossy().into_owned(),
                repo_b: repo_b.to_string_lossy().into_owned(),
                outside: outside.to_string_lossy().into_owned(),
                conf,
                opened: Arc::new(Mutex::new(Vec::new())),
                _root: root,
            }
        }

        fn app(fx: &Fixture) -> axum::Router {
            let opened = fx.opened.clone();
            let open_file: OpenFile = Arc::new(move |repo_path, file| {
                opened.lock().unwrap().push((repo_path, file));
            });
            build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                repos_conf: Some(fx.conf.clone()),
                open_file: Some(open_file),
                // Small so that 413 can be verified cheaply.
                file_max_bytes: Some(32),
                ..Default::default()
            })
        }

        async fn post(app: axum::Router, uri: &str, body: &str) -> (StatusCode, String) {
            let req = HttpRequest::builder()
                .method("POST")
                .uri(uri)
                .header("host", OK_HOST)
                .header("x-zashiki-token", "t")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        /// Gets the (staged, changed) path lists by classifying git status --porcelain in core.
        fn status_paths(p: &str) -> (Vec<String>, Vec<String>) {
            let raw = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(["status", "--porcelain=v1"])
                .output()
                .unwrap();
            let parsed = zashiki_core::git::parse_git_status(&String::from_utf8_lossy(&raw.stdout));
            (
                parsed.staged.into_iter().map(|e| e.path).collect(),
                parsed.changed.into_iter().map(|e| e.path).collect(),
            )
        }

        #[tokio::test]
        async fn stage_unstage_happy_and_guards() {
            let fx = fixture();
            std::fs::write(Path::new(&fx.repo_a).join("base.txt"), "modified\n").unwrap();

            let (s, b) = post(
                app(&fx),
                "/api/git/stage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"base.txt"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert_eq!(b, r#"{"ok":true}"#);
            assert!(status_paths(&fx.repo_a).0.contains(&"base.txt".to_string()));

            let (s, _) = post(
                app(&fx),
                "/api/git/unstage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"base.txt"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(!status_paths(&fx.repo_a).0.contains(&"base.txt".to_string()));

            // A repoPath outside the scan is 403
            let (s, _) = post(
                app(&fx),
                "/api/git/stage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"base.txt"}}"#, fx.outside),
            )
            .await;
            assert_eq!(s, StatusCode::FORBIDDEN);

            // Path traversal and absolute paths are 400
            let (s, _) = post(
                app(&fx),
                "/api/git/stage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"../repo-b/base.txt"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
            let (s, _) = post(
                app(&fx),
                "/api/git/unstage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"/etc/passwd"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);

            // A malformed body (missing file) is 400
            let (s, _) = post(
                app(&fx),
                "/api/git/stage?token=t",
                &format!(r#"{{"repoPath":"{}"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        #[tokio::test]
        async fn stage_all_unstage_all() {
            let fx = fixture();
            std::fs::write(Path::new(&fx.repo_a).join("base.txt"), "modified\n").unwrap();
            std::fs::write(Path::new(&fx.repo_a).join("untracked.txt"), "new\n").unwrap();

            let (s, _) = post(
                app(&fx),
                "/api/git/stage-all?token=t",
                &format!(r#"{{"repoPath":"{}"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(status_paths(&fx.repo_a).1.is_empty());

            let (s, _) = post(
                app(&fx),
                "/api/git/unstage-all?token=t",
                &format!(r#"{{"repoPath":"{}"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(status_paths(&fx.repo_a).0.is_empty());

            let (s, _) = post(
                app(&fx),
                "/api/git/stage-all?token=t",
                &format!(r#"{{"repoPath":"{}"}}"#, fx.outside),
            )
            .await;
            assert_eq!(s, StatusCode::FORBIDDEN);
        }

        #[tokio::test]
        async fn open_injects_and_rejects_escape() {
            let fx = fixture();
            let (s, _) = post(
                app(&fx),
                "/api/git/open?token=t",
                &format!(r#"{{"repoPath":"{}","file":"base.txt"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert_eq!(
                fx.opened.lock().unwrap().as_slice(),
                &[(fx.repo_a.clone(), "base.txt".to_string())]
            );

            // A nonexistent file is 404
            let (s, _) = post(
                app(&fx),
                "/api/git/open?token=t",
                &format!(r#"{{"repoPath":"{}","file":"no-such.txt"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::NOT_FOUND);

            // A symlink outside the repo is 400 and open is not called
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink("/etc/hosts", Path::new(&fx.repo_a).join("sneaky"))
                    .unwrap();
                let before = fx.opened.lock().unwrap().len();
                let (s, _) = post(
                    app(&fx),
                    "/api/git/open?token=t",
                    &format!(r#"{{"repoPath":"{}","file":"sneaky"}}"#, fx.repo_a),
                )
                .await;
                assert_eq!(s, StatusCode::BAD_REQUEST);
                assert_eq!(fx.opened.lock().unwrap().len(), before);
            }
        }

        #[tokio::test]
        async fn commit_happy_conflict_and_schema() {
            let fx = fixture();
            std::fs::write(Path::new(&fx.repo_b).join("dash-msg.txt"), "x\n").unwrap();
            post(
                app(&fx),
                "/api/git/stage?token=t",
                &format!(r#"{{"repoPath":"{}","file":"dash-msg.txt"}}"#, fx.repo_b),
            )
            .await;
            // A message starting with `-` is also safe
            let (s, _) = post(
                app(&fx),
                "/api/git/commit?token=t",
                &format!(
                    r#"{{"repoPath":"{}","message":"--amend looking message"}}"#,
                    fx.repo_b
                ),
            )
            .await;
            assert_eq!(s, StatusCode::OK);

            // Nothing staged is 409
            let (s, b) = post(
                app(&fx),
                "/api/git/commit?token=t",
                &format!(r#"{{"repoPath":"{}","message":"no staged"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::CONFLICT);
            assert_eq!(b, r#"{"error":"nothing staged to commit"}"#);

            // An empty message is 400
            let (s, _) = post(
                app(&fx),
                "/api/git/commit?token=t",
                &format!(r#"{{"repoPath":"{}","message":"   "}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);

            // A repoPath outside the scan is 403
            let (s, _) = post(
                app(&fx),
                "/api/git/commit?token=t",
                &format!(r#"{{"repoPath":"{}","message":"hi"}}"#, fx.outside),
            )
            .await;
            assert_eq!(s, StatusCode::FORBIDDEN);
        }

        #[tokio::test]
        async fn routing_unknown_405_and_401() {
            let fx = fixture();
            // An unknown endpoint is 404
            let (s, _) = post(app(&fx), "/api/git/nope?token=t", "{}").await;
            assert_eq!(s, StatusCode::NOT_FOUND);
            // GET /api/git/stage (wrong method) is 405
            let (s, _) = request(app(&fx), "/api/git/stage?token=t", Some(OK_HOST), &[]).await;
            assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
            // No token is 401
            let (s, _) = request(app(&fx), "/api/git/stage", Some(OK_HOST), &[]).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED);
        }

        // ---- /api/file ----

        async fn read(app: axum::Router, repo_path: &str, file: &str) -> (StatusCode, String) {
            let q = format!(
                "/api/file?token=t&repoPath={}&file={}",
                urlencoding(repo_path),
                urlencoding(file)
            );
            request(app, &q, Some(OK_HOST), &[]).await
        }

        fn urlencoding(s: &str) -> String {
            s.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect()
        }

        #[tokio::test]
        async fn file_read_happy_and_errors() {
            let fx = fixture();
            let (s, b) = read(app(&fx), &fx.repo_a, "README.md").await;
            assert_eq!(s, StatusCode::OK);
            assert_eq!(b, r##"{"content":"# hello\n"}"##);

            // Nonexistent -> 404
            let (s, _) = read(app(&fx), &fx.repo_a, "nope.txt").await;
            assert_eq!(s, StatusCode::NOT_FOUND);
            // Directory -> 400 not a file
            let (s, b) = read(app(&fx), &fx.repo_a, "src").await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
            assert_eq!(b, r#"{"error":"not a file"}"#);
            // .. is 400 unsafe
            let (s, _) = read(app(&fx), &fx.repo_a, "../base.txt").await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
            // A repoPath outside the allowlist is 403 (the org1 directory itself)
            let org1 = Path::new(&fx.repo_a).parent().unwrap().to_string_lossy();
            let (s, _) = read(app(&fx), &org1, "README.md").await;
            assert_eq!(s, StatusCode::FORBIDDEN);
            // Exceeding maxBytes is 413
            std::fs::write(Path::new(&fx.repo_a).join("big.txt"), "x".repeat(100)).unwrap();
            let (s, _) = read(app(&fx), &fx.repo_a, "big.txt").await;
            assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn file_read_symlink_escape_is_400() {
            let fx = fixture();
            let root = Path::new(&fx.repo_a).parent().unwrap().parent().unwrap();
            std::fs::write(root.join("secret.txt"), "TOP SECRET\n").unwrap();
            std::os::unix::fs::symlink(root.join("secret.txt"), Path::new(&fx.repo_a).join("escape.txt"))
                .unwrap();
            let (s, _) = read(app(&fx), &fx.repo_a, "escape.txt").await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        #[tokio::test]
        async fn file_write_happy_and_errors() {
            let fx = fixture();
            let (s, b) = post(
                app(&fx),
                "/api/file?token=t",
                &format!(
                    r#"{{"repoPath":"{}","file":"src/app.ts","content":"export const x = 1\n"}}"#,
                    fx.repo_a
                ),
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert_eq!(b, r#"{"ok":true}"#);
            assert_eq!(
                std::fs::read_to_string(Path::new(&fx.repo_a).join("src/app.ts")).unwrap(),
                "export const x = 1\n"
            );

            // Missing content is 400
            let (s, _) = post(
                app(&fx),
                "/api/file?token=t",
                &format!(r#"{{"repoPath":"{}","file":"README.md"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);

            // .. is 400 and does not write
            let (s, _) = post(
                app(&fx),
                "/api/file?token=t",
                &format!(r#"{{"repoPath":"{}","file":"../base.txt","content":"HACKED\n"}}"#, fx.repo_a),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);

            // Content exceeding maxBytes is 413
            let (s, _) = post(
                app(&fx),
                "/api/file?token=t",
                &format!(r#"{{"repoPath":"{}","file":"README.md","content":"{}"}}"#, fx.repo_a, "y".repeat(100)),
            )
            .await;
            assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);

            // A repoPath outside the allowlist is 403
            let org1 = Path::new(&fx.repo_a).parent().unwrap().to_string_lossy();
            let (s, _) = post(
                app(&fx),
                "/api/file?token=t",
                &format!(r#"{{"repoPath":"{}","file":"README.md","content":"x"}}"#, org1),
            )
            .await;
            assert_eq!(s, StatusCode::FORBIDDEN);
        }

        /// content = exactly FILE_MAX_BYTES (+ the JSON envelope) still returns 200. With axum's default 2MiB
        /// body limit it would be 413 at the transport layer, but /api/file raises the limit to maxBytes+64KiB.
        #[tokio::test]
        async fn file_write_at_max_bytes_succeeds() {
            let fx = fixture();
            let max = crate::file::FILE_MAX_BYTES;
            let app = build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                repos_conf: Some(fx.conf.clone()),
                file_max_bytes: Some(max),
                ..Default::default()
            });
            let content = "a".repeat(max as usize);
            let body = format!(
                r#"{{"repoPath":"{}","file":"README.md","content":"{}"}}"#,
                fx.repo_a, content
            );
            let (s, _) = post(app, "/api/file?token=t", &body).await;
            assert_eq!(s, StatusCode::OK);
            assert_eq!(
                std::fs::read_to_string(Path::new(&fx.repo_a).join("README.md"))
                    .unwrap()
                    .len(),
                max as usize
            );
        }
    }

    // ---- session save/restore REST wiring (owned registry + in-process HTTP) ----

    mod sessions_persist_rest_tests {
        use super::OK_HOST;
        use crate::control::{ConfigView, ControlHub, ControlServices};
        use crate::session_launch::{plan_new_session, plan_to_config};
        use crate::session_registry::{SessionMeta, SessionRegistry};
        use crate::status_poller::StateSnapshot;
        use crate::term_registry::TermRegistry;
        use crate::{build_router, ServerConfig};
        use axum::body::{to_bytes, Body};
        use axum::http::{Request as HttpRequest, StatusCode};
        use std::collections::BTreeMap;
        use std::sync::Arc;
        use tower::ServiceExt;

        fn empty_snapshot() -> StateSnapshot {
            StateSnapshot {
                sessions: vec![],
                orgs: vec![],
                org_colors: BTreeMap::new(),
            }
        }

        /// Owned services without a poller (the persist handlers only look at sessions and launch_claude,
        /// so the rest can be bogus).
        fn services(sessions: Arc<SessionRegistry>) -> ControlServices {
            let (refresh, rx) = tokio::sync::mpsc::channel(8);
            drop(rx);
            ControlServices {
                hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
                refresh,
                repos: crate::repos::shared_repos(vec![], Default::default()),
                launch_claude: true,
                terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
                sessions,
                heartbeat: crate::control::HEARTBEAT_INTERVAL,
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: std::sync::Arc::new(|_| {}),
                config_path: None,
            }
        }

        fn app(dir: &std::path::Path, sessions: Arc<SessionRegistry>) -> axum::Router {
            build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                control: Some(services(sessions)),
                saves_dir: Some(dir.to_path_buf()),
                ..Default::default()
            })
        }

        async fn send(app: axum::Router, method: &str, uri: &str, body: &str) -> (StatusCode, String) {
            let req = HttpRequest::builder()
                .method(method)
                .uri(uri)
                .header("host", OK_HOST)
                .header("x-zashiki-token", "t")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        #[tokio::test]
        async fn save_empty_registry_returns_409_with_code() {
            let dir = tempfile::tempdir().unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let (s, b) = send(app(dir.path(), sessions), "POST", "/api/sessions/save?token=t", "").await;
            assert_eq!(s, StatusCode::CONFLICT);
            // TS session-routes also returns a `code` for PersistError (drop-in contract).
            assert!(b.contains(r#""code":"save_empty""#), "body: {b}");
        }

        #[tokio::test]
        async fn restore_missing_file_returns_404() {
            let dir = tempfile::tempdir().unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let (s, _b) = send(app(dir.path(), sessions), "POST", "/api/sessions/restore?token=t", "{}").await;
            assert_eq!(s, StatusCode::NOT_FOUND);
        }

        #[tokio::test]
        async fn restore_empty_file_returns_422() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("last.tsv"), "").unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let (s, _b) = send(app(dir.path(), sessions), "POST", "/api/sessions/restore?token=t", "{}").await;
            assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
        }

        #[tokio::test]
        async fn restore_bad_filename_returns_400() {
            let dir = tempfile::tempdir().unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let (s, _b) = send(
                app(dir.path(), sessions),
                "POST",
                "/api/sessions/restore?token=t",
                r#"{"file":"../escape.tsv"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        #[tokio::test]
        async fn wrong_method_returns_405() {
            let dir = tempfile::tempdir().unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let (s, _b) = send(app(dir.path(), sessions), "GET", "/api/sessions/save?token=t", "").await;
            assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn restore_happy_returns_camelcase_body() {
            let dir = tempfile::tempdir().unwrap();
            let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
            std::fs::write(
                dir.path().join("last.tsv"),
                format!("1\talpha\t/tmp\t{sid}\n"),
            )
            .unwrap();
            let sessions = Arc::new(SessionRegistry::new());

            let (s, b) = send(
                app(dir.path(), sessions.clone()),
                "POST",
                "/api/sessions/restore?token=t",
                "{}",
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            // Enforce the camelCase contract of the response body (restored / warnings / backupPath) at the HTTP layer.
            assert!(b.contains(r#""restored":1"#), "body: {b}");
            assert!(b.contains(r#""warnings":[]"#), "body: {b}");
            // Since the pre-restore registry is empty, backupPath is null (camelCase, nullified).
            assert!(b.contains(r#""backupPath":null"#), "body: {b}");

            for id in sessions.list().await {
                sessions.remove(&id).await;
            }
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn save_happy_writes_last_and_returns_body() {
            let dir = tempfile::tempdir().unwrap();
            let sessions = Arc::new(SessionRegistry::new());
            let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
            let plan = plan_new_session(sid, "/tmp", "alpha", false, "/bin/sh", "claude");
            sessions
                .create_with_meta(
                    sid.to_string(),
                    plan_to_config(&plan),
                    SessionMeta {
                        cwd: "/tmp".to_string(),
                        wname: "alpha".to_string(),
                    },
                )
                .await
                .unwrap();

            let (s, b) = send(
                app(dir.path(), sessions.clone()),
                "POST",
                "/api/sessions/save?token=t",
                "",
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""saved":1"#), "body: {b}");
            assert!(b.contains(r#""skipped":[]"#), "body: {b}");
            assert!(std::fs::read_to_string(dir.path().join("last.tsv"))
                .unwrap()
                .contains(sid));

            for id in sessions.list().await {
                sessions.remove(&id).await;
            }
        }
    }

    // ---- hooks/event REST wiring (owned control + in-process HTTP) ----

    mod hooks_rest_tests {
        use super::OK_HOST;
        use crate::control::{ConfigView, ControlHub, ControlServices};
        use crate::hooks::{MacNotification, NotifyMode};
        use crate::protocol::ServerMessage;
        use crate::session_registry::SessionRegistry;
        use crate::status_poller::StateSnapshot;
        use crate::term_registry::TermRegistry;
        use crate::{build_router, ServerConfig};
        use axum::body::{to_bytes, Body};
        use axum::http::{Request as HttpRequest, StatusCode};
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tower::ServiceExt;

        type MacLog = Arc<Mutex<Vec<MacNotification>>>;

        fn empty_snapshot() -> StateSnapshot {
            StateSnapshot {
                sessions: vec![],
                orgs: vec![],
                org_colors: BTreeMap::new(),
            }
        }

        fn services(hub: Arc<ControlHub>, mode: NotifyMode, mac_log: MacLog) -> ControlServices {
            services_with_registry(hub, mode, mac_log, Arc::new(SessionRegistry::new()))
        }

        fn services_with_registry(
            hub: Arc<ControlHub>,
            mode: NotifyMode,
            mac_log: MacLog,
            sessions: Arc<SessionRegistry>,
        ) -> ControlServices {
            let (refresh, rx) = tokio::sync::mpsc::channel(8);
            drop(rx);
            ControlServices {
                hub,
                refresh,
                repos: crate::repos::shared_repos(vec![], Default::default()),
                launch_claude: false,
                terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
                sessions,
                heartbeat: crate::control::HEARTBEAT_INTERVAL,
                notify_mode: mode,
                mac_notify: Arc::new(move |n| mac_log.lock().unwrap().push(n)),
                config_path: None,
            }
        }

        fn app(services: ControlServices) -> axum::Router {
            build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                control: Some(services),
                ..Default::default()
            })
        }

        async fn send(app: axum::Router, method: &str, body: &str) -> (StatusCode, String) {
            let req = HttpRequest::builder()
                .method(method)
                .uri("/api/hooks/event?token=t")
                .header("host", OK_HOST)
                .header("x-zashiki-token", "t")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        #[tokio::test]
        async fn wrong_method_returns_405() {
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let (s, _) = send(
                app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
                "GET",
                "",
            )
            .await;
            assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
        }

        #[tokio::test]
        async fn tool_broadcasts_git_dirty_and_matched_false() {
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let mut rx = hub.subscribe();
            let (s, b) = send(
                app(services(hub.clone(), NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
                "POST",
                r#"{"kind":"tool"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""matched":false"#), "body: {b}");
            // The git.dirty that triggers a git-panel refetch flows to all connections.
            assert!(matches!(rx.try_recv(), Ok(ServerMessage::GitDirty)));
        }

        #[tokio::test]
        async fn waiting_without_resolvable_window_is_not_matched() {
            // Empty registry -> window can't be resolved -> resolve None -> matched=false, no delivery
            // (returns 200 rather than 500 even when unresolvable = the hook is fire-and-forget).
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let mac_log: MacLog = Arc::new(Mutex::new(vec![]));
            let (s, b) = send(
                app(services(hub, NotifyMode::Both, mac_log.clone())),
                "POST",
                r#"{"kind":"waiting","cwd":"/nope"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""ok":true"#) && b.contains(r#""matched":false"#), "body: {b}");
            assert!(mac_log.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn prompt_is_accepted_and_not_matched() {
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let (s, b) = send(
                app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
                "POST",
                r#"{"kind":"prompt"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""matched":false"#), "body: {b}");
        }

        #[tokio::test]
        async fn invalid_kind_is_bad_request() {
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let (s, _) = send(
                app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
                "POST",
                r#"{"kind":"bogus"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        /// Places an owned session in the registry, resolves by cwd match -> matched=true, notify push, and mac
        /// fire (verifies over HTTP that notification delivery works for owned sessions and that the wiring holds).
        #[cfg(unix)]
        #[tokio::test]
        async fn owned_waiting_matches_by_cwd_and_delivers() {
            use crate::session_launch::{plan_new_session, plan_to_config};
            use crate::session_registry::SessionMeta;

            let sessions = Arc::new(SessionRegistry::new());
            let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
            let plan = plan_new_session(sid, "/tmp", "repo-a", false, "/bin/sh", "claude");
            sessions
                .create_with_meta(
                    sid.to_string(),
                    plan_to_config(&plan),
                    SessionMeta {
                        cwd: "/tmp".to_string(),
                        wname: "repo-a".to_string(),
                    },
                )
                .await
                .unwrap();

            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let mut rx = hub.subscribe();
            let mac_log: MacLog = Arc::new(Mutex::new(vec![]));
            // Both does both push+mac regardless of clientCount (makes the wiring verification deterministic).
            let svc =
                services_with_registry(hub.clone(), NotifyMode::Both, mac_log.clone(), sessions.clone());
            let (s, b) = send(app(svc), "POST", r#"{"kind":"waiting","cwd":"/tmp"}"#).await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""matched":true"#), "body: {b}");

            // The notify push ({t:"notify",...}) flows to all connections.
            let mut saw_notify = false;
            while let Ok(msg) = rx.try_recv() {
                if let ServerMessage::Notify { title, kind, .. } = msg {
                    assert_eq!(title, "repo-a");
                    assert_eq!(kind, crate::protocol::NotifyKind::Waiting);
                    saw_notify = true;
                }
            }
            assert!(saw_notify, "notify broadcast expected");
            // Both also emits a mac notification (the body is empty since there's no snap; the title is the window name).
            {
                let macs = mac_log.lock().unwrap();
                assert_eq!(macs.len(), 1);
                assert_eq!(macs[0].title, "repo-a");
            }
            for id in sessions.list().await {
                sessions.remove(&id).await;
            }
        }

        async fn send_focus(app: axum::Router, body: &str) -> (StatusCode, String) {
            let req = HttpRequest::builder()
                .method("POST")
                .uri("/api/focus?token=t")
                .header("host", OK_HOST)
                .header("x-zashiki-token", "t")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        #[tokio::test]
        async fn focus_unresolved_returns_resolved_false_and_broadcasts_nothing() {
            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let mut rx = hub.subscribe();
            let (s, b) = send_focus(
                app(services(hub.clone(), NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
                r#"{"cwd":"/nope"}"#,
            )
            .await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""resolved":false"#), "body: {b}");
            assert!(rx.try_recv().is_err(), "no select expected when unresolved");
        }

        /// Resolving a focus request by cwd broadcasts a `select` for the owned window and
        /// echoes the resolved windowId (so a clicked notification can select the session).
        #[cfg(unix)]
        #[tokio::test]
        async fn focus_resolved_broadcasts_select_with_window_id() {
            use crate::session_launch::{plan_new_session, plan_to_config};
            use crate::session_registry::SessionMeta;

            let sessions = Arc::new(SessionRegistry::new());
            let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
            let plan = plan_new_session(sid, "/tmp", "repo-a", false, "/bin/sh", "claude");
            sessions
                .create_with_meta(
                    sid.to_string(),
                    plan_to_config(&plan),
                    SessionMeta {
                        cwd: "/tmp".to_string(),
                        wname: "repo-a".to_string(),
                    },
                )
                .await
                .unwrap();

            let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
            let mut rx = hub.subscribe();
            let svc = services_with_registry(
                hub.clone(),
                NotifyMode::Web,
                Arc::new(Mutex::new(vec![])),
                sessions.clone(),
            );
            let (s, b) = send_focus(app(svc), r#"{"cwd":"/tmp"}"#).await;
            assert_eq!(s, StatusCode::OK);
            assert!(b.contains(r#""resolved":true"#), "body: {b}");
            assert!(b.contains(&format!(r#""windowId":"{sid}""#)), "body: {b}");

            let mut saw_select = false;
            while let Ok(msg) = rx.try_recv() {
                if let ServerMessage::Select { window_id } = msg {
                    assert_eq!(window_id, sid);
                    saw_select = true;
                }
            }
            assert!(saw_select, "select broadcast expected");
            for id in sessions.list().await {
                sessions.remove(&id).await;
            }
        }
    }

    // ---- /api/repos/add wiring (validation + append via in-process HTTP) ----

    mod repos_add_rest_tests {
        use super::OK_HOST;
        use crate::{build_router, ServerConfig};
        use axum::body::{to_bytes, Body};
        use axum::http::{Request as HttpRequest, StatusCode};
        use tower::ServiceExt;

        fn app(conf: std::path::PathBuf) -> axum::Router {
            build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                repos_conf: Some(conf),
                ..Default::default()
            })
        }

        async fn send(app: axum::Router, body: &str) -> (StatusCode, String) {
            let req = HttpRequest::builder()
                .method("POST")
                .uri("/api/repos/add?token=t")
                .header("host", OK_HOST)
                .header("x-zashiki-token", "t")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = app.oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        fn make_dir(parent: &std::path::Path, name: &str) -> String {
            let p = parent.join(name);
            std::fs::create_dir_all(&p).unwrap();
            p.to_string_lossy().into_owned()
        }

        #[tokio::test]
        async fn add_valid_directory_writes_line_and_returns_org() {
            let dir = tempfile::tempdir().unwrap();
            let conf = dir.path().join("repos.conf");
            let path = make_dir(dir.path(), "myorg");
            let (s, b) = send(
                app(conf.clone()),
                &format!(r##"{{"path":"{path}","color":"#7aa2f7"}}"##),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "body: {b}");
            assert!(b.contains(r#""org":"myorg""#), "body: {b}");
            let written = std::fs::read_to_string(&conf).unwrap();
            assert!(
                written.contains(&path) && written.contains("#7aa2f7"),
                "conf: {written}"
            );
        }

        #[tokio::test]
        async fn add_duplicate_returns_409() {
            let dir = tempfile::tempdir().unwrap();
            let conf = dir.path().join("repos.conf");
            let path = make_dir(dir.path(), "dup");
            std::fs::write(&conf, format!("{path}\n")).unwrap();
            let (s, _b) = send(app(conf), &format!(r#"{{"path":"{path}"}}"#)).await;
            assert_eq!(s, StatusCode::CONFLICT);
        }

        #[tokio::test]
        async fn add_nonexistent_path_returns_400() {
            let dir = tempfile::tempdir().unwrap();
            let conf = dir.path().join("repos.conf");
            let missing = dir.path().join("nope").to_string_lossy().into_owned();
            let (s, _b) = send(app(conf), &format!(r#"{{"path":"{missing}"}}"#)).await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        #[tokio::test]
        async fn add_invalid_color_returns_400() {
            let dir = tempfile::tempdir().unwrap();
            let conf = dir.path().join("repos.conf");
            let path = make_dir(dir.path(), "c");
            let (s, _b) = send(
                app(conf),
                &format!(r#"{{"path":"{path}","color":"blue"}}"#),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST);
        }

        /// End-to-end: with a live control runtime, adding an org updates the shared live set and the
        /// new org appears in state.sync without a restart (the core "immediate reflection" contract).
        #[tokio::test]
        async fn add_reflects_in_shared_state_and_state_sync() {
            use crate::control::ConfigView;
            use crate::protocol::ServerMessage;
            use crate::runtime::{spawn_control_runtime, ControlRuntimeConfig};
            use std::time::Duration;

            let dir = tempfile::tempdir().unwrap();
            let conf = dir.path().join("repos.conf");
            std::fs::write(&conf, "").unwrap();
            let org_dir = make_dir(dir.path(), "freshorg");

            let services = spawn_control_runtime(ControlRuntimeConfig {
                projects_root: dir.path().to_path_buf(),
                repos_roots: vec![],
                org_colors: std::collections::BTreeMap::new(),
                repos_conf: Some(conf.clone()),
                poll_sec: 0.05,
                run_marker: None,
                bg_agent_marker: None,
                limit_marker: None,
                launch_claude: false,
                config: ConfigView::default(),
                config_path: None,
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: std::sync::Arc::new(|_| {}),
                app_version: None,
            });
            let repos_handle = services.repos.clone();
            let mut rx = services.hub.subscribe();

            let router = build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                repos_conf: Some(conf.clone()),
                control: Some(services),
                ..Default::default()
            });
            let (s, b) = send(router, &format!(r#"{{"path":"{org_dir}"}}"#)).await;
            assert_eq!(s, StatusCode::OK, "body: {b}");

            // The live set is updated synchronously by the endpoint (no restart).
            assert!(
                repos_handle
                    .read()
                    .unwrap()
                    .roots
                    .iter()
                    .any(|r| r.ends_with("freshorg")),
                "shared roots should include the added org"
            );

            // The poller re-evaluates and publishes state.sync carrying the new org.
            let found = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(ServerMessage::StateSync { orgs, .. }) = rx.recv().await {
                        if orgs.contains(&"freshorg".to_string()) {
                            return true;
                        }
                    }
                }
            })
            .await
            .unwrap_or(false);
            assert!(found, "state.sync should carry the newly added org");
        }
    }

    // ---- /ws/control wiring (connectivity via a real WS client) ----

    mod ws_control_tests {
        use crate::control::{ConfigView, ControlHub, ControlServices};
        use crate::protocol::{Notification, NotificationLevel};
        use crate::runtime::{spawn_control_runtime, ControlRuntimeConfig};
        use crate::status_poller::StateSnapshot;
        use crate::term_registry::{TermEntry, TermRegistry};
        use crate::{build_router, ServerConfig};
        use futures_util::{SinkExt, StreamExt};
        use std::collections::BTreeMap;
        use std::sync::Arc;
        use tokio_tungstenite::tungstenite::Message as TMsg;

        fn snapshot(window: &str) -> StateSnapshot {
            StateSnapshot {
                sessions: vec![crate::protocol::SessionInfo {
                    window_id: window.to_string(),
                    name: "repo".to_string(),
                    org: "org".to_string(),
                    repo: "repo".to_string(),
                    state: "running".to_string(),
                    title: None,
                    sid: None,
                    active: true,
                    running_subagents: Some(0),
                    limited: false,
                }],
                orgs: vec!["org".to_string()],
                org_colors: BTreeMap::new(),
            }
        }

        /// Owned services without a poller. Since the refresh rx is dropped, state.refresh becomes a fallback response.
        fn test_services(hub: Arc<ControlHub>, repos_roots: Vec<String>) -> ControlServices {
            let (refresh, rx) = tokio::sync::mpsc::channel(8);
            drop(rx);
            ControlServices {
                hub,
                refresh,
                repos: crate::repos::shared_repos(repos_roots, Default::default()),
                launch_claude: false,
                terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
                sessions: Arc::new(crate::session_registry::SessionRegistry::new()),
                heartbeat: crate::control::HEARTBEAT_INTERVAL,
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: std::sync::Arc::new(|_| {}),
                config_path: None,
            }
        }

        async fn serve(control: Option<ControlServices>) -> u16 {
            let app = build_router(ServerConfig {
                expected_token: Some("t".to_string()),
                control,
                ..Default::default()
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            port
        }

        async fn connect(
            port: u16,
        ) -> tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        > {
            let url = format!("ws://127.0.0.1:{port}/ws/control?token=t");
            tokio_tungstenite::connect_async(&url).await.unwrap().0
        }

        async fn next_text<S>(ws: &mut S) -> String
        where
            S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            loop {
                match ws.next().await.expect("stream ended").expect("ws error") {
                    TMsg::Text(t) => return t.to_string(),
                    _ => continue,
                }
            }
        }

        /// Reads the next error frame. Since an error also accumulates into NOTIFICATION and comes with a
        /// notifications.sync, the notifications.sync interleaved in between is skipped.
        async fn next_error_text<S>(ws: &mut S) -> String
        where
            S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            loop {
                let t = next_text(ws).await;
                if !t.contains(r#""t":"notifications.sync""#) {
                    return t;
                }
            }
        }

        /// Skips the 3 stages sent on connect (config/notifications/state).
        async fn drain_handshake<S>(ws: &mut S)
        where
            S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            for _ in 0..3 {
                next_text(ws).await;
            }
        }

        #[tokio::test]
        async fn handshake_sends_config_notifications_state_then_broadcasts() {
            let hub = ControlHub::new(
                ConfigView {
                    notify_sound: true,
                    debug: false,
                    update_check: true,
                    language: None,
                },
                vec![],
                snapshot("@1"),
            );
            let port = serve(Some(test_services(hub.clone(), vec![]))).await;
            let mut ws = connect(port).await;

            assert!(next_text(&mut ws).await.contains(r#""t":"config.sync""#));
            assert!(next_text(&mut ws)
                .await
                .contains(r#""t":"notifications.sync""#));
            let state = next_text(&mut ws).await;
            assert!(state.contains(r#""t":"state.sync""#) && state.contains("@1"));

            // An invalid message -> error response. The error also accumulates into NOTIFICATION.
            ws.send(TMsg::Text("not json".to_string())).await.unwrap();
            let err = next_text(&mut ws).await;
            assert!(err.contains(r#""t":"error""#) && err.contains("invalid_message"));
            let notif = next_text(&mut ws).await;
            assert!(
                notif.contains(r#""t":"notifications.sync""#)
                    && notif.contains(r#""level":"error""#)
                    && notif.contains("invalid_message"),
                "error must also accumulate into NOTIFICATION: {notif}"
            );

            // The hub's publish flows to the connection.
            hub.publish_snapshot(snapshot("@9"));
            let pushed = next_text(&mut ws).await;
            assert!(pushed.contains(r#""t":"state.sync""#) && pushed.contains("@9"));
        }

        #[tokio::test]
        async fn upgrade_without_token_is_rejected() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let port = serve(Some(test_services(hub, vec![]))).await;
            let url = format!("ws://127.0.0.1:{port}/ws/control");
            assert!(tokio_tungstenite::connect_async(&url).await.is_err());
        }

        #[tokio::test]
        async fn state_refresh_replies_with_state_sync_via_poller() {
            let tmp = tempfile::tempdir().unwrap();
            let services = spawn_control_runtime(ControlRuntimeConfig {
                projects_root: tmp.path().to_path_buf(),
                repos_roots: vec!["/repos/charlie".to_string()],
                org_colors: std::collections::BTreeMap::new(),
                repos_conf: None,
                poll_sec: 60.0, // Slow the periodic tick so the response comes via the refresh path.
                run_marker: None,
                bg_agent_marker: None,
                limit_marker: None,
                launch_claude: false,
                config: ConfigView::default(),
                config_path: None,
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: std::sync::Arc::new(|_| {}),
                app_version: None,
            });
            let port = serve(Some(services)).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(r#"{"t":"state.refresh"}"#.to_string()))
                .await
                .unwrap();
            let reply = next_text(&mut ws).await;
            assert!(reply.contains(r#""t":"state.sync""#) && reply.contains("charlie"));
        }

        /// session.new registers the owned PTY into the `SessionRegistry`. Without this, the poller keeps seeing empty.
        #[cfg(unix)]
        #[tokio::test]
        async fn owned_session_new_registers_pty_in_registry() {
            use std::time::Duration;

            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().to_string_lossy().to_string();
            let org = std::path::Path::new(&root)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();

            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let services = test_services(hub, vec![root.clone()]);
            let sessions = services.sessions.clone();
            let port = serve(Some(services)).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(format!(r#"{{"t":"session.new","org":"{org}"}}"#)))
                .await
                .unwrap();

            let registered = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if sessions.len().await == 1 {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or(false);
            assert!(
                registered,
                "owned session.new should register a PTY in SessionRegistry"
            );
        }

        #[tokio::test]
        async fn state_refresh_falls_back_when_poller_absent() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@7"));
            let port = serve(Some(test_services(hub, vec![]))).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(r#"{"t":"state.refresh"}"#.to_string()))
                .await
                .unwrap();
            let reply = next_text(&mut ws).await;
            assert!(reply.contains(r#""t":"state.sync""#) && reply.contains("@7"));
        }

        #[tokio::test]
        async fn notification_dismiss_removes_dismissible_and_broadcasts() {
            let notif = Notification {
                id: "n1".to_string(),
                level: NotificationLevel::Info,
                title: "t".to_string(),
                body: None,
                created_at: 1,
                sticky: false,
                dismissible: true,
                toast: None,
            };
            let hub = ControlHub::new(ConfigView::default(), vec![notif], snapshot("@1"));
            let port = serve(Some(test_services(hub, vec![]))).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(
                r#"{"t":"notification.dismiss","id":"n1"}"#.to_string(),
            ))
            .await
            .unwrap();
            let synced = next_text(&mut ws).await;
            assert!(synced.contains(r#""t":"notifications.sync""#) && !synced.contains("\"n1\""));
        }

        #[tokio::test]
        async fn heartbeat_keeps_responsive_client_connected() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let mut services = test_services(hub, vec![]);
            services.heartbeat = std::time::Duration::from_millis(60);
            let port = serve(Some(services)).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            // Keep reading = tungstenite auto-pongs each ping. Reading past 2 cycles (120ms) without
            // being disconnected = alive. If close/EOF arrives, inner returns and the timeout is Ok.
            let mut saw_ping = false;
            let outcome = tokio::time::timeout(std::time::Duration::from_millis(220), async {
                loop {
                    match ws.next().await {
                        None | Some(Err(_)) => break false,
                        Some(Ok(TMsg::Close(_))) => break false,
                        Some(Ok(TMsg::Ping(_))) => {
                            saw_ping = true; // Evidence that heartbeat actually sends pings.
                            continue;
                        }
                        Some(Ok(_)) => continue,
                    }
                }
            })
            .await;
            assert!(
                outcome.is_err(),
                "responsive client must stay connected across heartbeat cycles, got {outcome:?}"
            );
            assert!(saw_ping, "server must actually emit heartbeat pings");
        }

        #[tokio::test]
        async fn heartbeat_disconnects_silent_client() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let mut services = test_services(hub, vec![]);
            services.heartbeat = std::time::Duration::from_millis(60);
            let port = serve(Some(services)).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            // Not reading = not returning pongs. The server pings after 1 cycle and, with no pong by the next
            // cycle, disconnects (~2 cycles = 120ms). Wait 3+ cycles, then read and confirm close/EOF.
            tokio::time::sleep(std::time::Duration::from_millis(220)).await;
            let closed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    match ws.next().await {
                        None | Some(Err(_)) => break true,
                        Some(Ok(TMsg::Close(_))) => break true,
                        Some(Ok(_)) => continue, // Skip buffered pings etc.
                    }
                }
            })
            .await
            .expect("silent client should be disconnected by heartbeat");
            assert!(closed);
        }

        #[tokio::test]
        async fn session_new_rejects_unknown_org() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            // Empty repos_roots -> every org is unknown. It's rejected by org verification and never reaches session creation.
            let port = serve(Some(test_services(hub, vec![]))).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(
                r#"{"t":"session.new","org":"nope"}"#.to_string(),
            ))
            .await
            .unwrap();
            let err = next_text(&mut ws).await;
            assert!(err.contains(r#""t":"error""#) && err.contains("unknown_org"));
        }

        #[tokio::test]
        async fn term_open_on_existing_term_is_term_exists() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let services = test_services(hub, vec![]);
            // An already-registered term is rejected by the term_exists check without touching the PTY.
            services.terms.lock().unwrap().commit(TermEntry::new(
                "t1".to_string(),
                "$1".to_string(),
                80,
                24,
            ));
            let port = serve(Some(services)).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            ws.send(TMsg::Text(
                r#"{"t":"term.open","termId":"t1","cols":80,"rows":24}"#.to_string(),
            ))
            .await
            .unwrap();
            let err = next_text(&mut ws).await;
            assert!(err.contains(r#""t":"error""#) && err.contains("term_exists"));
        }

        #[tokio::test]
        async fn term_ops_on_unknown_term_are_unknown_term() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let port = serve(Some(test_services(hub, vec![]))).await;
            let mut ws = connect(port).await;
            drain_handshake(&mut ws).await;

            for msg in [
                r#"{"t":"term.resize","termId":"x","cols":80,"rows":24}"#,
                r#"{"t":"term.select","termId":"x","windowId":"@2"}"#,
                r#"{"t":"term.close","termId":"x"}"#,
            ] {
                ws.send(TMsg::Text(msg.to_string())).await.unwrap();
                let err = next_error_text(&mut ws).await;
                assert!(
                    err.contains(r#""t":"error""#) && err.contains("unknown_term"),
                    "expected unknown_term for {msg}, got {err}"
                );
            }
        }

        #[tokio::test]
        async fn ws_term_unknown_term_closes_4404() {
            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let port = serve(Some(test_services(hub, vec![]))).await;
            let url = format!("ws://127.0.0.1:{port}/ws/term/nope?token=t");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // An unregistered termId gets close(4404) on the first frame.
            match ws.next().await.expect("frame").expect("ws ok") {
                TMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4404),
                other => panic!("expected close 4404, got {other:?}"),
            }
        }

        /// Smoke test that `/ws/term` bridges to the owned PTY. Checks that content written to the owned PTY's
        /// screen beforehand reaches the WS via the initial replay (redraw sequence) **without sending any input**.
        /// (Input echo can't serve as an identifier, since the PTY line discipline reflects it in the kernel.)
        #[tokio::test]
        async fn ws_term_replays_owned_pty_screen() {
            use crate::pty_host::PtyConfig;
            use portable_pty::CommandBuilder;
            use std::time::Duration;

            let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
            let services = test_services(hub, vec![]);
            let mut cmd = CommandBuilder::new("sh");
            cmd.arg("-c");
            cmd.arg("cat");
            cmd.env("TERM", "xterm-256color");
            services
                .sessions
                .create("sess-owned".to_string(), PtyConfig::new(cmd))
                .await
                .unwrap();
            // Draw a marker onto the owned PTY's screen (cat echoes it -> reflected onto the vt100 screen).
            let session = services.sessions.get("sess-owned").await.unwrap();
            session.write_input(b"OWNED-REPLAY\n").unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(session.screen_contents().contains("OWNED-REPLAY"));

            services.terms.lock().unwrap().commit(TermEntry::new(
                "owned".to_string(),
                "sess-owned".to_string(),
                80,
                24,
            ));
            let port = serve(Some(services)).await;

            let result = async {
                let url = format!("ws://127.0.0.1:{port}/ws/term/owned?token=t");
                let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
                // Send no input. If the marker arrives from the initial replay alone, it's the owned PTY path.
                loop {
                    match ws.next().await {
                        Some(Ok(TMsg::Binary(b)))
                            if String::from_utf8_lossy(&b).contains("OWNED-REPLAY") =>
                        {
                            break true
                        }
                        Some(Ok(_)) => continue,
                        _ => break false,
                    }
                }
            };
            let replayed = tokio::time::timeout(Duration::from_secs(5), result)
                .await
                .unwrap_or(false);
            assert!(replayed, "expected owned PTY screen replay over /ws/term");
        }
    }
}
