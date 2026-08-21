#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pages;
mod sidecar;

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sidecar::Config;
use tauri::Manager;

/// Even in Tauri mode, the shell opens the server's URL directly (it does not use tauri://).
/// This keeps the page Origin as an http://127.0.0.1-style origin, so the server's Origin validation doesn't need to change.
fn base_url(cfg: &Config) -> String {
    if let Ok(url) = std::env::var("ZK_SHELL_URL") {
        return url;
    }
    if tauri::is_dev() {
        // tauri dev: the Vite server started by beforeDevCommand (same setup as the client's README)
        "http://localhost:5173".to_string()
    } else {
        format!("http://127.0.0.1:{}", cfg.port)
    }
}

/// Opens the WebView inspector for the in-app Developer mode.
#[tauri::command]
fn open_devtools(webview: tauri::WebviewWindow) {
    webview.open_devtools();
}

fn main() {
    let cfg = Config::from_env();
    let base = base_url(&cfg);
    // The Child of the spawned server (None when riding along with an existing one).
    // We hold it in an Arc on the main side rather than as managed state inside setup so that it
    // isn't orphaned even on failure paths after a successful setup (= paths where RunEvent::Exit doesn't fire).
    let owned_server: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    // Guarded quit (#65): before tearing down the sidecar, ask the server whether any session /
    // agent / background shell is running and, if so, confirm. `quitting` lets the eventual real exit
    // pass through; `deciding` serializes decisions so repeated quit gestures don't stack dialogs.
    let quit_port = cfg.port;
    let quit_token_path = cfg.token_path.clone();
    let quitting = Arc::new(AtomicBool::new(false));
    let deciding = Arc::new(AtomicBool::new(false));

    let win_quitting = Arc::clone(&quitting);
    let win_deciding = Arc::clone(&deciding);
    let win_token = quit_token_path.clone();

    let owned_in_setup = Arc::clone(&owned_server);
    let build_result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_devtools])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if win_quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                request_guarded_quit(
                    window.app_handle().clone(),
                    Arc::clone(&win_quitting),
                    Arc::clone(&win_deciding),
                    quit_port,
                    win_token.clone(),
                );
            }
        })
        .setup(move |app| {
            // Tauri v2 internally converts an Err from setup into a panic, and because this runs inside
            // did_finish_launching (extern "C") it cannot unwind, resulting in SIGABRT.
            // So we must not return an Err from here on sidecar-startup failure.
            // Show the loading page immediately and start the sidecar on a background thread
            // (not blocking the main thread = resolving the perceived "hang").
            let loading: tauri::Url = pages::data_url(&pages::loading_html())
                .parse()
                .expect("data URL は常にパース可能");
            let window = match tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(loading),
            )
            .title("Zashiki")
            .inner_size(1280.0, 840.0)
            // Always inspectable so the in-app Developer mode can open the inspector in release too.
            .devtools(true)
            // WKWebView's OS-level drag-drop handler swallows HTML5 dragover/drop events,
            // which breaks in-page tab reordering. Disable it so DOM drag-and-drop works.
            .disable_drag_drop_handler()
            .build()
            {
                Ok(window) => window,
                Err(e) => {
                    // In an environment where the window itself can't be created, there's no surface to show the user.
                    // Log to stderr and exit gracefully (child cleanup happens via the Exit event).
                    eprintln!("zashiki: ウィンドウの生成に失敗しました: {e}");
                    app.handle().exit(1);
                    return Ok(());
                }
            };

            // setup is FnOnce, so cfg/base can be moved in directly.
            // The real bundle version lives in the shell (tauri.conf.json, injected at release), not the
            // server's Cargo version. Hand it to the server via ZK_APP_VERSION for the update check (#26).
            let mut cfg = cfg;
            cfg.app_version = app.package_info().version.to_string();
            let owned_slot = Arc::clone(&owned_in_setup);
            std::thread::spawn(move || match sidecar::start(&cfg, &base) {
                Ok((url, owned)) => {
                    *owned_slot.lock().unwrap() = owned;
                    match url.parse::<tauri::Url>() {
                        Ok(parsed) => {
                            if let Err(e) = window.navigate(parsed) {
                                eprintln!("zashiki: 初期 URL への遷移に失敗しました: {e}");
                            }
                        }
                        Err(e) => eprintln!("zashiki: 初期 URL が不正です（{url}）: {e}"),
                    }
                }
                Err(msg) => {
                    // start() has already cleaned up the child it spawned. Here we only display the error and
                    // leave the window open, waiting for the user to close it (closing it exits normally).
                    eprintln!("zashiki シェルの起動に失敗しました:\n{msg}");
                    if let Ok(err_url) = pages::data_url(&pages::error_html(&msg)).parse() {
                        let _ = window.navigate(err_url);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match build_result {
        Ok(app) => app,
        Err(e) => {
            shutdown_owned(&owned_server);
            eprintln!("zashiki シェルの起動に失敗: {e}");
            std::process::exit(1);
        }
    };

    // Clean up the sidecar on SIGTERM/SIGINT as well (measured: on an abrupt signal death, RunEvent::Exit
    // doesn't fire and the spawned server is orphaned). Clean up directly on the signal thread and then
    // exit (since we take from the Mutex, it won't double-kill even if it overlaps with the Exit path).
    #[cfg(unix)]
    {
        let owned_on_signal = Arc::clone(&owned_server);
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            use signal_hook::consts::{SIGINT, SIGTERM};
            if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGINT, SIGTERM]) {
                if signals.forever().next().is_some() {
                    eprintln!("zashiki: シグナル受信 → sidecar を掃除して終了します");
                    shutdown_owned(&owned_on_signal);
                    handle.exit(0);
                }
            }
        });
    }

    let owned_on_exit = Arc::clone(&owned_server);
    let run_quitting = Arc::clone(&quitting);
    let run_deciding = Arc::clone(&deciding);
    let run_token = quit_token_path.clone();
    app.run(move |app_handle, event| match event {
        // User quit gestures (Cmd+Q / menu / `osascript ... to quit`) arrive with code=None;
        // programmatic exits carry Some(code) and pass straight through. `quitting` guards against
        // re-entering on our own exit. The window close button is handled by on_window_event.
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_some() || run_quitting.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            request_guarded_quit(
                app_handle.clone(),
                Arc::clone(&run_quitting),
                Arc::clone(&run_deciding),
                quit_port,
                run_token.clone(),
            );
        }
        tauri::RunEvent::Exit => shutdown_owned(&owned_on_exit),
        _ => {}
    });
}

