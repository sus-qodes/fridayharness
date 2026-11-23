//! Friday's desktop shell (plan §8): the Notch window over the user's editor and the Studio
//! window, both hosting the `apps/ui` bundle, with a tray, global shortcuts and native
//! notifications. The Rust core is the only HTTP client of the daemon on the desktop: the webview
//! holds no credential (FD-06) and reaches the daemon only through the commands below.

mod ask;
mod autostart;
mod confirm;
mod daemon;
mod events;
mod island;
mod notify;
mod paths;
mod platform_windows;
#[cfg(feature = "probe")]
mod probe;
mod proxy;
mod routes;
mod settings;
mod shortcuts;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_global_shortcut::ShortcutState;

use crate::confirm::{visible, Dialog};
use crate::proxy::{CmdError, Gate, Request};

/// The interface API this shell speaks (`ui_api` of the daemon's snapshot, `UI_API` of the page).
pub const UI_API: u32 = 1;
pub const STUDIO: &str = "studio";
/// Every webview gets exactly these arguments: WebView2 runs one browser per process, and a
/// window created with other arguments comes up blank. The autoplay switch lets the Notch's
/// first alert sound before any click.
pub const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Where the daemon is in its life, as the page and the tray see it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DaemonStatus {
    /// `starting`, `ready`, `stopping`, `stopped`, `failed` or `no_project`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Friday was updated while this daemon ran, and work kept it from restarting with the new
    /// code (2026-11-19): the page offers to restart it, and it restarts by itself once idle.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub outdated: bool,
}

pub struct AppState {
    project: RwLock<Option<daemon::Project>>,
    install: Mutex<Option<daemon::Install>>,
    status: Mutex<DaemonStatus>,
    island: Arc<island::Island>,
    streams: Arc<events::Streams>,
    shortcuts: shortcuts::Shortcuts,
    settings: Mutex<settings::Settings>,
    config_dir: PathBuf,
    tray: Mutex<Option<tray::Items<Wry>>>,
    /// Starting, stopping and restarting run one at a time.
    lifecycle: Mutex<()>,
    notifier: notify::Notifier,
    paused: AtomicBool,
    muted: AtomicBool,
    /// A stop this app asked for (the watchdog then does not report a crash).
    stopping: AtomicBool,
    /// A project is being chosen (the folder picker and its dialogs): one at a time.
    choosing: AtomicBool,
    /// The running daemon is older than Friday's code on disk, and work kept it from restarting.
    outdated: AtomicBool,
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn current_project(app: &AppHandle) -> Result<daemon::Project, CmdError> {
    state(app).project.read().unwrap().clone().ok_or_else(CmdError::no_project)
}

fn current_install(app: &AppHandle) -> Result<daemon::Install, CmdError> {
    state(app)
        .install
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| CmdError::shell(0, "DESKTOP-2003", "no_install", "the desktop app has not found Friday's install"))
}

/// Runs blocking work (network, dialogs, child processes) off the async runtime's workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, CmdError> + Send + 'static) -> Result<T, CmdError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::offline(format!("the desktop app failed: {e}")))?
}

fn request<'a>(method: &'a str, raw: &'a str, body: Option<&'a Value>, timeout: Duration) -> Request<'a> {
    Request { method, raw, body, timeout, idempotency_key: None }
}

fn visible_studio(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(STUDIO).filter(|w| w.is_visible().unwrap_or(false))
}

/// A native two-button dialog; true when confirmed. Never call it on the main thread.
fn ask(app: &AppHandle, d: &Dialog) -> bool {
    ask_from(app, None, d)
}

/// The same dialog, shown over the window the person clicked in (2026-11-18). It was always attached
/// to the Studio: a click in the Notch, which stays above every window, opened it behind the Notch's
/// card, so the person saw a busy cursor, a card that would not close, and no question.
fn ask_from(app: &AppHandle, from: Option<&WebviewWindow>, d: &Dialog) -> bool {
    // In Friday's own window (ask.rs); the system's box only when that window cannot be made.
    if let Some(answer) = ask_in_friday(app, from, d) {
        return answer;
    }
    let mut b = app
        .dialog()
        .message(&d.text)
        .title(&d.title)
        .kind(if d.danger { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::OkCancelCustom(d.confirm.clone(), "Cancel".into()));
    let clicked = from.filter(|w| w.is_visible().unwrap_or(false)).cloned();
    if let Some(w) = clicked.or_else(|| visible_studio(app)) {
        b = b.parent(&w);
    }
    b.blocking_show()
}

/// Asks in Friday's own confirmation window and waits for the answer; None when the window could
/// not be made (another question is open, or the webview refused), so the caller asks natively.
/// Never call it on the main thread: it waits.
fn ask_in_friday(app: &AppHandle, from: Option<&WebviewWindow>, d: &Dialog) -> Option<bool> {
    let waiting = app.state::<ask::Waiting>();
    let id = format!(
        "q{:x}{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos()).unwrap_or(0),
        std::process::id()
    );
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    {
        let mut open = waiting.0.lock().ok()?;
        if open.is_some() || app.get_webview_window(ask::LABEL).is_some() {
            return None;
        }
        *open = Some((id.clone(), tx.clone()));
    }
    let close = |window: Option<&WebviewWindow>| {
        if let Ok(mut open) = waiting.0.lock() {
            *open = None;
        }
        if let Some(w) = window {
            let _ = w.destroy();
        }
    };
    let (width, height) = ask::size_for(&d.text);
    let parent = from.filter(|w| w.is_visible().unwrap_or(false)).cloned().or_else(|| visible_studio(app));
    let mut b = WebviewWindowBuilder::new(app, ask::LABEL, WebviewUrl::App(ask::PAGE.into()))
        .title("Friday")
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .visible(true)
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script(ask::init_script(&id, d))
        .on_navigation(ask::navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false);
    // Over the Studio when that is where the person clicked; in the middle of the screen for the
    // Notch, whose own window is a strip at its top.
    let over = parent.as_ref().filter(|w| w.label() == STUDIO).and_then(|w| {
        let (pos, size, scale) = (w.outer_position().ok()?, w.outer_size().ok()?, w.scale_factor().ok()?);
        let x = pos.x as f64 / scale + (size.width as f64 / scale - width) / 2.0;
        let y = pos.y as f64 / scale + (size.height as f64 / scale - height) / 2.0;
        Some((x.max(0.0), y.max(0.0)))
    });
    b = match over {
        Some((x, y)) => b.position(x, y),
        None => b.center(),
    };
    if let Some(p) = &parent {
        b = match b.parent(p) {
            Ok(b) => b,
            Err(_) => {
                close(None);
                return None;
            }
        };
    }
    let window = match b.build() {
        Ok(w) => w,
        Err(_) => {
            close(None);
            return None;
        }
    };
    // Closed by its person, or gone for any reason: a no.
    let closed = tx.clone();
    window.on_window_event(move |e| {
        if matches!(e, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            let _ = closed.send(false);
        }
    });
    let _ = window.set_focus();
    let answer = rx.recv_timeout(Duration::from_secs(ask::TIMEOUT_SECS)).unwrap_or(false);
    close(Some(&window));
    Some(answer)
}

/// The confirmation window's answer (ask.rs). Only that window is given this command, and it is
/// asked again here who calls and for which question.
#[tauri::command]
fn confirm_answer(app: AppHandle, window: WebviewWindow, id: String, yes: bool) -> Result<(), CmdError> {
    let waiting = app.state::<ask::Waiting>();
    let open = waiting.0.lock().map_err(|_| CmdError::bad_request("no question is open"))?;
    match open.as_ref() {
        Some((asked, tx)) if ask::accepts(window.label(), Some(asked.as_str()), &id) => {
            let _ = tx.send(yes);
            Ok(())
        }
        _ => Err(CmdError::bad_request("no such question is open")),
    }
}

#[derive(PartialEq)]
enum Choice {
    First,
    Second,
    Cancel,
}

/// A native three-button dialog.
fn ask3(app: &AppHandle, title: &str, text: &str, first: &str, second: &str, kind: MessageDialogKind) -> Choice {
    let r = app
        .dialog()
        .message(text)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::YesNoCancelCustom(first.into(), second.into(), "Cancel".into()))
        .blocking_show_with_result();
    match r {
        MessageDialogResult::Yes => Choice::First,
        MessageDialogResult::No => Choice::Second,
        MessageDialogResult::Custom(s) if s == first => Choice::First,
        MessageDialogResult::Custom(s) if s == second => Choice::Second,
        _ => Choice::Cancel,
    }
}

fn tell(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    let _ = app.dialog().message(text).title(title).kind(kind).buttons(MessageDialogButtons::Ok).blocking_show();
}

// ---- commands: the daemon ------------------------------------------------------------------------

/// Sends one allowlisted request (routes.rs) and returns the daemon's JSON answer.
#[tauri::command]
async fn friday_request(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
    idempotency_key: Option<String>,
) -> Result<Value, CmdError> {
    let project = current_project(&app)?;
    blocking(move || {
        proxy::send(
            &project,
            Gate::Page,
            &Request {
                method: &method,
                raw: &path,
                body: body.as_ref(),
                timeout: timeout_ms.map(Duration::from_millis).unwrap_or(proxy::DEFAULT_TIMEOUT),
                idempotency_key: idempotency_key.as_deref(),
            },
        )
    })
    .await
}

