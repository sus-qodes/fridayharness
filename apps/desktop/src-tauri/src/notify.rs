//! Native notifications (plan §8.7, FD-25): sent from Rust when the Notch page asks, and only
//! while the Notch is parked (the tray's "Show Notch" is off) or the screen is locked; otherwise
//! the Notch itself shows the item. At most [`PER_MINUTE`] go out a minute, so a page script
//! cannot flood the desktop.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::confirm::visible;

pub const PER_MINUTE: usize = 10;
const TITLE_MAX: usize = 100;
const BODY_MAX: usize = 300;

#[derive(Default)]
pub struct Notifier {
    sent: Mutex<VecDeque<Instant>>,
}

/// Text fit for a notification: hidden characters shown, cut to `max` characters.
pub fn clean(text: &str, max: usize) -> String {
    let v = visible(text.trim());
    if v.chars().count() <= max {
        return v;
    }
    let mut s: String = v.chars().take(max.saturating_sub(1)).collect();
    s.push('…');
    s
}

/// Whether a notification goes out now.
pub fn should_send(notch_parked: bool, locked: bool) -> bool {
    notch_parked || locked
}

impl Notifier {
    fn take_slot(&self, now: Instant) -> bool {
        let mut sent = self.sent.lock().unwrap();
        while sent.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            sent.pop_front();
        }
        if sent.len() >= PER_MINUTE {
            return false;
        }
        sent.push_back(now);
        true
    }

    /// Sends one notification when it should go out; returns whether it did.
    pub fn notify<R: Runtime>(&self, app: &AppHandle<R>, notch_parked: bool, title: &str, body: &str) -> bool {
        if !should_send(notch_parked, crate::platform_windows::session_locked()) {
            return false;
        }
        if !self.take_slot(Instant::now()) {
            return false;
        }
        app.notification()
            .builder()
            .title(clean(title, TITLE_MAX))
            .body(clean(body, BODY_MAX))
            .show()
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_go_out_only_when_the_notch_cannot_show_them() {
        assert!(!should_send(false, false));
        assert!(should_send(true, false));
        assert!(should_send(false, true));
    }

    #[test]
    fn text_is_cleaned_and_cut() {
        assert_eq!(clean("  Approve\u{202E} this\n", 100), "Approve⟨U+202E⟩ this");
        let long = clean(&"a".repeat(500), 10);
        assert_eq!(long.chars().count(), 10);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn at_most_ten_a_minute() {
        let n = Notifier::default();
        let t = Instant::now();
        for _ in 0..PER_MINUTE {
            assert!(n.take_slot(t));
        }
        assert!(!n.take_slot(t));
        assert!(n.take_slot(t + Duration::from_secs(61)));
    }
}
