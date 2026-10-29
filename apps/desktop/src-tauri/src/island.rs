//! The Notch window (plan §8.1, §8.2, FD-17, ERRATA F14, F32).
//!
//! A transparent, undecorated, always-on-top window of a fixed 460×300 logical pixels at the top
//! centre of the chosen monitor. It never takes focus by itself (not focusable, and
//! `WS_EX_TOOLWINDOW` kept by a window subclass), and it is hidden by parking it off-screen, never
//! by hide/show (show can take focus).
//!
//! Click-through: a thread reads the cursor every 16 ms, hit-tests the island rectangle the page
//! reported (`notch_rect`) grown by [`HIT_MARGIN`], and toggles `set_ignore_cursor_events`, so a
//! click outside the island reaches the editor underneath. The decision is made on the same tick
//! as the cursor read (an IPC round trip would lose clicks) and again whenever the rectangle
//! changes, even under a still cursor. While the island is the wake strip (its hidden state) the
//! thread parks: the window is cut down to the strip with a window region, and only the strip
//! takes the mouse. The thread also sends the cursor position to the page (event `cursor`, CSS
//! pixels of the window) while it moves, for the mascot's eyes.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::platform_windows as os;

pub const LABEL: &str = "notch";
/// Logical size of the Notch window: the largest card, its spring overshoot and the hit margin.
pub const NOTCH_W: f64 = 460.0;
pub const NOTCH_H: f64 = 300.0;
/// Margin around the island that still takes the mouse, in logical pixels: the flag is already
/// off by the time a moving cursor reaches a button.
pub const HIT_MARGIN: f64 = 14.0;
/// The cursor poll period.
pub const POLL: Duration = Duration::from_millis(16);
/// A reported rectangle at most this high is the wake strip (the island's hidden state, 4 px).
pub const WAKE_STRIP_MAX_H: f64 = 4.5;
/// Where a parked window waits.
pub const PARK_AT: i32 = -32000;

/// The island in window-logical (CSS) pixels.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    /// A rectangle from the page, clamped to the window; `None` for non-finite values.
    pub fn from_page(x: f64, y: f64, w: f64, h: f64) -> Option<Rect> {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) {
            return None;
        }
        let w = w.clamp(0.0, NOTCH_W);
        let h = h.clamp(0.0, NOTCH_H);
        let x = x.clamp(-HIT_MARGIN, NOTCH_W);
        let y = y.clamp(-HIT_MARGIN, NOTCH_H);
        Some(Rect { x, y, w, h })
    }

    pub fn is_wake_strip(&self) -> bool {
        self.h <= WAKE_STRIP_MAX_H
    }

    /// True when (x, y) is on the island or within `margin` of it. An empty island takes nothing.
    pub fn hit(&self, x: f64, y: f64, margin: f64) -> bool {
        self.w > 0.0
            && self.h > 0.0
            && x >= self.x - margin
            && x <= self.x + self.w + margin
            && y >= self.y - margin
            && y <= self.y + self.h + margin
    }
}

#[derive(Debug, Default)]
struct State {
    rect: Option<Rect>,
    /// Bumped on every rectangle change, so the poll decides again under a still cursor.
    generation: u64,
    /// The tray's "Show Notch" is off: the window is off-screen.
    parked: bool,
    /// The island is the wake strip: the window is cut to it and the poll sleeps.
    strip: bool,
    /// The last click-through flag applied (None: decide on the next tick).
    ignoring: Option<bool>,
    /// The Notch holds the keyboard, and the window that had it before.
    keyboard: bool,
    previous_foreground: isize,
}

impl State {
    fn polling(&self) -> bool {
        !self.parked && !self.strip && self.rect.is_some()
    }
}

/// Shared between the commands and the poll thread.
#[derive(Default)]
pub struct Island {
    state: Mutex<State>,
    wake: Condvar,
    /// The monitor name the Notch lives on (none: the primary monitor).
    monitor: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct Cursor {
    x: f64,
    y: f64,
}

pub fn window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(LABEL)
}

fn target_monitor<R: Runtime>(app: &AppHandle<R>, name: Option<&str>) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if let Some(name) = name {
        if let Some(m) = monitors.iter().find(|m| m.name().map(String::as_str) == Some(name)) {
            return Some(m.clone());
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next())
}

/// Position, size and scale of the target monitor; a change means placing the window again.
fn monitor_key(m: &Monitor) -> (i32, i32, u32, u32, u64) {
    let p = m.position();
    let s = m.size();
    (p.x, p.y, s.width, s.height, m.scale_factor().to_bits())
}