/// Sends an action the page may not send by itself, after Rust decided on and showed its native
/// dialog (confirm.rs).
#[tauri::command]
async fn confirm_and_send(
    app: AppHandle,
    window: WebviewWindow,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, CmdError> {
    let project = current_project(&app)?;
    blocking(move || {
        let discovery = daemon::read_discovery(&project)?;
        let (checked, what) = routes::for_confirm(&method, &path, body.as_ref(), &project.id, discovery.port)?;
        let get = |raw: &str| proxy::send(&project, Gate::Shell, &request("GET", raw, None, Duration::from_secs(60)));
        let prepared = confirm::prepare(what, &checked, &project.id, body.as_ref(), &get)?;
        if let Some(dialog) = &prepared.dialog {
            if !ask_from(&app, Some(&window), dialog) {
                return Err(confirm::cancelled_error());
            }
        }
        let timeout = match what {
            Some(routes::Confirm::Halt) | Some(routes::Confirm::LaunchAgent) | Some(routes::Confirm::StartAgent) => {
                Duration::from_secs(120)
            }
            // Longer than the daemon gives the merge itself (land.ts, 120 s), so a slow hook or a
            // large checkout never reads here as an error while the merge still finishes.
            Some(routes::Confirm::LandGoal) => Duration::from_secs(180),
            // The same merge, after the files in the way were kept and taken out of it.
            Some(routes::Confirm::LandGoalAside) => Duration::from_secs(300),
            _ => Duration::from_secs(30),
        };
        proxy::send(&project, Gate::Confirmed, &request(&method, &path, Some(&prepared.body), timeout))
    })
    .await
}

/// Opens the event stream from `since`; messages arrive on `channel` (events.rs).
#[tauri::command]
async fn stream_open(app: AppHandle, since: u64, channel: Channel<events::StreamMessage>) -> Result<u64, CmdError> {
    let project = current_project(&app)?;
    let streams = state(&app).streams.clone();
    blocking(move || events::open(&streams, &project, since, move |m| channel.send(m).is_ok())).await
}

#[tauri::command]
fn stream_close(app: AppHandle, id: u64) {
    state(&app).streams.close(id);
}

#[tauri::command]
fn project_info(app: AppHandle) -> Result<Value, CmdError> {
    let p = current_project(&app)?;
    let d = daemon::read_discovery(&p)?;
    Ok(json!({
        "project_id": p.id,
        "name": p.name,
        "root": p.root,
        "port": d.port,
        "url": format!("http://127.0.0.1:{}", d.port),
        "ui_api": UI_API,
    }))
}

#[tauri::command]
fn daemon_status(app: AppHandle) -> DaemonStatus {
    state(&app).status.lock().unwrap().clone()
}

#[tauri::command]
async fn stop_daemon(app: AppHandle) -> Result<(), CmdError> {
    blocking(move || {
        if !ask(&app, &confirm::stop_dialog()) {
            return Err(confirm::cancelled_error());
        }
        stop_friday(&app)
    })
    .await
}

#[tauri::command]
async fn restart_daemon(app: AppHandle) -> Result<(), CmdError> {
    blocking(move || {
        // A running Friday is stopped first, so it is asked like Stop; starting a stopped one is not.
        let project = current_project(&app)?;
        if daemon::running(&project).is_some() && !ask(&app, &confirm::restart_dialog()) {
            return Err(confirm::cancelled_error());
        }
        restart_friday(&app)
    })
    .await
}

/// The folder picker again, from the Studio's "No project is open" screen (the first one was
/// cancelled). Refused while a project is open: changing projects is not this command.
#[tauri::command]
fn choose_project_folder(app: AppHandle) -> Result<(), CmdError> {
    if state(&app).project.read().unwrap().is_some() {
        return Err(CmdError::bad_request("a project is already open"));
    }
    std::thread::spawn(move || boot(app, None, true, false));
    Ok(())
}

/// "Open another project…" (2026-11-17), from the project's name in the Studio: the folder picker,
/// then the project it names takes the place of the one that is open (`switch_project`). The
/// answer comes at once; the windows are told with `project-changed` when it happened.
#[tauri::command]
fn open_another_project(app: AppHandle) -> Result<(), CmdError> {
    std::thread::spawn(move || switch_project(&app, None));
    Ok(())
}

/// One project of the project menu (2026-11-18): its name and folder, whether it is the one open,
/// whether its Friday is running (agents may be at work there), and whether its folder is gone.
#[derive(Serialize)]
struct RecentProject {
    root: String,
    name: String,
    current: bool,
    running: bool,
    missing: bool,
}

/// The projects opened lately, newest first, with their state, for the project menu. A project is
/// switched to in the same window (`switch_project`); this only lists them.
#[tauri::command]
async fn recent_projects(app: AppHandle) -> Result<Vec<RecentProject>, CmdError> {
    let st = state(&app);
    let list = st.settings.lock().unwrap().recent_projects.clone();
    let current = st.project.read().unwrap().as_ref().map(|p| p.root.clone());
    blocking(move || {
        let mut out = Vec::new();
        let mut roots = list;
        if let Some(c) = &current {
            if !roots.iter().any(|r| same_root(r, c)) {
                roots.insert(0, c.clone());
            }
        }
        for root in roots {
            let is_current = current.as_ref().is_some_and(|c| same_root(c, &root));
            match daemon::open_project(&root) {
                Ok(Some(p)) => out.push(RecentProject {
                    root: p.root.to_string_lossy().to_string(),
                    name: p.name.clone(),
                    current: is_current,
                    running: daemon::running(&p).is_some(),
                    missing: false,
                }),
                _ => out.push(RecentProject {
                    root: root.to_string_lossy().to_string(),
                    name: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    current: is_current,
                    running: false,
                    missing: true,
                }),
            }
        }
        Ok(out)
    })
    .await
}

/// Opens one of the recent projects in this window, as "Open another project…" does after its
/// folder picker. Only a folder the menu listed: the page names no other folder to the shell.
#[tauri::command]
fn open_recent_project(app: AppHandle, root: String) -> Result<(), CmdError> {
    let dir = PathBuf::from(&root);
    if !state(&app).settings.lock().unwrap().is_recent(&dir) {
        return Err(CmdError::shell(400, "DESKTOP-1009", "not_recent", "that folder is not one of your recent projects"));
    }
    std::thread::spawn(move || switch_project(&app, Some(dir)));
    Ok(())
}

/// Opens the project's config.yaml or the daemon's console log, for the screen shown when Friday
/// did not start: in VS Code, or without it in Notepad, which every Windows has.
#[tauri::command]
async fn open_project_file(app: AppHandle, kind: String) -> Result<(), CmdError> {
    let project = current_project(&app)?;
    let file = match kind.as_str() {
        "config" => project.root.join(".friday").join("config.yaml"),
        "log" => daemon::console_log(&project),
        _ => return Err(CmdError::bad_request("the file is config or log")),
    };
    blocking(move || {
        if !file.is_file() {
            return Err(CmdError::bad_request("that file does not exist yet"));
        }
        if platform_windows::shell_open(&paths::vscode_uri(&file, None)) {
            return Ok(());
        }
        match std::process::Command::new("notepad.exe").arg(&file).spawn() {
            Ok(_) => Ok(()),
            Err(e) => Err(CmdError::shell(500, "DESKTOP-2004", "no_editor", format!("the file could not be opened ({e})"))),
        }
    })
    .await
}

// ---- commands: windows ---------------------------------------------------------------------------

/// The island's rectangle in the Notch window's CSS pixels (click-through, island.rs).
#[tauri::command]
fn notch_rect(app: AppHandle, window: WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> Result<(), CmdError> {
    if window.label() != island::LABEL {
        return Err(CmdError::bad_request("only the Notch window reports its island"));
    }
    let rect = island::Rect::from_page(x, y, w, h).ok_or_else(|| CmdError::bad_request("the rectangle is not finite"))?;
    state(&app).island.set_rect(&app, rect);
    Ok(())
}

#[tauri::command]
fn notch_keyboard(app: AppHandle, window: WebviewWindow, take: bool) -> Result<(), CmdError> {
    if window.label() != island::LABEL {
        return Err(CmdError::bad_request("only the Notch window takes the keyboard"));
    }
    state(&app).island.set_keyboard(&app, take);
    Ok(())
}

/// Where the Studio should look when it opens.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DeepLink {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    /// The id the panel opens on (a task for Recover, a goal for a revision).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The reach the human chose on the Notch's card, for the approval's full view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<String>,
    /// The tab the panel or drawer opens on (Settings' Planner, a diff's files).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// The file a diff opens on, as the daemon names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl DeepLink {
    fn valid(&self) -> bool {
        let id = |s: &Option<String>| {
            s.as_ref().is_none_or(|v| {
                !v.is_empty() && v.len() <= 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
        };
        let name = |s: &Option<String>| {
            s.as_ref().is_none_or(|v| {
                !v.is_empty() && v.len() <= 32 && v.chars().all(|c| c.is_ascii_lowercase() || c == '-')
            })
        };
        // A drawer's tab by the page's own rule (desktop/boot.ts `TAB`): a lower-case letter, then
        // lower-case letters, digits and hyphens.
        let tab = self.tab.as_ref().is_none_or(|v| {
            let mut c = v.chars();
            v.len() <= 32
                && c.next().is_some_and(|f| f.is_ascii_lowercase())
                && c.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        });
        let reach = self.reach.as_deref().is_none_or(|r| matches!(r, "once" | "run" | "task"));
        // Any file name, but no control character (NUL and line ends among them).
        let path = self
            .path
            .as_ref()
            .is_none_or(|v| !v.is_empty() && v.chars().count() <= 1024 && !v.chars().any(char::is_control));
        id(&self.focus_task)
            && id(&self.approval_id)
            && id(&self.id)
            && name(&self.panel)
            && tab
            && reach
            && path
    }
}

/// A second launch of the app: open its `--project` when none is open, or say which one is.
fn second_launch(app: &AppHandle, argv: Vec<String>) {
    if let Some(dir) = project_arg(&argv) {
        let open = state(app).project.read().unwrap().clone();
        let app2 = app.clone();
        match open {
            None => {
                std::thread::spawn(move || boot(app2, Some(dir), true, true));
            }
            Some(p) => {
                let wanted = std::fs::canonicalize(&dir).unwrap_or(dir);
                let inside = wanted.to_string_lossy().to_lowercase().starts_with(&p.root.to_string_lossy().to_lowercase());
                if !inside {
                    // Another project: opened here, after the same question as the tray's item.
                    std::thread::spawn(move || switch_project(&app2, Some(wanted)));
                    return;
                }
            }
        }
    }
    show_studio_window(app, None);
}

/// Shows and focuses the Studio and sends it `studio-deeplink` with the target.
pub(crate) fn show_studio_window(app: &AppHandle, target: Option<DeepLink>) {
    if let Some(w) = app.get_webview_window(STUDIO) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(t) = target {
            let _ = app.emit_to(STUDIO, "studio-deeplink", t);
        }
    }
}

#[tauri::command]
fn show_studio(app: AppHandle, target: Option<DeepLink>) -> Result<(), CmdError> {
    if target.as_ref().is_some_and(|t| !t.valid()) {
        return Err(CmdError::bad_request("the Studio target holds an unexpected value"));
    }
    show_studio_window(&app, target);
    Ok(())
}

/// The tray's icon and status line, from the page's snapshot.
#[tauri::command]
fn set_tray_state(
    app: AppHandle,
    state: String,
    counts_line: String,
    paused: Option<bool>,
    muted: Option<bool>,
) -> Result<(), CmdError> {
    let status = tray::Status::parse(&state).ok_or_else(|| CmdError::bad_request("unknown tray state"))?;
    // The line is the page's status sentence (what runs, what waits and why, who is connected). A
    // tray tooltip holds 127 characters on Windows, and "Friday: " takes eight of them.
    let line = notify::clean(&counts_line, 119);
    let st = crate::state(&app);
    if let Some(p) = paused {
        st.paused.store(p, Ordering::SeqCst);
    }
    if let Some(m) = muted {
        st.muted.store(m, Ordering::SeqCst);
    }
    if let Some(items) = st.tray.lock().unwrap().as_ref() {
        let _ = items.tray.set_icon(Some(tray::icon(status)));
        let _ = items.tray.set_tooltip(Some(format!("Friday: {line}")));
        let _ = items.status.set_text(if line.is_empty() { "Friday".to_string() } else { line.clone() });
        let _ = items.pause.set_text(if st.paused.load(Ordering::SeqCst) { "Resume" } else { "Pause" });
        let _ = items.mute.set_checked(st.muted.load(Ordering::SeqCst));
    }
    Ok(())
}

/// A native notification, sent only while the Notch is parked or the screen is locked. A `test`
/// (Settings → Desktop app) comes from either window and goes now, within its own budget. Either
/// answers whether it was handed to Windows, which says nothing of whether it appeared (notify.rs).
#[tauri::command]
fn notify(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    body: String,
    test: Option<bool>,
) -> Result<bool, CmdError> {
    let st = state(&app);
    if test == Some(true) {
        return st.notifier.test(&app, &title, &body).map_err(|_| too_many_notifications());
    }
    if window.label() != island::LABEL {
        return Err(CmdError::bad_request("notifications come from the Notch window"));
    }
    Ok(st.notifier.notify(&app, st.island.is_parked(), &title, &body))
}

fn too_many_notifications() -> CmdError {
    CmdError::shell(
        429,
        "DESKTOP-1008",
        "too_many_notifications",
        format!(
            "Friday sent {} test notifications in the last minute; try again in a minute",
            notify::TESTS_PER_MINUTE
        ),
    )
}

// ---- commands: shortcuts, editor, browser, secrets -------------------------------------------------

#[tauri::command]
fn get_shortcuts(app: AppHandle) -> Vec<shortcuts::Info> {
    state(&app).shortcuts.report()
}

#[tauri::command]
async fn set_shortcut(app: AppHandle, id: String, accel: String) -> Result<Vec<shortcuts::Info>, CmdError> {
    if !shortcuts::known(&id) {
        return Err(CmdError::bad_request("unknown shortcut"));
    }
    if shortcuts::parse(&accel).is_none() {
        return Err(CmdError::bad_request("not a shortcut: it needs Ctrl, Alt or the Windows key and one other key"));
    }
    blocking(move || {
        let st = state(&app);
        let stored = {
            let mut s = st.settings.lock().unwrap();
            s.shortcuts.insert(id, accel);
            let _ = s.save(&st.config_dir);
            s.shortcuts.clone()
        };
        Ok(st.shortcuts.apply(&app, &stored))
    })
    .await
}

#[tauri::command]
async fn open_in_editor(app: AppHandle, path: String, line: Option<u32>) -> Result<(), CmdError> {
    let project = current_project(&app)?;
    blocking(move || {
        // This project's worktrees only: their folder is named by the last 8 characters of the
        // project key, the same hash (`rootKey` in packages/git), not the whole shared folder.
        let own = project.key.rsplit('-').next().unwrap_or_default().to_string();
        let roots = [project.root.clone(), daemon::worktrees_dir().join(own)];
        let real = paths::allowed(&path, &project.root, &roots)
            .ok_or_else(|| CmdError::bad_request("only files of the project and its task folders open in the editor"))?;
        if platform_windows::shell_open(&paths::vscode_uri(&real, line)) {
            Ok(())
        } else {
            Err(CmdError::shell(500, "DESKTOP-2004", "no_editor", "Windows has no handler for vscode:// links (is VS Code installed?)"))
        }
    })
    .await
}

/// Opens the Studio in the default browser, signed in: the daemon writes a one-time link into a
/// user-only redirect file and the system opener gets that file, never the link (FD-05).
fn open_browser(app: &AppHandle) -> Result<(), CmdError> {
    let project = current_project(app)?;
    let raw = format!("{}{}/ui/login-codes", routes::PREFIX, project.id);
    let answer = proxy::send(&project, Gate::Shell, &request("POST", &raw, None, Duration::from_secs(15)))?;
    let file = answer
        .get("redirect_file")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| CmdError::shell(500, "DESKTOP-2005", "no_redirect_file", "this Friday wrote no sign-in file"))?;
    drop(answer);
    let private = daemon::real_path(&project.private_dir);
    let ok = file.extension().is_some_and(|e| e == "html")
        && file.is_file()
        && paths::inside(&daemon::real_path(&file), &private);
    if !ok || !platform_windows::shell_open(&file.to_string_lossy()) {
        return Err(CmdError::shell(500, "DESKTOP-2005", "no_redirect_file", "the sign-in file could not be opened"));
    }
    Ok(())
}

#[tauri::command]
async fn open_in_browser(app: AppHandle) -> Result<(), CmdError> {
    blocking(move || open_browser(&app)).await
}

fn provider_name_ok(name: &str) -> bool {
    let mut c = name.chars();
    c.next().is_some_and(|f| f.is_ascii_lowercase())
        && name.len() <= 32
        && c.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

/// Asks for a provider key in Windows' own password prompt and stores it with
/// `friday secrets set <name> --json`, the key on standard input (FD-26). The key is never
/// logged, shown or given to the page.
#[tauri::command]
async fn store_key(app: AppHandle, name: String) -> Result<Value, CmdError> {
    if !provider_name_ok(&name) {
        return Err(CmdError::bad_request("a provider name is lower-case letters, digits, _ and -"));
    }
    let install = current_install(&app)?;
    let root = state(&app).project.read().unwrap().as_ref().map(|p| p.root.clone());
    blocking(move || {
        let parent = visible_studio(&app).map(|w| platform_windows::raw_hwnd(&w));
        let key = platform_windows::prompt_secret(
            parent,
            "Friday: store a provider key",
            &format!(
                "Paste your {name} key in the password field. Friday encrypts it for this Windows user (DPAPI); it is never shown again and never reaches the browser."
            ),
            &name,
        )
        .ok_or_else(confirm::cancelled_error)?;
        let mut input = key;
        input.push('\n');
        let out = daemon::run_cli(
            &install,
            root.as_deref(),
            &["secrets", "set", &name, "--json"],
            Some(input.as_bytes()),
            Duration::from_secs(60),
        );
        proxy::clear(&mut input);
        let out = out.map_err(|e| CmdError::shell(500, "DESKTOP-2006", "cli_failed", e))?;
        if out.code != Some(0) {
            let first = out.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("the command failed");
            return Err(CmdError::shell(500, "DESKTOP-2006", "cli_failed", format!("the key was not stored: {}", visible(first))));
        }
        // Only what the page needs: not the key's length or where it is kept.
        let v = out.json().unwrap_or(Value::Null);
        Ok(json!({
            "name": name,
            "stored": true,
            "protection": v.get("protection").cloned().unwrap_or(Value::Null),
            "endpoint": v.get("endpoint").cloned().unwrap_or(Value::Null),
        }))
    })
    .await
}

/// What planning with a provider uses, in words for the approval dialog, and whether Friday knows
/// a price for it. `None`: not a planner this dialog approves.
///
/// Claude's two are held to dollars. For the others (2026-11-23: Codex, and a service reached with
/// the person's own key) Friday knows no price, so they are held to requests a day.
fn planner_account(provider: &str) -> Option<(&'static str, bool)> {
    Some(match provider {
        "anthropic" => ("your Anthropic API key", true),
        "claude-code" => ("your Claude Code sign-in (your subscription or key, as Claude Code uses it)", true),
        "codex" => ("your Codex sign-in (your ChatGPT plan or key, as Codex uses it)", false),
        "openai" => ("your OpenAI API key", false),
        "gemini" => ("your Google Gemini API key", false),
        "deepseek" => ("your DeepSeek API key", false),
        "openrouter" => ("your OpenRouter API key", false),
        _ => return None,
    })
}

/// The approval dialog's text and the limit's arguments for `friday brain allow-remote`: dollars a
/// day where Friday knows a price, requests a day where it does not.
fn spending_words(project: &str, provider: &str, budget: f64, calls: Option<u32>) -> Result<(String, Vec<String>), CmdError> {
    let (whose, priced) =
        planner_account(provider).ok_or_else(|| CmdError::bad_request("this is not a planner Friday can approve here"))?;
    let tail = "The project's own limit still applies; the lower of the two holds.";
    if priced {
        if !budget.is_finite() || !(0.0..=100_000.0).contains(&budget) {
            return Err(CmdError::bad_request("the budget is a number of dollars from 0 to 100000"));
        }
        let amount = format!("{}", (budget * 100.0).round() / 100.0);
        let text = format!(
            "Let Friday write plans for {} with {} on this computer, spending at most ${} a day?\n\n{}",
            visible(project),
            whose,
            amount,
            tail
        );
        return Ok((text, vec!["--budget".into(), amount]));
    }
    let n = calls.ok_or_else(|| CmdError::bad_request("say how many requests a day planning may make"))?;
    if !(1..=10_000).contains(&n) {
        return Err(CmdError::bad_request("the requests a day are a whole number from 1 to 10000"));
    }
    let text = format!(
        "Let Friday write plans for {} with {} on this computer, with at most {} requests a day?\n\nTo plan, Friday sends the goal and a summary of the project there. Friday knows no price for it, so it counts requests instead of dollars: a plan is usually one or two.\n\n{}",
        visible(project),
        whose,
        n,
        tail
    );
    Ok((text, vec!["--calls".into(), n.to_string()]))
}

/// Lets this clone plan with a provider, after a native confirmation:
/// `friday brain allow-remote --provider <p> --budget <n> | --calls <n> --json` (FD-26).
/// `provider` is the planner the approval is for: `anthropic` (the default, a stored key),
/// `claude-code` or `codex` (the installed program, signed in as on this machine), or a service
/// reached with a stored key (`openai`, `gemini`, `deepseek`, `openrouter`).
#[tauri::command]
async fn allow_spending(
    app: AppHandle,
    budget: f64,
    provider: Option<String>,
    calls: Option<u32>,
) -> Result<Value, CmdError> {
    let provider = provider.unwrap_or_else(|| "anthropic".into());
    let install = current_install(&app)?;
    let project = current_project(&app)?;
    let (text, limit) = spending_words(&project.name, &provider, budget, calls)?;
    blocking(move || {
        let d = Dialog { title: "Friday: allow planning?".into(), text, confirm: "Allow".into(), danger: true };
        if !ask(&app, &d) {
            return Err(confirm::cancelled_error());
        }
        let mut args: Vec<&str> = vec!["brain", "allow-remote", "--provider", &provider];
        args.extend(limit.iter().map(String::as_str));
        args.push("--json");
        let out = daemon::run_cli(&install, Some(&project.root), &args, None, Duration::from_secs(60))
        .map_err(|e| CmdError::shell(500, "DESKTOP-2006", "cli_failed", e))?;
        if out.code != Some(0) {
            let first = out.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("the command failed");
            return Err(CmdError::shell(500, "DESKTOP-2006", "cli_failed", visible(first)));
        }
        Ok(out.json().unwrap_or(Value::Null))
    })
    .await
}

/// Whether Windows starts this app when the user signs in (autostart.rs).
#[tauri::command]
fn get_autostart() -> bool {
    autostart::enabled()
}

/// "Start Friday when I sign in": adds or removes the per-user Run entry; returns the state now.
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, CmdError> {
    autostart::set(enabled).map_err(|e| CmdError::shell(500, "DESKTOP-2007", "autostart_failed", e))
}

// ---- lifecycle -----------------------------------------------------------------------------------

fn set_status(app: &AppHandle, state_name: &'static str, message: Option<String>) {
    let outdated = state_name == "ready" && state(app).outdated.load(Ordering::SeqCst);
    let status = DaemonStatus { state: state_name, message, outdated };
    *state(app).status.lock().unwrap() = status.clone();
    let line = match state_name {
        "ready" => None,
        "starting" => Some("Starting Friday…".to_string()),
        "stopping" => Some("Stopping Friday…".to_string()),
        "stopped" => Some("Friday is stopped".to_string()),
        "failed" => Some("Friday did not start".to_string()),
        _ => Some("No project open".to_string()),
    };
    if let Some(line) = line {
        if let Some(items) = state(app).tray.lock().unwrap().as_ref() {
            let _ = items.status.set_text(&line);
            let _ = items.tray.set_tooltip(Some(format!("Friday: {line}")));
            if state_name == "failed" {
                let _ = items.tray.set_icon(Some(tray::icon(tray::Status::Error)));
            }
        }
    }
    let _ = app.emit("daemon-status", status);
}

fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    app.dialog().file().set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok())
}

