//! Friday's desktop shell (plan §8): the Notch window over the user's editor and the Studio
//! window, both hosting the `apps/ui` bundle, with a tray, global shortcuts and native
//! notifications. The Rust core is the only HTTP client of the daemon on the desktop: the webview
//! holds no credential (FD-06) and reaches the daemon only through the commands below.

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
    let mut b = app
        .dialog()
        .message(&d.text)
        .title(&d.title)
        .kind(if d.danger { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::OkCancelCustom(d.confirm.clone(), "Cancel".into()));
    if let Some(w) = visible_studio(app) {
        b = b.parent(&w);
    }
    b.blocking_show()
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
async fn confirm_and_send(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, CmdError> {
    let project = current_project(&app)?;
    blocking(move || {
        let discovery = daemon::read_discovery(&project)?;
        let (checked, what) = routes::for_confirm(&method, &path, body.as_ref(), &project.id, discovery.port)?;
        let get = |raw: &str| proxy::send(&project, Gate::Shell, &request("GET", raw, None, Duration::from_secs(60)));
        let prepared = confirm::prepare(what, &checked, &project.id, body.as_ref(), &get)?;
        if let Some(dialog) = &prepared.dialog {
            if !ask(&app, dialog) {
                return Err(confirm::cancelled_error());
            }
        }
        let timeout = match what {
            Some(routes::Confirm::Halt) | Some(routes::Confirm::LaunchAgent) | Some(routes::Confirm::StartAgent) => {
                Duration::from_secs(120)
            }
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
}

impl DeepLink {
    fn valid(&self) -> bool {
        let id = |s: &Option<String>| {
            s.as_ref().is_none_or(|v| {
                !v.is_empty() && v.len() <= 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
        };
        let panel = self
            .panel
            .as_ref()
            .is_none_or(|v| !v.is_empty() && v.len() <= 32 && v.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
        let reach = self.reach.as_deref().is_none_or(|r| matches!(r, "once" | "run" | "task"));
        id(&self.focus_task) && id(&self.approval_id) && id(&self.id) && panel && reach
    }
}

/// A second launch of the app: open its `--project` when none is open, or say which one is.
fn second_launch(app: &AppHandle, argv: Vec<String>) {
    if let Some(dir) = project_arg(&argv) {
        let open = state(app).project.read().unwrap().clone();
        let app2 = app.clone();
        match open {
            None => {
                std::thread::spawn(move || boot(app2, Some(dir)));
            }
            Some(p) => {
                let wanted = std::fs::canonicalize(&dir).unwrap_or(dir);
                let inside = wanted.to_string_lossy().to_lowercase().starts_with(&p.root.to_string_lossy().to_lowercase());
                if !inside {
                    let text = format!(
                        "The desktop app is open for {}.\n\nTo open {}, close the app (tray: Quit) and start it again from that project.",
                        visible(&p.root.to_string_lossy()),
                        visible(&wanted.to_string_lossy())
                    );
                    std::thread::spawn(move || {
                        app2.dialog().message(text).title("Friday: another project").kind(MessageDialogKind::Info).blocking_show();
                    });
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
    let line = notify::clean(&counts_line, 80);
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

/// A native notification, sent only while the Notch is parked or the screen is locked.
#[tauri::command]
fn notify(app: AppHandle, window: WebviewWindow, title: String, body: String) -> Result<bool, CmdError> {
    if window.label() != island::LABEL {
        return Err(CmdError::bad_request("notifications come from the Notch window"));
    }
    let st = state(&app);
    Ok(st.notifier.notify(&app, st.island.is_parked(), &title, &body))
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
            .ok_or_else(|| CmdError::bad_request("only files of the project and its worktrees open in the editor"))?;
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

/// Lets this clone use the provider key, after a native confirmation:
/// `friday brain allow-remote --budget <n> --json` (FD-26).
#[tauri::command]
async fn allow_spending(app: AppHandle, budget: f64) -> Result<Value, CmdError> {
    if !budget.is_finite() || !(0.0..=100_000.0).contains(&budget) {
        return Err(CmdError::bad_request("the budget is a number of dollars from 0 to 100000"));
    }
    let install = current_install(&app)?;
    let project = current_project(&app)?;
    blocking(move || {
        let amount = format!("{}", (budget * 100.0).round() / 100.0);
        let d = Dialog {
            title: "Friday: allow this clone to spend?".into(),
            text: format!(
                "Let this clone of {} use your provider key for the Master Brain, at most ${} a day?\n\nThe project's own budget still applies; the lower of the two wins.",
                visible(&project.name),
                amount
            ),
            confirm: "Allow".into(),
            danger: true,
        };
        if !ask(&app, &d) {
            return Err(confirm::cancelled_error());
        }
        let out = daemon::run_cli(
            &install,
            Some(&project.root),
            &["brain", "allow-remote", "--budget", &amount, "--json"],
            None,
            Duration::from_secs(60),
        )
        .map_err(|e| CmdError::shell(500, "DESKTOP-2006", "cli_failed", e))?;
        if out.code != Some(0) {
            let first = out.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("the command failed");
            return Err(CmdError::shell(500, "DESKTOP-2006", "cli_failed", visible(first)));
        }
        Ok(out.json().unwrap_or(Value::Null))
    })
    .await
}

// ---- lifecycle -----------------------------------------------------------------------------------

fn set_status(app: &AppHandle, state_name: &'static str, message: Option<String>) {
    let status = DaemonStatus { state: state_name, message };
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
fn choose_project(app: &AppHandle, initial: Option<PathBuf>) -> Option<daemon::Project> {
    let mut next = initial.or_else(|| state(app).settings.lock().unwrap().last_project.clone()).filter(|d| d.is_dir());
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
            let mut text = format!(
                "Friday is set up in {}.\n\nCommit these two files so every clone shares the project:\n  .friday/config.yaml\n  .friday/.gitignore",
                visible(&dir.to_string_lossy())
            );
            if !daemon::has_commit(dir) {
                text.push_str("\n\nThis repository has no commit yet: every agent would work in the main checkout. Make a first commit before you start agents.");
            }
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

/// Friday's install; `friday setup` runs when `install.json` is missing or stale.
fn ensure_install(app: &AppHandle) -> Option<daemon::Install> {
    if let Some(i) = state(app).install.lock().unwrap().clone() {
        return Some(i);
    }
    let mut chosen: Option<PathBuf> = None;
    loop {
        if let Some(i) = daemon::find_install(chosen.as_deref()) {
            if !daemon::install_file_ok() {
                let _ = daemon::run_cli(&i, None, &["setup", "--json"], None, Duration::from_secs(60));
            }
            *state(app).install.lock().unwrap() = Some(i.clone());
            return Some(i);
        }
        let go = ask(
            app,
            &Dialog {
                title: "Friday: where is Friday installed?".into(),
                text: "The desktop app could not find Friday (apps\\cli\\bin\\friday.mjs and node.exe). Choose the folder of your Friday checkout, built with pnpm build.".into(),
                confirm: "Choose the folder".into(),
                danger: false,
            },
        );
        if !go {
            return None;
        }
        chosen = Some(pick_folder(app, "Friday: choose the Friday checkout")?);
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
            if daemon::running(&project).is_some() {
                Ok(())
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
                set_status(app, "failed", Some(f.message.clone()));
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
    let _ = std::thread::Builder::new().name("friday-watchdog".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let st = state(&app);
        if st.status.lock().unwrap().state != "ready" || st.stopping.load(Ordering::SeqCst) {
            continue;
        }
        let Ok(p) = current_project(&app) else { continue };
        let alive = daemon::read_discovery(&p).is_ok_and(|d| platform_windows::pid_alive(d.pid));
        if !alive {
            set_status(&app, "stopped", Some("Friday stopped. Use Restart Friday in the tray to start it again.".into()));
        }
    });
}

fn boot(app: AppHandle, initial: Option<PathBuf>) {
    let Some(project) = choose_project(&app, initial) else {
        set_status(&app, "no_project", Some("No project is open. Restart the app to choose one.".into()));
        return;
    };
    *state(&app).project.write().unwrap() = Some(project);
    ensure_daemon(&app);
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
            stream_open,
            stream_close,
            project_info,
            daemon_status,
            stop_daemon,
            restart_daemon,
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
        ])
        .setup(move |app| {
            let config_dir = app.path().app_config_dir()?;
            let settings = settings::Settings::load(&config_dir);
            create_windows(app)?;
            let island = Arc::new(island::Island::default());
            island.set_monitor(settings.notch_monitor.clone());
            let show_notch = settings.show_notch;
            let stored_shortcuts = settings.shortcuts.clone();
            app.manage(AppState {
                project: RwLock::new(None),
                install: Mutex::new(None),
                status: Mutex::new(DaemonStatus { state: "starting", message: None }),
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
            });
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
                std::thread::spawn(move || boot(h, initial));
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
}