/// The window's physical size and top-left corner on a monitor: top centre, monitor frame.
pub fn placement(monitor_pos: (i32, i32), monitor_size: (u32, u32), scale: f64) -> ((u32, u32), (i32, i32)) {
    let pw = (NOTCH_W * scale).round().max(1.0) as u32;
    let ph = (NOTCH_H * scale).round().max(1.0) as u32;
    let x = monitor_pos.0 + (monitor_size.0 as i32 - pw as i32) / 2;
    ((pw, ph), (x, monitor_pos.1))
}

impl Island {
    pub fn set_monitor(&self, name: Option<String>) {
        *self.monitor.lock().unwrap() = name;
    }

    /// Places the window at the top centre of its monitor (or parks it).
    pub fn place<R: Runtime>(&self, app: &AppHandle<R>) {
        let Some(win) = window(app) else { return };
        if self.state.lock().unwrap().parked {
            let _ = win.set_position(PhysicalPosition::new(PARK_AT, PARK_AT));
            return;
        }
        let name = self.monitor.lock().unwrap().clone();
        let Some(m) = target_monitor(app, name.as_deref()) else { return };
        let ((pw, ph), (x, y)) = placement((m.position().x, m.position().y), (m.size().width, m.size().height), m.scale_factor());
        let _ = win.set_size(PhysicalSize::new(pw, ph));
        let _ = win.set_position(PhysicalPosition::new(x, y));
        // Moving across monitors can rescale the window: assert the physical size again.
        let _ = win.set_size(PhysicalSize::new(pw, ph));
        let _ = win.set_always_on_top(true);
        // No window call is made while the lock is held: a getter waits for the main thread,
        // which may be waiting for this lock.
        let strip = {
            let mut s = self.state.lock().unwrap();
            s.ignoring = None;
            s.generation += 1;
            if s.strip {
                s.rect
            } else {
                None
            }
        };
        if let Some(r) = strip {
            apply_strip(&win, &r, m.scale_factor());
        }
        self.wake.notify_all();
    }

    /// Shows the Notch at its place, or parks it off-screen (the tray's "Show Notch").
    pub fn set_parked<R: Runtime>(&self, app: &AppHandle<R>, parked: bool) {
        {
            let mut s = self.state.lock().unwrap();
            s.parked = parked;
            s.ignoring = None;
            s.generation += 1;
        }
        self.place(app);
        self.wake.notify_all();
    }

    pub fn is_parked(&self) -> bool {
        self.state.lock().unwrap().parked
    }

    /// `notch_rect`: the island's rectangle in the window's CSS pixels. Runs on the main thread
    /// (a synchronous command), which owns the window.
    pub fn set_rect<R: Runtime>(&self, app: &AppHandle<R>, rect: Rect) {
        let Some(win) = window(app) else { return };
        let scale = win.scale_factor().unwrap_or(1.0);
        let (now_strip, was_strip) = {
            let mut s = self.state.lock().unwrap();
            let was = s.strip;
            s.rect = Some(rect);
            s.generation += 1;
            s.strip = rect.is_wake_strip();
            if s.strip {
                s.ignoring = Some(false);
            } else if was {
                s.ignoring = None;
            }
            (s.strip, was)
        };
        if now_strip {
            // The poll sleeps; the window exists only where the strip is, and takes the mouse there.
            apply_strip(&win, &rect, scale);
            let _ = win.set_ignore_cursor_events(false);
        } else if was_strip {
            os::set_window_region(os::raw_hwnd(&win), None);
        }
        self.wake.notify_all();
    }

    /// `notch_keyboard`: lets the Notch take the keyboard (a text field got focus, or the Notch
    /// shortcut opened it), and gives it back.
    pub fn set_keyboard<R: Runtime>(&self, app: &AppHandle<R>, take: bool) {
        let Some(win) = window(app) else { return };
        let mut s = self.state.lock().unwrap();
        if take {
            if !s.keyboard {
                s.previous_foreground = os::foreground();
            }
            s.keyboard = true;
            drop(s);
            let _ = win.set_focusable(true);
            let _ = win.set_focus();
        } else {
            let was = s.keyboard;
            let previous = s.previous_foreground;
            s.keyboard = false;
            s.previous_foreground = 0;
            drop(s);
            let _ = win.set_focusable(false);
            // Hand the keyboard back to the window that had it, if the Notch still holds it.
            if was && previous != 0 && os::foreground() == os::raw_hwnd(&win) {
                os::set_foreground(previous);
            }
        }
    }

    /// Starts the cursor poll thread.
    pub fn spawn_poll<R: Runtime>(self: &Arc<Self>, app: AppHandle<R>) {
        let me = self.clone();
        let _ = std::thread::Builder::new().name("friday-notch-poll".into()).spawn(move || me.poll(app));
    }

