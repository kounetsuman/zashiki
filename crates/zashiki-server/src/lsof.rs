//! lsof snapshot adapter for resident background-shell detection.
//! Returns the raw machine-readable output of `lsof -F pfn -a -d 1` (p=pid / f=fd / n=name, fd1 only).
//! Parsing lives in `crate::shells`. lsof commonly exits non-zero while still emitting valid records
//! (some fds are unreadable), so the exit status is not gated; only a spawn failure falls back to an
//! empty string, i.e. treated as no live background shells.

use tokio::process::Command;

/// lsof CLI adapter.
pub struct LsofAdapter;

impl LsofAdapter {
    pub async fn fd1_outputs(&self) -> String {
        Command::new("lsof")
            .args(["-F", "pfn", "-a", "-d", "1"])
            .output()
            .await
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fd1_outputs_lists_pid_and_fd_records() {
        let out = LsofAdapter.fd1_outputs().await;
        assert!(
            out.lines().any(|l| l.starts_with('p')),
            "lsof -F output should contain pid records"
        );
    }
}
