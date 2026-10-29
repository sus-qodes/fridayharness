//! The daemon client (plan §8.3, FD-06): the desktop shell is the only HTTP client of the daemon on
//! the desktop, and the webview holds no credential.
//!
//! Requests go only to `127.0.0.1:<port>` from the private `daemon.json`, over a plain HTTP/1.1
//! connection this module writes itself: no redirects are ever followed, no `Origin` (or any
//! header but the ones below) is sent, and the request line is written from the URL that
//! [`crate::routes`] checked. Before the bearer token is written, the connection's other end is
//! checked to belong to the daemon's process (the pid in `daemon.json`), so a program that took
//! the port of a dead daemon never receives the token. The operator token is read from the private
//! state folder for every request, re-read after a 401, and never logged; `daemon.json` is re-read
//! after a connection failure.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use crate::daemon::{self, Project};
use crate::routes::{self, Checked, Method, Refusal};

/// Largest answer read into memory (diffs and snapshots are capped by the daemon well below).
const MAX_BODY: u64 = 64 * 1024 * 1024;
const MAX_HEAD: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// The longest a request may wait: verification and integration, whose checks may each run an
/// hour (`TIMEOUTS.long` in apps/ui/src/api/timeouts.ts, and the CLI's own wait).
pub const MAX_TIMEOUT: Duration = Duration::from_secs(3_700);

/// The operator token. Never printed: `Debug` shows nothing, and the bytes are cleared on drop.
pub struct Token(String);

impl Token {
    pub fn new(s: String) -> Option<Token> {
        let t = s.trim().to_string();
        // A token is one header value: refuse anything that could end the header line.
        let ok = !t.is_empty()
            && t.len() <= 4096
            && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '='));
        let mut s = s;
        clear(&mut s);
        if ok {
            Some(Token(t))
        } else {
            let mut t = t;
            clear(&mut t);
            None
        }
    }

    fn header(&self) -> String {
        format!("Bearer {}", self.0)
    }

    pub fn same_as(&self, other: &Token) -> bool {
        self.0 == other.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

impl Drop for Token {
    fn drop(&mut self) {
        clear(&mut self.0);
    }
}

/// Overwrites a string's bytes before it is freed.
pub fn clear(s: &mut String) {
    let mut bytes = std::mem::take(s).into_bytes();
    for b in bytes.iter_mut() {
        // SAFETY: `b` is a valid, aligned, exclusive reference into `bytes`.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    drop(bytes);
}

/// What the page receives when a command fails. `status` is the daemon's HTTP status, or 0 when
/// the daemon was not reached. `body` is the daemon's JSON answer passed through unchanged
/// (`{error: {code, name, message, retryable, details}}`); the shell's own refusals use the same
/// shape with `DESKTOP-xxxx` codes.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct CmdError {
    pub status: u16,
    pub body: Value,
}

pub const OFFLINE: &str = "DESKTOP-2000";
pub const NOT_THE_DAEMON: &str = "DESKTOP-2001";
pub const NO_PROJECT: &str = "DESKTOP-2002";
pub const BAD_REQUEST: &str = "DESKTOP-1007";

impl CmdError {
    pub fn shell(status: u16, code: &str, name: &str, message: impl Into<String>) -> CmdError {
        CmdError {
            status,
            body: json!({"error": {"code": code, "name": name, "message": message.into(), "retryable": false}}),
        }
    }

    pub fn offline(message: impl Into<String>) -> CmdError {
        CmdError {
            status: 0,
            body: json!({"error": {"code": OFFLINE, "name": "offline", "message": message.into(), "retryable": true}}),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> CmdError {
        CmdError::shell(400, BAD_REQUEST, "bad_request", message)
    }

    pub fn no_project() -> CmdError {
        CmdError {
            status: 0,
            body: json!({"error": {"code": NO_PROJECT, "name": "no_project",
                "message": "the desktop app has not opened a project yet", "retryable": true}}),
        }
    }

    pub fn message(&self) -> String {
        self.body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("the daemon answered {}", self.status))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn code(&self) -> Option<&str> {
        self.body.pointer("/error/code").and_then(Value::as_str)
    }
}

impl From<Refusal> for CmdError {
    fn from(r: Refusal) -> CmdError {
        let status = if r.code == routes::NOT_FORWARDED { 403 } else { 400 };
        CmdError::shell(status, r.code, r.name, r.message)
    }
}

// ---- the HTTP/1.1 exchange ---------------------------------------------------------------------

/// A transport failure. `Connect` means nothing was sent; `Io` may have been sent.
#[derive(Debug)]
pub enum Fail {
    Connect(String),
    NotTheDaemon(String),
    Io(String),
    Protocol(String),
}

impl Fail {
    fn into_cmd(self) -> CmdError {
        match self {
            Fail::Connect(m) => CmdError::offline(format!("Friday is not answering ({m})")),
            Fail::NotTheDaemon(m) => CmdError {
                status: 0,
                body: json!({"error": {"code": NOT_THE_DAEMON, "name": "not_the_daemon", "message": m, "retryable": true}}),
            },
            Fail::Io(m) => CmdError::offline(format!("the connection to Friday failed ({m})")),
            Fail::Protocol(m) => CmdError::offline(format!("Friday's answer could not be read ({m})")),
        }
    }
}

pub struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The parts of a request besides the URL.
pub struct Outgoing<'a> {
    pub method: Method,
    pub token: &'a Token,
    pub body: Option<&'a [u8]>,
    pub accept: &'a str,
    pub idempotency_key: Option<&'a str>,
}

/// The request head, exactly as written to the socket.
pub fn request_head(url: &Url, out: &Outgoing<'_>) -> Result<String, Fail> {
    let port = url.port().ok_or_else(|| Fail::Protocol("no port".into()))?;
    let mut target = url.path().to_string();
    if let Some(q) = url.query() {
        target.push('?');
        target.push_str(q);
    }
    if target.bytes().any(|b| b <= b' ' || b >= 0x7f) {
        return Err(Fail::Protocol("the request target holds a character it may not".into()));
    }
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {}\r\nAccept: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        out.method.as_str(),
        target,
        out.token.header(),
        out.accept
    );
    if let Some(k) = out.idempotency_key {
        head.push_str(&format!("Idempotency-Key: {k}\r\n"));
    }
    match (out.method, out.body) {
        (_, Some(b)) => head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len())),
        (Method::Post, None) => head.push_str("Content-Length: 0\r\n"),
        (Method::Get, None) => {}
    }
    head.push_str("\r\n");
    Ok(head)
}

