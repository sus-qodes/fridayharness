//! The tray (plan §8.6): a status icon (idle, working, waiting for you, error), a status line the
//! page sets from its snapshot, the version, and the daily actions. With no taskbar button for
//! the Notch, the tray is the app's always-visible handle.
//!
//! The icons are drawn here, in code: Friday's duck — the same leaning-yellow-duck drawing as
//! `apps/ui/public/favicon.svg` and `apps/desktop/scripts/make-icons.mjs` — with a status dot.

use std::f32::consts::PI;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime, Wry};

pub const ID: &str = "friday";
const SIZE: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Working,
    Waiting,
    Error,
}

impl Status {
    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "idle" => Some(Status::Idle),
            "working" => Some(Status::Working),
            "waiting" | "waiting_for_you" => Some(Status::Waiting),
            "error" => Some(Status::Error),
            _ => None,
        }
    }

    fn dot(self) -> Option<[u8; 3]> {
        match self {
            Status::Idle => None,
            Status::Working => Some([0x06, 0xb6, 0xd4]),
            Status::Waiting => Some([0xf5, 0x9e, 0x0b]),
            Status::Error => Some([0xef, 0x44, 0x44]),
        }
    }
}

fn seg_dist(px: f32, py: f32, (ax, ay): (f32, f32), (bx, by): (f32, f32)) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

/// Linear mix of two colours, the fraction clamped to 0..1 (the favicon's gradient stops).
fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t).round() as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t).round() as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t).round() as u8,
    ]
}

fn in_ellipse(px: f32, py: f32, (cx, cy): (f32, f32), (rx, ry): (f32, f32)) -> bool {
    ((px - cx) / rx).powi(2) + ((py - cy) / ry).powi(2) <= 1.0
}

const BODY_TOP: [u8; 3] = [0xff, 0xe7, 0x66];
const BODY_BOTTOM: [u8; 3] = [0xf2, 0xb9, 0x1a];
const BEAK_TOP: [u8; 3] = [0xff, 0xbe, 0x3a];
const BEAK_BOTTOM: [u8; 3] = [0xf2, 0x9a, 0x10];
const SMILE: [u8; 3] = [0xb6, 0x5e, 0x00];
const EYE: [u8; 3] = [0x0e, 0x2a, 0x68];
const WHITE: [u8; 3] = [0xff, 0xff, 0xff];

/// The dark rim that separates the status dot from the duck behind it.
const DOT_RIM: [u8; 3] = [0x0c, 0x12, 0x1e];

const SMILE_POINTS: [(f32, f32); 5] = [(53.5, 71.5), (57.0, 74.0), (60.0, 74.8), (63.0, 74.0), (66.5, 71.5)];

/// The colour of the duck at a point of its 120-unit design grid (before the tilt), or none.
/// Front to back: smile, beak, eyes, wing, body, head, tuft — as in make-icons.mjs.
fn duck_at(x: f32, y: f32) -> Option<[u8; 3]> {
    let body = mix(BODY_TOP, BODY_BOTTOM, (y - 7.0) / 113.0);
    for w in SMILE_POINTS.windows(2) {
        if seg_dist(x, y, w[0], w[1]) <= 0.9 {
            return Some(SMILE);
        }
    }
    if in_ellipse(x, y, (60.0, 70.0), (15.0, 9.5)) {
        return Some(mix(BEAK_TOP, BEAK_BOTTOM, (y - 60.5) / 19.0));
    }
    for ex in [42.0, 78.0] {
        if in_ellipse(x, y, (ex - 1.6, 52.5), (2.3, 2.3)) {
            return Some(WHITE);
        }
        if in_ellipse(x, y, (ex, 55.0), (5.6, 7.4)) {
            return Some(EYE);
        }
    }
    if in_ellipse(x, y, (36.0, 101.0), (14.0, 11.0)) {
        return Some(if in_ellipse(x, y, (36.0, 101.0), (12.4, 9.6)) {
            mix(BODY_TOP, BODY_BOTTOM, 0.25)
        } else {
            BODY_BOTTOM
        });
    }
    if in_ellipse(x, y, (60.0, 100.0), (36.0, 20.0)) || in_ellipse(x, y, (60.0, 58.0), (42.0, 38.0)) {
        return Some(body);
    }
    if in_ellipse(x, y, (57.0, 16.0), (8.5, 11.0)) || in_ellipse(x, y, (71.0, 21.0), (7.5, 6.5)) {
        return Some(body);
    }
    None
}

