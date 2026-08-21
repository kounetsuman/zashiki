use axum::{extract::State, http::StatusCode, response::Response, Json};
use serde::Deserialize;

use crate::app_state::{resolve_editor, scan, spawn_editor, AppState};
use crate::git;
use crate::wire_support::{
    git_result, guard_file_action, guard_repo, json_error, json_ok, parse_json_body,
};

/// git status for each repo (branch + staged/changed).
pub(crate) async fn git_status(State(state): State<AppState>) -> Json<git::GitStatusResponse> {
    let repos = git::git_status(scan(&state).await).await;
    Json(git::GitStatusResponse { repos })
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

pub(crate) async fn git_stage(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    match guard_file_action(&state, &body).await {
        Err((status, msg)) => json_error(status, &msg),
        Ok((repo_path, file)) => {
            git_result(git::stage(std::path::Path::new(&repo_path), &file).await)
        }
    }
}

pub(crate) async fn git_unstage(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    match guard_file_action(&state, &body).await {
        Err((status, msg)) => json_error(status, &msg),
        Ok((repo_path, file)) => {
            git_result(git::unstage(std::path::Path::new(&repo_path), &file).await)
        }
    }
}

pub(crate) async fn git_open(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
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
        None => {
            let configured = state.control.as_ref().and_then(|c| c.hub.editor_command());
            let editor = resolve_editor(configured.as_deref(), state.editor.as_str());
            spawn_editor(editor, &repo_path, &file);
        }
    }
    json_ok()
}

pub(crate) async fn git_stage_all(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Response {
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

pub(crate) async fn git_unstage_all(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Response {
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

pub(crate) async fn git_commit(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
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

// ---- git write REST + /api/file wiring (real git repo + in-process HTTP) ----

#[cfg(test)]
mod git_file_rest_tests {
    use crate::{build_router, OpenFile, ServerConfig};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    async fn request(
        app: axum::Router,
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
