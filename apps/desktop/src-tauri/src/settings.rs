//! The desktop app's own settings, in `desktop.json` in the app's config folder
//! (`%APPDATA%\dev.friday.desktop`): the last project opened, whether the Notch shows, the global
//! shortcuts and the monitor the Notch lives on. No secret is ever stored here.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// The project folder opened last.
    pub last_project: Option<PathBuf>,
    /// The tray's "Show Notch".
    pub show_notch: bool,
    /// Shortcut id -> accelerator ("Ctrl+Alt+Shift+F"); missing ids use the defaults.
    pub shortcuts: BTreeMap<String, String>,
    /// The name of the monitor the Notch lives on; none means the primary monitor.
    pub notch_monitor: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { last_project: None, show_notch: true, shortcuts: BTreeMap::new(), notch_monitor: None }
    }
}

pub const FILE: &str = "desktop.json";

impl Settings {
    /// Reads the settings; a missing or broken file gives the defaults.
    pub fn load(dir: &Path) -> Settings {
        fs::read_to_string(dir.join(FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Writes the settings (through a temporary file, so a crash never leaves half a file).
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{FILE}.tmp"));
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        fs::write(&tmp, format!("{text}\n"))?;
        fs::rename(&tmp, dir.join(FILE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_survive_a_broken_file() {
        let dir = std::env::temp_dir().join(format!("friday-desktop-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(Settings::load(&dir), Settings::default());
        let mut s = Settings::default();
        s.last_project = Some(PathBuf::from(r"C:\work\shop"));
        s.show_notch = false;
        s.shortcuts.insert("studio".into(), "Ctrl+Alt+Shift+S".into());
        s.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir), s);
        fs::write(dir.join(FILE), "{not json").unwrap();
        assert_eq!(Settings::load(&dir), Settings::default());
        fs::write(dir.join(FILE), r#"{"show_notch": false, "unknown": 1}"#).unwrap();
        assert!(!Settings::load(&dir).show_notch);
        let _ = fs::remove_dir_all(&dir);
    }
}
