//! `zashiki-server statusline-hook`: the launch-injected statusLine command. Relays claude's statusLine
//! payload (which alone carries rate_limits) to the running server, and passes the user's own statusLine
//! output through so their status line is preserved. The source of truth for behavior is the `tests` below.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

const POST_TIMEOUT: Duration = Duration::from_secs(1);
const PASSTHROUGH_TIMEOUT: Duration = Duration::from_secs(3);

/// The user's own statusLine command to pass through, or None. Requires `type == "command"`, and skips a
/// command that runs this same binary so the injected override can never recurse into itself.
fn passthrough_command(settings: &Value, self_exe: &str) -> Option<String> {
    let status_line = settings.get("statusLine")?;
    if status_line.get("type").and_then(Value::as_str) != Some("command") {
        return None;
    }
    let command = status_line.get("command").and_then(Value::as_str)?;
    let is_self = !self_exe.is_empty() && command.contains(self_exe);
    (!is_self).then(|| command.to_string())
}

fn token_file() -> PathBuf {
    std::env::var_os("ZK_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".zashiki/token"))
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn port() -> String {
    std::env::var("ZK_PORT").unwrap_or_else(|_| "8790".to_string())
}

/// Best-effort POST of the payload to the running server. Never blocks claude: a short timeout and any
/// error (server down, no token) is swallowed.
fn post_to_server(payload: &str) {
    let Ok(token) = std::fs::read_to_string(token_file()) else {
        return;
    };
    let token = token.trim();
    if token.is_empty() {
        return;
    }
    let url = format!("http://127.0.0.1:{}/api/hooks/statusline", port());
    let _ = ureq::post(&url)
        .set("x-zashiki-token", token)
        .set("content-type", "application/json")
        .timeout(POST_TIMEOUT)
        .send_string(payload);
}

/// Runs the user's own statusLine (resolved from `~/.claude/settings.json`) with the same stdin and returns
/// its stdout, or None when they have none. Bounded by `timeout` so a hanging user command can never leave
/// the hook process resident (claude spawns a fresh one each render).
fn passthrough_output(
    settings_path: &Path,
    self_exe: &str,
    payload: &str,
    timeout: Duration,
) -> Option<String> {
    let settings: Value = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())?;
    let command = passthrough_command(&settings, self_exe)?;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    {
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes());
        }
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Entry point for the subcommand: read the payload, relay it, then emit the user's own statusLine (if any).
pub fn run() {
    let mut payload = String::new();
    let _ = std::io::stdin().read_to_string(&mut payload);
    post_to_server(&payload);
    let self_exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let settings_path = home().join(".claude/settings.json");
    if let Some(out) =
        passthrough_output(&settings_path, &self_exe, &payload, PASSTHROUGH_TIMEOUT)
    {
        print!("{out}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EXE: &str = "/apps/zashiki-server";

    #[test]
    fn passthrough_command_extracts_a_command_statusline() {
        let settings = json!({ "statusLine": { "type": "command", "command": "~/mine.sh" } });
        assert_eq!(
            passthrough_command(&settings, EXE),
            Some("~/mine.sh".to_string())
        );
    }

    #[test]
    fn passthrough_command_none_when_absent_or_not_a_command() {
        assert_eq!(passthrough_command(&json!({}), EXE), None);
        assert_eq!(
            passthrough_command(&json!({ "statusLine": { "type": "static", "command": "x" } }), EXE),
            None
        );
    }

    #[test]
    fn passthrough_command_skips_only_our_own_binary_not_a_lookalike_name() {
        let ours = json!({
            "statusLine": { "type": "command", "command": "'/apps/zashiki-server' statusline-hook" }
        });
        assert_eq!(passthrough_command(&ours, EXE), None);
        // A user command that merely contains the substring "statusline-hook" is still passed through.
        let theirs = json!({
            "statusLine": { "type": "command", "command": "/usr/bin/my-statusline-hook.sh" }
        });
        assert_eq!(
            passthrough_command(&theirs, EXE),
            Some("/usr/bin/my-statusline-hook.sh".to_string())
        );
    }

    #[test]
    fn passthrough_output_runs_the_user_command_with_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"statusLine":{"type":"command","command":"cat"}}"#).unwrap();
        assert_eq!(
            passthrough_output(&path, EXE, "PAYLOAD", Duration::from_secs(3)).as_deref(),
            Some("PAYLOAD")
        );
    }

    #[test]
    fn passthrough_output_none_without_a_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            passthrough_output(&dir.path().join("nope.json"), EXE, "x", Duration::from_secs(3)),
            None
        );
    }

    #[test]
    fn passthrough_output_times_out_a_hanging_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"statusLine":{"type":"command","command":"sleep 30"}}"#).unwrap();
        let started = Instant::now();
        assert_eq!(
            passthrough_output(&path, EXE, "x", Duration::from_millis(150)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
