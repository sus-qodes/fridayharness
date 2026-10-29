//! Paths the page asks the shell to open (`open_in_editor`, `open_in_browser`): only real paths
//! inside an allowed folder are opened, and they go to their handler as one URI or file name.

use std::path::{Component, Path, PathBuf};

use crate::daemon::{real_path, strip_verbatim};

/// True when `path` is `root` or inside it, comparing components without case (Windows paths).
pub fn inside(path: &Path, root: &Path) -> bool {
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .filter(|c| !matches!(c, Component::CurDir))
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let p = norm(path);
    let r = norm(root);
    !r.is_empty() && p.len() >= r.len() && p[..r.len()] == r[..] && !p.iter().any(|c| c == "..")
}

/// The real path of an existing file or folder named by the page, when it lies in one of `roots`.
pub fn allowed(raw: &str, base: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > 4096 || raw.chars().any(|c| c.is_control()) {
        return None;
    }
    let given = PathBuf::from(raw.replace('/', "\\"));
    let joined = if given.is_absolute() { given } else { base.join(given) };
    let real = PathBuf::from(strip_verbatim(&std::fs::canonicalize(&joined).ok()?.to_string_lossy()));
    roots.iter().map(|r| real_path(r)).any(|r| inside(&real, &r)).then_some(real)
}

/// `vscode://file/<path>[:line]`, every path segment percent-encoded (the drive letter kept).
pub fn vscode_uri(path: &Path, line: Option<u32>) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let encoded: Vec<String> = text
        .split('/')
        .enumerate()
        .map(|(i, seg)| {
            if i == 0 && seg.len() == 2 && seg.ends_with(':') && seg.as_bytes()[0].is_ascii_alphabetic() {
                return seg.to_string();
            }
            let mut out = String::new();
            for b in seg.bytes() {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                    out.push(b as char);
                } else {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            out
        })
        .collect();
    let joined = encoded.join("/");
    let lead = if joined.starts_with('/') { "" } else { "/" };
    match line.filter(|l| *l > 0 && *l < 10_000_000) {
        Some(l) => format!("vscode://file{lead}{joined}:{l}"),
        None => format!("vscode://file{lead}{joined}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_compares_components_without_case() {
        assert!(inside(Path::new(r"C:\Work\Shop\src\a.ts"), Path::new(r"c:\work\shop")));
        assert!(inside(Path::new(r"C:\Work\Shop"), Path::new(r"C:\Work\Shop")));
        assert!(!inside(Path::new(r"C:\Work\ShopX\a.ts"), Path::new(r"C:\Work\Shop")));
        assert!(!inside(Path::new(r"C:\Work\Shop\..\Other"), Path::new(r"C:\Work\Shop")));
        assert!(!inside(Path::new(r"C:\Work"), Path::new(r"C:\Work\Shop")));
        assert!(!inside(Path::new(r"C:\x"), Path::new("")));
    }

    #[test]
    fn only_real_paths_inside_the_roots_are_allowed() {
        let base = std::env::temp_dir().join(format!("friday-desktop-paths-{}", std::process::id()));
        let root = base.join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.ts"), "x").unwrap();
        std::fs::write(base.join("outside.txt"), "x").unwrap();
        let roots = vec![root.clone()];
        assert!(allowed("src/a.ts", &root, &roots).is_some());
        assert!(allowed(&root.join("src").join("a.ts").to_string_lossy(), &root, &roots).is_some());
        assert!(allowed("src/../../outside.txt", &root, &roots).is_none());
        assert!(allowed(&base.join("outside.txt").to_string_lossy(), &root, &roots).is_none());
        assert!(allowed("src/missing.ts", &root, &roots).is_none());
        assert!(allowed("src/a.ts\u{0}", &root, &roots).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn editor_uris_are_encoded() {
        assert_eq!(vscode_uri(Path::new(r"C:\Work\Shop\src\a.ts"), Some(12)), "vscode://file/C:/Work/Shop/src/a.ts:12");
        assert_eq!(
            vscode_uri(Path::new(r"C:\My Files\a&b,c#d.ts"), None),
            "vscode://file/C:/My%20Files/a%26b%2Cc%23d.ts"
        );
        assert_eq!(vscode_uri(Path::new(r"C:\x\café.ts"), Some(0)), "vscode://file/C:/x/caf%C3%A9.ts");
    }
}
