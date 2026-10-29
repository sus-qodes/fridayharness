//! Global shortcuts (plan FD-16): `Ctrl+Alt+Shift+F` opens the Studio, `Ctrl+Alt+Shift+N` opens
//! the Notch and gives it the keyboard, `Ctrl+Alt+Shift+H` opens the halt dialog. Each can be
//! changed (stored in `desktop.json`); one another program holds is reported `in_use`, and one
//! that types a character on an installed keyboard layout (Ctrl+Alt is AltGr) is `skipped`.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const DEFAULTS: &[(&str, &str)] =
    &[("studio", "Ctrl+Alt+Shift+F"), ("notch", "Ctrl+Alt+Shift+N"), ("halt", "Ctrl+Alt+Shift+H")];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Registered,
    InUse,
    Skipped,
    Invalid,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Info {
    pub id: String,
    pub accel: String,
    pub state: State,
    /// Why it is not registered (the character it would take, or what is wrong).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Default)]
pub struct Shortcuts {
    /// What is registered now: shortcut id (the plugin's) -> our id.
    active: Mutex<Vec<(u32, &'static str)>>,
    report: Mutex<Vec<Info>>,
}

/// Parses an accelerator the way the plugin does. A global shortcut needs Ctrl, Alt or the
/// Windows key (a bare or Shift-only key would take that key from every program); Escape is never
/// one.
pub fn parse(accel: &str) -> Option<Shortcut> {
    if accel.trim().is_empty() || accel.len() > 64 {
        return None;
    }
    let s = Shortcut::from_str(accel).ok()?;
    let has_modifier = s.mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER | Modifiers::META);
    (has_modifier && s.key != Code::Escape).then_some(s)
}

/// True when Windows reads the combination as AltGr: Ctrl and Alt, no Windows key.
pub fn altgr_like(s: &Shortcut) -> bool {
    s.mods.contains(Modifiers::CONTROL | Modifiers::ALT) && !s.mods.intersects(Modifiers::SUPER | Modifiers::META)
}

/// The virtual-key code of a key that can type a character (letters, digits, punctuation).
pub fn character_vk(code: Code) -> Option<u16> {
    use Code::*;
    const LETTERS: [Code; 26] = [
        KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO, KeyP, KeyQ, KeyR,
        KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    ];
    if let Some(i) = LETTERS.iter().position(|c| *c == code) {
        return Some(0x41 + i as u16);
    }
    const DIGITS: [Code; 10] = [Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9];
    if let Some(i) = DIGITS.iter().position(|c| *c == code) {
        return Some(0x30 + i as u16);
    }
    Some(match code {
        Space => 0x20,
        Semicolon => 0xBA,
        Equal => 0xBB,
        Comma => 0xBC,
        Minus => 0xBD,
        Period => 0xBE,
        Slash => 0xBF,
        Backquote => 0xC0,
        BracketLeft => 0xDB,
        Backslash => 0xDC,
        BracketRight => 0xDD,
        Quote => 0xDE,
        IntlBackslash => 0xE2,
        _ => return None,
    })
}

/// The character the shortcut types on an installed layout, if any.
pub fn typed_character(s: &Shortcut, layouts: &dyn Fn(u16, bool) -> Option<String>) -> Option<String> {
    if !altgr_like(s) {
        return None;
    }
    layouts(character_vk(s.key)?, s.mods.contains(Modifiers::SHIFT))
}

/// What each shortcut should be, before the system is asked: the shortcut to register, or why not.
pub fn plan(
    stored: &BTreeMap<String, String>,
    layouts: &dyn Fn(u16, bool) -> Option<String>,
) -> Vec<(Info, Option<Shortcut>)> {
    let mut seen: Vec<u32> = Vec::new();
    DEFAULTS
        .iter()
        .map(|(id, default)| {
            let accel = stored.get(*id).cloned().unwrap_or_else(|| default.to_string());
            let mut info = Info { id: id.to_string(), accel: accel.clone(), state: State::Registered, note: None };
            let Some(s) = parse(&accel) else {
                info.state = State::Invalid;
                info.note = Some("not a shortcut: it needs Ctrl, Alt or the Windows key and one other key".into());
                return (info, None);
            };
            if let Some(c) = typed_character(&s, layouts) {
                info.state = State::Skipped;
                info.note = Some(format!("it types {c:?} on one of your keyboard layouts"));
                return (info, None);
            }
            if seen.contains(&s.id()) {
                info.state = State::InUse;
                info.note = Some("another Friday shortcut uses it".into());
                return (info, None);
            }
            seen.push(s.id());
            (info, Some(s))
        })
        .collect()
}

impl Shortcuts {
    /// Registers the planned shortcuts (call from a thread other than the main one: the plugin
    /// waits for the main thread).
    pub fn apply<R: Runtime>(&self, app: &AppHandle<R>, stored: &BTreeMap<String, String>) -> Vec<Info> {
        let gs = app.global_shortcut();
        self.active.lock().unwrap().clear();
        let _ = gs.unregister_all();
        let mut report = Vec::new();
        let mut active = Vec::new();
        for (mut info, s) in plan(stored, &crate::platform_windows::ctrl_alt_types) {
            if let Some(s) = s {
                match gs.register(s) {
                    Ok(()) => {
                        let id: &'static str = DEFAULTS.iter().find(|(d, _)| *d == info.id).map(|(d, _)| *d).unwrap_or("");
                        active.push((s.id(), id));
                    }
                    Err(e) => {
                        info.state = State::InUse;
                        info.note = Some(format!("another program holds it ({e})"));
                    }
                }
            }
            report.push(info);
        }
        *self.active.lock().unwrap() = active;
        *self.report.lock().unwrap() = report.clone();
        report
    }

    pub fn report(&self) -> Vec<Info> {
        self.report.lock().unwrap().clone()
    }

    /// Which of ours a pressed shortcut is.
    pub fn which(&self, s: &Shortcut) -> Option<&'static str> {
        self.active.lock().unwrap().iter().find(|(id, _)| *id == s.id()).map(|(_, ours)| *ours)
    }
}