/// The project: `--project`, the last one opened, or a folder picker; a folder without Friday
/// offers "Set up Friday here".
fn choose_project(app: &AppHandle, initial: Option<PathBuf>, use_last: bool) -> Option<daemon::Project> {
    let last = if use_last { state(app).settings.lock().unwrap().last_project.clone() } else { None };
    let mut next = initial.or(last).filter(|d| d.is_dir());
    loop {
        let dir = match next.take() {
            Some(d) => d,
            None => pick_folder(app, "Friday: choose your project's folder")?,
        };
        match daemon::open_project(&dir) {
            Ok(Some(p)) => {
                let st = state(app);
                let mut s = st.settings.lock().unwrap();
                s.last_project = Some(p.root.clone());
                s.remember(&p.root);
                let _ = s.save(&st.config_dir);
                return Some(p);
            }
            Ok(None) => {
                let text = format!(
                    "{} is not a Friday project yet (it has no .friday/config.yaml).\n\nSet up Friday in this folder, or choose another folder?",
                    visible(&dir.to_string_lossy())
                );
                match ask3(app, "Friday: set up Friday here?", &text, "Set up Friday here", "Choose another folder", MessageDialogKind::Info) {
                    Choice::First => {
                        if set_up_here(app, &dir) {
                            next = Some(dir);
                        }
                    }
                    Choice::Second => {}
                    Choice::Cancel => return None,
                }
            }
            Err(e) => tell(app, "Friday: this project cannot be opened", &visible(&e), MessageDialogKind::Error),
        }
    }
}

