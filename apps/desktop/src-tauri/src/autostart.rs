//! "Start Friday when I sign in" (plan §7.10, §8.3): a per-user Run entry,
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Friday`, holding this app's exe in
//! quotes and `--background`, so the app opens the last project and stays in the tray: a launch by
//! hand opens the Studio, a sign-in does not (2026-11-17). An entry written before, the exe alone,
//! is still this app's. The entry is the setting itself: nothing in `desktop.json` can disagree
//! with it.

use std::path::Path;

use crate::platform_windows;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const NAME: &str = "Friday";
/// The argument of a start Windows makes at sign-in: the Studio stays hidden.
pub const BACKGROUND: &str = "--background";
/// Windows runs a Run entry of at most 260 characters.
const MAX_COMMAND: usize = 260;

/// The entry for an exe: its path in quotes (it may hold spaces) and `--background`. None when the
/// path cannot be written as one (empty, a quote or a control character, or too long).
pub fn command_line(exe: &Path) -> Option<String> {
    let path = exe.to_str()?;
    let ok = !path.is_empty() && !path.chars().any(|c| c == '"' || c.is_control());
    let line = format!("\"{path}\" {BACKGROUND}");
    (ok && line.chars().count() <= MAX_COMMAND).then_some(line)
}

/// True when a stored entry starts the exe of `line`, with `--background` or, as written before
/// 2026-11-17, without it (Windows paths ignore case).
pub fn is_this_app(stored: &str, line: &str) -> bool {
    let stored = stored.trim().to_lowercase();
    let line = line.to_lowercase();
    let suffix = format!(" {BACKGROUND}");
    let bare = line.strip_suffix(&suffix).unwrap_or(&line);
    stored == line || stored == bare
}

fn this_app() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("the app's own path is unknown ({e})"))?;
    command_line(&exe).ok_or_else(|| "the app's path cannot be written in a sign-in entry".to_string())
}

/// Whether Windows starts this app at sign in.
pub fn enabled() -> bool {
    let Ok(line) = this_app() else { return false };
    platform_windows::reg_get_string(RUN_KEY, NAME).is_some_and(|v| is_this_app(&v, &line))
}

/// Adds or removes the entry; returns whether Windows starts this app at sign in now.
pub fn set(on: bool) -> Result<bool, String> {
    if on {
        let line = this_app()?;
        if !platform_windows::reg_set_string(RUN_KEY, NAME, &line) {
            return Err("Windows did not save the sign-in entry".into());
        }
    } else if !platform_windows::reg_delete_value(RUN_KEY, NAME) {
        return Err("Windows did not remove the sign-in entry".into());
    }
    Ok(enabled())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_is_the_exe_in_quotes_started_in_the_background() {
        let exe = Path::new(r"C:\Program Files\Friday\friday-desktop.exe");
        assert_eq!(
            command_line(exe).as_deref(),
            Some(r#""C:\Program Files\Friday\friday-desktop.exe" --background"#)
        );
        assert_eq!(command_line(Path::new(r"C:\a\b.exe")).as_deref(), Some(r#""C:\a\b.exe" --background"#));
        assert!(command_line(Path::new("")).is_none());
        assert!(command_line(Path::new(r#"C:\a"b.exe"#)).is_none());
        assert!(command_line(Path::new("C:\\a\nb.exe")).is_none());
        assert!(command_line(Path::new("C:\\a\0b.exe")).is_none());
        // 245 characters of path, the two quotes and " --background" fit; one more does not.
        let fits = format!(r"C:\{}.exe", "d".repeat(245 - 7));
        assert_eq!(command_line(Path::new(&fits)).map(|l| l.chars().count()), Some(260));
        let long = format!(r"C:\{}.exe", "d".repeat(246 - 7));
        assert!(command_line(Path::new(&long)).is_none());
    }

    #[test]
    fn a_stored_entry_is_this_app_whatever_its_case() {
        let line = r#""C:\Users\Me\Friday\friday-desktop.exe" --background"#;
        assert!(is_this_app(line, line));
        assert!(is_this_app(r#" "c:\users\me\friday\FRIDAY-DESKTOP.EXE" --BACKGROUND "#, line));
        // An entry written before the flag existed is still this app's.
        assert!(is_this_app(r#""C:\Users\Me\Friday\friday-desktop.exe""#, line));
        assert!(!is_this_app(r#""C:\Old\friday-desktop.exe" --background"#, line));
        assert!(!is_this_app(r#""C:\Users\Me\Friday\friday-desktop.exe" --project C:\x"#, line));
    }

    #[cfg(windows)]
    #[test]
    fn the_running_exe_gives_an_entry() {
        // The test binary stands in for the app.
        let line = this_app().unwrap();
        assert!(line.starts_with('"') && line.to_lowercase().ends_with(".exe\" --background"), "{line}");
    }
}
