//! The request allowlist (plan §8.4, FD-06).
//!
//! The webview holds no daemon credential: every request it wants sent goes through Rust, which
//! forwards exactly the routes in [`ROUTES`] and nothing else. A raw path is checked character by
//! character *before* it is parsed (no dot segments, no percent-encoded dots, slashes or
//! backslashes, no backslashes, no empty segments, no second `?`, no NUL); then it is parsed with
//! the same URL parser that writes the request line (the `url` crate), the parsed path and query
//! must be byte-for-byte the raw ones, the path must match a template, and the project id must be
//! the open project's.
//!
//! Some routes are owned by `confirm_and_send` (approving, trusting policy, halting, cancelling,
//! stopping Friday, starting an agent) and so is any body asking for `danger-full-access`:
//! `friday_request` refuses them, so Rust always sees the item and the body before they are sent
//! and decides whether a native dialog is needed (FD-15, FD-28).

use serde_json::Value;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn parse(s: &str) -> Option<Method> {
        match s {
            "GET" => Some(Method::Get),
            "POST" => Some(Method::Post),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// The actions only `confirm_and_send` may send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirm {
    Approve,
    Trust,
    Halt,
    CancelTask,
    CancelGoal,
    StopDaemon,
    LaunchAgent,
    StartAgent,
}

/// Which command may send a route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// `friday_request` forwards it.
    Request,
    /// Only `confirm_and_send`.
    Confirm(Confirm),
    /// Only `stream_open` (the event stream).
    Stream,
}

/// One allowed route: a method, a template under `/api/v1/projects/{pid}/`, the query keys it
/// takes, and who may send it.
#[derive(Debug)]
pub struct Route {
    pub method: Method,
    pub template: &'static str,
    pub query: &'static [&'static str],
    pub owner: Owner,
}

const fn get(template: &'static str, query: &'static [&'static str]) -> Route {
    Route { method: Method::Get, template, query, owner: Owner::Request }
}

const fn post(template: &'static str) -> Route {
    Route { method: Method::Post, template, query: &[], owner: Owner::Request }
}

const fn confirm(template: &'static str, what: Confirm) -> Route {
    Route { method: Method::Post, template, query: &[], owner: Owner::Confirm(what) }
}

/// The project routes prefix; the next segment is the project id.
pub const PREFIX: &str = "/api/v1/projects/";

/// Exactly the routes `apps/ui` calls (`src/api/client.ts`, plus `messages/{mid}` from the inbox
/// and `routing/explain/{tid}` from the question card). Never here: `ui/login-codes`,
/// `ui/logout`, `harness-sessions/bind`, `hooks/*`, `/admin/*`, `/protocol/*`.
pub static ROUTES: &[Route] = &[
    // ---- board and events
    get("ui/snapshot", &[]),
    get("events", &["since", "limit", "type"]),
    Route { method: Method::Get, template: "events/stream", query: &["since"], owner: Owner::Stream },
    // ---- tasks
    get("tasks/{tid}", &[]),
    get("tasks/{tid}/events", &["order", "limit", "before"]),
    get("tasks/{tid}/diff", &["stat"]),
    get("tasks/{tid}/recovery", &[]),
    get("tasks/{tid}/delivered-context", &[]),
    post("tasks"),
    post("tasks/{tid}/continue"),
    post("tasks/{tid}/ready"),
    post("tasks/{tid}/release"),
    post("tasks/{tid}/rework"),
    post("tasks/{tid}/unreserve"),
    confirm("tasks/{tid}/cancel", Confirm::CancelTask),
    post("tasks/{tid}/assign"),
    post("tasks/{tid}/verify"),
    post("tasks/{tid}/integrate"),
    post("tasks/{tid}/recover"),
    post("tasks/{tid}/worktree"),
    post("context/compile"),
    get("context/{cid}/explain", &[]),
    // ---- goals and plans
    get("goals", &[]),
    get("goals/{gid}", &[]),
    get("goals/{gid}/diff", &["stat"]),
    post("goals"),
    confirm("goals/{gid}/cancel", Confirm::CancelGoal),
    post("goals/{gid}/replan"),
    post("goals/{gid}/plans"),
    post("plans/{plan}/versions/{v}/approve"),
    post("plans/{plan}/versions/{v}/reject"),
    get("plans/{plan}/diff", &["from", "to"]),
    post("brain/run-once"),
    // ---- approvals and questions
    confirm("approvals/{aid}/approve", Confirm::Approve),
    post("approvals/{aid}/reject"),
    post("approvals/{aid}/revoke"),
    post("escalations/{eid}/answer"),
    // ---- messages
    get("messages", &["task", "status", "to", "limit"]),
    get("messages/{mid}", &[]),
    post("messages"),
    get("inbox/{who}", &[]),
    post("inbox/human/ack"),
    // ---- graph, memory, routing
    get("graph", &[]),
    get("graph/query", &["path", "depth"]),
    post("graph/reindex"),
    get("memory", &["query", "kind", "all", "limit"]),
    get("memory/review", &[]),
    post("memory/{mid}/approve"),
    post("memory/{mid}/retract"),
    get("models", &[]),
    get("routing/pins", &["all"]),
    post("routing/pins"),
    post("routing/pins/{pin}/revoke"),
    get("routing/explain/{tid}", &[]),
    // ---- worktrees, policy, control
    get("worktrees", &["all"]),
    post("worktrees/prune"),
    get("policy", &[]),
    confirm("policy/trust", Confirm::Trust),
    post("control/pause"),
    post("control/resume"),
    confirm("control/halt", Confirm::Halt),
    confirm("daemon/stop", Confirm::StopDaemon),
    // ---- files (the scope picker)
    get("files", &["dir"]),
    post("files/match"),
    // ---- agents
    get("agents", &[]),
    get("harnesses/{hid}", &[]),
    get("agent-hosts", &["refresh"]),
    get("agent-processes", &[]),
    confirm("agent-processes", Confirm::LaunchAgent),
    post("agent-processes/{key}/stop"),
    confirm("agent-processes/{key}/start", Confirm::StartAgent),
    post("agent-processes/{key}/forget"),
    get("agent-setup/claude-code", &["agent"]),
    post("agent-setup/claude-code"),
];

/// Why a request was not forwarded. `code` is the shell's own error code (`DESKTOP-xxxx`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub name: &'static str,
    pub message: String,
}

