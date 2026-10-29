//! The verification harness (feature `probe`; README "Verifying the shell"). Never in a normal
//! build. With `FRIDAY_DESKTOP_PROBE=<file>` set, the app runs a script in both windows once the
//! daemon is ready: it checks that Tauri's IPC works under the CSP (with Trusted Types), that the
//! page has no global Tauri object, that `eval`, `innerHTML` and foreign `fetch` are blocked, that
//! `friday_request` reads the snapshot and refuses an approval, that the event stream delivers,
//! and (from Rust) the Notch window's styles and click-through. The result goes to the file as
//! JSON and the app quits.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::platform_windows as os;

const SCRIPT: &str = r#"
window.__fridayProbe = { done: false };
(async () => {
  const r = {};
  const t = window.__TAURI_INTERNALS__;
  r.internals = !!t;
  r.global_tauri = typeof window.__TAURI__ !== 'undefined';
  r.title = document.title;
  r.page_rendered = !!(document.getElementById('app') && document.getElementById('app').children.length);
  try { const d = document.createElement('div'); d.innerHTML = '<b>x</b>'; r.inner_html = 'allowed'; }
  catch (e) { r.inner_html = 'blocked: ' + e.name; }
  try { (0, eval)('1'); r.eval = 'allowed'; } catch (e) { r.eval = 'blocked: ' + e.name; }
  try { await fetch('http://127.0.0.1:9/'); r.fetch_other = 'allowed'; } catch (e) { r.fetch_other = 'blocked: ' + e.name; }
  const call = async (cmd, args) => {
    try { return { ok: true, value: await t.invoke(cmd, args) }; }
    catch (e) { return { ok: false, error: e }; }
  };
  r.shortcuts = await call('get_shortcuts');
  let status = await call('daemon_status');
  for (let i = 0; i < 80 && !(status.ok && status.value.state === 'ready'); i += 1) {
    await new Promise((res) => setTimeout(res, 500));
    status = await call('daemon_status');
  }
  r.daemon_status = status;
  const info = await call('project_info');
  r.project_info = info.ok ? { ok: true, ui_api: info.value.ui_api, has_port: typeof info.value.port === 'number' } : info;
  if (info.ok) {
    const p = '/api/v1/projects/' + info.value.project_id;
    const snap = await call('friday_request', { method: 'GET', path: p + '/ui/snapshot' });
    r.snapshot = snap.ok ? { ok: true, ui_api: snap.value.ui_api, head: snap.value.head } : snap;
    r.approve_refused = await call('friday_request', { method: 'POST', path: p + '/approvals/appr_x/approve', body: { reuse: 'once' } });
    r.admin_refused = await call('friday_request', { method: 'POST', path: '/admin/shutdown' });
    r.dots_refused = await call('friday_request', { method: 'GET', path: p + '/tasks/%2e%2e/diff' });
    r.not_pending = await call('confirm_and_send', { method: 'POST', path: p + '/approvals/appr_x/approve', body: { reuse: 'once' } });
    const got = [];
    const id = t.transformCallback((m) => got.push(m && 'message' in m ? m.message : m));
    const opened = await call('stream_open', { since: 0, channel: '__CHANNEL__:' + id });
    await new Promise((res) => setTimeout(res, 2500));
    if (opened.ok) await call('stream_close', { id: opened.value });
    r.stream = { opened, kinds: [...new Set(got.map((m) => m && m.kind))], count: got.length };
    if (window.__FRIDAY_PROBE_RESTART__) {
      const before = info.value.port;
      r.restart = await call('restart_daemon');
      const after = await call('project_info');
      r.restart_port_changed = after.ok && after.value.port !== before;
      r.status_after_restart = await call('daemon_status');
      const snap2 = await call('friday_request', { method: 'GET', path: p + '/ui/snapshot' });
      r.snapshot_after_restart = snap2.ok;
    }
  }
  window.__fridayProbe = { done: true, result: r };
})();
"#;

