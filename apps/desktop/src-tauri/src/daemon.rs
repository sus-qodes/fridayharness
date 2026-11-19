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
use std::time::{Duration, Instant, SystemTime};

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

// ---- an update while Friday runs (2026-11-19) -----------------------------------------------------
//
// Installing a new Friday left the project's daemon running the code it had started with: the app
// connected to it as it was, and what the update fixed was not there until somebody restarted it.

/// When the running daemon started: it writes `daemon.json` once, as it starts.
pub fn started_at(p: &Project) -> Option<SystemTime> {
    fs::metadata(p.private_dir.join("daemon.json")).ok()?.modified().ok()
}

/// The newest built code file of the copy of Friday `install` runs: its CLI, its daemon and the
/// packages they load (`<home>\apps\{cli,daemon}\dist`, `<home>\packages\**\dist`).
pub fn code_built_at(install: &Install) -> Option<SystemTime> {
    let home = install.cli.ancestors().nth(4)?;
    let mut dists = vec![home.join("apps").join("daemon").join("dist"), home.join("apps").join("cli").join("dist")];
    for group in [home.join("packages"), home.join("packages").join("adapters")] {
        if let Ok(entries) = fs::read_dir(&group) {
            dists.extend(entries.flatten().map(|e| e.path().join("dist")).filter(|d| d.is_dir()));
        }
    }
    let mut newest = None;
    let mut seen = 0usize;
    for d in &dists {
        newest_code(d, 0, &mut newest, &mut seen);
    }
    newest
}

fn newest_code(dir: &Path, depth: usize, newest: &mut Option<SystemTime>, seen: &mut usize) {
    if depth > 4 || *seen > 50_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        let path = e.path();
        if kind.is_dir() {
            newest_code(&path, depth + 1, newest, seen);
            continue;
        }
        if !matches!(path.extension().and_then(OsStr::to_str), Some("js" | "mjs" | "cjs")) {
            continue;
        }
        *seen += 1;
        if let Ok(at) = e.metadata().and_then(|m| m.modified()) {
            if newest.map_or(true, |n| at > n) {
                *newest = Some(at);
            }
        }
    }
}

/// Whether a daemon that started at `started` runs older code than was built at `built`. Two
/// seconds of slack: the daemon writes `daemon.json` after it has loaded its code. Unknown is not
/// outdated.
pub fn outdated(started: Option<SystemTime>, built: Option<SystemTime>) -> bool {
    match (started, built) {
        (Some(s), Some(b)) => b > s + Duration::from_secs(2),
        _ => false,
    }
}

/// What a restart would interrupt, read from the board (`ui/snapshot`): tasks being started,
/// worked on, waiting on the person, done and waiting to be checked, or being checked, and plans
/// being written.
pub fn work_in_progress(snapshot: &Value) -> usize {
    const BUSY: [&str; 5] = ["ASSIGNED", "RUNNING", "WAITING", "READY_FOR_VERIFICATION", "VERIFYING"];
    let tasks = snapshot
        .get("tasks")
        .and_then(Value::as_array)
        .map(|t| t.iter().filter(|x| x.get("status").and_then(Value::as_str).is_some_and(|s| BUSY.contains(&s))).count())
        .unwrap_or(0);
    // A plan job that waits (for the person to allow spending) loses nothing: it is asked again.
    let plans = snapshot.get("brain_jobs").and_then(Value::as_array).map_or(0, |jobs| {
        jobs.iter().filter(|j| matches!(j.get("status").and_then(Value::as_str), Some("calling" | "pending"))).count()
    });
    tasks + plans
}

// ---- Friday's install ---------------------------------------------------------------------------

/// Where `node` and the CLI entry are.
#[derive(Debug, Clone, PartialEq)]
pub struct Install {
    pub node: PathBuf,
    pub cli: PathBuf,
    /// True when the CLI was found through `install.json` itself, false when in a folder
    /// (`FRIDAY_HOME`, the checkout this app was built from, or one the person chose).
    pub from_file: bool,
}

#[derive(Debug, Deserialize)]
struct InstallFile {
    node_path: Option<String>,
    cli_entry: Option<String>,
    mcp_server_entry: Option<String>,
}