/// `friday init` in a folder, then the files to commit.
fn set_up_here(app: &AppHandle, dir: &std::path::Path) -> bool {
    let Some(install) = ensure_install(app) else { return false };
    match daemon::run_cli(&install, Some(dir), &["init", "--json"], None, Duration::from_secs(60)) {
        Ok(out) if out.code == Some(0) => {
            // A folder with no saved version in git is offered one (2026-11-19, G2): it was told to
            // run `git init` and make a first commit, in a terminal.
            if !daemon::has_commit(dir) {
                offer_first_version(app, &install, dir);
                return true;
            }
            let text = format!(
                "Friday is set up in {}.\n\nCommit these two files so everyone who works on the project shares its settings:\n  .friday/config.yaml\n  .friday/.gitignore",
                visible(&dir.to_string_lossy())
            );
            tell(app, "Friday: set up", &text, MessageDialogKind::Info);
            true
        }
        Ok(out) => {
            let msg = out.stderr.lines().chain(out.stdout.lines()).find(|l| !l.trim().is_empty()).unwrap_or("init failed").to_string();
            tell(app, "Friday: set up failed", &visible(&msg), MessageDialogKind::Error);
            false
        }
        Err(e) => {
            tell(app, "Friday: set up failed", &visible(&e), MessageDialogKind::Error);
            false
        }
    }
}

/// Where Git for Windows is downloaded.
const GIT_DOWNLOAD: &str = "https://git-scm.com/download/win";
/// Where Node.js is downloaded.
const NODE_DOWNLOAD: &str = "https://nodejs.org/en/download";