    fn poll<R: Runtime>(&self, app: AppHandle<R>) {
        let mut last_cursor = (f64::MIN, f64::MIN);
        let mut last_generation = u64::MAX;
        let mut last_monitor: Option<(i32, i32, u32, u32, u64)> = None;
        let mut last_monitor_check = Instant::now();
        loop {
            // Park while there is nothing to poll for, waking every second to watch the monitors.
            {
                let s = self.state.lock().unwrap();
                if !s.polling() {
                    let (s, _) = self.wake.wait_timeout_while(s, Duration::from_secs(1), |s| !s.polling()).unwrap();
                    let parked = s.parked;
                    let polling = s.polling();
                    drop(s);
                    if !polling {
                        if !parked {
                            self.watch_monitor(&app, &mut last_monitor, &mut last_monitor_check, Duration::from_secs(1));
                        }
                        continue;
                    }
                }
            }
            std::thread::sleep(POLL);
            self.watch_monitor(&app, &mut last_monitor, &mut last_monitor_check, Duration::from_millis(500));
            let Some(win) = window(&app) else { continue };
            let (Ok(origin), Ok(scale)) = (win.outer_position(), win.scale_factor()) else { continue };
            let Some((cx, cy)) = os::cursor_physical() else { continue };
            let x = (cx - origin.x) as f64 / scale;
            let y = (cy - origin.y) as f64 / scale;
            let moved = (x - last_cursor.0).abs() >= 1.0 || (y - last_cursor.1).abs() >= 1.0;
            let mut s = self.state.lock().unwrap();
            if !s.polling() {
                continue;
            }
            if !moved && s.generation == last_generation && s.ignoring.is_some() {
                continue;
            }
            last_generation = s.generation;
            let accept = s.rect.is_some_and(|r| r.hit(x, y, HIT_MARGIN));
            if s.ignoring != Some(!accept) {
                s.ignoring = Some(!accept);
                let _ = win.set_ignore_cursor_events(!accept);
            }
            drop(s);
            if moved {
                last_cursor = (x, y);
                let _ = app.emit_to(LABEL, "cursor", Cursor { x, y });
            }
        }
    }

    fn watch_monitor<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        last: &mut Option<(i32, i32, u32, u32, u64)>,
        checked: &mut Instant,
        every: Duration,
    ) {
        if checked.elapsed() < every {
            return;
        }
        *checked = Instant::now();
        let name = self.monitor.lock().unwrap().clone();
        let Some(m) = target_monitor(app, name.as_deref()) else { return };
        let key = monitor_key(&m);
        if last.is_some_and(|k| k != key) {
            self.place(app);
        }
        *last = Some(key);
    }
}

/// Cuts the window down to the strip (physical pixels of the window).
fn apply_strip<R: Runtime>(win: &WebviewWindow<R>, r: &Rect, scale: f64) {
    let x = (r.x * scale).floor() as i32;
    let y = (r.y.max(0.0) * scale).floor() as i32;
    let w = (r.w * scale).ceil() as i32;
    let h = (r.h.max(1.0) * scale).ceil() as i32;
    os::set_window_region(os::raw_hwnd(win), Some((x, y, w, h)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hit_test_uses_the_margin() {
        let r = Rect::from_page(30.0, 0.0, 400.0, 200.0).unwrap();
        assert!(r.hit(30.0, 0.0, HIT_MARGIN));
        assert!(r.hit(30.0 - HIT_MARGIN, 100.0, HIT_MARGIN));
        assert!(!r.hit(30.0 - HIT_MARGIN - 0.5, 100.0, HIT_MARGIN));
        assert!(r.hit(430.0 + HIT_MARGIN, 200.0 + HIT_MARGIN, HIT_MARGIN));
        assert!(!r.hit(230.0, 200.0 + HIT_MARGIN + 1.0, HIT_MARGIN));
        assert!(!Rect::default().hit(0.0, 0.0, HIT_MARGIN));
    }

    #[test]
    fn page_rectangles_are_clamped_and_checked() {
        assert!(Rect::from_page(f64::NAN, 0.0, 1.0, 1.0).is_none());
        assert!(Rect::from_page(0.0, 0.0, f64::INFINITY, 1.0).is_none());
        let r = Rect::from_page(-1000.0, -5.0, 9999.0, 9999.0).unwrap();
        assert_eq!(r, Rect { x: -HIT_MARGIN, y: -5.0, w: NOTCH_W, h: NOTCH_H });
        assert!(Rect::from_page(170.0, 0.0, 120.0, 4.0).unwrap().is_wake_strip());
        assert!(!Rect::from_page(130.0, 0.0, 200.0, 32.0).unwrap().is_wake_strip());
    }

    #[test]
    fn the_window_sits_at_the_top_centre_in_physical_pixels() {
        assert_eq!(placement((0, 0), (1920, 1080), 1.0), ((460, 300), (730, 0)));
        assert_eq!(placement((0, 0), (2880, 1800), 1.5), ((690, 450), (1095, 0)));
        assert_eq!(placement((-1920, -200), (1920, 1080), 1.25), ((575, 375), (-1248, -200)));
    }
}
