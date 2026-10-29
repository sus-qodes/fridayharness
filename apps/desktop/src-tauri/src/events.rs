//! The event stream (plan §2, §8.3): `GET …/events/stream?since=N` read in a thread with the
//! bearer token, parsed, and forwarded to the page on a Tauri channel:
//!
//! - `{kind: "event", event}` for every message carrying a JSON `data` line;
//! - `{kind: "activity"}` whenever bytes arrive (pings included; liveness is judged on raw bytes);
//! - `{kind: "end", reason: "shutdown" | "closed"}` when the daemon drains or the connection ends;
//! - `{kind: "error", message}` when the connection fails mid-stream.
//!
//! `stream_close` shuts the socket down, so the reading thread ends at once.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::daemon::{self, Project};
use crate::proxy::{self, CmdError, Outgoing};
use crate::routes::{self, Method};

/// The daemon pings every 15 s when idle; a read that waits longer than this ends the stream.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Activity is forwarded at most this often (the page's watchdog waits 45 s).
const ACTIVITY_EVERY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamMessage {
    Event { event: Value },
    Activity,
    End { reason: &'static str },
    Error { message: String },
}

/// One parsed SSE message.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseMessage {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// An incremental SSE parser (the same rules as `@friday/sdk/sse`): `id`, `event` and `data`
/// fields; a blank line ends a message; comment lines (`: ping`) produce no message.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    current: SseMessage,
    has_data: bool,
    has_fields: bool,
    last_cr: bool,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        let mut out = Vec::new();
        for &b in chunk {
            if self.last_cr {
                self.last_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' | b'\r' => {
                    self.last_cr = b == b'\r';
                    let line = std::mem::take(&mut self.buf);
                    self.line(&String::from_utf8_lossy(&line), &mut out);
                }
                _ => {
                    if self.buf.len() < 16 * 1024 * 1024 {
                        self.buf.push(b);
                    }
                }
            }
        }
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseMessage>) {
        if line.is_empty() {
            if self.has_fields {
                let mut m = std::mem::take(&mut self.current);
                if self.has_data && m.data.ends_with('\n') {
                    m.data.pop();
                }
                out.push(m);
            }
            self.has_data = false;
            self.has_fields = false;
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (name, value) = match line.split_once(':') {
            Some((n, v)) => (n, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match name {
            "data" => {
                self.current.data.push_str(value);
                self.current.data.push('\n');
                self.has_data = true;
                self.has_fields = true;
            }
            "event" => {
                self.current.event = Some(value.to_string());
                self.has_fields = true;
            }
            "id" => {
                self.current.id = Some(value.to_string());
                self.has_fields = true;
            }
            _ => {}
        }
    }
}

/// What the stream thread does with one parsed message: forward it, or end the stream.
pub fn handle(msg: SseMessage) -> Option<Result<StreamMessage, &'static str>> {
    if msg.event.as_deref() == Some("shutdown") {
        return Some(Err("shutdown"));
    }
    if msg.data.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(&msg.data).ok().map(|event| Ok(StreamMessage::Event { event }))
}

struct Open {
    closed: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}

/// The open streams, by id.
#[derive(Default)]
pub struct Streams {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Arc<Open>>>,
}

impl Streams {
    pub fn close(&self, id: u64) {
        let s = self.open.lock().unwrap().remove(&id);
        if let Some(s) = s {
            s.closed.store(true, Ordering::SeqCst);
            if let Some(sock) = s.socket.lock().unwrap().take() {
                let _ = sock.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<u64> = self.open.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.close(id);
        }
    }
}

/// Opens the stream and returns its id once the daemon accepted it (so `onOpen` follows); a
/// refusal comes back as the daemon's error. `send` receives every message.
pub fn open(
    streams: &Arc<Streams>,
    project: &Project,
    since: u64,
    send: impl Fn(StreamMessage) -> bool + Send + 'static,
) -> Result<u64, CmdError> {
    let mut discovery = daemon::read_discovery(project)?;
    let raw = routes::stream_path(&project.id, since);
    let mut tried_token = false;
    let mut tried_port = false;
    let (reader, socket) = loop {
        let checked = routes::check("GET", &raw, &project.id, discovery.port)?;
        if checked.route.owner != routes::Owner::Stream {
            return Err(CmdError::bad_request("not the event stream"));
        }
        let token = daemon::read_token(project)?;
        let head = proxy::request_head(
            &checked.url,
            &Outgoing { method: Method::Get, token: &token, body: None, accept: "text/event-stream", idempotency_key: None },
        )
        .map_err(|_| CmdError::bad_request("the stream request could not be written"))?;
        drop(token);
        let mut stream = match proxy::connect(discovery.port, discovery.pid, READ_TIMEOUT) {
            Ok(s) => s,
            Err(_) if !tried_port => {
                tried_port = true;
                match daemon::read_discovery(project) {
                    Ok(d) if d != discovery => {
                        discovery = d;
                        continue;
                    }
                    _ => return Err(CmdError::offline("Friday is not answering")),
                }
            }
            Err(_) => return Err(CmdError::offline("Friday is not answering")),
        };
        let mut bytes = head.into_bytes();
        let written = stream.write_all(&bytes).and_then(|_| stream.flush());
        for b in bytes.iter_mut() {
            // SAFETY: `b` is a valid, aligned, exclusive reference into `bytes`.
            unsafe { std::ptr::write_volatile(b, 0) };
        }
        written.map_err(|e| CmdError::offline(format!("the stream request failed ({e})")))?;
        let socket = stream.try_clone().map_err(|e| CmdError::offline(e.to_string()))?;
        let mut reader = BufReader::new(stream);
        let head = proxy::read_head(&mut reader).map_err(|_| CmdError::offline("the stream's answer could not be read"))?;
        if head.status == 401 && !tried_token {
            tried_token = true;
            continue;
        }
        if head.status != 200 {
            let mut body = Vec::new();
            if let Ok(b) = proxy::Body::new(&head, reader) {
                let _ = b.take(1024 * 1024).read_to_end(&mut body);
            }
            return Err(CmdError { status: head.status, body: proxy::json_of(&body) });
        }
        let body = proxy::Body::new(&head, reader).map_err(|_| CmdError::offline("the stream's answer is broken"))?;
        break (body, socket);
    };

    let id = streams.next.fetch_add(1, Ordering::SeqCst) + 1;
    let open = Arc::new(Open { closed: AtomicBool::new(false), socket: Mutex::new(Some(socket)) });
    streams.open.lock().unwrap().insert(id, open.clone());
    let streams = streams.clone();
    std::thread::Builder::new()
        .name(format!("friday-events-{id}"))
        .spawn(move || {
            let end = pump(reader, &open, &send);
            if !open.closed.load(Ordering::SeqCst) {
                let _ = send(end);
            }
            streams.open.lock().unwrap().remove(&id);
        })
        .map_err(|e| CmdError::offline(e.to_string()))?;
    Ok(id)
}

fn pump<R: Read>(mut body: R, open: &Open, send: &dyn Fn(StreamMessage) -> bool) -> StreamMessage {
    let mut parser = SseParser::default();
    let mut buf = vec![0u8; 16 * 1024];
    let mut last_activity: Option<Instant> = None;
    loop {
        let n = match body.read(&mut buf) {
            Ok(0) => return StreamMessage::End { reason: "closed" },
            Ok(n) => n,
            Err(e) => {
                if open.closed.load(Ordering::SeqCst) {
                    return StreamMessage::End { reason: "closed" };
                }
                return StreamMessage::Error { message: format!("the event stream failed ({e})") };
            }
        };
        if open.closed.load(Ordering::SeqCst) {
            return StreamMessage::End { reason: "closed" };
        }
        if last_activity.is_none_or(|t| t.elapsed() >= ACTIVITY_EVERY) {
            last_activity = Some(Instant::now());
            if !send(StreamMessage::Activity) {
                return StreamMessage::End { reason: "closed" };
            }
        }
        for msg in parser.push(&buf[..n]) {
            match handle(msg) {
                Some(Ok(m)) => {
                    if !send(m) {
                        return StreamMessage::End { reason: "closed" };
                    }
                }
                Some(Err(reason)) => return StreamMessage::End { reason },
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn messages_comments_and_shutdown_are_parsed() {
        let mut p = SseParser::default();
        let out = p.push(b": ping\n\nid: 7\nevent: task.created\ndata: {\"sequence\":7}\n\n: ping\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id.as_deref(), Some("7"));
        assert_eq!(out[0].event.as_deref(), Some("task.created"));
        assert_eq!(out[0].data, "{\"sequence\":7}");
        let out = p.push(b"event: shutdown\ndata:\n\n");
        assert_eq!(handle(out[0].clone()), Some(Err("shutdown")));
    }

    #[test]
    fn chunks_may_split_anywhere_and_lines_may_end_with_crlf() {
        let mut p = SseParser::default();
        let text = b"id: 1\r\nevent: a\r\ndata: {\"x\":\r\n\r\nid: 2\ndata: [1,\ndata: 2]\n\n";
        let mut out = Vec::new();
        for b in text.chunks(3) {
            out.extend(p.push(b));
        }
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].data, "{\"x\":");
        assert_eq!(out[1].data, "[1,\n2]");
        assert_eq!(handle(out[0].clone()), None);
        assert_eq!(handle(out[1].clone()), Some(Ok(StreamMessage::Event { event: json!([1, 2]) })));
    }

    #[test]
    fn the_pump_forwards_activity_events_and_the_end() {
        let open = Open { closed: AtomicBool::new(false), socket: Mutex::new(None) };
        let sent = Mutex::new(Vec::new());
        let body = Cursor::new(b": ping\n\nid: 3\nevent: x\ndata: {\"sequence\":3}\n\nevent: shutdown\ndata:\n\n".to_vec());
        let end = pump(body, &open, &|m| {
            sent.lock().unwrap().push(m);
            true
        });
        assert_eq!(end, StreamMessage::End { reason: "shutdown" });
        let sent = sent.into_inner().unwrap();
        assert_eq!(sent[0], StreamMessage::Activity);
        assert_eq!(sent[1], StreamMessage::Event { event: json!({"sequence": 3}) });
        let end = pump(Cursor::new(Vec::new()), &open, &|_| true);
        assert_eq!(end, StreamMessage::End { reason: "closed" });
    }

    #[test]
    fn messages_serialise_as_the_page_expects() {
        assert_eq!(serde_json::to_value(StreamMessage::Activity).unwrap(), json!({"kind": "activity"}));
        assert_eq!(
            serde_json::to_value(StreamMessage::End { reason: "shutdown" }).unwrap(),
            json!({"kind": "end", "reason": "shutdown"})
        );
        assert_eq!(
            serde_json::to_value(StreamMessage::Event { event: json!({"a": 1}) }).unwrap(),
            json!({"kind": "event", "event": {"a": 1}})
        );
    }
}