/// Offers a folder without a saved version in git its first one: `friday git-start` starts git if
/// needed and saves the files as they are, leaving out what tools make and files with secrets.
fn offer_first_version(app: &AppHandle, install: &daemon::Install, dir: &std::path::Path) {
    let text = format!(
        "Friday is set up in {}, but the folder has no saved version in git yet.\n\nFriday works best with one: each agent then works in its own copy of the project, and every change can be undone.\n\nFriday can do it now: it starts git here if needed and saves your files as they are as the first version. Folders that tools make (like node_modules) and files with passwords or keys (like .env) are left out. Nothing leaves this computer.",
        visible(&dir.to_string_lossy())
    );
    let choice = ask3(app, "Friday: save a first version?", &text, "Save a first version", "Not now", MessageDialogKind::Info);
    if choice != Choice::First {
        tell(
            app,
            "Friday: set up",
            "Friday is set up. Until the folder has a saved version in git, agents work in it directly, one at a time. Choose the folder again to save one.",
            MessageDialogKind::Info,
        );
        return;
    }
    let answer = daemon::run_cli(install, Some(dir), &["git-start", "--json"], None, Duration::from_secs(600));
    let (text, no_git) = match answer {
        Ok(out) => first_version_words(out.json().as_ref(), &out.stderr),
        Err(e) => (visible(&e), false),
    };
    if no_git {
        let open = ask3(app, "Friday: Git is not installed", &text, "Open the download page", "Close", MessageDialogKind::Warning);
        if open == Choice::First {
            platform_windows::shell_open(GIT_DOWNLOAD);
        }
        return;
    }
    tell(app, "Friday: first version", &text, MessageDialogKind::Info);
}

/// What `friday git-start --json` did, in a person's words; and whether Git is missing.
fn first_version_words(v: Option<&Value>, stderr: &str) -> (String, bool) {
    let Some(v) = v else {
        let line = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("Friday could not save a first version.");
        return (visible(line), false);
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let status = s("status");
    let mut text = visible(&s("message"));
    match status.as_str() {
        "started" | "saved" => {
            let secrets: Vec<String> = v
                .get("secrets")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).take(10).map(visible).collect())
                .unwrap_or_default();
            if !secrets.is_empty() {
                text.push_str(&format!("\n\nLeft out, they hold secrets (they stay on this computer): {}", secrets.join(", ")));
            }
            if v.get("ignore_written").and_then(Value::as_bool) == Some(true) {
                text.push_str("\n\nFriday wrote a .gitignore that lists the folders tools make, so they are never saved.");
            }
            if let Some(id) = v.get("identity").filter(|i| !i.is_null()) {
                let get = |k: &str| visible(id.get(k).and_then(Value::as_str).unwrap_or(""));
                text.push_str(&format!(
                    "\n\nGit did not know your name yet, so this project's versions are saved as {} <{}>. You can change it in VS Code's or git's settings.",
                    get("name"),
                    get("email")
                ));
            }
            text.push_str("\n\nAgents now work in copies of their own.");
        }
        "too_big" => {
            let big: Vec<String> = v
                .get("big")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|b| {
                            let p = b.get("path").and_then(Value::as_str)?;
                            let mb = b.get("bytes").and_then(Value::as_f64).unwrap_or(0.0) / 1_048_576.0;
                            Some(format!("  {}  {:.0} MB", visible(p), mb))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !big.is_empty() {
                text.push_str(&format!("\n\nThe biggest folders:\n{}", big.join("\n")));
            }
        }
        _ => {}
    }
    (text, status == "no_git")
}

/// Keeps the install found for this run, after making `install.json` name it (`friday setup`, when
/// the file is missing, broken or names another copy): the coding tools a person opens themselves
/// start the Friday that file names, so it has to be the one this app runs. One try, and the
/// install is then kept for the run; a failure goes to the error output (a console under
/// `cargo run`) and the app carries on with the install it found.
fn adopt_install(app: &AppHandle, install: daemon::Install) -> daemon::Install {
    if let Err(e) = daemon::refresh_install_file(&install) {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "friday-desktop: {e}");
    }
    *state(app).install.lock().unwrap() = Some(install.clone());
    install
}

/// The same for a start that opens no project, where nothing else looks for Friday: the install is
/// adopted when it is found without asking anything, and left for `ensure_install` when it is not.
fn adopt_install_quietly(app: &AppHandle) {
    if state(app).install.lock().unwrap().is_some() {
        return;
    }
    if let Some(i) = daemon::find_install(None) {
        adopt_install(app, i);
    }
}

/// Friday's install, asked for when it is not found; `install.json` is made to name it (see
/// `adopt_install`).
fn ensure_install(app: &AppHandle) -> Option<daemon::Install> {
    if let Some(i) = state(app).install.lock().unwrap().clone() {
        return Some(i);
    }
    let mut chosen: Option<PathBuf> = None;
    loop {
        if let Some(i) = daemon::find_install(chosen.as_deref()) {
            return Some(adopt_install(app, i));
        }
        // Friday's own program is there and Node.js is not: another folder would change nothing.
        // It asked for the folder again each time, and never named Node.js (2026-11-17).
        if let (Some(_), None) = daemon::find_parts(chosen.as_deref()) {
            // With its download page (2026-11-19): a computer set up from the installer alone has
            // Friday and needs Node.js, which the agents' hooks run by name in each project.
            match ask3(
                app,
                "Friday: Node.js is needed",
                "Friday runs on Node.js, and none was found on this computer.\n\nInstall Node.js 22.18 or newer (the LTS version from nodejs.org; the installer's defaults are fine), then choose Look again.",
                "Open the download page",
                "Look again",
                MessageDialogKind::Warning,
            ) {
                Choice::First => {
                    platform_windows::shell_open(NODE_DOWNLOAD);
                    // Asked again once it is installed: the dialog comes back with Look again.
                }
                Choice::Second => {}
                Choice::Cancel => return None,
            }
            continue;
        }
        let go = ask(
            app,
            &Dialog {
                title: "Friday: where is Friday installed?".into(),
                text: "The desktop app could not find Friday's own files (apps\\cli\\bin\\friday.mjs). Choose the folder Friday was installed or built in.".into(),
                confirm: "Choose the folder".into(),
                danger: false,
            },
        );
        if !go {
            return None;
        }
        chosen = Some(pick_folder(app, "Friday: choose Friday's folder")?);
    }
}

