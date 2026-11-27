#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Compiled everywhere, wired up only on macOS: CI checks and tests this crate on Linux, and the
// test that pins the menu's event names to the page has to run there too.
mod ipc_capability;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod menu;
mod navigation;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod opened_files;
mod pages;
mod picked_media;
mod popout;
mod quit_log;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod quit_source;
#[cfg(target_os = "macos")]
mod share;
mod sidecar;
#[cfg(target_os = "macos")]
mod terminate_guard;
#[cfg(target_os = "macos")]
mod wake;

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use sidecar::Config;
use tauri::{Emitter, Manager};

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

/// The dashboard overlay frames the configured page inside the window, so the navigation guard lets
/// that page's origin through as well. The app reports the configured address whenever it changes;
/// one that is not an http(s) address clears the allowance.
#[tauri::command]
fn set_dashboard_origin(dashboard: tauri::State<'_, DashboardOrigin>, url: String) {
    *dashboard.0.lock().unwrap() = navigation::dashboard_origin(&url);
}

#[derive(Default)]
struct DashboardOrigin(Mutex<Option<String>>);

/// Opens a web link the user clicked in the default browser. The page sends its links here because
/// macOS WebKit puts a link that opens a new window through the navigation guard first, which
/// refuses it before the new-window handler is reached.
#[tauri::command]
fn open_in_browser(
    guard: tauri::State<'_, Arc<navigation::Guard>>,
    url: String,
) -> Result<(), String> {
    let url: tauri::Url = url.parse().map_err(|_| "not a URL".to_string())?;
    if !navigation::opens_in_browser(&url, guard.app_origins()) {
        return Err("not a web page outside the app".to_string());
    }
    navigation::open_in_browser(&url);
    Ok(())
}

/// Opens the macOS share sheet for `text`, pointing at `anchor` (the Share button's rect).
#[cfg(target_os = "macos")]
#[tauri::command]
fn share_text(webview: tauri::Webview, text: String, anchor: share::Anchor) -> Result<(), String> {
    webview
        .with_webview(move |platform| share::show(platform.inner(), &text, anchor))
        .map_err(|e| e.to_string())
}

/// The share sheet is macOS-only; elsewhere the call is rejected.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn share_text(text: String) -> Result<(), String> {
    let _ = text;
    Err("unsupported".to_string())
}

/// Opens the pop-out window of a cockpit terminal at `url` (a page on the app's own origin), or brings
/// it to the front when it is already open. `x`/`y` place a new window where a dragged tab was let go.
/// Async because creating a window from a synchronous command can deadlock the event loop.
#[tauri::command]
async fn open_popout(
    app: tauri::AppHandle,
    guard: tauri::State<'_, Arc<navigation::Guard>>,
    cockpit_terminal_id: String,
    url: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = popout::find(&app, &cockpit_terminal_id) {
        popout::bring_to_front(&window);
        return Ok(());
    }
    let url: tauri::Url = url.parse().map_err(|_| "not a URL".to_string())?;
    let app_origins = guard.app_origins().to_vec();
    if !matches!(url.scheme(), "http" | "https")
        || !navigation::may_navigate(&url, &app_origins, false)
    {
        return Err("not a page of the app".to_string());
    }
    let browser_origins = app_origins.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        popout::label_for(&cockpit_terminal_id),
        tauri::WebviewUrl::External(url),
    )
    .title(title)
    .inner_size(900.0, 600.0)
    .devtools(true)
    .disable_drag_drop_handler()
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    })
    .on_navigation(move |url| navigation::may_navigate(url, &app_origins, false))
    .on_new_window(move |url, _features| {
        if navigation::opens_in_browser(&url, &browser_origins) {
            navigation::open_in_browser(&url);
        }
        tauri::webview::NewWindowResponse::Deny
    });
    if let (Some(x), Some(y)) = (x, y) {
        builder = builder.position(x, y);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Brings a cockpit terminal's pop-out window to the front; false when it has none.
#[tauri::command]
fn focus_popout(app: tauri::AppHandle, cockpit_terminal_id: String) -> bool {
    let window = popout::find(&app, &cockpit_terminal_id);
    if let Some(window) = &window {
        popout::bring_to_front(window);
    }
    window.is_some()
}

/// Closes a cockpit terminal's pop-out window, after which the main window hears
/// `zashiki:popout-closed`; false when it has none.
#[tauri::command]
fn close_popout(app: tauri::AppHandle, cockpit_terminal_id: String) -> bool {
    let window = popout::find(&app, &cockpit_terminal_id);
    if let Some(window) = &window {
        let _ = window.close();
    }
    window.is_some()
}

/// The cockpit terminals whose pop-out window is open, for a main page that has just (re)loaded.
#[tauri::command]
fn list_popouts(app: tauri::AppHandle) -> Vec<String> {
    popout::open_ids(&app)
}

/// One file chosen via the native open dialog: its text, the id to fetch a media file's bytes by
/// (`read_picked_media`), or the stable code ("tooLarge" / "readFailed") saying why it could not be
/// read, so the UI can name it in a specific message.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(untagged)]
enum PickedFile {
    Read {
        name: String,
        content: String,
    },
    Media {
        name: String,
        #[serde(rename = "mediaId")]
        media_id: u64,
    },
    Failed {
        name: String,
        error: &'static str,
    },
}

/// What a pick or an Open With reads with: the text size cap and the extensions held as media
/// instead (media has no cap, like a dropped file).
struct PickReader<'a> {
    max_bytes: u64,
    media_extensions: &'a [String],
    media: &'a picked_media::PickedMedia,
}

