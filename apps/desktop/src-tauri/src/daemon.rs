//! Finding the project, Friday's install and the daemon; starting and stopping it (plan §8.3).
//!
//! The private state folder is found exactly as `packages/sdk/src/discovery.ts` finds it:
//! `<state dir>\projects\<project_id>-<first 8 hex of sha256(root lower-cased)>`, where the state
//! dir is `FRIDAY_STATE_DIR` or `%LOCALAPPDATA%\Friday` and the root is the real path of the main
//! worktree. `daemon.json` and `operator.token` are read from there at call time; the token is
//! never printed, logged, stored elsewhere or sent to the webview.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::proxy::{self, CmdError, Token};

/// Keeps spawned console programs (node, git) from flashing a window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// How long a starting daemon has to answer.
pub const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a stopping daemon may drain (it answers 503 for up to about 90 s).
pub const STOP_TIMEOUT: Duration = Duration::from_secs(120);

/// The open project.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Project {
    /// Real path of the main worktree.
    pub root: PathBuf,
    pub id: String,
    pub name: String,
    pub key: String,
    pub private_dir: PathBuf,
}

fn env_path(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|v| !v.is_empty())
}

fn home() -> PathBuf {
    env_path("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\"))
}

/// `path.resolve` for one path: absolute and normalised.
pub fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// `FRIDAY_STATE_DIR`, else `%LOCALAPPDATA%\Friday` (`stateDir` in the SDK).
pub fn state_dir_from(env: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(d) = env("FRIDAY_STATE_DIR") {
        return absolute(Path::new(&d));
    }
    env("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Local"))
        .join("Friday")
}

pub fn state_dir() -> PathBuf {
    state_dir_from(&env_path)
}

/// `FRIDAY_WORKTREES_DIR`, else `friday-worktrees` beside the state directory (`worktreesDir`).
pub fn worktrees_dir_from(env: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(d) = env("FRIDAY_WORKTREES_DIR") {
        return absolute(Path::new(&d));
    }
    if let Some(d) = env("FRIDAY_STATE_DIR") {
        let state = absolute(Path::new(&d));
        return state.parent().map(Path::to_path_buf).unwrap_or(state).join("friday-worktrees");
    }
    env("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData").join("Local"))
        .join("friday-worktrees")
}

pub fn worktrees_dir() -> PathBuf {
    worktrees_dir_from(&env_path)
}