/// Starts the daemon when none answers; on failure shows the CLI's output and offers checks.
fn ensure_daemon(app: &AppHandle) {
    let Ok(project) = current_project(app) else { return };
    let Some(install) = ensure_install(app) else {
        set_status(app, "failed", Some("Friday's install was not found".into()));
        return;
    };
    loop {
        let result = {
            let st = state(app);
            let _one = st.lifecycle.lock().unwrap();
            st.stopping.store(false, Ordering::SeqCst);
            st.outdated.store(false, Ordering::SeqCst);
            if daemon::running(&project).is_some() {
                // Started before Friday was updated (2026-11-19): restarted now when nothing would
                // be interrupted, else said, and restarted by the watchdog once the work is done.
                if daemon::outdated(daemon::started_at(&project), daemon::code_built_at(&install)) {
                    if work_in_progress(&project) == Some(0) {
                        restart_updated(app, &project, &install)
                    } else {
                        st.outdated.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                } else {
                    Ok(())
                }
            } else {
                set_status(app, "starting", None);
                daemon::start(&project, &install).map(|_| ())
            }
        };
        match result {
            Ok(()) => {
                refresh_name(app, &project);
                set_status(app, "ready", None);
                return;
            }
            Err(f) => {
                set_status(app, "failed", Some(failure_line(&f)));
                let tail: Vec<String> = f.log_tail.iter().rev().take(15).rev().map(|l| visible(l)).collect();
                let text = format!(
                    "{}\n\nThe last lines of {}:\n{}\n\nRun Friday's checks, or start it again?",
                    f.message,
                    daemon::console_log(&project).display(),
                    if tail.is_empty() { "(empty)".to_string() } else { tail.join("\n") }
                );
                match ask3(app, "Friday did not start", &text, "Run checks", "Start again", MessageDialogKind::Error) {
                    Choice::First => run_checks(app, &install, &project),
                    Choice::Second => continue,
                    Choice::Cancel => return,
                }
                return;
            }
        }
    }
}

/// What a restart of the project's daemon would interrupt (`daemon::work_in_progress`); `None`
/// when the board could not be read, which counts as busy.
fn work_in_progress(project: &daemon::Project) -> Option<usize> {
    let raw = format!("{}{}/ui/snapshot", routes::PREFIX, project.id);
    proxy::send(project, Gate::Shell, &request("GET", &raw, None, Duration::from_secs(15)))
        .ok()
        .map(|v| daemon::work_in_progress(&v))
}

/// Stops a daemon that runs older code and starts the one now on disk; called under `lifecycle`.
fn restart_updated(
    app: &AppHandle,
    project: &daemon::Project,
    install: &daemon::Install,
) -> Result<(), daemon::StartFailure> {
    let st = state(app);
    st.stopping.store(true, Ordering::SeqCst);
    set_status(app, "starting", Some("Friday was updated: starting the new version".into()));
    st.streams.close_all();
    let stopped = daemon::stop(project);
    st.stopping.store(false, Ordering::SeqCst);
    if stopped.is_err() {
        // It kept running: the old one serves until it can be restarted.
        st.outdated.store(true, Ordering::SeqCst);
        return Ok(());
    }
    daemon::start(project, install).map(|_| ())
}

/// What the Studio shows when Friday did not start: the shell's own words and the last thing the
/// daemon wrote (its error), so "exit code 1" is not all a person gets.
fn failure_line(f: &daemon::StartFailure) -> String {
    match f.log_tail.iter().rev().map(|l| l.trim()).find(|l| !l.is_empty()) {
        Some(last) => format!("{}: {}", f.message, visible(&last.chars().take(300).collect::<String>())),
        None => f.message.clone(),
    }
}

/// `friday doctor --json`, summarised in a dialog.
fn run_checks(app: &AppHandle, install: &daemon::Install, project: &daemon::Project) {
    let text = match daemon::run_cli(install, Some(&project.root), &["doctor", "--json"], None, Duration::from_secs(120)) {
        Ok(out) => match out.json().and_then(|v| v.as_array().cloned()) {
            Some(checks) => {
                let lines: Vec<String> = checks
                    .iter()
                    .filter(|c| c.get("status").and_then(Value::as_str) != Some("ok"))
                    .map(|c| {
                        let get = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
                        let fix = get("fix");
                        format!(
                            "{} {}: {}{}",
                            visible(get("status")),
                            visible(get("id")),
                            visible(get("message")),
                            if fix.is_empty() { String::new() } else { format!(" (fix: {})", visible(fix)) }
                        )
                    })
                    .collect();
                if lines.is_empty() {
                    "Every check passed.".to_string()
                } else {
                    lines.join("\n")
                }
            }
            None => visible(out.stderr.trim()),
        },
        Err(e) => visible(&e),
    };
    tell(app, "Friday: checks", &text, MessageDialogKind::Info);
}

/// The project's name as the daemon knows it.
fn refresh_name(app: &AppHandle, project: &daemon::Project) {
    let raw = format!("{}{}", routes::PREFIX, project.id);
    if let Ok(v) = proxy::send(project, Gate::Shell, &request("GET", &raw, None, Duration::from_secs(10))) {
        if let Some(name) = v.get("name").and_then(Value::as_str) {
            if let Some(p) = state(app).project.write().unwrap().as_mut() {
                p.name = name.chars().take(200).collect();
            }
        }
    }
}

fn stop_friday(app: &AppHandle) -> Result<(), CmdError> {
    let project = current_project(app)?;
    let st = state(app);
    let _one = st.lifecycle.lock().unwrap();
    st.stopping.store(true, Ordering::SeqCst);
    set_status(app, "stopping", None);
    let r = daemon::stop(&project);
    st.streams.close_all();
    set_status(app, "stopped", r.as_ref().err().map(|e| e.message()));
    r
}

fn restart_friday(app: &AppHandle) -> Result<(), CmdError> {
    let project = current_project(app)?;
    if daemon::running(&project).is_some() {
        stop_friday(app)?;
    }
    ensure_daemon(app);
    let s = state(app).status.lock().unwrap().clone();
    if s.state == "ready" {
        Ok(())
    } else {
        Err(CmdError::offline(s.message.unwrap_or_else(|| "Friday did not start".into())))
    }
}

/// Notices a daemon that went away without this app stopping it.
fn spawn_watchdog(app: AppHandle) {
    let _ = std::thread::Builder::new().name("friday-watchdog".into()).spawn(move || {
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            ticks = ticks.wrapping_add(1);
            let st = state(&app);
            if st.status.lock().unwrap().state != "ready" || st.stopping.load(Ordering::SeqCst) {
                continue;
            }
            let Ok(p) = current_project(&app) else { continue };
            let alive = daemon::read_discovery(&p).is_ok_and(|d| platform_windows::pid_alive(d.pid));
            if !alive {
                set_status(&app, "stopped", Some("Friday stopped. Use Restart Friday in the tray to start it again.".into()));
                continue;
            }
            // A daemon left on old code because work was in progress: restarted with the new one
            // as soon as nothing would be interrupted, looked at every 30 seconds (2026-11-19).
            if ticks % 10 == 0 && st.outdated.load(Ordering::SeqCst) && work_in_progress(&p) == Some(0) {
                restart_when_idle(&app, &p);
            }
        }
    });
}

/// The watchdog's restart of an outdated daemon, one lifecycle step like any other.
fn restart_when_idle(app: &AppHandle, project: &daemon::Project) {
    let Some(install) = state(app).install.lock().unwrap().clone() else { return };
    let result = {
        let st = state(app);
        let _one = st.lifecycle.lock().unwrap();
        // Looked at again under the lock: a restart from the page may have been first.
        if !st.outdated.swap(false, Ordering::SeqCst) {
            return;
        }
        restart_updated(app, project, &install)
    };
    match result {
        Ok(()) => set_status(app, "ready", None),
        Err(f) => set_status(app, "failed", Some(failure_line(&f))),
    }
}

/// Opens a project and starts its Friday. `show` opens the Studio (a launch by hand; a start at
/// sign-in passes `--background` and stays in the tray), so the person sees Friday starting, or the
/// screen that says no project is open, instead of a tray icon alone. `use_last` reopens the last
/// project without asking; the Studio's "Choose a project folder" asks with the picker.
fn boot(app: AppHandle, initial: Option<PathBuf>, show: bool, use_last: bool) {
    if state(&app).choosing.swap(true, Ordering::SeqCst) {
        return;
    }
    let chosen = choose_project(&app, initial, use_last);
    state(&app).choosing.store(false, Ordering::SeqCst);
    let Some(project) = chosen else {
        set_status(&app, "no_project", None);
        if show {
            show_studio_window(&app, None);
        }
        // No daemon starts, so nothing below looks for Friday: `install.json` is still made to
        // name this copy, for the coding tools the person opens themselves.
        adopt_install_quietly(&app);
        return;
    };
    *state(&app).project.write().unwrap() = Some(project);
    set_status(&app, "starting", None);
    if show {
        show_studio_window(&app, None);
    }
    ensure_daemon(&app);
}

/// Whether two folders are the same project root (Windows paths compare without case).
fn same_root(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        let real = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        real.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
    };
    norm(a) == norm(b)
}

/// Opens another project in the app (2026-11-17). The app held one project for as long as it
/// ran: another one meant Quit, and a start from a terminal with `--project`. Now the tray's
/// "Open another project…", the project's name in the Studio and a second launch for another
/// folder all come here: the folder picker (unless the folder is given), with "Set up Friday here"
/// for a folder that is not a project yet, as at a first launch.
///
/// The project that was open keeps its Friday running or stops it, asked as on Quit: agents may
/// be working there. Cancelling at any point leaves everything as it was, the remembered project
/// included. Then the streams of the old project end, the new one is the app's project, both
/// windows are told to load again (`project-changed`), and its Friday is started.
fn switch_project(app: &AppHandle, initial: Option<PathBuf>) {
    let st = state(app);
    let Some(old) = st.project.read().unwrap().clone() else {
        // No project is open: this is the first choice, as the Studio's own button makes it.
        boot(app.clone(), initial, true, false);
        return;
    };
    if st.choosing.swap(true, Ordering::SeqCst) {
        return;
    }
    let (remembered, recent) = {
        let s = st.settings.lock().unwrap();
        (s.last_project.clone(), s.recent_projects.clone())
    };
    let chosen = choose_project(app, initial, false);
    st.choosing.store(false, Ordering::SeqCst);
    // `choose_project` remembers what it opened; a choice that is not taken is forgotten again.
    let keep_old = || {
        let mut s = st.settings.lock().unwrap();
        s.last_project = remembered.clone();
        s.recent_projects = recent.clone();
        let _ = s.save(&st.config_dir);
    };
    let Some(new) = chosen else {
        keep_old();
        return;
    };
    if same_root(&new.root, &old.root) {
        show_studio_window(app, None);
        return;
    }
    if daemon::running(&old).is_some() {
        let text = format!(
            "Keep Friday running in {} while you work in {}?\n\nAgents there keep working, and opening that project again brings you back to them. Stopping it keeps the work in its task folders.",
            visible(&old.name),
            visible(&new.name)
        );
        match ask3(app, "Friday: open another project?", &text, "Keep it running", "Stop it there", MessageDialogKind::Info) {
            Choice::First => {}
            Choice::Second => {
                let _ = stop_friday(app);
            }
            Choice::Cancel => {
                keep_old();
                return;
            }
        }
    }
    {
        // One change, under the lock every start and stop takes: nothing starts the old project
        // again between its streams ending and the new one taking its place.
        let _one = st.lifecycle.lock().unwrap();
        st.streams.close_all();
        *st.project.write().unwrap() = Some(new);
        st.paused.store(false, Ordering::SeqCst);
        if let Some(items) = st.tray.lock().unwrap().as_ref() {
            let _ = items.pause.set_text("Pause");
        }
    }
    set_status(app, "starting", None);
    // Both windows hold the old project's board: they load again, and find the new one.
    let _ = app.emit("project-changed", json!({}));
    show_studio_window(app, None);
    ensure_daemon(app);
}