/// The RGBA pixels of the tray icon for a status (32×32, 4×4 samples a pixel): the leaning duck
/// over a transparent background, with the status dot in the bottom-right corner.
pub fn pixels(status: Status) -> Vec<u8> {
    /// The duck leans clockwise by this many degrees, around its design-grid pivot.
    const TILT_DEG: f32 = 14.0;
    const PIVOT: (f32, f32) = (60.0, 63.0);
    let rad = (-TILT_DEG * PI) / 180.0;
    let (sin, cos) = rad.sin_cos();
    let dot = status.dot();
    let mut out = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut acc = [0f32; 4];
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f32 + (sx as f32 + 0.5) / 4.0;
                    let py = y as f32 + (sy as f32 + 0.5) / 4.0;
                    // Canvas -> design grid: 132 units across, centred on the duck; then undo the tilt.
                    let dx = (px / SIZE as f32 - 0.5) * 132.0 + PIVOT.0;
                    let dy = (py / SIZE as f32 - 0.5) * 132.0 + PIVOT.1 + 1.0;
                    let rx = PIVOT.0 + (dx - PIVOT.0) * cos - (dy - PIVOT.1) * sin;
                    let ry = PIVOT.1 + (dx - PIVOT.0) * sin + (dy - PIVOT.1) * cos;
                    let mut c = duck_at(rx, ry);
                    if let Some(dot) = dot {
                        let dd = ((px - 25.0).powi(2) + (py - 25.0).powi(2)).sqrt();
                        if dd <= 6.5 {
                            c = Some(if dd > 5.0 { DOT_RIM } else { dot });
                        }
                    }
                    if let Some(c) = c {
                        acc[0] += c[0] as f32;
                        acc[1] += c[1] as f32;
                        acc[2] += c[2] as f32;
                        acc[3] += 1.0;
                    }
                }
            }
            let i = ((y * SIZE + x) * 4) as usize;
            if acc[3] > 0.0 {
                out[i] = (acc[0] / acc[3]).round() as u8;
                out[i + 1] = (acc[1] / acc[3]).round() as u8;
                out[i + 2] = (acc[2] / acc[3]).round() as u8;
                out[i + 3] = (acc[3] / 16.0 * 255.0).round() as u8;
            }
        }
    }
    out
}

pub fn icon(status: Status) -> Image<'static> {
    Image::new_owned(pixels(status), SIZE, SIZE)
}

/// The menu items the app changes later.
pub struct Items<R: Runtime> {
    pub tray: TrayIcon<R>,
    pub status: MenuItem<R>,
    pub show_notch: CheckMenuItem<R>,
    pub pause: MenuItem<R>,
    pub mute: CheckMenuItem<R>,
}

pub fn build(app: &AppHandle, show_notch: bool) -> tauri::Result<Items<Wry>> {
    let status = MenuItem::with_id(app, "status", "Starting Friday…", false, None::<&str>)?;
    let version = MenuItem::with_id(app, "version", format!("Friday desktop {}", env!("CARGO_PKG_VERSION")), false, None::<&str>)?;
    let show = CheckMenuItem::with_id(app, "show_notch", "Show Notch", true, show_notch, None::<&str>)?;
    let studio = MenuItem::with_id(app, "studio", "Open Studio", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, "mute", "Mute sounds", true, false, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
    let halt = MenuItem::with_id(app, "halt", "Halt…", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Friday", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Friday", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[
            &status, &version, &sep()?, &show, &studio, &settings, &sep()?, &pause, &mute, &browser, &halt, &sep()?, &stop,
            &restart, &sep()?, &quit,
        ],
    )?;
    let tray = TrayIconBuilder::with_id(ID)
        .icon(icon(Status::Idle))
        .tooltip("Friday")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| crate::on_tray_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::show_studio_window(tray.app_handle(), None);
            }
        })
        .build(app)?;
    Ok(Items { tray, status, show_notch: show, pause, mute })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_status_has_an_icon_and_they_differ() {
        let all = [Status::Idle, Status::Working, Status::Waiting, Status::Error].map(pixels);
        for p in &all {
            assert_eq!(p.len(), (SIZE * SIZE * 4) as usize);
            assert!(p.chunks(4).any(|px| px[3] == 255));
            assert!(p.chunks(4).any(|px| px[3] == 0));
        }
        assert_ne!(all[0], all[1]);
        assert_ne!(all[1], all[2]);
        assert_ne!(all[2], all[3]);
        assert_eq!(Status::parse("waiting"), Some(Status::Waiting));
        assert_eq!(Status::parse("nonsense"), None);
    }
}