pub fn known(id: &str) -> bool {
    DEFAULTS.iter().any(|(d, _)| *d == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: u16, _: bool) -> Option<String> {
        None
    }

    #[test]
    fn the_defaults_parse_and_need_a_modifier() {
        for (_, accel) in DEFAULTS {
            let s = parse(accel).unwrap();
            assert!(altgr_like(&s));
        }
        assert!(parse("F").is_none());
        assert!(parse("Shift+F").is_none());
        assert!(parse("Ctrl+Escape").is_none());
        assert!(parse("Ctrl+Alt+Nonsense").is_none());
        assert!(parse("").is_none());
        assert!(parse("Super+F").is_some());
        assert!(!altgr_like(&parse("Ctrl+Alt+Super+F").unwrap()));
    }

    #[test]
    fn a_combination_that_types_a_character_is_skipped() {
        // Polish programmer layout: AltGr+Shift+N types Ń.
        let polish = |vk: u16, shift: bool| (vk == 0x4E && shift).then(|| "Ń".to_string());
        let p = plan(&BTreeMap::new(), &polish);
        let notch = p.iter().find(|(i, _)| i.id == "notch").unwrap();
        assert_eq!(notch.0.state, State::Skipped);
        assert!(notch.1.is_none());
        assert!(p.iter().filter(|(i, _)| i.id != "notch").all(|(i, s)| i.state == State::Registered && s.is_some()));
        // With the Windows key it is not AltGr, so it is kept.
        let mut stored = BTreeMap::new();
        stored.insert("notch".to_string(), "Ctrl+Alt+Super+N".to_string());
        assert_eq!(plan(&stored, &polish)[1].0.state, State::Registered);
    }

    #[test]
    fn stored_bindings_override_and_duplicates_are_reported() {
        let mut stored = BTreeMap::new();
        stored.insert("studio".to_string(), "Ctrl+Alt+Shift+H".to_string());
        let p = plan(&stored, &none);
        assert_eq!(p[0].0.accel, "Ctrl+Alt+Shift+H");
        assert_eq!(p[0].0.state, State::Registered);
        assert_eq!(p[2].0.id, "halt");
        assert_eq!(p[2].0.state, State::InUse);
        stored.insert("halt".to_string(), "nonsense".to_string());
        assert_eq!(plan(&stored, &none)[2].0.state, State::Invalid);
    }

    /// Which Ctrl+Alt+Shift+<letter> combinations type a character on this machine's layouts:
    /// `cargo test altgr_report -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn altgr_report() {
        for c in b'A'..=b'Z' {
            let typed = crate::platform_windows::ctrl_alt_types(u16::from(c), true);
            println!("Ctrl+Alt+Shift+{}: {}", c as char, typed.map(|t| format!("types {t:?}")).unwrap_or("free".into()));
        }
    }

    #[test]
    fn the_report_serialises_for_the_page() {
        let i = Info { id: "studio".into(), accel: "Ctrl+Alt+Shift+F".into(), state: State::InUse, note: None };
        assert_eq!(
            serde_json::to_value(&i).unwrap(),
            serde_json::json!({"id": "studio", "accel": "Ctrl+Alt+Shift+F", "state": "in_use"})
        );
    }
}