/// `projectKey` in the SDK: the root lower-cased (Windows), sha256, first 8 hex characters.
pub fn project_key(project_id: &str, root: &str) -> String {
    let digest = Sha256::digest(root.to_lowercase().as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{project_id}-{hex}")
}

/// A canonical path without the `\\?\` prefix, as Node's `realpathSync.native` returns it.
pub fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// The real path (links resolved), or the absolute path when it cannot be resolved.
pub fn real_path(p: &Path) -> PathBuf {
    match fs::canonicalize(p) {
        Ok(c) => PathBuf::from(strip_verbatim(&c.to_string_lossy())),
        Err(_) => absolute(p),
    }
}

fn has_config(dir: &Path) -> bool {
    dir.join(".friday").join("config.yaml").is_file()
}

/// Runs a short console program and returns its standard output when it exits 0.
fn run_quiet(program: &str, args: &[&OsStr], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                return status.success().then_some(text);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}


/// `findProjectRoot` in the SDK: the git main worktree when it holds `.friday/config.yaml`, else
/// the nearest folder upwards that does; as a real path.
pub fn find_root(start: &Path) -> Option<PathBuf> {
    let abs = absolute(start);
    let out = run_quiet(
        "git",
        &[
            OsStr::new("-C"),
            abs.as_os_str(),
            OsStr::new("rev-parse"),
            OsStr::new("--path-format=absolute"),
            OsStr::new("--git-common-dir"),
        ],
        Duration::from_secs(5),
    );
    if let Some(out) = out.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        let common = absolute(&abs.join(&out));
        if common.file_name().is_some_and(|n| n == ".git") {
            if let Some(parent) = common.parent() {
                if has_config(parent) {
                    return Some(real_path(parent));
                }
            }
        }
    }
    let mut dir = abs;
    loop {
        if has_config(&dir) {
            return Some(real_path(&dir));
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// True when the repository at `dir` has at least one commit.
pub fn has_commit(dir: &Path) -> bool {
    run_quiet(
        "git",
        &[OsStr::new("-C"), dir.as_os_str(), OsStr::new("rev-parse"), OsStr::new("--verify"), OsStr::new("HEAD")],
        Duration::from_secs(5),
    )
    .is_some()
}

const ID_ALPHABET: &str = "0123456789abcdefghjkmnpqrstvwxyz";

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The project id in a config file, as the hook launcher reads it:
/// `/\bid:\s*["']?(proj_[0-9a-hjkmnp-tv-z]{26})/`.
pub fn project_id_in(text: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = text[from..].find("id:") {
        let at = from + i;
        from = at + 3;
        if text[..at].chars().next_back().is_some_and(word_char) {
            continue;
        }
        let rest = text[at + 3..].trim_start_matches(|c: char| c.is_whitespace());
        let rest = rest.strip_prefix(['"', '\'']).unwrap_or(rest);
        let Some(tail) = rest.strip_prefix("proj_") else { continue };
        let id: String = tail.chars().take(26).collect();
        if id.chars().count() == 26 && id.chars().all(|c| ID_ALPHABET.contains(c)) {
            return Some(format!("proj_{id}"));
        }
    }
    None
}

/// Opens the project a folder belongs to. `Ok(None)` when no Friday project holds the folder.
pub fn open_project(dir: &Path) -> Result<Option<Project>, String> {
    let Some(root) = find_root(dir) else { return Ok(None) };
    let text = fs::read_to_string(root.join(".friday").join("config.yaml"))
        .map_err(|e| format!("cannot read .friday/config.yaml: {e}"))?;
    let id = project_id_in(&text).ok_or("the project's .friday/config.yaml has no valid project id")?;
    let root_text = root.to_string_lossy().to_string();
    let key = project_key(&id, &root_text);
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| id.clone());
    let private_dir = state_dir().join("projects").join(&key);
    Ok(Some(Project { root, id, name, key, private_dir }))
}

// ---- daemon.json and the token ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DiscoveryFile {
    pid: u32,
    port: u16,
    host: String,
    project_id: String,
    instance_id: String,
}

/// What `daemon.json` says about the running daemon.
#[derive(Debug, Clone, PartialEq)]
pub struct Discovery {
    pub pid: u32,
    pub port: u16,
    pub instance_id: String,
}

pub fn parse_discovery(text: &str, project_id: &str) -> Result<Discovery, String> {
    let d: DiscoveryFile = serde_json::from_str(text).map_err(|e| format!("daemon.json does not parse: {e}"))?;
    if d.host != "127.0.0.1" || d.port == 0 || d.pid == 0 {
        return Err("daemon.json does not name a daemon on 127.0.0.1".into());
    }
    if d.project_id != project_id {
        return Err("daemon.json belongs to another project".into());
    }
    Ok(Discovery { pid: d.pid, port: d.port, instance_id: d.instance_id })
}

pub fn read_discovery(p: &Project) -> Result<Discovery, CmdError> {
    let text = fs::read_to_string(p.private_dir.join("daemon.json"))
        .map_err(|_| CmdError::offline("Friday is not running for this project (no daemon.json)"))?;
    parse_discovery(&text, &p.id).map_err(CmdError::offline)
}

pub fn read_token(p: &Project) -> Result<Token, CmdError> {
    let text = fs::read_to_string(p.private_dir.join("operator.token"))
        .map_err(|_| CmdError::offline("Friday's operator token is missing (is Friday running?)"))?;
    Token::new(text).ok_or_else(|| CmdError::offline("Friday's operator token is not readable"))
}

// ---- health -------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub status: String,
    pub project_id: String,
    pub instance_id: String,
}

/// `GET /health`. The daemon asks for the bearer token on every route, `/health` included, so the
/// token is sent, and only after the connection's other end was found to be `d.pid`.
pub fn health(p: &Project, d: &Discovery) -> Option<Health> {
    let url = crate::routes::build_url(d.port, "/health", None).ok()?;
    let token = read_token(p).ok()?;
    let out = proxy::Outgoing {
        method: crate::routes::Method::Get,
        token: &token,
        body: None,
        accept: "application/json",
        idempotency_key: None,
    };
    let answer = proxy::exchange(&url, d.pid, &out, Duration::from_secs(3)).ok()?;
    if answer.status != 200 {
        return None;
    }
    serde_json::from_slice(&answer.body).ok()
}