pub const NOT_FORWARDED: &str = "DESKTOP-1000";
pub const CONFIRMATION_REQUIRED: &str = "DESKTOP-1001";
pub const NOT_CONFIRMABLE: &str = "DESKTOP-1002";

fn refuse(message: impl Into<String>) -> Refusal {
    Refusal { code: NOT_FORWARDED, name: "not_forwarded", message: message.into() }
}

/// A request that passed every check: its route, the parsed URL that will be sent, and the
/// route's parameters by name.
#[derive(Debug)]
pub struct Checked {
    pub route: &'static Route,
    pub url: Url,
    pub params: Vec<(&'static str, String)>,
}

impl Checked {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str())
    }
}

/// Characters a path may hold. No `.` at all: no route needs one, so no dot segment can exist.
fn path_char_ok(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/'
}

/// Characters a query value may hold, as `URLSearchParams` and `encodeURIComponent` write them.
fn query_value_char_ok(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '%' | '+' | '*' | '!' | '\'' | '(' | ')')
}

/// The checks made on the raw text, before any parser sees it. Returns the path and the query.
pub fn check_raw(raw: &str) -> Result<(&str, Option<&str>), Refusal> {
    if raw.is_empty() || raw.len() > 4096 {
        return Err(refuse("the path is empty or too long"));
    }
    if raw.contains('\0') {
        return Err(refuse("the path contains a NUL character"));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err(refuse("the path contains a control character"));
    }
    if raw.contains('\\') {
        return Err(refuse("the path contains a backslash"));
    }
    if raw.contains('#') {
        return Err(refuse("the path contains a fragment"));
    }
    if raw.matches('?').count() > 1 {
        return Err(refuse("the path contains a second '?'"));
    }
    let (path, query) = match raw.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (raw, None),
    };
    let lower = path.to_ascii_lowercase();
    for bad in ["%2e", "%2f", "%5c", "%00", "%25"] {
        if lower.contains(bad) {
            return Err(refuse(format!("the path contains the encoded character {bad}")));
        }
    }
    if !path.starts_with('/') {
        return Err(refuse("the path must start with '/'"));
    }
    for segment in path[1..].split('/') {
        if segment.is_empty() {
            return Err(refuse("the path contains an empty segment"));
        }
        if segment == "." || segment == ".." {
            return Err(refuse("the path contains a dot segment"));
        }
    }
    if let Some(c) = path.chars().find(|c| !path_char_ok(*c)) {
        return Err(refuse(format!("the path contains the character {:?}", c)));
    }
    if let Some(q) = query {
        if q.is_empty() {
            return Err(refuse("the query is empty"));
        }
        if q.to_ascii_lowercase().contains("%00") {
            return Err(refuse("the query contains an encoded NUL"));
        }
        for pair in q.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if k.is_empty() || !k.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                return Err(refuse("the query has an unexpected key"));
            }
            if let Some(c) = v.chars().find(|c| !query_value_char_ok(*c)) {
                return Err(refuse(format!("the query contains the character {:?}", c)));
            }
            let bytes = v.as_bytes();
            for (i, b) in bytes.iter().enumerate() {
                if *b == b'%'
                    && !(i + 2 < bytes.len()
                        && bytes[i + 1].is_ascii_hexdigit()
                        && bytes[i + 2].is_ascii_hexdigit())
                {
                    return Err(refuse("the query contains a broken percent escape"));
                }
            }
        }
    }
    Ok((path, query))
}

fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `apps/cli/src/agent-profiles.ts` AGENT_KEY: `^[a-z0-9][a-z0-9-]{0,63}$`.
pub fn agent_key_ok(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    s.len() <= 64 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn param_ok(name: &str, value: &str) -> bool {
    match name {
        "v" => !value.is_empty() && value.len() <= 9 && value.chars().all(|c| c.is_ascii_digit()),
        "key" => agent_key_ok(value),
        _ => id_ok(value),
    }
}

/// Builds the URL a checked path is sent to. The same function serves the check and the send.
pub fn build_url(port: u16, path: &str, query: Option<&str>) -> Result<Url, Refusal> {
    let text = match query {
        Some(q) => format!("http://127.0.0.1:{port}{path}?{q}"),
        None => format!("http://127.0.0.1:{port}{path}"),
    };
    let url = Url::parse(&text).map_err(|e| refuse(format!("the path does not parse: {e}")))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(port)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(refuse("the path changes the address"));
    }
    // The parser must not have rewritten anything the checks above looked at.
    if url.path() != path || url.query() != query {
        return Err(refuse("the path changes when parsed"));
    }
    Ok(url)
}

/// Every check except who may send it: the raw text, the parse, the template and the project.
pub fn check(method: &str, raw: &str, project_id: &str, port: u16) -> Result<Checked, Refusal> {
    let method = Method::parse(method).ok_or_else(|| refuse("only GET and POST are forwarded"))?;
    let (path, query) = check_raw(raw)?;
    let url = build_url(port, path, query)?;
    let rest = url.path().strip_prefix(PREFIX).ok_or_else(|| refuse("only project routes are forwarded"))?;
    let mut segments = rest.split('/');
    let pid = segments.next().unwrap_or_default();
    if pid != project_id {
        return Err(refuse("that is not the open project"));
    }
    let tail: Vec<&str> = segments.collect();
    for route in ROUTES {
        if route.method != method {
            continue;
        }
        let parts: Vec<&str> = route.template.split('/').collect();
        if parts.len() != tail.len() {
            continue;
        }
        let mut params = Vec::new();
        let mut matched = true;
        for (t, s) in parts.iter().zip(tail.iter()) {
            if let Some(name) = t.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
                if !param_ok(name, s) {
                    matched = false;
                    break;
                }
                params.push((name_of(route.template, name), (*s).to_string()));
            } else if t != s {
                matched = false;
                break;
            }
        }
        if !matched {
            continue;
        }
        if let Some(q) = url.query() {
            for pair in q.split('&') {
                let key = pair.split_once('=').map(|(k, _)| k).unwrap_or(pair);
                if !route.query.contains(&key) {
                    return Err(refuse(format!("the query key {key:?} is not taken by this route")));
                }
            }
        }
        return Ok(Checked { route, url, params });
    }
    Err(refuse(format!("{} {} is not a route the desktop app forwards", method.as_str(), url.path())))
}

