//! The tray (plan §8.6): a status icon (idle, working, waiting for you, error), a status line the
//! page sets from its snapshot, the version, and the daily actions. With no taskbar button for
//! the Notch, the tray is the app's always-visible handle.
//!
//! The icons are drawn here, in code: Friday's mark (the favicon of `apps/ui`) with a status dot.

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

fn rounded_box(px: f32, py: f32, (x0, y0, x1, y1): (f32, f32, f32, f32), r: f32) -> f32 {
    let cx = (x0 + x1) / 2.0;
    let cy = (y0 + y1) / 2.0;
    let hx = (x1 - x0) / 2.0 - r;
    let hy = (y1 - y0) / 2.0 - r;
    let qx = (px - cx).abs() - hx;
    let qy = (py - cy).abs() - hy;
    (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
}

/// The RGBA pixels of the tray icon for a status (32×32, 4×4 samples a pixel). Coordinates are
/// the favicon's 64-unit grid, halved.
pub fn pixels(status: Status) -> Vec<u8> {
    let bg = [0x0c, 0x12, 0x1e];
    let ring = [0x06, 0xb6, 0xd4];
    let ink = [0xe2, 0xe8, 0xf0];
    let mut out = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut acc = [0f32; 4];
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f32 + (sx as f32 + 0.5) / 4.0;
                    let py = y as f32 + (sy as f32 + 0.5) / 4.0;
                    let d = rounded_box(px, py, (2.0, 2.0, 30.0, 30.0), 8.0);
                    let mut c: Option<[u8; 3]> = None;
                    if d <= 0.0 {
                        c = Some(if d > -2.0 { ring } else { bg });
                    }
                    let f = seg_dist(px, py, (12.0, 23.0), (12.0, 9.0))
                        .min(seg_dist(px, py, (12.0, 9.0), (21.0, 9.0)))
                        .min(seg_dist(px, py, (12.0, 15.5), (18.5, 15.5)));
                    if f <= 1.5 && d < -2.0 {
                        c = Some(ink);
                    }
                    if let Some(dot) = status.dot() {
                        let dd = ((px - 25.0).powi(2) + (py - 25.0).powi(2)).sqrt();
                        if dd <= 6.5 {
                            c = Some(if dd > 5.0 { bg } else { dot });
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
