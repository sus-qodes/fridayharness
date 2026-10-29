//! Native notifications (plan §8.7, FD-25): sent from Rust when the Notch page asks, and only
//! while the Notch is parked (the tray's "Show Notch" is off) or the screen is locked; otherwise
//! the Notch itself shows the item. At most [`PER_MINUTE`] go out a minute, so a page script
//! cannot flood the desktop. A test from Settings goes out now, within a budget of its own
//! ([`TESTS_PER_MINUTE`]), so testing never holds back a real alert.
//!
//! What either can tell is only whether the notification was handed to Windows: the plugin's
//! `show()` prepares it, queues it on a background task and drops Windows' answer, so it fails only
//! when the payload cannot be prepared (the app's own path unknown). Whether it appeared, nobody
//! here sees: Windows may hold it back without an error (Do Not Disturb, Focus, the app's own
//! setting, or an unpackaged build, apps/desktop README).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::confirm::visible;

pub const PER_MINUTE: usize = 10;
pub const TESTS_PER_MINUTE: usize = 3;
const TITLE_MAX: usize = 100;
const BODY_MAX: usize = 300;

#[derive(Default)]
pub struct Notifier {
    sent: Mutex<VecDeque<Instant>>,
    tests: Mutex<VecDeque<Instant>>,
}

/// Why a notification was not handed to Windows.
#[derive(Debug, PartialEq)]
pub enum Held {
    /// The Notch is on screen and shows the item itself.
    NotchShows,
    /// The budget went out in the last minute ([`PER_MINUTE`], or [`TESTS_PER_MINUTE`] for tests).
    TooMany,
}

/// Takes a slot of `slots` (at most `limit` in the last minute); false when none is free.
fn take_slot(slots: &Mutex<VecDeque<Instant>>, limit: usize, now: Instant) -> bool {
    let mut sent = slots.lock().unwrap();
    while sent.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
        sent.pop_front();
    }
    if sent.len() >= limit {
        return false;
    }
    sent.push_back(now);
    true
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
        take_slot(&self.sent, PER_MINUTE, now)
    }

    /// Whether a notification goes to Windows now. A test goes whatever the Notch shows, within
    /// its own budget.
    fn admit(&self, test: bool, notch_parked: bool, locked: bool, now: Instant) -> Result<(), Held> {
        if test {
            return if take_slot(&self.tests, TESTS_PER_MINUTE, now) { Ok(()) } else { Err(Held::TooMany) };
        }
        if !should_send(notch_parked, locked) {
            return Err(Held::NotchShows);
        }
        if !self.take_slot(now) {
            return Err(Held::TooMany);
        }
        Ok(())
    }

    /// Sends one notification when it should go out; returns whether it was handed to Windows.
    pub fn notify<R: Runtime>(&self, app: &AppHandle<R>, notch_parked: bool, title: &str, body: &str) -> bool {
        let locked = crate::platform_windows::session_locked();
        self.admit(false, notch_parked, locked, Instant::now()).is_ok() && show(app, title, body)
    }

    /// A test notification, sent now: whether it was handed to Windows, or why it was not sent.
    pub fn test<R: Runtime>(&self, app: &AppHandle<R>, title: &str, body: &str) -> Result<bool, Held> {
        self.admit(true, false, false, Instant::now())?;
        Ok(show(app, title, body))
    }
}

fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> bool {
    app.notification().builder().title(clean(title, TITLE_MAX)).body(clean(body, BODY_MAX)).show().is_ok()
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

    #[test]
    fn a_test_goes_out_while_the_notch_shows_items_within_a_budget_of_its_own() {
        let n = Notifier::default();
        let t = Instant::now();
        assert_eq!(n.admit(false, false, false, t), Err(Held::NotchShows));
        for _ in 0..TESTS_PER_MINUTE {
            assert_eq!(n.admit(true, false, false, t), Ok(()));
        }
        assert_eq!(n.admit(true, false, false, t), Err(Held::TooMany));
        // Testing took none of the real alerts' slots.
        for _ in 0..PER_MINUTE {
            assert_eq!(n.admit(false, false, true, t), Ok(()));
        }
        assert_eq!(n.admit(false, false, true, t), Err(Held::TooMany));
        // And real alerts take none of the tests'.
        assert_eq!(n.admit(true, false, false, t + Duration::from_secs(61)), Ok(()));
    }
}