/// What to do about a quit request, given the server's activity (`None` = server unreachable / token
/// unreadable). Pure so the branch matrix is unit-testable without Tauri.
enum QuitDecision {
    Proceed,
    Confirm(String),
}

fn quit_decision(activity: Option<sidecar::Activity>) -> QuitDecision {
    match activity {
        Some(a) if a.is_busy() => QuitDecision::Confirm(a.summary()),
        _ => QuitDecision::Proceed,
    }
}

/// Off the main thread (dialogs must not block the run loop), decides whether to proceed with the
/// quit and, if so, flips `quitting` and triggers the real exit (which runs the normal graceful
/// shutdown). `deciding` serializes decisions so repeated quit gestures don't stack dialogs, and the
/// drop guard clears it even if the dialog panics during event-loop teardown (so quit can't wedge).
fn request_guarded_quit(
    app: tauri::AppHandle,
    quitting: Arc<AtomicBool>,
    deciding: Arc<AtomicBool>,
    port: u16,
    token_path: PathBuf,
) {
    if deciding.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let _clear = ClearOnDrop(deciding);
        let activity = sidecar::read_token(&token_path)
            .ok()
            .and_then(|token| sidecar::fetch_activity(port, &token));
        let proceed = match quit_decision(activity) {
            QuitDecision::Proceed => true,
            QuitDecision::Confirm(summary) => confirm_quit(&app, &summary),
        };
        if proceed {
            quitting.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    });
}

struct ClearOnDrop(Arc<AtomicBool>);

impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn confirm_quit(app: &tauri::AppHandle, summary: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(format!("{summary}.\n\nQuitting will stop them."))
        .title("Quit Zashiki?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sidecar::Activity;

    #[test]
    fn quit_decision_proceeds_when_server_unreachable() {
        assert!(matches!(quit_decision(None), QuitDecision::Proceed));
    }

    #[test]
    fn quit_decision_proceeds_when_nothing_running() {
        let idle = Activity {
            active_sessions: 0,
            running_subagents: 0,
            background_shells: 0,
        };
        assert!(matches!(quit_decision(Some(idle)), QuitDecision::Proceed));
    }

    #[test]
    fn quit_decision_confirms_with_summary_when_busy() {
        let busy = Activity {
            active_sessions: 2,
            running_subagents: 0,
            background_shells: 1,
        };
        match quit_decision(Some(busy)) {
            QuitDecision::Confirm(summary) => {
                assert_eq!(summary, "2 sessions, 1 background shell still running");
            }
            QuitDecision::Proceed => panic!("busy activity should confirm"),
        }
    }
}

fn shutdown_owned(slot: &Arc<Mutex<Option<Child>>>) {
    let child = slot.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        sidecar::shutdown(&mut child, sidecar::SHUTDOWN_GRACE);
    }
}