// ---- tray and shortcuts --------------------------------------------------------------------------

fn send_control(app: &AppHandle, verb: &str) -> Result<Value, CmdError> {
    let project = current_project(app)?;
    let raw = format!("{}{}/control/{verb}", routes::PREFIX, project.id);
    proxy::send(&project, Gate::Confirmed, &request("POST", &raw, Some(&json!({})), Duration::from_secs(60)))
}

pub(crate) fn on_tray_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "show_notch" => {
            let st = state(&app);
            let show = st.island.is_parked();
            st.island.set_parked(&app, !show);
            if let Some(items) = st.tray.lock().unwrap().as_ref() {
                let _ = items.show_notch.set_checked(show);
            }
            let mut s = st.settings.lock().unwrap();
            s.show_notch = show;
            let _ = s.save(&st.config_dir);
        }
        "studio" => show_studio_window(&app, None),
        "settings" => show_studio_window(&app, Some(DeepLink { panel: Some("settings".into()), ..Default::default() })),
        "mute" => {
            let st = state(&app);
            let muted = !st.muted.load(Ordering::SeqCst);
            st.muted.store(muted, Ordering::SeqCst);
            if let Some(items) = st.tray.lock().unwrap().as_ref() {
                let _ = items.mute.set_checked(muted);
            }
            let _ = app.emit("toggle-mute", json!({ "muted": muted }));
        }
        "halt" => {
            show_studio_window(&app, None);
            let _ = app.emit_to(STUDIO, "open-halt", ());
        }
        other => {
            let other = other.to_string();
            std::thread::spawn(move || match other.as_str() {
                "pause" => {
                    let st = state(&app);
                    let paused = st.paused.load(Ordering::SeqCst);
                    match send_control(&app, if paused { "resume" } else { "pause" }) {
                        Ok(_) => {
                            st.paused.store(!paused, Ordering::SeqCst);
                            if let Some(items) = st.tray.lock().unwrap().as_ref() {
                                let _ = items.pause.set_text(if paused { "Pause" } else { "Resume" });
                            }
                        }
                        Err(e) => tell(&app, "Friday", &visible(&e.message()), MessageDialogKind::Error),
                    }
                }
                "browser" => {
                    if let Err(e) = open_browser(&app) {
                        tell(&app, "Friday: open in browser", &visible(&e.message()), MessageDialogKind::Error);
                    }
                }
                "stop" => {
                    if ask(&app, &confirm::stop_dialog()) {
                        if let Err(e) = stop_friday(&app) {
                            tell(&app, "Friday", &visible(&e.message()), MessageDialogKind::Error);
                        }
                    }
                }
                "restart" => {
                    if let Err(e) = restart_friday(&app) {
                        tell(&app, "Friday", &visible(&e.message()), MessageDialogKind::Error);
                    }
                }
                "open_project" => switch_project(&app, None),
                "quit" => quit(&app),
                _ => {}
            });
        }
    }
}

fn quit(app: &AppHandle) {
    let running = current_project(app).ok().and_then(|p| daemon::running(&p)).is_some();
    if running {
        match ask3(
            app,
            "Friday: quit the desktop app?",
            "Keep Friday running for this project after the app closes? Agents keep working, and the app or the shortcut brings you back.",
            "Keep Friday running",
            "Stop Friday",
            MessageDialogKind::Info,
        ) {
            Choice::First => {}
            Choice::Second => {
                let _ = stop_friday(app);
            }
            Choice::Cancel => return,
        }
    }
    state(app).streams.close_all();
    app.exit(0);
}

fn on_shortcut(app: &AppHandle, id: &str) {
    match id {
        "studio" => show_studio_window(app, None),
        "notch" => {
            let st = state(app);
            if st.island.is_parked() {
                st.island.set_parked(app, false);
            }
            st.island.set_keyboard(app, true);
            let _ = app.emit_to(island::LABEL, "notch-open", json!({ "focus": true }));
        }
        "halt" => {
            show_studio_window(app, None);
            let _ = app.emit_to(STUDIO, "open-halt", ());
        }
        _ => {}
    }
}

// ---- windows -------------------------------------------------------------------------------------

/// Navigation stays on the bundled pages.
fn navigation_allowed(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
        && matches!(url.path(), "/" | "/index.html" | "/notch.html")
}

fn create_windows(app: &tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, island::LABEL, WebviewUrl::App("notch.html".into()))
        .title("Friday Notch")
        .inner_size(island::NOTCH_W, island::NOTCH_H)
        .position(island::PARK_AT as f64, island::PARK_AT as f64)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(true)
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()?;
    WebviewWindowBuilder::new(app, STUDIO, WebviewUrl::App("index.html".into()))
        .title("Friday Studio")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .decorations(true)
        .visible(false)
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()?;
    Ok(())
}