/// Connects to the daemon's port and checks that the other end belongs to `daemon_pid`.
pub fn connect(port: u16, daemon_pid: u32, timeout: Duration) -> Result<TcpStream, Fail> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| Fail::Connect(e.to_string()))?;
    let _ = stream.set_nodelay(true);
    stream.set_read_timeout(Some(timeout)).map_err(|e| Fail::Io(e.to_string()))?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| Fail::Io(e.to_string()))?;
    let local = match stream.local_addr() {
        Ok(SocketAddr::V4(a)) => a,
        _ => return Err(Fail::NotTheDaemon("the connection is not IPv4".into())),
    };
    let remote = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    match crate::platform_windows::tcp_peer_pid(local, remote) {
        Some(pid) if pid == daemon_pid => Ok(stream),
        Some(_) => Err(Fail::NotTheDaemon(format!(
            "port {port} is held by another program than Friday's daemon (pid {daemon_pid}); the token was not sent"
        ))),
        None => Err(Fail::NotTheDaemon(format!(
            "could not check which program holds port {port}; the token was not sent"
        ))),
    }
}

/// The status and headers of an answer, read from `reader`.
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

pub fn read_head<R: BufRead>(reader: &mut R) -> Result<Head, Fail> {
    let mut total = 0usize;
    let mut line = String::new();
    let mut read_line = |reader: &mut R, line: &mut String| -> Result<(), Fail> {
        line.clear();
        let n = reader.read_line(line).map_err(|e| Fail::Io(e.to_string()))?;
        if n == 0 {
            return Err(Fail::Protocol("the connection closed before the answer".into()));
        }
        total += n;
        if total > MAX_HEAD {
            return Err(Fail::Protocol("the answer's headers are too long".into()));
        }
        while line.ends_with('\n') || line.ends_with('\r') {
            line.pop();
        }
        Ok(())
    };
    read_line(reader, &mut line)?;
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/1.") {
        return Err(Fail::Protocol("not an HTTP/1 answer".into()));
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .filter(|s| (100..=599).contains(s))
        .ok_or_else(|| Fail::Protocol("no status".into()))?;
    let mut headers = Vec::new();
    loop {
        read_line(reader, &mut line)?;
        if line.is_empty() {
            break;
        }
        if headers.len() >= 200 {
            return Err(Fail::Protocol("too many headers".into()));
        }
        let (n, v) = line.split_once(':').ok_or_else(|| Fail::Protocol("a broken header".into()))?;
        headers.push((n.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    Ok(Head { status, headers })
}

/// The body of an answer: chunked, by length, or until the connection closes.
pub enum Body<R: BufRead> {
    Chunked(Chunked<R>),
    Length(io::Take<R>),
    Eof(R),
}

impl<R: BufRead> Body<R> {
    pub fn new(head: &Head, reader: R) -> Result<Body<R>, Fail> {
        if head.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            return Ok(Body::Chunked(Chunked::new(reader)));
        }
        if let Some(len) = head.header("content-length") {
            let n: u64 = len.parse().map_err(|_| Fail::Protocol("a broken Content-Length".into()))?;
            return Ok(Body::Length(reader.take(n)));
        }
        Ok(Body::Eof(reader))
    }
}

impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Body::Chunked(c) => c.read(buf),
            Body::Length(t) => t.read(buf),
            Body::Eof(r) => r.read(buf),
        }
    }
}