fn cli_in(home: &Path) -> Option<PathBuf> {
    let cli = home.join("apps").join("cli").join("bin").join("friday.mjs");
    cli.is_file().then_some(cli)
}

/// The MCP server launcher of the copy of Friday a CLI entry belongs to, when it is there:
/// `<home>\apps\cli\bin\friday.mjs` gives `<home>\packages\mcp-server\bin\friday-mcp.mjs`, the
/// path that copy's `friday setup` records as `mcp_server_entry`.
fn mcp_entry_beside(cli: &Path) -> Option<PathBuf> {
    let entry = cli.ancestors().nth(4)?.join("packages").join("mcp-server").join("bin").join("friday-mcp.mjs");
    entry.is_file().then_some(entry)
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

/// The folders Friday is looked for in before `install.json`: `FRIDAY_HOME` (a Friday checkout),
/// then the checkout this app was built from.
fn own_homes() -> Vec<PathBuf> {
    let built_from = option_env!("FRIDAY_BUILD_HOME").map(PathBuf::from);
    env_path("FRIDAY_HOME").map(PathBuf::from).into_iter().chain(built_from).collect()
}

/// Friday's own program, and whether `install.json` is where it was found: the first of `homes`
/// that holds it, then `install.json` (written by `friday setup`), then `chosen` (a folder the
/// user picked).
fn find_cli(homes: &[PathBuf], file: Option<&InstallFile>, chosen: Option<&Path>) -> Option<(PathBuf, bool)> {
    homes
        .iter()
        .find_map(|h| cli_in(h))
        .map(|cli| (cli, false))
        .or_else(|| {
            file.and_then(|f| f.cli_entry.as_deref())
                .map(PathBuf::from)
                .filter(|p| p.is_absolute() && p.is_file())
                .map(|cli| (cli, true))
        })
        .or_else(|| chosen.and_then(cli_in).map(|cli| (cli, false)))
}

/// Node.js: the one `install.json` names, else `node.exe` on PATH or in its default folder.
fn find_node(file: Option<&InstallFile>) -> Option<PathBuf> {
    file.and_then(|f| f.node_path.as_deref())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .or_else(node_on_path)
}

/// The install: `FRIDAY_HOME` (a Friday checkout), then the checkout this app was built from,
/// then `install.json` (written by `friday setup`), then `chosen` (a folder the user picked).
pub fn find_install(chosen: Option<&Path>) -> Option<Install> {
    let file = read_install_file(&state_dir());
    let (cli, from_file) = find_cli(&own_homes(), file.as_ref(), chosen)?;
    Some(Install { node: find_node(file.as_ref())?, cli, from_file })
}

/// The two things an install is made of, each found or not: Friday's own program, and Node.js to
/// run it. Told apart (2026-11-17) so a computer without Node.js is told so, in place of being
/// asked again and again where Friday is.
pub fn find_parts(chosen: Option<&Path>) -> (Option<PathBuf>, Option<PathBuf>) {
    let file = read_install_file(&state_dir());
    (find_cli(&own_homes(), file.as_ref(), chosen).map(|(cli, _)| cli), find_node(file.as_ref()))
}

/// A path as text to compare with another: the real path where it exists (links and short names
/// resolved), else the absolute one; `\` between folders, none at the end, and no case.
fn comparable(p: &Path) -> String {
    real_path(p).to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Whether two paths name the same file, however each is written.
pub fn same_file(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
}

/// Why this app's own `friday setup` has to write `install.json` (in `state`) again, or `None`
/// when the file can stay.
///
/// The coding tools a person opens themselves start Friday's MCP server through a launcher that
/// reads `install.json` each time it runs. A file that names another copy of Friday leaves them
/// on that copy while this app runs its own: on 2026-11-17 a 17-day-old file gave a new daemon an
/// old MCP server, and a session registered under the wrong name, showed as two agents and was
/// refused work. So the file is written again when it is missing or broken (as before), and when
/// the app found its Friday in a folder and the file names another copy.
fn setup_reason_in(state: &Path, install: &Install) -> Option<&'static str> {
    let Some(file) = read_install_file(state) else {
        return Some("is missing or cannot be read");
    };
    let there = |p: &Option<String>| p.as_deref().is_some_and(|p| Path::new(p).is_file());
    if !there(&file.node_path) || !there(&file.cli_entry) {
        return Some("names a Node.js or a Friday that is not there");
    }
    // Found through the file itself: it names this Friday, and there is nothing to compare.
    if install.from_file {
        return None;
    }
    // A copy without its MCP server has nothing to give those tools: a file that works stays.
    let own_mcp = mcp_entry_beside(&install.cli)?;
    let names =
        |recorded: &Option<String>, own: &Path| recorded.as_deref().is_some_and(|r| same_file(Path::new(r), own));
    if names(&file.cli_entry, &install.cli) && names(&file.mcp_server_entry, &own_mcp) {
        None
    } else {
        Some("names another copy of Friday")
    }
}

/// Makes `install.json` name the Friday this app runs (see `setup_reason_in`), with that Friday's
/// own `friday setup`. One try: `Err` says what went wrong, for the caller to note and carry on.
pub fn refresh_install_file(install: &Install) -> Result<(), String> {
    let state = state_dir();
    let Some(why) = setup_reason_in(&state, install) else {
        return Ok(());
    };
    let out = run_cli(install, None, &["setup", "--json"], None, Duration::from_secs(60))
        .map_err(|e| format!("install.json {why}, and friday setup could not run: {e}"))?;
    if out.code != Some(0) {
        let said = out.stderr.lines().chain(out.stdout.lines()).find(|l| !l.trim().is_empty());
        let said = said.unwrap_or("it printed nothing").trim();
        return Err(format!("install.json {why}, and friday setup failed: {said}"));
    }
    match setup_reason_in(&state, install) {
        None => Ok(()),
        Some(still) => Err(format!("friday setup ran, and install.json still {still}")),
    }
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

    // An update while Friday runs (2026-11-19): the daemon kept the code it started with.
    #[test]
    fn a_daemon_older_than_the_code_it_runs_is_outdated_and_unknown_is_not() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(outdated(Some(t), Some(t + Duration::from_secs(60))));
        // Built while it was loading, or before it started: not outdated.
        assert!(!outdated(Some(t), Some(t + Duration::from_secs(1))));
        assert!(!outdated(Some(t), Some(t - Duration::from_secs(3600))));
        assert!(!outdated(None, Some(t)));
        assert!(!outdated(Some(t), None));
    }

    #[test]
    fn the_newest_built_code_file_of_an_install_is_found_and_nothing_else_counts() {
        let home = std::env::temp_dir().join(format!("friday-built-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let file = |rel: &str| {
            let p = home.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "x").unwrap();
            p
        };
        let cli = file(r"apps\cli\bin\friday.mjs");
        let install = Install { node: PathBuf::from("node.exe"), cli, from_file: false };
        assert_eq!(code_built_at(&install), None);
        let daemon = file(r"apps\daemon\dist\index.js");
        let deep = file(r"packages\adapters\claude\dist\hooks\entry.js");
        let _ = file(r"packages\sdk\dist\index.d.ts");
        let newest = [daemon, deep].iter().filter_map(|p| fs::metadata(p).and_then(|m| m.modified()).ok()).max();
        assert_eq!(code_built_at(&install), newest);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn work_a_restart_would_interrupt_is_counted_from_the_board() {
        let board = serde_json::json!({
            "tasks": [
                { "status": "RUNNING" }, { "status": "WAITING" }, { "status": "VERIFYING" },
                { "status": "COMPLETED" }, { "status": "READY" }, { "status": "FAILED" }
            ],
            "brain_jobs": [{ "status": "calling" }, { "status": "waiting" }]
        });
        assert_eq!(work_in_progress(&board), 4);
        assert_eq!(work_in_progress(&serde_json::json!({ "tasks": [{ "status": "COMPLETED" }], "brain_jobs": [] })), 0);
        assert_eq!(work_in_progress(&serde_json::json!({})), 0);
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

    /// A folder of this test's own under the temp folder, removed when the test ends. Nothing here
    /// reads the state folder of the person running the tests.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("friday-desktop-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        /// A stand-in copy of Friday in `<scratch>\<name>`: the two launchers `friday setup`
        /// records, empty (they are never run). Returns the CLI entry and the MCP server entry.
        fn copy(&self, name: &str) -> (PathBuf, PathBuf) {
            let home = self.0.join(name);
            let cli = home.join("apps").join("cli").join("bin").join("friday.mjs");
            let mcp = home.join("packages").join("mcp-server").join("bin").join("friday-mcp.mjs");
            for f in [&cli, &mcp] {
                fs::create_dir_all(f.parent().unwrap()).unwrap();
                fs::write(f, "").unwrap();
            }
            (cli, mcp)
        }

        /// A stand-in `node.exe` (never run) and an empty state folder.
        fn node_and_state(&self) -> (PathBuf, PathBuf) {
            let node = self.0.join("node.exe");
            fs::write(&node, "").unwrap();
            let state = self.0.join("state");
            fs::create_dir_all(&state).unwrap();
            (node, state)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `install.json` as `friday setup` writes it, with the paths given as text.
    fn write_install_file(state: &Path, node: &str, cli: Option<&str>, mcp: Option<&str>) {
        let info = serde_json::json!({
            "friday_version": "0.1.0",
            "node_path": node,
            "cli_entry": cli,
            "daemon_entry": null,
            "mcp_server_entry": mcp,
            "written_at": "2026-10-31T09:00:00.000Z",
        });
        fs::write(state.join("install.json"), serde_json::to_string_pretty(&info).unwrap()).unwrap();
    }

    fn text(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    #[test]
    fn a_path_is_the_same_file_however_it_is_written() {
        // Files that do not exist are compared as written: without case, either slash, no last one.
        let a = Path::new(r"Z:\Friday\apps\cli\bin\friday.mjs");
        assert!(same_file(a, Path::new(r"z:\friday\APPS\cli\bin\FRIDAY.mjs")));
        assert!(same_file(a, Path::new("Z:/Friday/apps/cli/bin/friday.mjs")));
        assert!(same_file(a, Path::new(r"Z:\Friday\apps\..\apps\cli\.\bin\friday.mjs")));
        assert!(same_file(Path::new(r"Z:\Friday\"), Path::new("z:/friday")));
        assert!(!same_file(a, Path::new(r"Z:\Friday2\apps\cli\bin\friday.mjs")));
        assert!(!same_file(a, Path::new(r"Y:\Friday\apps\cli\bin\friday.mjs")));
        // A file that exists is the same through its real path, whatever the case and the slashes.
        let scratch = Scratch::new("same-file");
        let (cli, mcp) = scratch.copy("Friday");
        assert!(same_file(&cli, Path::new(&text(&cli).to_uppercase())));
        assert!(same_file(&cli, Path::new(&text(&cli).to_lowercase().replace('\\', "/"))));
        assert!(same_file(&cli, &cli.parent().unwrap().join("..").join("bin").join("friday.mjs")));
        assert!(!same_file(&cli, &mcp));
    }

    #[test]
    fn friday_is_found_in_a_folder_before_install_json_names_it() {
        let scratch = Scratch::new("find-cli");
        let (own_cli, _) = scratch.copy("own");
        let (other_cli, _) = scratch.copy("other");
        let (picked_cli, _) = scratch.copy("picked");
        let (node, state) = scratch.node_and_state();
        write_install_file(&state, text(&node), Some(text(&other_cli)), None);
        let file = read_install_file(&state);
        let (own, picked, empty) = (scratch.0.join("own"), scratch.0.join("picked"), scratch.0.join("empty"));
        // A folder that holds Friday comes first, and the file is then not where it was found.
        assert_eq!(find_cli(&[own.clone()], file.as_ref(), None), Some((own_cli.clone(), false)));
        assert_eq!(find_cli(&[empty.clone(), own], file.as_ref(), Some(&picked)), Some((own_cli, false)));
        // No such folder: the file names it, and that is remembered.
        assert_eq!(find_cli(&[empty.clone()], file.as_ref(), Some(&picked)), Some((other_cli, true)));
        // A file that names nothing usable: the folder the person chose.
        write_install_file(&state, text(&node), Some(text(&scratch.0.join("gone").join("friday.mjs"))), None);
        let stale = read_install_file(&state);
        assert_eq!(find_cli(&[empty.clone()], stale.as_ref(), Some(&picked)), Some((picked_cli.clone(), false)));
        assert_eq!(find_cli(&[], None, Some(&picked)), Some((picked_cli, false)));
        assert_eq!(find_cli(&[empty], None, None), None);
    }

    #[test]
    fn install_json_is_written_again_when_it_names_another_copy_of_friday() {
        let scratch = Scratch::new("install-file");
        let (own_cli, own_mcp) = scratch.copy("own");
        let (other_cli, other_mcp) = scratch.copy("other");
        let (node, state) = scratch.node_and_state();
        let in_folder = Install { node: node.clone(), cli: own_cli.clone(), from_file: false };
        let other = Some("names another copy of Friday");

        // As before: no file, a file that is not JSON, a file that names what is not there.
        assert_eq!(setup_reason_in(&state, &in_folder), Some("is missing or cannot be read"));
        fs::write(state.join("install.json"), "{ not json").unwrap();
        assert_eq!(setup_reason_in(&state, &in_folder), Some("is missing or cannot be read"));
        let gone = scratch.0.join("gone").join("friday.mjs");
        write_install_file(&state, text(&node), Some(text(&gone)), Some(text(&own_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), Some("names a Node.js or a Friday that is not there"));
        write_install_file(&state, text(&gone), Some(text(&own_cli)), Some(text(&own_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), Some("names a Node.js or a Friday that is not there"));
        write_install_file(&state, text(&node), None, Some(text(&own_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), Some("names a Node.js or a Friday that is not there"));

        // The file of 2026-11-17: both entries exist, in another copy than the one this app runs.
        write_install_file(&state, text(&node), Some(text(&other_cli)), Some(text(&other_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), other);
        // Half another copy is another copy: this CLI with that MCP server, or with none recorded.
        write_install_file(&state, text(&node), Some(text(&own_cli)), Some(text(&other_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), other);
        write_install_file(&state, text(&node), Some(text(&own_cli)), None);
        assert_eq!(setup_reason_in(&state, &in_folder), other);
        write_install_file(&state, text(&node), Some(text(&other_cli)), Some(text(&own_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), other);

        // This copy, as `friday setup` writes it, and written with another case and other slashes.
        write_install_file(&state, text(&node), Some(text(&own_cli)), Some(text(&own_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), None);
        let shouted = text(&own_cli).to_uppercase();
        let slashed = text(&own_mcp).to_lowercase().replace('\\', "/");
        write_install_file(&state, text(&node), Some(&shouted), Some(&slashed));
        assert_eq!(setup_reason_in(&state, &in_folder), None);

        // Friday found through the file itself: it is the file's copy, there is nothing to compare.
        write_install_file(&state, text(&node), Some(text(&other_cli)), Some(text(&other_mcp)));
        let through_file = Install { node: node.clone(), cli: other_cli.clone(), from_file: true };
        assert_eq!(setup_reason_in(&state, &through_file), None);
        write_install_file(&state, text(&node), Some(text(&other_cli)), None);
        assert_eq!(setup_reason_in(&state, &through_file), None);

        // A copy without its MCP server has nothing to offer: a file that works is left alone.
        fs::remove_file(&own_mcp).unwrap();
        write_install_file(&state, text(&node), Some(text(&other_cli)), Some(text(&other_mcp)));
        assert_eq!(setup_reason_in(&state, &in_folder), None);
    }

    #[test]
    fn the_mcp_server_entry_is_the_one_beside_the_cli() {
        let scratch = Scratch::new("mcp-beside");
        let (cli, mcp) = scratch.copy("friday");
        assert_eq!(mcp_entry_beside(&cli), Some(mcp.clone()));
        fs::remove_file(&mcp).unwrap();
        assert_eq!(mcp_entry_beside(&cli), None);
        // A CLI entry that is not four folders deep has no copy around it.
        assert_eq!(mcp_entry_beside(Path::new(r"C:\friday.mjs")), None);
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