fn read_picked_file(path: &std::path::Path, reader: &PickReader) -> PickedFile {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let failed = |error| PickedFile::Failed {
        name: name.clone(),
        error,
    };
    if picked_media::is_media(path, reader.media_extensions) {
        return PickedFile::Media {
            name: name.clone(),
            media_id: reader.media.hold(path),
        };
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > reader.max_bytes => return failed("tooLarge"),
        Ok(_) => {}
        Err(_) => return failed("readFailed"),
    }
    match std::fs::read_to_string(path) {
        Ok(content) => PickedFile::Read {
            name: name.clone(),
            content,
        },
        Err(_) => failed("readFailed"),
    }
}

/// Cmd+O: shows the native open dialog (with a localized title passed from the UI), allowing several
/// files, and returns each chosen file in order. Returns an empty list when the user cancels.
/// `max_bytes` is the single source of truth for the size cap (the client passes the configured
/// `fileSizeLimits.maxBytes`). The picker and the reads run off the async runtime (blocking_pick_files dispatches
/// the modal to the main thread itself).
#[tauri::command]
async fn pick_and_read_files(
    app: tauri::AppHandle,
    title: String,
    max_bytes: u64,
    media_extensions: Vec<String>,
) -> Result<Vec<PickedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let reader = PickReader {
            max_bytes,
            media_extensions: &media_extensions,
            media: &app.state::<picked_media::PickedMedia>(),
        };
        app.dialog()
            .file()
            .set_title(&title)
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|file_path| {
                let shown = file_path.to_string();
                match file_path.into_path() {
                    Ok(path) => read_picked_file(&path, &reader),
                    Err(_) => PickedFile::Failed {
                        name: shown,
                        error: "readFailed",
                    },
                }
            })
            .collect()
    })
    .await
    .map_err(|_| "readFailed".to_string())
}

/// Reads the files macOS handed to the app since the last call (see `opened_files`), the same way
/// as Cmd+O.
#[tauri::command]
async fn take_opened_files(
    app: tauri::AppHandle,
    max_bytes: u64,
    media_extensions: Vec<String>,
) -> Result<Vec<PickedFile>, String> {
    let paths = app.state::<opened_files::OpenedFiles>().take();
    tauri::async_runtime::spawn_blocking(move || {
        let reader = PickReader {
            max_bytes,
            media_extensions: &media_extensions,
            media: &app.state::<picked_media::PickedMedia>(),
        };
        paths
            .iter()
            .map(|path| read_picked_file(path, &reader))
            .collect()
    })
    .await
    .map_err(|_| "readFailed".to_string())
}

/// The bytes of a media file a pick or an Open With returned the id of, sent as a raw binary
/// response (an ArrayBuffer on the page). Each id reads once.
#[tauri::command]
async fn read_picked_media(
    app: tauri::AppHandle,
    media_id: u64,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<picked_media::PickedMedia>().read(media_id)
    })
    .await
    .ok()
    .flatten()
    .map(tauri::ipc::Response::new)
    .ok_or_else(|| "readFailed".to_string())
}

/// Reply channels the quit thread hands to the WebView. The quit gesture runs off the main thread
/// and asks the WebView two things (Is the Memo dirty? Did the save finish?), each tagged with a
/// request number the WebView echoes back.
#[derive(Default)]
struct QuitBridge {
    next_request: AtomicU64,
    dirty: Mutex<Option<PendingReply>>,
    saved: Mutex<Option<PendingReply>>,
    /// Whether the app has been pointed at the window yet. Until it has, the window still shows the
    /// startup or error page, which has no Memo and no listener, so a quit would wait out both
    /// timeouts and then ask about unsaved edits that cannot exist. Set when the navigation is
    /// dispatched, not when the app has finished loading: quitting during the load still falls
    /// through to the guard, which is the safe direction.
    app_loaded: AtomicBool,
}

/// The request the quit thread is currently waiting on, and where to deliver its answer.
struct PendingReply {
    request: u64,
    tx: mpsc::Sender<bool>,
}

/// The request number travels with the event so an answer can be matched to its question.
#[derive(Clone, serde::Serialize)]
struct MemoRequest {
    request: u64,
}

/// Delivers an answer only when it belongs to the request still being waited on. A late answer to a
/// request that already timed out would otherwise be read as the answer to the current one — the
/// save retry asks again while the previous save may still be running.
///
/// The number orders answers; it does not authenticate them. The capability grants these commands to
/// the local server origin, so whatever the WebView loads from there is already trusted to speak for
/// the Memo — the same boundary every other app command sits behind.
fn deliver(slot: &Mutex<Option<PendingReply>>, request: u64, answer: bool) {
    if let Some(pending) = slot.lock().unwrap().as_ref() {
        if pending.request == request {
            let _ = pending.tx.send(answer);
        }
    }
}

/// The WebView's answer to `zashiki:memo-check`: whether the Memo has unsaved edits.
#[tauri::command]
fn report_memo_status(bridge: tauri::State<'_, QuitBridge>, request: u64, dirty: bool) {
    deliver(&bridge.dirty, request, dirty);
}