/// A `Transfer-Encoding: chunked` decoder.
pub struct Chunked<R: BufRead> {
    inner: R,
    left: u64,
    done: bool,
}

impl<R: BufRead> Chunked<R> {
    pub fn new(inner: R) -> Self {
        Chunked { inner, left: 0, done: false }
    }

    fn line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        let n = (&mut self.inner).take(4096).read_line(&mut line)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the chunked body ended early"));
        }
        if !line.ends_with('\n') {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a chunk line is too long"));
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 {
            let line = self.line()?;
            let size = line.split(';').next().unwrap_or_default().trim();
            let n = u64::from_str_radix(size, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a broken chunk size"))?;
            if n == 0 {
                // Trailers, then the empty line.
                loop {
                    if self.line()?.is_empty() {
                        break;
                    }
                }
                self.done = true;
                return Ok(0);
            }
            self.left = n;
        }
        let want = buf.len().min(self.left.min(usize::MAX as u64) as usize);
        let got = self.inner.read(&mut buf[..want])?;
        if got == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the chunked body ended early"));
        }
        self.left -= got as u64;
        if self.left == 0 {
            let end = self.line()?;
            if !end.is_empty() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a chunk does not end with CRLF"));
            }
        }
        Ok(got)
    }
}

/// One request and its whole answer.
pub fn exchange(url: &Url, daemon_pid: u32, out: &Outgoing<'_>, timeout: Duration) -> Result<Answer, Fail> {
    let port = url.port().ok_or_else(|| Fail::Protocol("no port".into()))?;
    let head = request_head(url, out)?;
    let mut stream = connect(port, daemon_pid, timeout)?;
    let mut bytes = head.into_bytes();
    if let Some(b) = out.body {
        bytes.extend_from_slice(b);
    }
    let written = stream.write_all(&bytes).and_then(|_| stream.flush());
    // Clear the copy of the request that held the token.
    for b in bytes.iter_mut() {
        // SAFETY: `b` is a valid, aligned, exclusive reference into `bytes`.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    written.map_err(|e| Fail::Io(e.to_string()))?;
    let mut reader = BufReader::new(stream);
    let head = read_head(&mut reader)?;
    let mut body = Vec::new();
    Body::new(&head, reader)?
        .take(MAX_BODY + 1)
        .read_to_end(&mut body)
        .map_err(|e| Fail::Io(e.to_string()))?;
    if body.len() as u64 > MAX_BODY {
        return Err(Fail::Protocol("the answer is too large".into()));
    }
    Ok(Answer { status: head.status, body })
}

/// The JSON of an answer body (`null` when empty or not JSON).
pub fn json_of(body: &[u8]) -> Value {
    if body.iter().all(|b| b.is_ascii_whitespace()) {
        return Value::Null;
    }
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

// ---- requests on behalf of the page and of the shell --------------------------------------------

/// What the shell needs to send one request.
pub struct Request<'a> {
    pub method: &'a str,
    pub raw: &'a str,
    pub body: Option<&'a Value>,
    pub timeout: Duration,
    pub idempotency_key: Option<&'a str>,
}

/// Which check a request goes through.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// `friday_request`: only `Request` routes.
    Page,
    /// `confirm_and_send` after its dialog, and the shell's own reads.
    Confirmed,
    /// Routes the shell sends itself, outside the table (`/admin/shutdown`, `ui/login-codes`).
    Shell,
}

