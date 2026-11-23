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
    /// The project folders opened lately, newest first (2026-11-18): the project menu lists them.
    pub recent_projects: Vec<PathBuf>,
    /// The tray's "Show Notch".
    pub show_notch: bool,
    /// Shortcut id -> accelerator ("Ctrl+Alt+Shift+F"); missing ids use the defaults.
    pub shortcuts: BTreeMap<String, String>,
    /// The name of the monitor the Notch lives on; none means the primary monitor.
    pub notch_monitor: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            last_project: None,
            recent_projects: Vec::new(),
            show_notch: true,
            shortcuts: BTreeMap::new(),
            notch_monitor: None,
        }
    }
}

/// How many recent projects the menu lists.
pub const RECENT_MAX: usize = 8;

/// The same folder, as Windows compares paths: without regard to case or a trailing separator.
fn same_folder(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('/', "\\");
        let s = s.trim_end_matches('\\').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

pub const FILE: &str = "desktop.json";

impl Settings {
    /// Puts a project first among the recent ones, once, and keeps `RECENT_MAX` of them.
    pub fn remember(&mut self, root: &Path) {
        self.recent_projects.retain(|p| !same_folder(p, root));
        self.recent_projects.insert(0, root.to_path_buf());
        self.recent_projects.truncate(RECENT_MAX);
    }

    /// Whether a folder is one of the recent projects.
    pub fn is_recent(&self, root: &Path) -> bool {
        self.recent_projects.iter().any(|p| same_folder(p, root))
    }

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
    fn recent_projects_are_newest_first_once_each_and_few() {
        let mut s = Settings::default();
        for i in 0..10 {
            s.remember(&PathBuf::from(format!(r"C:\\work\\p{i}")));
        }
        assert_eq!(s.recent_projects.len(), RECENT_MAX);
        assert_eq!(s.recent_projects[0], PathBuf::from(r"C:\\work\\p9"));
        // The same folder again, in other letters or with a trailing separator: moved first, not added.
        s.remember(&PathBuf::from(r"C:\\WORK\\p5\\"));
        assert_eq!(s.recent_projects.len(), RECENT_MAX);
        assert!(s.is_recent(&PathBuf::from(r"c:\\work\\p5")));
        assert!(!s.is_recent(&PathBuf::from(r"C:\\work\\p0")));
        // An older settings file without the list reads as an empty list.
        let old: Settings = serde_json::from_str(r#"{"last_project": "C:\\\\x", "show_notch": true}"#).unwrap();
        assert!(old.recent_projects.is_empty());
    }

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
