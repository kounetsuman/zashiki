//! ps snapshot adapter.
//! Returns the raw output of `ps -Aww -o pid=,ppid=,args=`. Parsing lives in `zashiki_core::process_tree`.
//! On failure (cannot spawn / non-zero exit) it falls back to an empty string, i.e. treated as no process tree (no claude).

use tokio::process::Command;

/// ps CLI adapter.
pub struct PsAdapter;

impl PsAdapter {
    pub async fn snapshot(&self) -> String {
        Command::new("ps")
            .args(["-Aww", "-o", "pid=,ppid=,args="])
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }

    /// Snapshot including stat (for zombie/Z detection) and etime (elapsed time), used for orphan/zombie detection.
    /// Parsing lives in `zashiki_server::orphan_detector::parse_ps_orphan`. Empty string on failure.
    pub async fn snapshot_extended(&self) -> String {
        Command::new("ps")
            .args(["-Aww", "-o", "pid=,ppid=,stat=,etime=,args="])
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zashiki_core::process_tree::parse_ps_snapshot;

    #[tokio::test]
    async fn snapshot_lists_our_own_process() {
        let out = PsAdapter.snapshot().await;
        assert!(!out.is_empty(), "ps snapshot should not be empty");
        let entries = parse_ps_snapshot(&out);
        let my_pid = std::process::id() as i64;
        assert!(
            entries.iter().any(|e| e.pid == my_pid),
            "ps snapshot should include our own pid {my_pid}"
        );
    }
}