/// The `'static` spelling of a parameter name inside its template.
fn name_of(template: &'static str, name: &str) -> &'static str {
    for part in template.split('/') {
        if let Some(n) = part.strip_prefix('{').and_then(|p| p.strip_suffix('}')) {
            if n == name {
                return n;
            }
        }
    }
    ""
}

/// True when any string in the body asks for `danger-full-access` (a Codex sandbox mode).
pub fn asks_for_danger(body: &Value) -> bool {
    match body {
        Value::String(s) => s.trim().eq_ignore_ascii_case("danger-full-access"),
        Value::Array(items) => items.iter().any(asks_for_danger),
        Value::Object(map) => map.iter().any(|(k, v)| {
            k.trim().eq_ignore_ascii_case("danger-full-access") || asks_for_danger(v)
        }),
        _ => false,
    }
}

/// What `friday_request` may send: a `Request` route, no body on a GET, no danger.
pub fn for_request(
    method: &str,
    raw: &str,
    body: Option<&Value>,
    project_id: &str,
    port: u16,
) -> Result<Checked, Refusal> {
    let checked = check(method, raw, project_id, port)?;
    match checked.route.owner {
        Owner::Request => {}
        Owner::Confirm(_) => {
            return Err(Refusal {
                code: CONFIRMATION_REQUIRED,
                name: "confirmation_required",
                message: "this action is confirmed by the desktop app; send it with confirm_and_send".into(),
            })
        }
        Owner::Stream => return Err(refuse("the event stream is opened with stream_open")),
    }
    if let Some(b) = body {
        if checked.route.method == Method::Get && !b.is_null() {
            return Err(refuse("a GET request has no body"));
        }
        if asks_for_danger(b) {
            return Err(Refusal {
                code: CONFIRMATION_REQUIRED,
                name: "confirmation_required",
                message: "danger-full-access is confirmed by the desktop app; send it with confirm_and_send".into(),
            });
        }
    }
    Ok(checked)
}

/// What `confirm_and_send` may send: a route it owns, or a `Request` POST whose body asks for
/// danger. Returns the check and the action (None for a danger body on another route).
pub fn for_confirm(
    method: &str,
    raw: &str,
    body: Option<&Value>,
    project_id: &str,
    port: u16,
) -> Result<(Checked, Option<Confirm>), Refusal> {
    let checked = check(method, raw, project_id, port)?;
    let danger = body.is_some_and(asks_for_danger);
    match checked.route.owner {
        Owner::Confirm(what) => Ok((checked, Some(what))),
        Owner::Request if danger && checked.route.method == Method::Post => Ok((checked, None)),
        _ => Err(Refusal {
            code: NOT_CONFIRMABLE,
            name: "not_confirmable",
            message: "this request does not need the desktop app's confirmation; send it with friday_request".into(),
        }),
    }
}

/// The events stream path for the open project.
pub fn stream_path(project_id: &str, since: u64) -> String {
    format!("{PREFIX}{project_id}/events/stream?since={since}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PID: &str = "proj_0123456789abcdefghjkmnpqrs";
    const PORT: u16 = 4310;

    fn p(rest: &str) -> String {
        format!("{PREFIX}{PID}/{rest}")
    }

    fn req(method: &str, raw: &str) -> Result<Checked, Refusal> {
        for_request(method, raw, None, PID, PORT)
    }

    fn refused(method: &str, raw: &str) -> bool {
        req(method, raw).is_err()
    }

    #[test]
    fn plain_routes_pass_and_keep_their_url() {
        let c = req("GET", &p("ui/snapshot")).unwrap();
        assert_eq!(c.route.template, "ui/snapshot");
        assert_eq!(c.url.as_str(), format!("http://127.0.0.1:{PORT}{}", p("ui/snapshot")));
        let c = req("GET", &p("tasks/task_ABC123/diff?stat=1")).unwrap();
        assert_eq!(c.param("tid"), Some("task_ABC123"));
        assert_eq!(c.url.query(), Some("stat=1"));
        assert!(req("POST", &p("approvals/appr_1/reject")).is_ok());
        assert!(req("POST", &p("plans/plan_1/versions/3/approve")).is_ok());
        assert!(req("GET", &p("memory?query=100%25+done&limit=40")).is_ok());
        assert!(req("GET", &p("files?dir=src%2Fcomponents")).is_ok());
        assert!(req("GET", &p("graph/query?path=src%2Findex.ts&depth=2")).is_ok());
        assert!(req("GET", &p("events?since=4&limit=200&type=task.created&type=task.updated")).is_ok());
        assert!(req("POST", &p("agent-processes/claude-1/stop")).is_ok());
    }

    #[test]
    fn dot_segments_are_refused() {
        assert!(refused("GET", &p("tasks/../ui/snapshot")));
        assert!(refused("GET", &p("tasks/./t1")));
        assert!(refused("GET", &p("ui/snapshot/..")));
        assert!(refused("GET", &format!("{PREFIX}{PID}/../{PID}/ui/snapshot")));
        assert!(refused("GET", "/api/v1/projects/../../admin/snapshots"));
        assert!(refused("GET", &p("tasks/t.1")));
    }

    #[test]
    fn percent_encoded_dots_and_slashes_are_refused_in_either_case() {
        for enc in ["%2e", "%2E", "%2f", "%2F", "%5c", "%5C", "%2e%2e", "%2E%2e"] {
            assert!(refused("GET", &p(&format!("tasks/{enc}/diff"))), "{enc}");
            assert!(refused("GET", &p(&format!("tasks/t1{enc}x"))), "{enc}");
        }
        assert!(refused("GET", &p("tasks/%2e%2e/%2e%2e/ui/snapshot")));
        assert!(refused("GET", &p("tasks/%252e%252e/diff")));
        assert!(refused("GET", &p("tasks/%00/diff")));
        assert!(refused("GET", &p("memory?query=%00")));
        assert!(refused("GET", &p("memory?query=%2")));
        assert!(refused("GET", &p("memory?query=%zz")));
    }

    #[test]
    fn empty_segments_and_double_slashes_are_refused() {
        assert!(refused("GET", &p("tasks//diff")));
        assert!(refused("GET", &format!("/api/v1/projects//{PID}/ui/snapshot")));
        assert!(refused("GET", &format!("//api/v1/projects/{PID}/ui/snapshot")));
        assert!(refused("GET", &p("ui/snapshot/")));
        assert!(refused("GET", &format!("//127.0.0.1:9/api/v1/projects/{PID}/ui/snapshot")));
    }

    #[test]
    fn backslashes_nul_controls_and_odd_characters_are_refused() {
        assert!(refused("GET", &p("tasks\\..\\ui/snapshot")));
        assert!(refused("GET", &p("ui\\snapshot")));
        assert!(refused("GET", &p("ui/snapshot\0")));
        assert!(refused("GET", &p("ui/snap\u{0}shot")));
        assert!(refused("GET", &p("ui/snapshot\r\nX-Evil: 1")));
        assert!(refused("GET", &p("ui/snapshot\t")));
        assert!(refused("GET", &p("ui/snapshot#frag")));
        assert!(refused("GET", &p("ui/snap shot")));
        assert!(refused("GET", &p("tasks/t\u{2024}1")));
        assert!(refused("GET", &p("tasks/t%201")));
        assert!(refused("GET", "http://127.0.0.1:1/api/v1/projects"));
        assert!(refused("GET", "api/v1/projects"));
        assert!(refused("GET", ""));
    }

    #[test]
    fn a_second_question_mark_or_a_stray_query_is_refused() {
        assert!(refused("GET", &p("memory?query=a?b")));
        assert!(refused("GET", &p("memory??query=a")));
        assert!(refused("GET", &p("ui/snapshot?x=1")));
        assert!(refused("GET", &p("ui/snapshot?")));
        assert!(refused("GET", &p("tasks/t1/diff?stat=1&extra=2")));
        assert!(refused("GET", &p("memory?Query=1")));
        assert!(refused("GET", &p("memory?query=<script>")));
    }

    #[test]
    fn a_foreign_project_id_is_refused() {
        assert!(refused("GET", "/api/v1/projects/proj_zzzzzzzzzzzzzzzzzzzzzzzzzz/ui/snapshot"));
        assert!(refused("GET", "/api/v1/projects"));
        assert!(refused("GET", &format!("/api/v1/projects/{PID}")));
        assert!(refused("GET", &format!("/api/v1/projects/{}/ui/snapshot", PID.to_uppercase())));
    }

    #[test]
    fn admin_hooks_protocol_and_session_routes_are_never_forwarded() {
        for raw in [
            "/admin/shutdown".to_string(),
            "/admin/snapshots".to_string(),
            "/admin/rotate-tokens".to_string(),
            "/protocol/v1/rpc".to_string(),
            "/protocol/v1/stream".to_string(),
            "/health".to_string(),
            "/ui/session".to_string(),
            p("hooks/claude-code/pre-tool-use"),
            p("hooks/session-start"),
            p("harness-sessions/bind"),
            p("ui/login-codes"),
            p("ui/logout"),
            p("admin/shutdown"),
            p("approvals"),
            p("status"),
            p("memory"),
        ] {
            assert!(refused("POST", &raw), "POST {raw}");
            if !raw.ends_with("/memory") {
                assert!(refused("GET", &raw), "GET {raw}");
            }
        }
    }

    #[test]
    fn no_table_entry_names_a_forbidden_route() {
        for r in ROUTES {
            for bad in ["login-codes", "logout", "harness-sessions", "hooks", "admin", "protocol"] {
                assert!(!r.template.split('/').any(|s| s == bad), "{}", r.template);
            }
            assert!(!r.template.contains('.'), "{}", r.template);
        }
    }

    #[test]
    fn methods_other_than_get_and_post_are_refused() {
        assert!(refused("PUT", &p("tasks")));
        assert!(refused("DELETE", &p("tasks/t1")));
        assert!(refused("get", &p("ui/snapshot")));
        assert!(refused("POST", &p("ui/snapshot")));
        assert!(refused("GET", &p("tasks/t1/verify")));
    }

    #[test]
    fn friday_request_refuses_every_route_confirm_and_send_owns() {
        for raw in [
            p("approvals/appr_1/approve"),
            p("approvals/appr_XYZ/approve"),
            p("policy/trust"),
            p("control/halt"),
            p("tasks/task_1/cancel"),
            p("goals/goal_1/cancel"),
            p("daemon/stop"),
            p("agent-processes"),
            p("agent-processes/claude-1/start"),
        ] {
            let e = req("POST", &raw).unwrap_err();
            assert_eq!(e.code, CONFIRMATION_REQUIRED, "{raw}");
            assert!(for_confirm("POST", &raw, None, PID, PORT).is_ok(), "{raw}");
        }
    }

    #[test]
    fn friday_request_refuses_danger_full_access_anywhere_in_the_body() {
        let launch = json!({"host": "codex", "agent_key": "codex-1", "role": "implementer",
            "options": {"sandbox": "danger-full-access"}});
        assert!(for_request("POST", &p("agent-processes"), Some(&launch), PID, PORT).is_err());
        let sneaky = json!({"request": "x", "nested": [{"a": " DANGER-FULL-ACCESS "}]});
        let e = for_request("POST", &p("goals"), Some(&sneaky), PID, PORT).unwrap_err();
        assert_eq!(e.code, CONFIRMATION_REQUIRED);
        let (_, what) = for_confirm("POST", &p("goals"), Some(&sneaky), PID, PORT).unwrap();
        assert_eq!(what, None);
        let fine = json!({"sandbox": "workspace-write"});
        assert!(for_request("POST", &p("goals"), Some(&fine), PID, PORT).is_ok());
    }

    #[test]
    fn confirm_and_send_refuses_routes_it_does_not_own() {
        let e = for_confirm("POST", &p("approvals/a1/reject"), None, PID, PORT).unwrap_err();
        assert_eq!(e.code, NOT_CONFIRMABLE);
        assert!(for_confirm("GET", &p("ui/snapshot"), None, PID, PORT).is_err());
        assert!(for_confirm("POST", &p("ui/login-codes"), None, PID, PORT).is_err());
        assert!(for_confirm("POST", &p("approvals/../approve"), None, PID, PORT).is_err());
    }

    #[test]
    fn the_stream_is_only_for_stream_open() {
        assert!(refused("GET", &p("events/stream?since=0")));
        let c = check("GET", &stream_path(PID, 12), PID, PORT).unwrap();
        assert_eq!(c.route.owner, Owner::Stream);
    }

    #[test]
    fn route_parameters_are_validated() {
        assert!(refused("POST", &p("plans/plan_1/versions/x/approve")));
        assert!(refused("POST", &p("agent-processes/Claude_1/stop")));
        assert!(refused("POST", &p("agent-processes/-x/stop")));
        assert!(refused("GET", &p(&format!("tasks/{}", "a".repeat(129)))));
        assert!(req("GET", &p(&format!("tasks/{}", "a".repeat(128)))).is_ok());
    }

    #[test]
    fn a_get_carries_no_body() {
        assert!(for_request("GET", &p("ui/snapshot"), Some(&json!({"x": 1})), PID, PORT).is_err());
        assert!(for_request("GET", &p("ui/snapshot"), Some(&Value::Null), PID, PORT).is_ok());
    }

    #[test]
    fn the_url_always_points_at_the_daemon() {
        let c = req("GET", &p("goals")).unwrap();
        assert_eq!(c.url.host_str(), Some("127.0.0.1"));
        assert_eq!(c.url.port(), Some(PORT));
        assert!(build_url(PORT, "@evil.example/x", None).is_err());
        assert!(build_url(PORT, "/a/../b", None).is_err());
    }
}