/// The WebView's answer to `zashiki:memo-save`: whether the flush actually landed (`ok`).
#[tauri::command]
fn report_memo_saved(bridge: tauri::State<'_, QuitBridge>, request: u64, ok: bool) {
    deliver(&bridge.saved, request, ok);
}

fn main() {
    // The quit sequence runs off the main thread and its trace is the only record of why a quit did
    // not happen; a panic there must not end that trace in silence.
    quit_log::install_panic_logger();
    // Paired with the clean-exit line: a start with no clean exit before it means the last run crashed.
    quit_log::log(&format!("started (pid {})", std::process::id()));
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
    #[cfg(target_os = "macos")]
    let (term_quitting, term_deciding, term_token) = (
        Arc::clone(&quitting),
        Arc::clone(&deciding),
        quit_token_path.clone(),
    );

    let owned_in_setup = Arc::clone(&owned_server);
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Only macOS gets a menu from Tauri, and only there does the menu take the keystroke before the
    // WebView; elsewhere a menu bar of our own would newly swallow Ctrl+Z on its way to the terminal.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    let build_result = builder
        .manage(QuitBridge::default())
        .manage(DashboardOrigin::default())
        .manage(opened_files::OpenedFiles::default())
        .manage(picked_media::PickedMedia::default())
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            open_in_browser,
            pick_and_read_files,
            report_memo_status,
            report_memo_saved,
            set_dashboard_origin,
            share_text,
            open_popout,
            focus_popout,
            close_popout,
            list_popouts,
            take_opened_files,
            read_picked_media
        ])
        .on_window_event(move |window, event| {
            // Closing a pop-out only puts its terminal back; the quit guard is the main window's.
            if popout::is_popout(window.label()) {
                if let tauri::WindowEvent::Destroyed = event {
                    popout::on_destroyed(
                        window.app_handle(),
                        window.label(),
                        win_quitting.load(Ordering::SeqCst),
                    );
                }
                return;
            }
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
                    "window close button".to_string(),
                );
            }
        })
        .setup(move |app| {
            // Tauri v2 internally converts an Err from setup into a panic, and because this runs inside
            // did_finish_launching (extern "C") it cannot unwind, resulting in SIGABRT.
            // So we must not return an Err from here on sidecar-startup failure.
            grant_app_commands(app, &base);
            // Show the loading page immediately and start the sidecar on a background thread
            // (not blocking the main thread = resolving the perceived "hang").
            let guard = Arc::new(navigation::Guard::new(navigation::app_origins(
                &base, cfg.port,
            )));
            app.manage(Arc::clone(&guard));
            let new_window_guard = Arc::clone(&guard);
            let guard_handle = app.handle().clone();
            let loading: tauri::Url = pages::data_url(&pages::loading_html())
                .parse()
                .expect("data URL は常にパース可能");
            let builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(loading))
                    .title("Zashiki")
                    .inner_size(1280.0, 840.0)
                    // Always inspectable so the in-app Developer mode can open the inspector in release too.
                    .devtools(true)
                    // WKWebView's OS-level drag-drop handler swallows HTML5 dragover/drop events,
                    // which breaks in-page tab reordering. Disable it so DOM drag-and-drop works.
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| {
                        let dashboard = guard_handle.state::<DashboardOrigin>();
                        let dashboard_origin = dashboard.0.lock().unwrap().clone();
                        guard.allows(url, dashboard_origin)
                    })
                    .on_new_window(move |url, _features| {
                        if navigation::opens_in_browser(&url, new_window_guard.app_origins()) {
                            navigation::open_in_browser(&url);
                        }
                        tauri::webview::NewWindowResponse::Deny
                    });
            // Overlay the title bar so the webview reaches into it; the account indicator sits there,
            // right of the native traffic lights. macOS-only builder method.
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
            let window = match builder.build() {
                Ok(window) => window,
                Err(e) => {
                    // In an environment where the window itself can't be created, there's no surface to show the user.
                    // Log to stderr and exit gracefully (child cleanup happens via the Exit event).
                    quit_log::log(&format!(
                        "exiting: the main window could not be created: {e}"
                    ));
                    app.handle().exit(1);
                    return Ok(());
                }
            };

            #[cfg(target_os = "macos")]
            wake::forward_system_wake(app.handle().clone());
            #[cfg(target_os = "macos")]
            guard_system_quits(
                app.handle().clone(),
                term_quitting,
                term_deciding,
                quit_port,
                term_token,
            );

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
                        Ok(_) => match window.eval(pages::redirect_script(&url)) {
                            Ok(()) => window
                                .app_handle()
                                .state::<QuitBridge>()
                                .app_loaded
                                .store(true, Ordering::SeqCst),
                            Err(e) => {
                                eprintln!("zashiki: 初期 URL への遷移に失敗しました: {e}")
                            }
                        },
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
            quit_log::log(&format!("exiting: the shell could not be built: {e}"));
            std::process::exit(1);
        }
    };

    // Clean up the sidecar on SIGTERM/SIGINT as well (measured: on an abrupt signal death, RunEvent::Exit
    // doesn't fire and the spawned server is orphaned). Clean up directly on the signal thread and then
    // exit (since we take from the Mutex, it won't double-kill even if it overlaps with the Exit path).
    #[cfg(unix)]
    {
        let owned_on_signal = Arc::clone(&owned_server);
        let signal_quitting = Arc::clone(&quitting);
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            use signal_hook::consts::{SIGINT, SIGTERM};
            use signal_hook::iterator::{exfiltrator::WithOrigin, SignalsInfo};
            if let Ok(mut signals) = SignalsInfo::<WithOrigin>::new([SIGINT, SIGTERM]) {
                if let Some(origin) = signals.forever().next() {
                    quit_log::log(&format!(
                        "exiting on {}",
                        quit_source::describe_signal(
                            signal_name(origin.signal),
                            origin.process.map(signal_sender).as_ref()
                        )
                    ));
                    signal_quitting.store(true, Ordering::SeqCst);
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
        // On macOS ⌘Q, the menu, Dock and Apple Event quits are taken by `terminate_guard` and the
        // close button by on_window_event; what reaches here is Tauri's own request, without a code
        // when no window is left and with one for a programmatic exit, which passes straight through.
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
                "Tauri exit request with no exit code".to_string(),
            );
        }
        tauri::RunEvent::Exit => {
            shutdown_owned(&owned_on_exit);
            quit_log::log("exited cleanly");
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => receive_opened_files(app_handle, &urls),
        _ => {}
    });
}

