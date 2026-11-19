//! Friday's own confirmation window (2026-11-18).
//!
//! What a person confirms (approving a request for a whole task, trusting a setting, halting,
//! cancelling, landing) was asked in the system's grey message box, which looks like no part of
//! Friday and reads like a warning from Windows. It is asked in a small window of the app's own
//! now, and nothing about who may answer changes:
//!
//! - Rust creates the window and writes what is asked into it before any script of the page runs
//!   (`init_script`). The Studio and the Notch pages take no part: they cannot create it, write
//!   into it or read it.
//! - The answer comes through one command, `confirm_answer`, which the app's permissions give to
//!   this window alone (`capabilities/confirm.json`) and which checks the caller's label and the
//!   question's id again (`accepts`). A page that asked cannot answer itself.
//! - Closing the window, or ten minutes without an answer, is a no. When the window cannot be
//!   made, the system's own box asks instead: a question is never skipped.

use std::sync::mpsc::Sender;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::confirm::Dialog;

/// The label of the confirmation window: one at a time.
pub const LABEL: &str = "confirm";
/// Its page in the bundled interface.
pub const PAGE: &str = "confirm.html";
/// How long an unanswered question stands before it counts as a no.
pub const TIMEOUT_SECS: u64 = 600;

/// The question that is open, and where its answer goes.
#[derive(Default)]
pub struct Waiting(pub Mutex<Option<(String, Sender<bool>)>>);

/// What the page is given: the dialog as text, under the id its answer must name.
pub fn payload(id: &str, d: &Dialog) -> Value {
    json!({ "id": id, "title": d.title, "text": d.text, "confirm": d.confirm, "danger": d.danger })
}

/// The script that hands the dialog to the page before any of its own scripts run, as a value the
/// page cannot replace. JSON is JavaScript, except for two line separators JavaScript once
/// refused inside strings: they are written as escapes.
pub fn init_script(id: &str, d: &Dialog) -> String {
    let data = payload(id, d).to_string().replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    format!(
        "Object.defineProperty(window, '__FRIDAY_CONFIRM__', {{ value: Object.freeze({data}), writable: false, configurable: false }});"
    )
}

/// The window's size for a text: wide enough for a command, tall enough for what is asked, with
/// the rest scrolled inside it.
pub fn size_for(text: &str) -> (f64, f64) {
    const WIDTH: f64 = 560.0;
    const PER_LINE: usize = 68;
    let lines: usize = text.split('\n').map(|l| 1 + l.chars().count() / PER_LINE).sum();
    let height = 150.0 + 21.0 * lines as f64;
    (WIDTH, height.clamp(220.0, 600.0))
}

/// Whether an answer is taken: from the confirmation window, for the question that is open.
pub fn accepts(label: &str, open: Option<&str>, id: &str) -> bool {
    label == LABEL && !id.is_empty() && open == Some(id)
}

/// Whether the confirmation window may go to a page: its own, and no other.
pub fn navigation_allowed(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none()
        && url.path() == "/confirm.html"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialog(text: &str) -> Dialog {
        Dialog { title: "Friday: allow this request?".into(), text: text.into(), confirm: "Allow".into(), danger: true }
    }

    #[test]
    fn the_page_gets_the_dialog_as_data_it_cannot_change() {
        let d = dialog("Target: rm -rf \"x\"\n</script><script>alert(1)</script>\u{2028}next");
        let p = payload("q1", &d);
        assert_eq!(p["id"], "q1");
        assert_eq!(p["confirm"], "Allow");
        assert_eq!(p["danger"], true);
        let s = init_script("q1", &d);
        assert!(s.starts_with("Object.defineProperty(window, '__FRIDAY_CONFIRM__'"));
        assert!(s.contains("Object.freeze({"));
        assert!(s.contains("writable: false"));
        // The text is a JSON string inside the script: its quotes are escaped, and no line
        // separator ends the string early.
        assert!(s.contains(r#"rm -rf \"x\""#));
        assert!(!s.contains('\u{2028}'));
        assert!(s.contains("\\u2028"));
        // What it holds is what was asked, read back as JSON.
        let from = s.find("Object.freeze(").unwrap() + "Object.freeze(".len();
        let to = s.rfind("), writable").unwrap();
        let back: Value = serde_json::from_str(&s[from..to]).unwrap();
        assert_eq!(back["text"], d.text);
    }

    #[test]
    fn only_the_confirmation_window_answers_and_only_the_open_question() {
        assert!(accepts("confirm", Some("q1"), "q1"));
        // The Studio and the Notch asked; they do not answer.
        assert!(!accepts("studio", Some("q1"), "q1"));
        assert!(!accepts("notch", Some("q1"), "q1"));
        // Another question, none open, or no id at all.
        assert!(!accepts("confirm", Some("q2"), "q1"));
        assert!(!accepts("confirm", None, "q1"));
        assert!(!accepts("confirm", Some(""), ""));
    }

    #[test]
    fn the_window_fits_what_is_asked_within_bounds() {
        assert_eq!(size_for("Halt now?"), (560.0, 220.0));
        let long = "x".repeat(4000);
        assert_eq!(size_for(&long).1, 600.0);
        let some = size_for("Capability: file.write\nTarget: sed -i a.ts\nPurpose: fix\n\nAllow it?");
        assert!(some.1 > 220.0 && some.1 < 400.0, "{some:?}");
    }

    #[test]
    fn it_stays_on_its_own_page() {
        let ok = |u: &str| navigation_allowed(&url::Url::parse(u).unwrap());
        assert!(ok("http://tauri.localhost/confirm.html"));
        assert!(!ok("http://tauri.localhost/index.html"));
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("https://tauri.localhost/confirm.html"));
        assert!(!ok("http://example.com/confirm.html"));
        assert!(!ok("http://tauri.localhost:8080/confirm.html"));
    }
}