/// `--project <dir>` on the command line.
fn project_arg(args: &[String]) -> Option<PathBuf> {
    args.iter().position(|a| a == "--project").and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let initial = project_arg(&args);
    // Windows' start at sign-in stays in the tray; a person's own launch opens the Studio.
    let show = !args.iter().any(|a| a == autostart::BACKGROUND);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| second_launch(app, argv)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(st) = app.try_state::<AppState>() {
                            if let Some(id) = st.shortcuts.which(shortcut) {
                                on_shortcut(app, id);
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            friday_request,
            confirm_and_send,
            confirm_answer,
            stream_open,
            stream_close,
            project_info,
            daemon_status,
            stop_daemon,
            restart_daemon,
            choose_project_folder,
            open_another_project,
            recent_projects,
            open_recent_project,
            open_project_file,
            notch_rect,
            notch_keyboard,
            show_studio,
            set_tray_state,
            notify,
            get_shortcuts,
            set_shortcut,
            open_in_editor,
            open_in_browser,
            store_key,
            allow_spending,
            get_autostart,
            set_autostart,
        ])
        .setup(move |app| {
            let config_dir = app.path().app_config_dir()?;
            let settings = settings::Settings::load(&config_dir);
            let island = Arc::new(island::Island::default());
            island.set_monitor(settings.notch_monitor.clone());
            let show_notch = settings.show_notch;
            let stored_shortcuts = settings.shortcuts.clone();
            // The state must exist before the first webview does: a warm WebView2 loads the Notch
            // page during `create_windows` below, and its first `notch_rect` invoke lands while
            // setup is still running (LESSON: manage before windows, or a page beat the setup).
            app.manage(ask::Waiting::default());
            app.manage(AppState {
                project: RwLock::new(None),
                install: Mutex::new(None),
                status: Mutex::new(DaemonStatus { state: "starting", message: None, outdated: false }),
                island: island.clone(),
                streams: Arc::new(events::Streams::default()),
                shortcuts: shortcuts::Shortcuts::default(),
                settings: Mutex::new(settings),
                config_dir,
                tray: Mutex::new(None),
                lifecycle: Mutex::new(()),
                notifier: notify::Notifier::default(),
                paused: AtomicBool::new(false),
                muted: AtomicBool::new(false),
                stopping: AtomicBool::new(false),
                choosing: AtomicBool::new(false),
                outdated: AtomicBool::new(false),
            });
            create_windows(app)?;
            let handle = app.handle().clone();
            if let Some(notch) = island::window(&handle) {
                platform_windows::keep_tool_window(platform_windows::raw_hwnd(&notch));
                let _ = notch.set_ignore_cursor_events(true);
            }
            island.set_parked(&handle, !show_notch);
            island.spawn_poll(handle.clone());
            let items = tray::build(&handle, show_notch)?;
            *state(&handle).tray.lock().unwrap() = Some(items);
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    state(&h).shortcuts.apply(&h, &stored_shortcuts);
                });
            }
            {
                let h = handle.clone();
                let initial = initial.clone();
                std::thread::spawn(move || boot(h, initial, show, true));
            }
            spawn_watchdog(handle.clone());
            #[cfg(feature = "probe")]
            probe::start(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == STUDIO {
                    let _ = window.hide();
                }
            }
            WindowEvent::ScaleFactorChanged { .. } if window.label() == island::LABEL => {
                if let Some(st) = window.app_handle().try_state::<AppState>() {
                    st.island.place(window.app_handle());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("the desktop app could not start");
    app.run(|app, event| match event {
        // Closing windows never quits; the tray's Quit does.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(st) = app.try_state::<AppState>() {
                st.streams.close_all();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Planning without Claude (2026-11-23): Codex and a service reached with a key are approved
    // here too, held to requests a day because Friday knows no price for them.
    #[test]
    fn approving_a_planner_says_whose_account_and_which_limit() {
        let (text, args) = spending_words("shop", "claude-code", 2.0, None).unwrap();
        assert!(text.contains("with your Claude Code sign-in"));
        assert!(text.contains("spending at most $2 a day"));
        assert_eq!(args, vec!["--budget".to_string(), "2".to_string()]);
        // Dollars are not asked of a planner Friday knows no price for: requests are.
        let (text, args) = spending_words("shop", "codex", 0.0, Some(50)).unwrap();
        assert!(text.contains("with your Codex sign-in (your ChatGPT plan or key, as Codex uses it)"));
        assert!(text.contains("with at most 50 requests a day"));
        assert!(text.contains("Friday knows no price for it, so it counts requests instead of dollars"));
        assert!(text.contains("sends the goal and a summary of the project there"));
        assert!(!text.contains('$'));
        assert_eq!(args, vec!["--calls".to_string(), "50".to_string()]);
        for (provider, whose) in [
            ("openai", "your OpenAI API key"),
            ("gemini", "your Google Gemini API key"),
            ("deepseek", "your DeepSeek API key"),
            ("openrouter", "your OpenRouter API key"),
        ] {
            let (text, _) = spending_words("shop", provider, 0.0, Some(10)).unwrap();
            assert!(text.contains(whose), "{provider}");
        }
        // No number of requests, one out of range, an unknown planner, a budget out of range: refused.
        assert!(spending_words("shop", "codex", 0.0, None).is_err());
        assert!(spending_words("shop", "codex", 0.0, Some(0)).is_err());
        assert!(spending_words("shop", "openai", 0.0, Some(10_001)).is_err());
        assert!(spending_words("shop", "local", 1.0, None).is_err());
        assert!(spending_words("shop", "evil --flag", 1.0, Some(5)).is_err());
        assert!(spending_words("shop", "anthropic", -1.0, None).is_err());
        assert!(spending_words("shop", "anthropic", f64::NAN, None).is_err());
    }

    // A folder with no saved version in git (2026-11-19, G2): what Friday did, in words.
    #[test]
    fn the_first_version_is_told_with_what_was_left_out_and_under_which_name() {
        let saved = serde_json::json!({
            "status": "started", "message": "4 files saved as the first version.", "files": 4,
            "secrets": ["config/server.pem"], "ignore_written": true,
            "identity": { "name": "rahul", "email": "rahul@desk" }, "big": []
        });
        let (text, no_git) = first_version_words(Some(&saved), "");
        assert!(!no_git);
        assert!(text.starts_with("4 files saved as the first version."));
        assert!(text.contains("they hold secrets (they stay on this computer): config/server.pem"));
        assert!(text.contains("Friday wrote a .gitignore"));
        assert!(text.contains("saved as rahul <rahul@desk>"));
        let big = serde_json::json!({
            "status": "too_big", "message": "30000 files, 900 MB: … Nothing was changed.",
            "big": [{ "path": "vendor/", "bytes": 734_003_200 }]
        });
        let (text, _) = first_version_words(Some(&big), "");
        assert!(text.contains("The biggest folders:\n  vendor/  700 MB"));
        assert!(!text.contains("copies of their own"));
        let (text, no_git) = first_version_words(Some(&serde_json::json!({ "status": "no_git", "message": "Git is not installed" })), "");
        assert!(no_git);
        assert_eq!(text, "Git is not installed");
        let (text, _) = first_version_words(None, "\nerror: boom\n");
        assert_eq!(text, "error: boom");
    }

    #[test]
    fn navigation_stays_on_the_bundled_pages() {
        let ok = |s: &str| navigation_allowed(&url::Url::parse(s).unwrap());
        assert!(ok("http://tauri.localhost/index.html"));
        assert!(ok("http://tauri.localhost/notch.html"));
        assert!(ok("http://tauri.localhost/"));
        assert!(!ok("http://tauri.localhost/other.html"));
        assert!(!ok("https://tauri.localhost/index.html"));
        assert!(!ok("http://127.0.0.1:4310/ui/"));
        assert!(!ok("http://tauri.localhost:8080/index.html"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("file:///C:/x.html"));
    }

    #[test]
    fn deep_links_are_checked() {
        assert!(DeepLink { focus_task: Some("task_1".into()), ..Default::default() }.valid());
        assert!(DeepLink { panel: Some("settings".into()), ..Default::default() }.valid());
        assert!(!DeepLink { panel: Some("<b>".into()), ..Default::default() }.valid());
        assert!(!DeepLink { approval_id: Some("a b".into()), ..Default::default() }.valid());
        assert!(DeepLink { panel: Some("recover".into()), id: Some("task_1".into()), ..Default::default() }.valid());
        assert!(DeepLink { approval_id: Some("apr_1".into()), reach: Some("task".into()), ..Default::default() }.valid());
        assert!(!DeepLink { approval_id: Some("apr_1".into()), reach: Some("forever".into()), ..Default::default() }.valid());
        assert!(!DeepLink { panel: Some("recover".into()), id: Some("../x".into()), ..Default::default() }.valid());
        assert_eq!(
            serde_json::to_value(DeepLink { approval_id: Some("a1".into()), ..Default::default() }).unwrap(),
            json!({"approval_id": "a1"})
        );
    }

    #[test]
    fn deep_links_carry_a_drawer_tab_and_a_file() {
        let link = |v: Value| serde_json::from_value::<DeepLink>(v).unwrap();
        let diff = json!({"panel": "diff", "id": "task_1", "tab": "files", "path": "src/a b/ünï.ts"});
        assert!(link(diff.clone()).valid());
        // What the Studio receives is what the Notch sent.
        assert_eq!(serde_json::to_value(link(diff.clone())).unwrap(), diff);
        assert!(link(json!({"panel": "settings", "tab": "planner"})).valid());
        assert!(link(json!({"panel": "settings", "tab": "starts-at-sign-in"})).valid());
        // The page's rule (desktop/boot.ts `TAB`): a letter first, then letters, digits and hyphens.
        assert!(link(json!({"panel": "settings", "tab": "step-2"})).valid());
        for tab in ["", "Planner", "planner_1", "<b>", "-planner", "2fa", "a".repeat(33).as_str()] {
            assert!(!link(json!({"panel": "settings", "tab": tab})).valid(), "{tab:?}");
        }
        assert!(link(json!({"panel": "settings", "tab": "a".repeat(32)})).valid());
        // Every drawer and dialog the page names (shell/context.ts), and every tab it opens one on.
        let panels = [
            "inspector", "diff", "graph", "memory", "terminal", "agents", "inbox", "settings", "approval", "question",
            "new-goal", "halt", "plan-editor", "verify", "recover", "land", "claude-setup", "antigravity-setup",
            "start-agent", "plan-review",
        ];
        let tabs = [
            "planner", "routing", "pins", "claude", "antigravity", "goal", "overview", "context", "git", "history",
            "combined", "tools", "errors", "process",
        ];
        for panel in panels {
            for tab in tabs {
                assert!(link(json!({"panel": panel, "tab": tab})).valid(), "{panel} {tab}");
            }
        }
        assert!(link(json!({"panel": "diff", "path": "é".repeat(1024)})).valid());
        let bad: [String; 6] =
            ["".into(), "é".repeat(1025), "a\0b".into(), "a\nb".into(), "a\u{1b}[2Jb".into(), "a\u{85}b".into()];
        for path in bad {
            assert!(!link(json!({"panel": "diff", "path": path})).valid(), "{path:?}");
        }
    }

    #[test]
    fn provider_names_are_checked() {
        assert!(provider_name_ok("anthropic"));
        assert!(provider_name_ok("open_router-2"));
        assert!(!provider_name_ok("Anthropic"));
        assert!(!provider_name_ok("a b"));
        assert!(!provider_name_ok("--from-env"));
        assert!(!provider_name_ok(""));
    }

    #[test]
    fn the_project_argument_is_read() {
        let args: Vec<String> = ["friday-desktop", "--project", r"C:\work\shop"].iter().map(|s| s.to_string()).collect();
        assert_eq!(project_arg(&args), Some(PathBuf::from(r"C:\work\shop")));
        assert_eq!(project_arg(&args[..1]), None);
    }

    #[test]
    fn the_same_folder_is_one_project_however_it_is_written() {
        use std::path::Path;
        // Folders that do not exist are compared as written: without case, and without a last separator.
        assert!(same_root(Path::new(r"Z:\Work\Shop"), Path::new(r"z:\work\shop")));
        assert!(same_root(Path::new(r"Z:\work\shop\"), Path::new(r"Z:\work\shop")));
        assert!(same_root(Path::new("Z:/work/shop/"), Path::new("Z:/work/shop")));
        assert!(!same_root(Path::new(r"Z:\work\shop"), Path::new(r"Z:\work\shop2")));
        assert!(!same_root(Path::new(r"Z:\work\shop"), Path::new(r"Z:\work")));
        // A folder that exists is the same through its real path.
        let here = std::env::temp_dir();
        assert!(same_root(&here, &here.join(".")));
    }

    #[test]
    fn a_failed_start_says_what_the_daemon_wrote_last() {
        let f = |message: &str, tail: &[&str]| daemon::StartFailure {
            message: message.into(),
            log_tail: tail.iter().map(|l| l.to_string()).collect(),
        };
        // The last line that says something: the daemon's own error.
        assert_eq!(
            failure_line(&f("Friday stopped while starting (exit code 1)", &["starting", "config.yaml: bad key  ", "", "  "])),
            "Friday stopped while starting (exit code 1): config.yaml: bad key"
        );
        // An empty log leaves the shell's words alone.
        assert_eq!(failure_line(&f("could not run node: not found", &[])), "could not run node: not found");
        // A long line is cut, and a control character in it is never sent to the page raw.
        let noisy = format!("{}\u{1b}[2J", "e".repeat(400));
        let long = failure_line(&f("x", &[noisy.as_str()]));
        assert!(long.chars().count() <= 3 + 300 + 16, "{}", long.chars().count());
        assert!(!long.contains('\u{1b}'));
    }
}