/// Queues the files and brings the window forward. The page takes them on the event, or on load when
/// they arrive before it is listening.
#[cfg(target_os = "macos")]
fn receive_opened_files(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    if !app.state::<opened_files::OpenedFiles>().push(urls) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit(opened_files::OPENED_EVENT, ()) {
        eprintln!("zashiki: failed to forward the opened files: {e}");
    }
}

/// Grants the app commands to the origin the window is about to be served from, and to nothing else.
fn grant_app_commands(app: &tauri::App, base: &str) {
    let Some(origin) = navigation::web_origin_of(base) else {
        eprintln!("zashiki: no web origin in {base}; the app commands stay unreachable");
        return;
    };
    let configured = ipc_capability::configured_app_origin(app.config(), tauri::is_dev());
    for template in [ipc_capability::TEMPLATE, ipc_capability::POPOUT_TEMPLATE] {
        let capability = ipc_capability::for_origin(template, &origin, configured.as_deref());
        if let Err(e) = app.add_capability(capability) {
            eprintln!("zashiki: could not grant the app commands to {origin}: {e}");
        }
    }
}

/// The confirmation every quit asks for, worded by the server's activity (`None` = server
/// unreachable / token unreadable).
#[derive(Debug, PartialEq, Eq)]
struct QuitPrompt {
    message: String,
    confirm_label: &'static str,
}

fn quit_prompt(activity: Option<sidecar::Activity>) -> QuitPrompt {
    match activity {
        Some(a) if a.is_busy() => QuitPrompt {
            message: format!("{}.\n\nQuitting will stop them.", a.summary()),
            confirm_label: "Quit anyway",
        },
        _ => QuitPrompt {
            message: "Every Cockpit Terminal will close.".to_string(),
            confirm_label: "Quit",
        },
    }
}

#[cfg(target_os = "macos")]
fn guard_system_quits(
    app: tauri::AppHandle,
    quitting: Arc<AtomicBool>,
    deciding: Arc<AtomicBool>,
    port: u16,
    token_path: PathBuf,
) {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        quit_log::log("not on the main thread; ⌘Q and system quits stay unguarded");
        return;
    };
    let installed = terminate_guard::install(
        mtm,
        Box::new(move |source| {
            if quitting.load(Ordering::SeqCst) {
                return true;
            }
            request_guarded_quit(
                app.clone(),
                Arc::clone(&quitting),
                Arc::clone(&deciding),
                port,
                token_path.clone(),
                source,
            );
            false
        }),
    );
    if let Err(e) = installed {
        quit_log::log(&format!("⌘Q and system quits stay unguarded: {e}"));
    }
}

#[cfg(unix)]
fn signal_name(signal: i32) -> &'static str {
    match signal {
        signal_hook::consts::SIGTERM => "SIGTERM",
        signal_hook::consts::SIGINT => "SIGINT",
        _ => "a signal",
    }
}

#[cfg(unix)]
fn signal_sender(process: signal_hook::low_level::siginfo::Process) -> quit_source::Sender {
    #[cfg(target_os = "macos")]
    let name = terminate_guard::process_name(process.pid);
    #[cfg(not(target_os = "macos"))]
    let name = None;
    quit_source::Sender {
        pid: process.pid,
        name,
    }
}