/// The daemon of this project when it is up: `daemon.json` names a live pid whose `/health`
/// answers for this project and instance.
pub fn running(p: &Project) -> Option<Discovery> {
    let d = read_discovery(p).ok()?;
    if !crate::platform_windows::pid_alive(d.pid) {
        return None;
    }
    let h = health(p, &d)?;
    (h.project_id == p.id && h.instance_id == d.instance_id).then_some(d)
}

// ---- Friday's install ---------------------------------------------------------------------------

/// Where `node` and the CLI entry are.
#[derive(Debug, Clone, PartialEq)]
pub struct Install {
    pub node: PathBuf,
    pub cli: PathBuf,
}

#[derive(Debug, Deserialize)]
struct InstallFile {
    node_path: Option<String>,
    cli_entry: Option<String>,
}

fn cli_in(home: &Path) -> Option<PathBuf> {
    let cli = home.join("apps").join("cli").join("bin").join("friday.mjs");
    cli.is_file().then_some(cli)
}

/// `node.exe` on PATH (never the current folder), else the default install folder.
fn node_on_path() -> Option<PathBuf> {
    if let Some(path) = env_path("PATH") {
        for dir in std::env::split_paths(&path) {
            if !dir.is_absolute() {
                continue;
            }
            let exe = dir.join("node.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    let program_files = env_path("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let exe = program_files.join("nodejs").join("node.exe");
    exe.is_file().then_some(exe)
}

fn read_install_file(state: &Path) -> Option<InstallFile> {
    serde_json::from_str(&fs::read_to_string(state.join("install.json")).ok()?).ok()
}

/// The install: `FRIDAY_HOME` (a Friday checkout), then the checkout this app was built from,
/// then `install.json` (written by `friday setup`), then `chosen` (a folder the user picked).
pub fn find_install(chosen: Option<&Path>) -> Option<Install> {
    let file = read_install_file(&state_dir());
    let cli = env_path("FRIDAY_HOME")
        .and_then(|h| cli_in(Path::new(&h)))
        .or_else(|| option_env!("FRIDAY_BUILD_HOME").and_then(|h| cli_in(Path::new(h))))
        .or_else(|| {
            file.as_ref()
                .and_then(|f| f.cli_entry.as_deref())
                .map(PathBuf::from)
                .filter(|p| p.is_absolute() && p.is_file())
        })
        .or_else(|| chosen.and_then(cli_in))?;
    let node = file
        .as_ref()
        .and_then(|f| f.node_path.as_deref())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .or_else(node_on_path)?;
    Some(Install { node, cli })
}

/// True when `install.json` names an existing node and CLI (hooks and MCP launchers need it).
pub fn install_file_ok() -> bool {
    read_install_file(&state_dir()).is_some_and(|f| {
        f.node_path.is_some_and(|p| Path::new(&p).is_file()) && f.cli_entry.is_some_and(|p| Path::new(&p).is_file())
    })
}

/// What a CLI run printed.
#[derive(Debug)]
pub struct CliOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    pub fn json(&self) -> Option<Value> {
        serde_json::from_str(self.stdout.trim()).ok()
    }
}

/// Runs `node <cli> [--project <root>] <args…>` hidden, with `stdin` written to its standard
/// input (a key for `secrets set`; never logged), and waits at most `timeout`.
pub fn run_cli(
    install: &Install,
    project: Option<&Path>,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<CliOutput, String> {
    let mut cmd = Command::new(&install.node);
    cmd.arg(&install.cli);
    if let Some(root) = project {
        cmd.arg("--project").arg(root);
    }
    cmd.args(args)
        .current_dir(install.cli.parent().unwrap_or(Path::new(".")))
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("could not run node: {e}"))?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data).map_err(|e| format!("could not pass the input: {e}"))?;
        drop(pipe);
    }
    let mut out = child.stdout.take().ok_or("no output pipe")?;
    let mut err = child.stderr.take().ok_or("no error pipe")?;
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("the command did not finish within {} s", timeout.as_secs()));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(CliOutput {
        code: status.code(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

// ---- starting and stopping ----------------------------------------------------------------------

/// Why the daemon did not start.
#[derive(Debug, Clone, Serialize)]
pub struct StartFailure {
    pub message: String,
    pub log_tail: Vec<String>,
}

pub fn console_log(p: &Project) -> PathBuf {
    p.root.join(".friday").join("logs").join("daemon-console.log")
}

/// The last `n` lines of a file.
pub fn tail(path: &Path, n: usize) -> Vec<String> {
    let text = fs::read(path).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].iter().map(|l| l.to_string()).collect()
}

/// Starts `node <cli> --project <root> run` hidden, its output in `.friday/logs/daemon-console.log`,
/// and waits until `daemon.json` names the child's pid and `/health` answers (30 s). The daemon
/// is not tied to this app: it keeps running when the app quits.
pub fn start(p: &Project, install: &Install) -> Result<Discovery, StartFailure> {
    let fail = |message: String, log: &Path| StartFailure { message, log_tail: tail(log, 40) };
    let log_path = console_log(p);
    if let Some(dir) = log_path.parent() {
        fs::create_dir_all(dir).map_err(|e| fail(format!("cannot create {}: {e}", dir.display()), &log_path))?;
    }
    let log = fs::File::create(&log_path).map_err(|e| fail(format!("cannot write the console log: {e}"), &log_path))?;
    let log_err = log.try_clone().map_err(|e| fail(e.to_string(), &log_path))?;
    let mut cmd = Command::new(&install.node);
    cmd.arg(&install.cli)
        .arg("--project")
        .arg(&p.root)
        .arg("run")
        .current_dir(install.cli.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    let mut child = cmd.spawn().map_err(|e| fail(format!("could not run node: {e}"), &log_path))?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(fail(
                format!(
                    "Friday stopped while starting (exit code {})",
                    status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                ),
                &log_path,
            ));
        }
        if let Ok(d) = read_discovery(p) {
            if d.pid == child.id() {
                if let Some(h) = health(p, &d) {
                    if h.project_id == p.id && h.instance_id == d.instance_id && h.status == "ok" {
                        return Ok(d);
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(fail(format!("Friday did not answer within {} s", START_TIMEOUT.as_secs()), &log_path));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Stops the daemon gracefully (`POST /admin/shutdown` with the operator token) and waits for its
/// process to exit.
pub fn stop(p: &Project) -> Result<(), CmdError> {
    let d = read_discovery(p)?;
    if !crate::platform_windows::pid_alive(d.pid) {
        return Ok(());
    }
    proxy::send(
        p,
        proxy::Gate::Shell,
        &proxy::Request {
            method: "POST",
            raw: "/admin/shutdown",
            body: None,
            timeout: Duration::from_secs(15),
            idempotency_key: None,
        },
    )?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    while crate::platform_windows::pid_alive(d.pid) {
        if Instant::now() >= deadline {
            return Err(CmdError::offline("Friday did not stop within two minutes"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "proj_0123456789abcdefghjkmnpqrs";

    #[test]
    fn the_project_key_matches_the_sdk() {
        // Expected values computed with Node and the algorithm of packages/sdk/src/discovery.ts.
        assert_eq!(project_key(ID, r"C:\Users\Example\Projects\Shop"), format!("{ID}-678fba09"));
        assert_eq!(project_key(ID, r"c:\users\example\projects\shop"), format!("{ID}-678fba09"));
        assert_eq!(project_key(ID, "D:\\Work\\Ünïcode Café\\ΣΟΦΙΑΣ"), format!("{ID}-230edec9"));
        assert_eq!(project_key(ID, r"\\server\share\repo"), format!("{ID}-3bf6ff06"));
    }

    #[test]
    fn verbatim_prefixes_are_stripped_like_node_does() {
        assert_eq!(strip_verbatim(r"\\?\C:\friday"), r"C:\friday");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\x"), r"\\server\share\x");
        assert_eq!(strip_verbatim(r"C:\plain"), r"C:\plain");
    }

    #[test]
    fn the_state_and_worktrees_folders_follow_the_sdk() {
        let env = |m: &'static [(&'static str, &'static str)]| {
            move |k: &str| m.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(*v))
        };
        let local = env(&[("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]);
        assert_eq!(state_dir_from(&local), PathBuf::from(r"C:\Users\u\AppData\Local\Friday"));
        assert_eq!(worktrees_dir_from(&local), PathBuf::from(r"C:\Users\u\AppData\Local\friday-worktrees"));
        let custom = env(&[("FRIDAY_STATE_DIR", r"D:\state\friday"), ("LOCALAPPDATA", r"C:\x")]);
        assert_eq!(state_dir_from(&custom), PathBuf::from(r"D:\state\friday"));
        assert_eq!(worktrees_dir_from(&custom), PathBuf::from(r"D:\state\friday-worktrees"));
        let wt = env(&[("FRIDAY_WORKTREES_DIR", r"E:\wt"), ("FRIDAY_STATE_DIR", r"D:\s")]);
        assert_eq!(worktrees_dir_from(&wt), PathBuf::from(r"E:\wt"));
    }

    #[test]
    fn the_project_id_is_read_like_the_hook_launcher_reads_it() {
        let cfg = "# Friday\nproject:\n  id: proj_0123456789abcdefghjkmnpqrs\n  name: \"Shop\"\n";
        assert_eq!(project_id_in(cfg).as_deref(), Some(ID));
        assert_eq!(project_id_in("project:\n  id: \"proj_0123456789abcdefghjkmnpqrs\"").as_deref(), Some(ID));
        assert_eq!(project_id_in("project: {id: 'proj_0123456789abcdefghjkmnpqrs'}").as_deref(), Some(ID));
        // `\b`: a key that merely ends in "id" does not count; letters outside the alphabet fail.
        assert_eq!(project_id_in("  task_id: proj_0123456789abcdefghjkmnpqrs"), None);
        assert_eq!(project_id_in("id: proj_0123456789abcdefghjkmnpqri"), None);
        assert_eq!(project_id_in("id: proj_short"), None);
        assert_eq!(project_id_in("id: ../../evil"), None);
        let both = "other_id: proj_zzzzzzzzzzzzzzzzzzzzzzzzzz\nid: proj_0123456789abcdefghjkmnpqrs";
        assert_eq!(project_id_in(both).as_deref(), Some(ID));
    }

    #[test]
    fn daemon_json_must_describe_this_projects_daemon() {
        let ok = r#"{"schema_version":1,"instance_id":"inst_1","project_id":"proj_0123456789abcdefghjkmnpqrs","pid":42,"host":"127.0.0.1","port":4310,"url":"http://127.0.0.1:4310"}"#;
        assert_eq!(parse_discovery(ok, ID).unwrap(), Discovery { pid: 42, port: 4310, instance_id: "inst_1".into() });
        assert!(parse_discovery(ok, "proj_zzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        assert!(parse_discovery(&ok.replace("127.0.0.1\",\"port", "10.0.0.5\",\"port"), ID).is_err());
        assert!(parse_discovery(&ok.replace("4310,", "0,"), ID).is_err());
        assert!(parse_discovery("{", ID).is_err());
    }

    /// Against a real project: set FRIDAY_DESKTOP_TEST_PROJECT to a folder inside a Friday project
    /// and FRIDAY_DESKTOP_TEST_KEY to the key the SDK computes for it, then run
    /// `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn a_real_project_opens_with_the_sdks_key() {
        let dir = std::env::var("FRIDAY_DESKTOP_TEST_PROJECT").expect("FRIDAY_DESKTOP_TEST_PROJECT");
        let key = std::env::var("FRIDAY_DESKTOP_TEST_KEY").expect("FRIDAY_DESKTOP_TEST_KEY");
        let p = open_project(Path::new(&dir)).unwrap().expect("a Friday project");
        assert_eq!(p.key, key);
        assert_eq!(p.private_dir, state_dir().join("projects").join(&key));
    }

    #[test]
    fn tails_keep_the_last_lines() {
        let f = std::env::temp_dir().join(format!("friday-desktop-tail-{}.log", std::process::id()));
        fs::write(&f, "a\nb\nc\nd\n").unwrap();
        assert_eq!(tail(&f, 2), vec!["c".to_string(), "d".to_string()]);
        assert_eq!(tail(&f, 10).len(), 4);
        let _ = fs::remove_file(&f);
        assert!(tail(&f, 3).is_empty());
    }
}