fn read_result(win: &tauri::WebviewWindow) -> Option<Value> {
    let (tx, rx) = mpsc::channel();
    win.eval_with_callback("JSON.stringify(window.__fridayProbe || null)", move |s| {
        let _ = tx.send(s);
    })
    .ok()?;
    let s = rx.recv_timeout(Duration::from_secs(5)).ok()?;
    // The callback gets the JSON of the script's value: here a JSON string holding JSON.
    let inner: String = serde_json::from_str(&s).ok()?;
    serde_json::from_str(&inner).ok()
}

fn native_checks(app: &AppHandle) -> Value {
    let Some(notch) = crate::island::window(app) else { return json!({"error": "no notch window"}) };
    let raw = os::raw_hwnd(&notch);
    let ex = os::ex_style(raw);
    let mut out = json!({
        "ex_style": format!("{ex:#x}"),
        "tool_window": ex & 0x80 != 0,
        "no_activate": ex & 0x0800_0000 != 0,
        "topmost": ex & 0x8 != 0,
        "window_rect": os::window_rect(raw),
        "cursor": os::cursor_physical(),
    });
    let Some((wx, wy, ww, wh)) = os::window_rect(raw) else { return out };
    let scale = notch.scale_factor().unwrap_or(1.0);
    let st = crate::state(app);
    // The wake strip: only the strip takes the mouse.
    st.island.set_rect(app, crate::island::Rect { x: 170.0, y: 0.0, w: 120.0, h: 4.0 });
    std::thread::sleep(Duration::from_millis(300));
    let strip_x = wx + (230.0 * scale) as i32;
    out["strip_takes_mouse"] = json!(os::window_at_is(strip_x, wy + 1, raw));
    out["below_strip_passes"] = json!(!os::window_at_is(strip_x, wy + (100.0 * scale) as i32, raw));
    out["ex_style_strip"] = json!(format!("{:#x}", os::ex_style(raw)));
    // The expanded card with the cursor away from it: the whole window lets clicks through.
    st.island.set_rect(app, crate::island::Rect { x: 30.0, y: 0.0, w: 400.0, h: 200.0 });
    std::thread::sleep(Duration::from_millis(300));
    let cursor_on_card = os::cursor_physical().is_some_and(|(cx, cy)| {
        cx >= wx - 20 && cx <= wx + ww + 20 && cy >= wy - 20 && cy <= wy + wh + 20
    });
    out["cursor_near_window"] = json!(cursor_on_card);
    out["card_ex_style"] = json!(format!("{:#x}", os::ex_style(raw)));
    out["card_click_through_while_cursor_away"] = json!(os::ex_style(raw) & 0x20 != 0);
    out["card_point_passes_while_cursor_away"] =
        json!(!os::window_at_is(wx + (230.0 * scale) as i32, wy + (100.0 * scale) as i32, raw));
    out
}

pub fn start(app: AppHandle) {
    let Some(file) = std::env::var_os("FRIDAY_DESKTOP_PROBE") else { return };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        let started = Instant::now();
        let mut report = json!({});
        let restart = std::env::var_os("FRIDAY_DESKTOP_PROBE_RESTART").is_some();
        // One window after the other: the Studio's run may restart the daemon.
        for label in [crate::island::LABEL, crate::STUDIO] {
            let Some(w) = app.get_webview_window(label) else { continue };
            let flag = if restart && label == crate::STUDIO { "window.__FRIDAY_PROBE_RESTART__ = true;" } else { "" };
            let _ = w.eval(format!("{flag}{SCRIPT}"));
            let mut result = Value::Null;
            while started.elapsed() < Duration::from_secs(90) {
                match read_result(&w) {
                    Some(v) if v.get("done") == Some(&Value::Bool(true)) => {
                        result = v["result"].clone();
                        break;
                    }
                    Some(v) => result = v,
                    None => {}
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            report[label] = result;
        }
        report["native"] = native_checks(&app);
        let _ = std::fs::write(&file, serde_json::to_string_pretty(&report).unwrap_or_default());
        app.exit(0);
    });
}