/// Off the main thread (dialogs must not block the run loop), decides whether to proceed with the
/// quit and, if so, flips `quitting` and triggers the real exit (which runs the normal graceful
/// shutdown). `deciding` serializes decisions so repeated quit gestures don't stack dialogs, and the
/// drop guard clears it even if the dialog panics during event-loop teardown (so quit can't wedge).
///
/// Every branch is traced to `quit_log`: a quit that refuses to happen shows nothing in the UI, so
/// the log is the only place the reason can be read afterwards.
fn request_guarded_quit(
    app: tauri::AppHandle,
    quitting: Arc<AtomicBool>,
    deciding: Arc<AtomicBool>,
    port: u16,
    token_path: PathBuf,
    source: String,
) {
    if deciding.swap(true, Ordering::SeqCst) {
        quit_log::log(&format!(
            "quit requested ({source}) while an earlier quit decision was still open; ignored"
        ));
        return;
    }
    std::thread::spawn(move || {
        let _clear = ClearOnDrop(deciding);
        quit_log::log(&format!("quit requested ({source})"));
        // Memo guard first: unsaved edits are the data loss the user cares about most, and a Cancel
        // here aborts the whole quit before we even look at running sessions.
        if !app.state::<QuitBridge>().app_loaded.load(Ordering::SeqCst) {
            // Nothing has been pointed at the window yet, so it is still the startup or error page:
            // no Memo to lose, and asking would only wait out both timeouts. Logged because this is
            // the one way the guard skips without being asked.
            quit_log::log("the app was never loaded into the window; skipping the Memo guard");
        } else if ask_memo_dirty(&app) {
            match confirm_memo_save(&app) {
                MemoQuitAction::Cancel => {
                    quit_log::log("quit cancelled at the unsaved-Memo dialog");
                    return;
                }
                MemoQuitAction::DontSave => quit_log::log("discarding the unsaved Memo edits"),
                MemoQuitAction::Save => {
                    if !save_memo_before_quit(&app) {
                        return;
                    }
                }
            }
        }
        let activity = sidecar::read_token(&token_path)
            .ok()
            .and_then(|token| sidecar::fetch_activity(port, &token));
        let prompt = quit_prompt(activity);
        quit_log::log(&format!(
            "asking to confirm: {}",
            prompt.message.replace("\n\n", " ")
        ));
        if confirm_quit(&app, &prompt) {
            quit_log::log(&format!("quitting ({source})"));
            quitting.store(true, Ordering::SeqCst);
            app.exit(0);
        } else {
            quit_log::log("quit cancelled at the quit dialog");
        }
    });
}

/// Carries out the Save choice, and when the save doesn't land offers Retry / Quit without saving /
/// Cancel rather than leaving the quit to fail on its own (which reads as the close button doing
/// nothing). Returns whether the quit should continue.
fn save_memo_before_quit(app: &tauri::AppHandle) -> bool {
    loop {
        let Err(failure) = flush_memo(app) else {
            return true;
        };
        // A save we stopped waiting for can still land, since the window keeps writing past the wait.
        // Whether the buffer is clean, not whether an answer arrived, is what says the edits are safe,
        // so ask before putting a verdict in front of the user that we could refute ourselves.
        if memo_is_clean(app) {
            quit_log::log("the Memo turned out to be saved; continuing the quit");
            return true;
        }
        match confirm_memo_flush_failure(app, failure) {
            MemoFlushFailureAction::Retry => quit_log::log("retrying the Memo save"),
            MemoFlushFailureAction::QuitAnyway => {
                quit_log::log("quitting without a confirmed Memo save");
                return true;
            }
            MemoFlushFailureAction::Cancel => {
                quit_log::log("quit cancelled after the Memo save went unconfirmed");
                return false;
            }
        }
    }
}

/// How long to wait for the WebView to answer the dirty check before we stop waiting.
const MEMO_CHECK_TIMEOUT: Duration = Duration::from_secs(2);
/// How long to wait for the WebView to confirm a save before asking the user what to do. This bounds
/// how long the app may look frozen, not how long a save may take — the window keeps writing, and a
/// write queued behind another can outlast any wait we could pick.
const MEMO_FLUSH_WAIT: Duration = Duration::from_secs(5);

/// What the WebView said, or that it didn't.
enum Answer {
    Said(bool),
    NoReply,
}

/// Emits one tagged request to the WebView and waits (bounded) for the answer carrying that tag.
/// The slot is cleared on the way out, so a later answer is dropped rather than mistaken for the
/// next request's.
fn ask_webview(
    app: &tauri::AppHandle,
    slot: fn(&QuitBridge) -> &Mutex<Option<PendingReply>>,
    event: &str,
    timeout: Duration,
) -> Answer {
    let bridge = app.state::<QuitBridge>();
    let request = bridge.next_request.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    *slot(&bridge).lock().unwrap() = Some(PendingReply { request, tx });
    let answer = match app.emit(event, MemoRequest { request }) {
        Ok(()) => match rx.recv_timeout(timeout) {
            Ok(value) => Answer::Said(value),
            Err(_) => Answer::NoReply,
        },
        // `emit` only fails on an invalid event name or an unserializable payload, both fixed here;
        // were that ever to change, no answer is coming either way.
        Err(e) => {
            quit_log::log(&format!("could not send {event} ({e})"));
            Answer::NoReply
        }
    };
    *slot(&bridge).lock().unwrap() = None;
    answer
}

/// Asks the WebView whether the Memo has unsaved edits. Anything other than a plain "no" is treated
/// as dirty, so we prompt rather than exit past a Memo we couldn't confirm was clean.
fn ask_memo_dirty(app: &tauri::AppHandle) -> bool {
    match ask_webview(
        app,
        |bridge| &bridge.dirty,
        "zashiki:memo-check",
        MEMO_CHECK_TIMEOUT,
    ) {
        Answer::Said(dirty) => {
            quit_log::log(&format!("Memo dirty check answered: {dirty}"));
            dirty
        }
        Answer::NoReply => {
            quit_log::log(&format!(
                "Memo dirty check unanswered after {}s; assuming unsaved edits",
                MEMO_CHECK_TIMEOUT.as_secs()
            ));
            true
        }
    }
}