fn checked_for(gate: Gate, req: &Request<'_>, project: &Project, port: u16) -> Result<Url, CmdError> {
    let c: Checked = match gate {
        Gate::Page => routes::for_request(req.method, req.raw, req.body, &project.id, port)?,
        Gate::Confirmed => routes::check(req.method, req.raw, &project.id, port)?,
        Gate::Shell => {
            let (path, query) = routes::check_raw(req.raw)?;
            return Ok(routes::build_url(port, path, query)?);
        }
    };
    Ok(c.url)
}

/// The time a request is given: what it asked for, from 1 s up to [`MAX_TIMEOUT`].
pub fn effective_timeout(asked: Duration) -> Duration {
    asked.clamp(Duration::from_secs(1), MAX_TIMEOUT)
}

/// Sends a request to the open project's daemon and returns its JSON answer.
pub fn send(project: &Project, gate: Gate, req: &Request<'_>) -> Result<Value, CmdError> {
    if let Some(k) = req.idempotency_key {
        if k.is_empty() || k.len() > 200 || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(CmdError::bad_request("the idempotency key holds a character it may not"));
        }
    }
    let method = Method::parse(req.method).ok_or_else(|| CmdError::bad_request("only GET and POST are sent"))?;
    let body_bytes = match req.body {
        Some(v) if !v.is_null() => Some(serde_json::to_vec(v).map_err(|e| CmdError::bad_request(e.to_string()))?),
        _ => None,
    };
    let timeout = effective_timeout(req.timeout);

    let mut discovery = daemon::read_discovery(project)?;
    let mut url = checked_for(gate, req, project, discovery.port)?;
    let mut token = daemon::read_token(project)?;
    let mut retried_token = false;
    let mut retried_port = false;
    loop {
        let out = Outgoing {
            method,
            token: &token,
            body: body_bytes.as_deref(),
            accept: "application/json",
            idempotency_key: req.idempotency_key,
        };
        match exchange(&url, discovery.pid, &out, timeout) {
            Ok(answer) => {
                let value = json_of(&answer.body);
                if (200..300).contains(&answer.status) {
                    return Ok(value);
                }
                if answer.status == 401 && !retried_token {
                    retried_token = true;
                    let fresh = daemon::read_token(project)?;
                    if !fresh.same_as(&token) {
                        token = fresh;
                        continue;
                    }
                }
                return Err(CmdError { status: answer.status, body: value });
            }
            Err(fail @ (Fail::Connect(_) | Fail::NotTheDaemon(_))) if !retried_port => {
                retried_port = true;
                // The daemon may have restarted on another port: nothing was sent, so read again.
                match daemon::read_discovery(project) {
                    Ok(d) if d.port != discovery.port || d.pid != discovery.pid => {
                        discovery = d;
                        url = checked_for(gate, req, project, discovery.port)?;
                        token = daemon::read_token(project)?;
                        continue;
                    }
                    _ => return Err(fail.into_cmd()),
                }
            }
            Err(e) => return Err(e.into_cmd()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn token() -> Token {
        Token::new("abc.DEF_123-xyz".into()).unwrap()
    }

    #[test]
    fn tokens_that_could_break_a_header_are_refused() {
        assert!(Token::new("abc\r\nX-Evil: 1".into()).is_none());
        assert!(Token::new("a b".into()).is_none());
        assert!(Token::new("".into()).is_none());
        assert!(Token::new("  ok-token\n".into()).is_some());
        assert_eq!(format!("{:?}", token()), "Token(<redacted>)");
    }

    #[test]
    fn the_request_head_has_only_the_expected_headers() {
        let url = Url::parse("http://127.0.0.1:4310/api/v1/projects/p/tasks?x=1").unwrap();
        let t = token();
        let head = request_head(
            &url,
            &Outgoing { method: Method::Post, token: &t, body: Some(b"{}"), accept: "application/json", idempotency_key: Some("k-1") },
        )
        .unwrap();
        assert!(head.starts_with("POST /api/v1/projects/p/tasks?x=1 HTTP/1.1\r\nHost: 127.0.0.1:4310\r\n"));
        assert!(head.contains("Authorization: Bearer abc.DEF_123-xyz\r\n"));
        assert!(head.contains("Content-Length: 2\r\n"));
        assert!(head.contains("Idempotency-Key: k-1\r\n"));
        assert!(head.ends_with("\r\n\r\n"));
        assert!(!head.to_ascii_lowercase().contains("origin"));
        assert!(!head.to_ascii_lowercase().contains("cookie"));
        let get = request_head(
            &url,
            &Outgoing { method: Method::Get, token: &t, body: None, accept: "text/event-stream", idempotency_key: None },
        )
        .unwrap();
        assert!(!get.contains("Content-Length"));
        assert!(get.contains("Accept: text/event-stream\r\n"));
    }

    #[test]
    fn heads_are_parsed() {
        let mut r = Cursor::new(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        let head = read_head(&mut r).unwrap();
        assert_eq!(head.status, 503);
        assert_eq!(head.header("content-type"), Some("application/json"));
        let mut body = String::new();
        Body::new(&head, r).unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "{}");
        assert!(read_head(&mut Cursor::new(b"SSH-2.0-x\r\n\r\n".to_vec())).is_err());
        assert!(read_head(&mut Cursor::new(b"HTTP/1.1 200 OK\r\nbroken\r\n\r\n".to_vec())).is_err());
        assert!(read_head(&mut Cursor::new(b"HTTP/1.1 200".to_vec())).is_err());
    }

    #[test]
    fn chunked_bodies_are_decoded() {
        let raw = b"4\r\nWiki\r\n5;ext=1\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nX-T: 1\r\n\r\n";
        let mut out = String::new();
        Chunked::new(Cursor::new(raw.to_vec())).read_to_string(&mut out).unwrap();
        assert_eq!(out, "Wikipedia in\r\n\r\nchunks.");
        let mut out = Vec::new();
        assert!(Chunked::new(Cursor::new(b"5\r\nab".to_vec())).read_to_end(&mut out).is_err());
        assert!(Chunked::new(Cursor::new(b"zz\r\n".to_vec())).read_to_end(&mut out).is_err());
        assert!(Chunked::new(Cursor::new(b"2\r\nabXX".to_vec())).read_to_end(&mut out).is_err());
    }

    #[test]
    fn answers_become_json_or_null() {
        assert_eq!(json_of(b""), Value::Null);
        assert_eq!(json_of(b"  \n"), Value::Null);
        assert_eq!(json_of(b"<html>"), Value::Null);
        assert_eq!(json_of(br#"{"ok":true}"#), json!({"ok": true}));
    }

    #[test]
    fn refusals_keep_the_daemon_error_shape() {
        let e: CmdError = Refusal { code: routes::NOT_FORWARDED, name: "not_forwarded", message: "no".into() }.into();
        assert_eq!(e.status, 403);
        assert_eq!(e.code(), Some(routes::NOT_FORWARDED));
        assert_eq!(e.body.pointer("/error/retryable"), Some(&Value::Bool(false)));
        assert_eq!(CmdError::offline("x").status, 0);
    }

    #[test]
    fn every_budget_the_interface_asks_for_is_kept() {
        // apps/ui/src/api/timeouts.ts: the page's per-route budgets, verification's the longest.
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/api/timeouts.ts");
        let text = std::fs::read_to_string(&file).expect("apps/ui/src/api/timeouts.ts");
        let budgets: Vec<u64> = text
            .lines()
            .filter_map(|l| l.split_once(':')?.1.trim().trim_end_matches(',').replace('_', "").parse().ok())
            .collect();
        assert!(budgets.contains(&3_700_000), "{budgets:?}");
        for ms in budgets {
            assert_eq!(effective_timeout(Duration::from_millis(ms)), Duration::from_millis(ms), "{ms} ms");
        }
        // The CLI's verify and integrate wait as long (apps/cli/src/program.ts, integrations.ts).
        assert_eq!(effective_timeout(Duration::from_millis(3_700_000)), Duration::from_secs(3_700));
        assert_eq!(effective_timeout(Duration::from_secs(86_400)), MAX_TIMEOUT);
        assert_eq!(effective_timeout(Duration::ZERO), Duration::from_secs(1));
    }

    #[test]
    fn clearing_a_string_empties_it() {
        let mut s = String::from("secret");
        clear(&mut s);
        assert!(s.is_empty());
    }
}
