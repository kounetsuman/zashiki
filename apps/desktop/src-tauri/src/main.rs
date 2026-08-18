#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pages;
mod sidecar;

use std::process::Child;
use std::sync::{Arc, Mutex};

use sidecar::Config;

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

fn main() {
    let cfg = Config::from_env();
    let base = base_url(&cfg);
    // If debug is ON in the same config.json as the server (~/.zashiki/config.json), enable
    // the WebView's devtools (web inspector). dev (tauri dev) is always enabled;
    // builds produced by tauri build depend on the setting. The dev check uses the same tauri::is_dev() as base_url.
    let devtools = sidecar::devtools_enabled(
        sidecar::read_debug_flag(&sidecar::config_path_from_env()),
        tauri::is_dev(),
    );
    // The Child of the spawned server (None when riding along with an existing one).
    // We hold it in an Arc on the main side rather than as managed state inside setup so that it
    // isn't orphaned even on failure paths after a successful setup (= paths where RunEvent::Exit doesn't fire).
    let owned_server: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    let owned_in_setup = Arc::clone(&owned_server);
    let build_result = tauri::Builder::default()
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
            .devtools(devtools)
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
    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            shutdown_owned(&owned_on_exit);
        }
    });
}

fn shutdown_owned(slot: &Arc<Mutex<Option<Child>>>) {
    let child = slot.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        sidecar::shutdown(&mut child, sidecar::SHUTDOWN_GRACE);
    }
}