/// Whether the Memo is confirmed saved. Only a plain "not dirty" counts: a check that went
/// unanswered says nothing about the edits, and reading it as saved would discard them.
fn memo_is_clean(app: &tauri::AppHandle) -> bool {
    matches!(
        ask_webview(
            app,
            |bridge| &bridge.dirty,
            "zashiki:memo-check",
            MEMO_CHECK_TIMEOUT,
        ),
        Answer::Said(false)
    )
}

/// Why a quit-time save didn't land. Kept apart from "it landed" so the dialog can name the actual
/// failure instead of always blaming an unresponsive window.
enum MemoFlushFailure {
    Rejected,
    NoReply,
}

/// Asks the WebView to persist the Memo and waits (bounded) for it to confirm. The moment the wait
/// ends without one, the window is handed back: from here on the shell is deciding rather than
/// blocking, and a quit that is then cancelled must not leave the app under an overlay it has no way
/// to dismiss.
fn flush_memo(app: &tauri::AppHandle) -> Result<(), MemoFlushFailure> {
    let outcome = match ask_webview(
        app,
        |bridge| &bridge.saved,
        "zashiki:memo-save",
        MEMO_FLUSH_WAIT,
    ) {
        Answer::Said(true) => {
            quit_log::log("Memo saved");
            return Ok(());
        }
        Answer::Said(false) => {
            quit_log::log("Memo save reported as failed by the window");
            MemoFlushFailure::Rejected
        }
        Answer::NoReply => {
            quit_log::log(&format!(
                "Memo save unanswered after {}s; the window never called report_memo_saved",
                MEMO_FLUSH_WAIT.as_secs()
            ));
            MemoFlushFailure::NoReply
        }
    };
    let _ = app.emit("zashiki:memo-save-abandoned", ());
    Err(outcome)
}

/// The user's choice in the unsaved-Memo dialog.
enum MemoQuitAction {
    Save,
    DontSave,
    Cancel,
}

/// Maps the native dialog's result to an action. Unknown results (e.g. a dismissed dialog) fall back
/// to Cancel so an ambiguous outcome never discards unsaved work. Pure for unit testing.
fn memo_quit_action(result: &tauri_plugin_dialog::MessageDialogResult) -> MemoQuitAction {
    use tauri_plugin_dialog::MessageDialogResult as R;
    match result {
        R::Yes => MemoQuitAction::Save,
        R::Custom(label) if label == "Save" => MemoQuitAction::Save,
        R::No => MemoQuitAction::DontSave,
        R::Custom(label) if label == "Don't Save" => MemoQuitAction::DontSave,
        _ => MemoQuitAction::Cancel,
    }
}

