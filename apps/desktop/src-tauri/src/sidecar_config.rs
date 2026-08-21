//! startup config resolution (pure path/env).

use std::path::{Path, PathBuf};

use super::DEFAULT_PORT;

pub struct Config {
    pub port: u16,
    pub token_path: PathBuf,
    /// The server binary to launch (the Rust zashiki-server), exec'd directly by the sidecar.
    pub server_bin: PathBuf,
    /// The client dist served statically by the server. In the distributed .app this is a bundled
    /// resource (Contents/Resources/client-dist); in dev it may not exist (the dev WebView opens
    /// Vite:5173 and does not use the server's static serving, so a dist that is absent at spawn
    /// time is not passed as ZK_CLIENT_DIST).
    pub client_dist: PathBuf,
    /// The real bundle version (app.package_info().version), passed to the server as ZK_APP_VERSION so it can
    /// compare against GitHub Releases (#26). The server's own Cargo version stays at the 0.0.0 placeholder, so
    /// this is the only channel carrying the real version. Empty / 0.0.0 (dev) disables the server's update check.
    pub app_version: String,
}

impl Config {
    /// Resolves using the same environment variable scheme as the server (ZK_*).
    /// The token and binary can each be overridden so that tests do not touch the real ~/.zashiki.
    pub fn from_env() -> Self {
        let port = std::env::var("ZK_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let token_path = std::env::var("ZK_TOKEN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_token_path());
        let server_bin = std::env::var("ZK_SERVER_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_server_bin());
        let client_dist = std::env::var_os("ZK_CLIENT_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(default_client_dist);
        Self {
            port,
            token_path,
            server_bin,
            client_dist,
            // Filled in from app.package_info().version at setup time (main.rs); the env has no real version here.
            app_version: String::new(),
        }
    }
}

fn default_token_path() -> PathBuf {
    // The server writes to ~/.zashiki/token under $HOME (zashiki-server main.rs).
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".zashiki").join("token")
}

/// Resolves the Rust server binary to launch. In the distributed .app it uses the `zashiki-server`
/// bundled in the same directory as this shell executable; in development it uses the cargo output
/// inside the repository.
fn default_server_bin() -> PathBuf {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let cargo_target =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../crates/zashiki-server/target");
    resolve_server_bin(!cfg!(debug_assertions), exe_dir, &cargo_target)
}

/// Pure logic for resolving the server binary (with current_exe / profile / paths injected from
/// `default_server_bin`).
///
/// - bundled (release build = distributed .app): prefers the bundled sibling `zashiki-server`,
///   falling back to the cargo output (release, then debug) if it is absent.
/// - dev (debug build): does **not** look at the sibling. In tauri's `target/debug`, an externalBin
///   `#!/bin/sh` stub (which exits 0 immediately) can appear under the same name; grabbing it makes
///   the server "exit before startup". In dev, beforeDevCommand builds debug, so it prefers the
///   cargo debug output and falls back to release if absent.
fn resolve_server_bin(bundled: bool, exe_dir: Option<&Path>, cargo_target: &Path) -> PathBuf {
    let release = cargo_target.join("release/zashiki-server");
    let debug = cargo_target.join("debug/zashiki-server");
    if bundled {
        if let Some(sibling) = exe_dir.map(|dir| dir.join("zashiki-server")) {
            if sibling.is_file() {
                return sibling;
            }
        }
        if release.is_file() {
            return release;
        }
        return debug;
    }
    if debug.is_file() {
        return debug;
    }
    release
}

/// Resolves the client dist served statically by the server. In the distributed .app it points from
/// the executable (Contents/MacOS/Zashiki) to `../Resources/client-dist` (the bundled resource);
/// in development it points to the repository's `packages/client/dist` (in dev it may be absent
/// since the WebView opens Vite:5173).
fn default_client_dist() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = bundled_client_dist(dir);
            if bundled.is_dir() {
                return bundled;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/client/dist")
}

/// Pure function deriving the path to the bundled client dist (Contents/Resources/client-dist)
/// from the distributed .app's executable directory (Contents/MacOS).
/// Corresponds to `bundle.resources` in tauri.conf.json (client-dist -> Contents/Resources/client-dist).
fn bundled_client_dist(exe_dir: &Path) -> PathBuf {
    exe_dir.join("../Resources/client-dist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_server_bin_はbundledで同梱兄弟を最優先する() {
        // Distributed .app: use the zashiki-server next to the executable (Contents/MacOS/Zashiki).
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("MacOS");
        std::fs::create_dir(&exe_dir).unwrap();
        let sibling = exe_dir.join("zashiki-server");
        std::fs::write(&sibling, "REAL").unwrap();
        // Even if cargo output exists, the sibling (bundled resource) wins.
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        std::fs::write(cargo.join("release/zashiki-server"), "bin").unwrap();
        assert_eq!(resolve_server_bin(true, Some(&exe_dir), &cargo), sibling);
    }

    #[test]
    fn resolve_server_bin_はbundledで兄弟不在時にrelease出力へ落ちる() {
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("MacOS");
        std::fs::create_dir(&exe_dir).unwrap(); // no sibling
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        let release = cargo.join("release/zashiki-server");
        std::fs::write(&release, "bin").unwrap();
        assert_eq!(resolve_server_bin(true, Some(&exe_dir), &cargo), release);
    }

    #[test]
    fn resolve_server_bin_はdevで兄弟スタブを無視しcargo_debugを使う() {
        // Grabbing the #!/bin/sh stub (which exits 0 immediately) that appears in tauri's target/debug
        // as the sibling causes "server exited before startup (exit status: 0)". In dev it does not
        // look at the sibling and uses the cargo debug output (built by beforeDevCommand).
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("target/debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let stub = exe_dir.join("zashiki-server");
        std::fs::write(&stub, "#!/bin/sh\n").unwrap(); // sibling stub
        let cargo = dir.path().join("crates-target");
        std::fs::create_dir_all(cargo.join("debug")).unwrap();
        let real = cargo.join("debug/zashiki-server");
        std::fs::write(&real, "REAL").unwrap();
        let got = resolve_server_bin(false, Some(&exe_dir), &cargo);
        assert_eq!(got, real, "dev は兄弟スタブではなく cargo debug 出力を使うべき");
        assert_ne!(got, stub);
    }

    #[test]
    fn resolve_server_bin_はdevでdebug不在時にrelease出力へ落ちる() {
        let dir = tempfile::tempdir().unwrap();
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        let release = cargo.join("release/zashiki-server");
        std::fs::write(&release, "bin").unwrap();
        // No debug output -> fall back to release.
        assert_eq!(resolve_server_bin(false, None, &cargo), release);
    }

    #[test]
    fn bundled_client_dist_は実行体ディレクトリからresources配下を指す() {
        // Distributed .app: the executable is Contents/MacOS/Zashiki, the client dist is Contents/Resources/client-dist.
        // Pins the contract corresponding to the bundle.resources placement (client-dist) in tauri.conf.json.
        let exe_dir = Path::new("/Applications/Zashiki.app/Contents/MacOS");
        assert_eq!(
            bundled_client_dist(exe_dir),
            PathBuf::from("/Applications/Zashiki.app/Contents/MacOS/../Resources/client-dist")
        );
    }
}