fn confirm_memo_save(app: &tauri::AppHandle) -> MemoQuitAction {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let result = app
        .dialog()
        .message("Your changes will be lost if you don't save them.")
        .title("Save the changes you made to the Memo?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Save".to_string(),
            "Don't Save".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show_with_result();
    memo_quit_action(&result)
}

/// The user's choice when the save didn't confirm in time.
enum MemoFlushFailureAction {
    Retry,
    QuitAnyway,
    Cancel,
}

/// Maps the native dialog's result to an action. As with the unsaved-Memo dialog, anything
/// unexpected (a dismissed dialog) keeps the app open rather than discarding the edits.
fn memo_flush_failure_action(
    result: &tauri_plugin_dialog::MessageDialogResult,
) -> MemoFlushFailureAction {
    use tauri_plugin_dialog::MessageDialogResult as R;
    match result {
        R::Yes => MemoFlushFailureAction::Retry,
        R::Custom(label) if label == "Retry" => MemoFlushFailureAction::Retry,
        R::No => MemoFlushFailureAction::QuitAnyway,
        R::Custom(label) if label == "Quit Without Saving" => MemoFlushFailureAction::QuitAnyway,
        _ => MemoFlushFailureAction::Cancel,
    }
}

/// Says which failure actually happened: "the window went quiet" and "the save was refused" call for
/// different responses from the user, and one message for both sends them after the wrong problem.
fn memo_flush_failure_message(failure: &MemoFlushFailure) -> String {
    let cause = match failure {
        MemoFlushFailure::Rejected => {
            "The Memo couldn't be written. The Zashiki server may have stopped.".to_string()
        }
        MemoFlushFailure::NoReply => {
            "Zashiki asked the window to save the Memo but heard nothing back.".to_string()
        }
    };
    format!("{cause}\n\nQuitting without saving loses the unsaved edits. See ~/Library/Logs/zashiki/shell.log for details.")
}

/// Deliberately native rather than drawn in the window: one case this exists for is the window
/// failing to answer, and an in-page button would be just as unreachable as the reply we're missing.
fn confirm_memo_flush_failure(
    app: &tauri::AppHandle,
    failure: MemoFlushFailure,
) -> MemoFlushFailureAction {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let result = app
        .dialog()
        .message(memo_flush_failure_message(&failure))
        .title("Couldn't save the Memo")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Retry".to_string(),
            "Quit Without Saving".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show_with_result();
    memo_flush_failure_action(&result)
}

struct ClearOnDrop(Arc<AtomicBool>);

impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn confirm_quit(app: &tauri::AppHandle, prompt: &QuitPrompt) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(prompt.message.clone())
        .title("Quit Zashiki?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            prompt.confirm_label.to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use sidecar::Activity;

    fn generic_prompt() -> QuitPrompt {
        QuitPrompt {
            message: "Every Cockpit Terminal will close.".to_string(),
            confirm_label: "Quit",
        }
    }

    #[test]
    fn quit_prompt_still_asks_when_server_unreachable() {
        assert_eq!(quit_prompt(None), generic_prompt());
    }

    #[test]
    fn quit_prompt_still_asks_when_nothing_running() {
        let idle = Activity {
            active_sessions: 0,
            running_subagents: 0,
            background_shells: 0,
        };
        assert_eq!(quit_prompt(Some(idle)), generic_prompt());
    }

    #[test]
    fn quit_prompt_names_what_is_running_when_busy() {
        let busy = Activity {
            active_sessions: 2,
            running_subagents: 0,
            background_shells: 1,
        };
        assert_eq!(
            quit_prompt(Some(busy)),
            QuitPrompt {
                message:
                    "2 sessions, 1 background shell still running.\n\nQuitting will stop them."
                        .to_string(),
                confirm_label: "Quit anyway",
            }
        );
    }

    #[test]
    fn memo_quit_action_saves_on_the_save_button() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(matches!(
            memo_quit_action(&R::Custom("Save".to_string())),
            MemoQuitAction::Save
        ));
        assert!(matches!(memo_quit_action(&R::Yes), MemoQuitAction::Save));
    }

    #[test]
    fn memo_quit_action_discards_on_dont_save() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(matches!(
            memo_quit_action(&R::Custom("Don't Save".to_string())),
            MemoQuitAction::DontSave
        ));
        assert!(matches!(memo_quit_action(&R::No), MemoQuitAction::DontSave));
    }

    fn read_as_text_up_to(path: &std::path::Path, max_bytes: u64) -> PickedFile {
        let media = picked_media::PickedMedia::default();
        let reader = PickReader {
            max_bytes,
            media_extensions: &["png".to_string()],
            media: &media,
        };
        read_picked_file(path, &reader)
    }

    #[test]
    fn picked_media_is_held_for_its_bytes_even_past_the_text_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shot.png");
        std::fs::write(&path, [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).unwrap();
        let media = picked_media::PickedMedia::default();
        let reader = PickReader {
            max_bytes: 1,
            media_extensions: &["png".to_string()],
            media: &media,
        };
        let PickedFile::Media { name, media_id } = read_picked_file(&path, &reader) else {
            panic!("a png is held as media");
        };
        assert_eq!(name, "shot.png");
        assert_eq!(
            media.read(media_id),
            Some(vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
        );
    }

    #[test]
    fn picked_file_within_the_limit_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "hello").unwrap();
        assert_eq!(
            read_as_text_up_to(&path, 5),
            PickedFile::Read {
                name: "a.md".to_string(),
                content: "hello".to_string()
            }
        );
    }

    #[test]
    fn picked_file_past_the_limit_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.md");
        std::fs::write(&path, "hello!").unwrap();
        assert_eq!(
            read_as_text_up_to(&path, 5),
            PickedFile::Failed {
                name: "big.md".to_string(),
                error: "tooLarge"
            }
        );
    }

    #[test]
    fn picked_file_that_cannot_be_read_as_text_fails() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("bin.dat");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        let missing = dir.path().join("gone.md");
        for (path, name) in [(binary, "bin.dat"), (missing, "gone.md")] {
            assert_eq!(
                read_as_text_up_to(&path, 100),
                PickedFile::Failed {
                    name: name.to_string(),
                    error: "readFailed"
                }
            );
        }
    }

    #[test]
    fn picked_files_serialize_as_the_client_expects() {
        let read = PickedFile::Read {
            name: "a.md".to_string(),
            content: "x".to_string(),
        };
        let media = PickedFile::Media {
            name: "c.png".to_string(),
            media_id: 7,
        };
        let failed = PickedFile::Failed {
            name: "b.md".to_string(),
            error: "tooLarge",
        };
        assert_eq!(
            serde_json::to_string(&[read, media, failed]).unwrap(),
            r#"[{"name":"a.md","content":"x"},{"name":"c.png","mediaId":7},{"name":"b.md","error":"tooLarge"}]"#
        );
    }

    /// A command reaches the WebView only when it is listed in three places: `generate_handler!`
    /// here, `commands(&[..])` in build.rs (so tauri-build emits its ACL permission), and the
    /// capability's `permissions` (so the permission is actually granted). Miss one and the call is
    /// rejected at runtime with nothing in the UI to show for it — the shipped v0.31.0 quit guard was
    /// unreachable for exactly that reason (#414).
    ///
    /// Compared as sets in both directions: tauri-build never prunes, so a command that is removed
    /// leaves a permission file and a grant behind, still opening a name nobody registered.
    #[test]
    fn every_ipc_command_is_granted_to_the_webview() {
        let registered = registered_commands();

        assert_eq!(
            build_rs_commands(),
            registered,
            "build.rs must generate a permission for exactly the registered commands"
        );
        assert_eq!(
            generated_permission_files(),
            registered,
            "permissions/autogenerated must hold a file for exactly the registered commands"
        );
        assert_eq!(
            capability_allowances(),
            registered
                .iter()
                .map(|command| format!("allow-{}", command.replace('_', "-")))
                .collect(),
            "the capability must grant exactly the registered commands"
        );
    }

    /// The command names inside this file's `generate_handler!` block — the source of truth the ACL
    /// declarations have to agree with.
    fn registered_commands() -> BTreeSet<String> {
        let source = include_str!("main.rs");
        let (_, after) = source
            .split_once("invoke_handler(tauri::generate_handler![")
            .expect("main.rs registers commands with generate_handler!");
        let (block, _) = after.split_once(']').expect("generate_handler! is closed");
        let commands = comma_separated(block);
        assert!(!commands.is_empty(), "found no registered commands");
        commands
    }

    /// The command names build.rs hands to tauri-build, which is what makes it emit each permission.
    fn build_rs_commands() -> BTreeSet<String> {
        let source = include_str!("../build.rs");
        let (_, after) = source
            .split_once("commands(&[")
            .expect("build.rs lists the app commands");
        let (block, _) = after.split_once("])").expect("the command list is closed");
        comma_separated(&block.replace('"', ""))
    }

    /// The permission files tauri-build has emitted, one per command, named after it.
    fn generated_permission_files() -> BTreeSet<String> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/permissions/autogenerated");
        std::fs::read_dir(dir)
            .expect("tauri-build emits the permission files during the build")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                (path.extension()? == "toml")
                    .then(|| path.file_stem()?.to_str().map(str::to_string))?
            })
            .collect()
    }

    /// The command permissions the capability grants (its `core:*` entries are not app commands).
    fn capability_allowances() -> BTreeSet<String> {
        let capability = include_str!("../capabilities/default.json");
        serde_json::from_str::<serde_json::Value>(capability).expect("capability is valid JSON")
            ["permissions"]
            .as_array()
            .expect("capability lists permissions")
            .iter()
            .filter_map(|value| value.as_str())
            .filter(|permission| permission.starts_with("allow-"))
            .map(str::to_string)
            .collect()
    }

    fn comma_separated(block: &str) -> BTreeSet<String> {
        block
            .split(',')
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[test]
    fn memo_flush_failure_message_names_the_actual_failure() {
        let rejected = memo_flush_failure_message(&MemoFlushFailure::Rejected);
        let no_reply = memo_flush_failure_message(&MemoFlushFailure::NoReply);

        // A refused write must not be reported as an unresponsive window.
        assert!(rejected.contains("server"), "got {rejected}");
        assert!(!rejected.contains("heard nothing back"), "got {rejected}");
        assert!(no_reply.contains("heard nothing back"), "got {no_reply}");
        for message in [rejected, no_reply] {
            assert!(message.contains("shell.log"), "got {message}");
        }
    }

    #[test]
    fn a_late_answer_is_not_taken_as_the_answer_to_the_next_question() {
        // The save retry asks again while the previous save may still be running; its answer must
        // not be mistaken for the retry's.
        let slot = Mutex::new(None);
        let (tx, rx) = mpsc::channel();
        *slot.lock().unwrap() = Some(PendingReply { request: 7, tx });

        deliver(&slot, 6, true);
        assert!(
            rx.try_recv().is_err(),
            "an answer to request 6 must not satisfy request 7"
        );

        deliver(&slot, 7, true);
        assert_eq!(rx.try_recv(), Ok(true));
    }

    #[test]
    fn memo_flush_failure_retries_and_quits_on_their_buttons() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(matches!(
            memo_flush_failure_action(&R::Custom("Retry".to_string())),
            MemoFlushFailureAction::Retry
        ));
        assert!(matches!(
            memo_flush_failure_action(&R::Yes),
            MemoFlushFailureAction::Retry
        ));
        assert!(matches!(
            memo_flush_failure_action(&R::Custom("Quit Without Saving".to_string())),
            MemoFlushFailureAction::QuitAnyway
        ));
        assert!(matches!(
            memo_flush_failure_action(&R::No),
            MemoFlushFailureAction::QuitAnyway
        ));
    }

    #[test]
    fn memo_flush_failure_keeps_the_app_open_on_cancel_or_dismissal() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(matches!(
            memo_flush_failure_action(&R::Custom("Cancel".to_string())),
            MemoFlushFailureAction::Cancel
        ));
        assert!(matches!(
            memo_flush_failure_action(&R::Cancel),
            MemoFlushFailureAction::Cancel
        ));
        assert!(matches!(
            memo_flush_failure_action(&R::Ok),
            MemoFlushFailureAction::Cancel
        ));
    }

    #[test]
    fn memo_quit_action_cancels_on_cancel_or_dismissal() {
        use tauri_plugin_dialog::MessageDialogResult as R;
        assert!(matches!(
            memo_quit_action(&R::Custom("Cancel".to_string())),
            MemoQuitAction::Cancel
        ));
        assert!(matches!(
            memo_quit_action(&R::Cancel),
            MemoQuitAction::Cancel
        ));
        // An unexpected result must not silently discard unsaved edits.
        assert!(matches!(memo_quit_action(&R::Ok), MemoQuitAction::Cancel));
    }
}

fn shutdown_owned(slot: &Arc<Mutex<Option<Child>>>) {
    let child = slot.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        sidecar::shutdown(&mut child, sidecar::SHUTDOWN_GRACE);
    }
}
