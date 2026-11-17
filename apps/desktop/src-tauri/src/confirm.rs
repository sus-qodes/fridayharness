//! `confirm_and_send` (plan §8.4, FD-15, FD-28): the actions the page may not send by itself.
//!
//! Rust re-reads the item the action is about (an approval's risk, the policy's loosening, the
//! task or goal, a remembered agent), rebuilds the body it will send from the fields it knows,
//! decides whether a native dialog is needed, and shows the agent-written strings in that dialog
//! in full with every control, bidirectional and zero-width character escaped as `⟨U+XXXX⟩`.
//!
//! - Approving: a dialog only when the risk is `high` (or missing, or unknown) or the reach is
//!   `task`; one click otherwise is the page's job. `ttl_s` is clamped to [10, 86400].
//! - Trusting policy, halting, cancelling a task or a goal, stopping Friday, starting an agent and
//!   any body asking for `danger-full-access`: always a dialog.

use serde_json::{json, Map, Value};

use crate::proxy::CmdError;
use crate::routes::{Checked, Confirm, PREFIX};

pub const CANCELLED: &str = "DESKTOP-1003";
pub const NOT_PENDING: &str = "DESKTOP-1004";
pub const TOO_LONG: &str = "DESKTOP-1005";
pub const CHANGED: &str = "DESKTOP-1006";

/// Agent-written text longer than this is not put in a dialog: it could not be read in full.
pub const MAX_DIALOG_CHARS: usize = 4000;
pub const TTL_MIN: i64 = 10;
pub const TTL_MAX: i64 = 86_400;

/// Characters that change how text looks without being seen (FD-28), plus every C0 control:
/// in a dialog a newline written by an agent could fake a line of the dialog's own.
pub fn is_hidden(c: char) -> bool {
    let u = c as u32;
    u < 0x20
        || (0x7f..=0x9f).contains(&u)
        || u == 0xad
        || u == 0x061c
        || u == 0x180e
        || (0x200b..=0x200f).contains(&u)
        || (0x2028..=0x202e).contains(&u)
        || (0x2060..=0x2064).contains(&u)
        || (0x2066..=0x2069).contains(&u)
        || u == 0xfeff
        // Tag characters: invisible, and able to carry a whole hidden message (the page marks them too).
        || (0xe0000..=0xe007f).contains(&u)
}

/// The text with every hidden character shown as `⟨U+XXXX⟩`.
pub fn visible(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if is_hidden(c) {
            out.push_str(&format!("⟨U+{:04X}⟩", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// A native dialog to show before sending.
#[derive(Debug, Clone, PartialEq)]
pub struct Dialog {
    pub title: String,
    pub text: String,
    pub confirm: String,
    pub danger: bool,
}

/// What `confirm_and_send` sends, and the dialog that must be confirmed first (if any).
#[derive(Debug)]
pub struct Prepared {
    pub body: Value,
    pub dialog: Option<Dialog>,
}

fn field<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v.get(name).and_then(Value::as_str)
}

fn shown(v: Option<&str>) -> String {
    match v {
        Some(s) if !s.is_empty() => visible(s),
        _ => "(none)".into(),
    }
}

fn text_field(body: Option<&Value>, name: &str, max: usize) -> Result<Option<String>, CmdError> {
    match body.and_then(|b| b.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(CmdError::bad_request(format!("{name} is longer than {max} characters"))),
        Some(_) => Err(CmdError::bad_request(format!("{name} must be text"))),
    }
}

/// `{reason}` bodies: only the reason is sent.
fn reason_body(body: Option<&Value>) -> Result<Value, CmdError> {
    let mut m = Map::new();
    if let Some(r) = text_field(body, "reason", 2000)? {
        m.insert("reason".into(), Value::String(r));
    }
    Ok(Value::Object(m))
}

pub fn clamp_ttl(ttl: i64) -> i64 {
    ttl.clamp(TTL_MIN, TTL_MAX)
}

fn reach_text(reuse: &str) -> &'static str {
    match reuse {
        "once" => "once (this one use)",
        "run" => "this attempt (every use until the agent's run ends)",
        _ => "this whole task (every attempt, every agent working on it)",
    }
}

fn too_long(parts: &[&str]) -> Result<(), CmdError> {
    let n: usize = parts.iter().map(|p| p.chars().count()).sum();
    if n > MAX_DIALOG_CHARS {
        return Err(CmdError::shell(
            400,
            TOO_LONG,
            "too_long_to_confirm",
            "this request is too long to show in full in a dialog; decide it in a terminal",
        ));
    }
    Ok(())
}

fn cancelled() -> CmdError {
    CmdError::shell(400, CANCELLED, "cancelled", "you cancelled it in the confirmation dialog")
}

pub fn cancelled_error() -> CmdError {
    cancelled()
}

/// The approval body actually sent: `reuse` (required), `ttl_s` clamped, `note`, `via: "ui"`.
pub fn approve_body(body: Option<&Value>) -> Result<(Value, String), CmdError> {
    let reuse = match body.and_then(|b| b.get("reuse")).and_then(Value::as_str) {
        Some(r @ ("once" | "run" | "task")) => r.to_string(),
        _ => return Err(CmdError::bad_request("reuse must be once, run or task")),
    };
    let mut m = Map::new();
    m.insert("reuse".into(), Value::String(reuse.clone()));
    m.insert("via".into(), Value::String("ui".into()));
    match body.and_then(|b| b.get("ttl_s")) {
        None | Some(Value::Null) => {}
        Some(v) => {
            let n = v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| CmdError::bad_request("ttl_s must be a number"))?;
            m.insert("ttl_s".into(), json!(clamp_ttl(n.round() as i64)));
        }
    }
    if let Some(note) = text_field(body, "note", 500)? {
        m.insert("note".into(), Value::String(note));
    }
    Ok((Value::Object(m), reuse))
}

/// The dialog for an approval, or none when one click is enough (low or medium risk, reach
/// `once` or `run`).
pub fn approval_dialog(approval: &Value, reuse: &str) -> Result<Option<Dialog>, CmdError> {
    let risk = field(approval, "risk");
    let one_click = matches!(risk, Some("low" | "medium")) && reuse != "task";
    if one_click {
        return Ok(None);
    }
    let capability = field(approval, "capability");
    let target = field(approval, "target");
    let purpose = field(approval, "purpose");
    too_long(&[capability.unwrap_or(""), target.unwrap_or(""), purpose.unwrap_or("")])?;
    let risk_text = match risk {
        Some("high") => "high".to_string(),
        Some(other) => format!("{} (unknown; treated as high)", visible(other)),
        None => "not stated (treated as high)".to_string(),
    };
    let text = format!(
        "An agent asks to use a capability.\n\nCapability: {}\nTarget: {}\nPurpose: {}\nRisk: {}\nReach: {}\nTask: {}\nAsked by: {}\n\nCharacters an agent could hide are shown as ⟨U+XXXX⟩.\nAllow it?",
        shown(capability),
        shown(target),
        shown(purpose),
        risk_text,
        reach_text(reuse),
        shown(field(approval, "task_id")),
        shown(field(approval, "requested_by_id")),
    );
    Ok(Some(Dialog {
        title: "Friday: allow this request?".into(),
        text,
        confirm: if reuse == "task" { "Allow for the whole task".into() } else { "Allow".into() },
        danger: true,
    }))
}

fn options_text(options: Option<&Value>) -> String {
    match options.and_then(Value::as_object) {
        Some(m) if !m.is_empty() => m
            .iter()
            .map(|(k, v)| {
                // The spending limit in words: an amount, or none. Anything else under that name is
                // shown as it is, so nothing the daemon would read differently is dressed up.
                if k == "max_budget_usd" {
                    match v {
                        Value::Null => return "no spending limit per attempt".to_string(),
                        Value::Number(n) => return format!("spending limit per attempt: ${n}"),
                        _ => {}
                    }
                }
                let v = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                format!("{}: {}", visible(k), visible(&v))
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => "(defaults)".into(),
    }
}

const DANGER_NOTE: &str = "\n\nWARNING: danger-full-access lets the agent run any command on this computer without a sandbox, outside the project too.";

/// Builds what `confirm_and_send` sends for `what` and its dialog. `get` reads a project route
/// (a path under `/api/v1/projects/<pid>/`) from the daemon.
pub fn prepare(
    what: Option<Confirm>,
    checked: &Checked,
    project_id: &str,
    body: Option<&Value>,
    get: &dyn Fn(&str) -> Result<Value, CmdError>,
) -> Result<Prepared, CmdError> {
    let danger = body.is_some_and(crate::routes::asks_for_danger);
    let base = format!("{PREFIX}{project_id}/");
    match what {
        Some(Confirm::Approve) => {
            let aid = checked.param("aid").unwrap_or_default().to_string();
            let (sent, reuse) = approve_body(body)?;
            let list = get(&format!("{base}approvals?status=pending"))?;
            let approval = list
                .get("approvals")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|x| field(x, "approval_id") == Some(aid.as_str())))
                .cloned()
                .ok_or_else(|| {
                    CmdError::shell(409, NOT_PENDING, "not_pending", "that approval is no longer pending")
                })?;
            Ok(Prepared { body: sent, dialog: approval_dialog(&approval, &reuse)? })
        }
        Some(Confirm::Trust) => {
            let hash = match body.and_then(|b| b.get("loosening_hash")) {
                Some(Value::String(h)) if !h.is_empty() && h.len() <= 200 => h.clone(),
                _ => return Err(CmdError::bad_request("loosening_hash is required")),
            };
            let policy = get(&format!("{base}policy"))?;
            let p = policy.get("policy").cloned().unwrap_or(Value::Null);
            if field(&p, "loosening_hash") != Some(hash.as_str()) {
                return Err(CmdError::shell(
                    409,
                    CHANGED,
                    "changed",
                    "the project's policy changed since it was shown; look at it again",
                ));
            }
            let items: Vec<String> = p
                .get("loosening")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|l| {
                            format!(
                                "- {} from {} to {} (in {})",
                                shown(field(l, "setting")),
                                shown(field(l, "from")),
                                shown(field(l, "to")),
                                shown(field(l, "source"))
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let list = items.join("\n");
            too_long(&[&list])?;
            Ok(Prepared {
                body: json!({"loosening_hash": hash}),
                dialog: Some(Dialog {
                    title: "Friday: trust this project's policy?".into(),
                    text: format!(
                        "Files tracked in this repository loosen Friday's policy on this computer:\n\n{}\n\nAnyone who can change those files chose these settings. Trust exactly these settings for this clone?",
                        if list.is_empty() { "(nothing listed)".to_string() } else { list }
                    ),
                    confirm: "Trust these settings".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::Halt) => Ok(Prepared {
            body: reason_body(body)?,
            dialog: Some(Dialog {
                title: "Friday: halt every agent?".into(),
                text: "Halting pauses Friday and stops every running attempt. Work in the worktrees is kept and the tasks go back to READY; no task is cancelled.\n\nHalt now?".into(),
                confirm: "Halt".into(),
                danger: true,
            }),
        }),
        Some(Confirm::RecoverCancel) => {
            let tid = checked.param("tid").unwrap_or_default().to_string();
            let detail = get(&format!("{base}tasks/{tid}"))?;
            let summary = detail.pointer("/task/summary").and_then(Value::as_str);
            too_long(&[summary.unwrap_or("")])?;
            // The recovery body as recovery takes it, nothing else: the action and an optional reason.
            let mut m = Map::new();
            m.insert("action".into(), Value::String("cancel".into()));
            if let Some(r) = text_field(body, "reason", 2000)? {
                m.insert("reason".into(), Value::String(r));
            }
            Ok(Prepared {
                body: Value::Object(m),
                dialog: Some(Dialog {
                    title: "Friday: cancel this task?".into(),
                    text: format!(
                        "Task {}: {}\n\nRecovery cancels the task: a cancelled task does not run again. Its worktree is kept until you prune it.\n\nCancel the task?",
                        visible(&tid),
                        shown(summary)
                    ),
                    confirm: "Cancel the task".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::CancelTask) => {
            let tid = checked.param("tid").unwrap_or_default().to_string();
            let detail = get(&format!("{base}tasks/{tid}"))?;
            let summary = detail.pointer("/task/summary").and_then(Value::as_str);
            too_long(&[summary.unwrap_or("")])?;
            // What becomes of the tasks that depend on it, as the person chose in the page: one of
            // two words, sent on as it is and said here; anything else is left out.
            let dependents = body
                .and_then(|b| b.get("dependents"))
                .and_then(Value::as_str)
                .filter(|d| matches!(*d, "cancel" | "release"));
            let mut sent = reason_body(body)?;
            if let (Some(d), Some(m)) = (dependents, sent.as_object_mut()) {
                m.insert("dependents".into(), Value::String(d.to_string()));
            }
            let also = match dependents {
                Some("cancel") => "\n\nThe unfinished tasks that depend on it are cancelled too.",
                Some("release") => "\n\nThe tasks that depend on it are kept, and no longer wait for it.",
                _ => "",
            };
            Ok(Prepared {
                body: sent,
                dialog: Some(Dialog {
                    title: "Friday: cancel this task?".into(),
                    text: format!(
                        "Task {}: {}\n\nA cancelled task does not run again. Its worktree is kept until you prune it.{also}\n\nCancel the task?",
                        visible(&tid),
                        shown(summary)
                    ),
                    confirm: "Cancel the task".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::CancelGoal) => {
            let gid = checked.param("gid").unwrap_or_default().to_string();
            let detail = get(&format!("{base}goals/{gid}"))?;
            let goal = detail.get("goal").cloned().unwrap_or(Value::Null);
            let text = field(&goal, "objective").or_else(|| field(&goal, "request"));
            too_long(&[text.unwrap_or("")])?;
            Ok(Prepared {
                body: reason_body(body)?,
                dialog: Some(Dialog {
                    title: "Friday: cancel this goal?".into(),
                    text: format!(
                        "Goal {}: {}\n\nIts open tasks are cancelled too. Work already in worktrees is kept.\n\nCancel the goal?",
                        visible(&gid),
                        shown(text)
                    ),
                    confirm: "Cancel the goal".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::LandGoal) => {
            let gid = checked.param("gid").unwrap_or_default().to_string();
            let detail = get(&format!("{base}goals/{gid}"))?;
            let goal = detail.get("goal").cloned().unwrap_or(Value::Null);
            let text = field(&goal, "objective").or_else(|| field(&goal, "request"));
            // What landing would do, read now (`GET goals/{gid}/land`): the branch it lands into by
            // name, or that nothing would merge. Only a merge is asked about: a goal already on that
            // branch, or one the daemon refuses with its reason (changes in the way, a merge of the
            // person's in progress, work that is already in the folder), is sent without a dialog,
            // since it changes nothing in the folder.
            let plan = get(&format!("{base}goals/{gid}/land"))?;
            if field(&plan, "state") != Some("ready") {
                return Ok(Prepared { body: json!({}), dialog: None });
            }
            let into = field(&plan, "into").unwrap_or("your branch").to_string();
            let diff = get(&format!("{base}goals/{gid}/diff?stat=1"))?;
            let branch = field(&diff, "branch").map(str::to_string).unwrap_or_else(|| format!("friday/goal-{gid}"));
            let commits = diff.get("commits_ahead").and_then(Value::as_array).map_or(0, Vec::len);
            let files = diff.get("files").and_then(Value::as_array).map_or(0, Vec::len);
            too_long(&[text.unwrap_or(""), &branch, &into])?;
            Ok(Prepared {
                // The land route takes nothing: what it merges is the goal's own branch.
                body: json!({}),
                dialog: Some(Dialog {
                    title: "Friday: land this goal?".into(),
                    text: format!(
                        "Goal {}: {}\n\nThis merges {} ({} {}, {} {}) into {}, the branch your project folder has checked out, as \"git merge\" there would. If git cannot merge cleanly, nothing is changed.\n\nLand the goal?",
                        visible(&gid),
                        shown(text),
                        visible(&branch),
                        commits,
                        if commits == 1 { "commit" } else { "commits" },
                        files,
                        if files == 1 { "file" } else { "files" },
                        visible(&into),
                    ),
                    confirm: "Land the goal".into(),
                    danger: false,
                }),
            })
        }
        Some(Confirm::StopDaemon) => Ok(Prepared {
            body: json!({}),
            dialog: Some(stop_dialog()),
        }),
        Some(Confirm::LaunchAgent) => {
            let mut b = body.cloned().unwrap_or_else(|| json!({}));
            // What the dialog says is what is sent: the daemon starts an agent with Friday unless
            // the body says false (agent-launcher.ts), so a missing value is shown and sent as true.
            let autostart = b.get("autostart") != Some(&Value::Bool(false));
            if let Some(m) = b.as_object_mut() {
                m.insert("autostart".into(), Value::Bool(autostart));
            }
            let host = field(&b, "host");
            let key = field(&b, "agent_key");
            let role = field(&b, "role");
            let opts = options_text(b.get("options"));
            too_long(&[host.unwrap_or(""), key.unwrap_or(""), role.unwrap_or(""), &opts])?;
            Ok(Prepared {
                body: b.clone(),
                dialog: Some(Dialog {
                    title: "Friday: start this agent?".into(),
                    text: format!(
                        "Host: {}\nAgent: {}\nRole: {}\nOptions: {}\nStarts with Friday: {}{}\n\nAn agent works on this project's tasks and may spend on its provider account.\n\nStart it?",
                        shown(host),
                        shown(key),
                        shown(role),
                        opts,
                        if autostart { "yes" } else { "no" },
                        if danger { DANGER_NOTE } else { "" }
                    ),
                    confirm: "Start the agent".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::StartAgent) => {
            let key = checked.param("key").unwrap_or_default().to_string();
            let view = get(&format!("{base}agent-processes"))?;
            let profile = view
                .get("profiles")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|p| field(p, "agent_key") == Some(key.as_str())))
                .cloned()
                .unwrap_or(Value::Null);
            let profile_danger = crate::routes::asks_for_danger(&profile);
            let opts = options_text(profile.get("options"));
            Ok(Prepared {
                body: json!({}),
                dialog: Some(Dialog {
                    title: "Friday: start this agent again?".into(),
                    text: format!(
                        "Agent: {}\nHost: {}\nRole: {}\nOptions: {}{}\n\nStart it again?",
                        visible(&key),
                        shown(field(&profile, "host")),
                        shown(field(&profile, "role")),
                        opts,
                        if profile_danger || danger { DANGER_NOTE } else { "" }
                    ),
                    confirm: "Start the agent".into(),
                    danger: true,
                }),
            })
        }
        Some(Confirm::UpdateAgent) => {
            let key = checked.param("key").unwrap_or_default().to_string();
            let view = get(&format!("{base}agent-processes"))?;
            let profile = view
                .get("profiles")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|p| field(p, "agent_key") == Some(key.as_str())))
                .cloned()
                .ok_or_else(|| CmdError::shell(404, NOT_PENDING, "agent_not_found", "Friday does not remember this agent"))?;
            // Only what the route changes is sent: the role, the options and whether it starts with
            // Friday. What the body leaves out stays as it is, and is shown as it is.
            let mut sent = Map::new();
            if let Some(r) = text_field(body, "role", 64)? {
                sent.insert("role".into(), Value::String(r));
            }
            match body.and_then(|b| b.get("options")) {
                None => {}
                Some(o @ Value::Object(_)) => {
                    sent.insert("options".into(), o.clone());
                }
                Some(_) => return Err(CmdError::bad_request("options must be an object")),
            }
            match body.and_then(|b| b.get("autostart")) {
                None => {}
                Some(Value::Bool(a)) => {
                    sent.insert("autostart".into(), Value::Bool(*a));
                }
                Some(_) => return Err(CmdError::bad_request("autostart must be true or false")),
            }
            let role = sent.get("role").and_then(Value::as_str).or_else(|| field(&profile, "role"));
            let options = sent.get("options").or_else(|| profile.get("options"));
            let autostart = sent
                .get("autostart")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| profile.get("autostart") == Some(&Value::Bool(true)));
            let opts = options_text(options);
            let before = options_text(profile.get("options"));
            too_long(&[&key, role.unwrap_or(""), &opts, &before])?;
            let asks_danger = options.is_some_and(crate::routes::asks_for_danger);
            Ok(Prepared {
                body: Value::Object(sent.clone()),
                dialog: Some(Dialog {
                    title: "Friday: change this agent?".into(),
                    text: format!(
                        "Agent: {}\nHost: {}\nRole: {}\nOptions: {}\nStarts with Friday: {}\n\nIts options until now: {}{}\n\nA spending limit applies from the agent's next attempt; everything else the next time it starts. An agent may spend on its provider account.\n\nSave the change?",
                        visible(&key),
                        shown(field(&profile, "host")),
                        shown(role),
                        opts,
                        if autostart { "yes" } else { "no" },
                        before,
                        if asks_danger || danger { DANGER_NOTE } else { "" }
                    ),
                    confirm: "Save the change".into(),
                    danger: true,
                }),
            })
        }
        None => {
            let b = body.cloned().unwrap_or(Value::Null);
            let shown_body = visible(&serde_json::to_string_pretty(&b).unwrap_or_default());
            too_long(&[&shown_body])?;
            Ok(Prepared {
                body: b,
                dialog: Some(Dialog {
                    title: "Friday: allow danger-full-access?".into(),
                    text: format!(
                        "{} {} asks for danger-full-access:\n\n{}{}\n\nSend it?",
                        checked.route.method.as_str(),
                        checked.route.template,
                        shown_body,
                        DANGER_NOTE
                    ),
                    confirm: "Send".into(),
                    danger: true,
                }),
            })
        }
    }
}

pub fn restart_dialog() -> Dialog {
    Dialog {
        title: "Friday: restart Friday?".into(),
        text: "Friday stops for this project and starts again: agents lose their connection for a moment and spawned agents stop. Work in worktrees is kept.\n\nRestart Friday?".into(),
        confirm: "Restart Friday".into(),
        danger: true,
    }
}

pub fn stop_dialog() -> Dialog {
    Dialog {
        title: "Friday: stop Friday?".into(),
        text: "Friday stops for this project: agents lose their connection and spawned agents stop. Work in worktrees is kept.\n\nStop Friday?".into(),
        confirm: "Stop Friday".into(),
        danger: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::{for_confirm, PREFIX};

    const PID: &str = "proj_0123456789abcdefghjkmnpqrs";

    fn checked(rest: &str, body: Option<&Value>) -> (Checked, Option<Confirm>) {
        for_confirm("POST", &format!("{PREFIX}{PID}/{rest}"), body, PID, 4310).unwrap()
    }

    fn approvals(list: Value) -> impl Fn(&str) -> Result<Value, CmdError> {
        move |path: &str| {
            assert!(path.ends_with("/approvals?status=pending"), "{path}");
            Ok(json!({ "approvals": list.clone() }))
        }
    }

    #[test]
    fn hidden_characters_become_visible_marks() {
        assert_eq!(visible("rm -rf /\u{202E}gpj.exe"), "rm -rf /⟨U+202E⟩gpj.exe");
        assert_eq!(visible("a\u{200B}b\u{200C}c\u{200D}d\u{2060}e\u{FEFF}"), "a⟨U+200B⟩b⟨U+200C⟩c⟨U+200D⟩d⟨U+2060⟩e⟨U+FEFF⟩");
        assert_eq!(visible("x\u{2066}y\u{2069}\u{200E}\u{200F}\u{202A}"), "x⟨U+2066⟩y⟨U+2069⟩⟨U+200E⟩⟨U+200F⟩⟨U+202A⟩");
        assert_eq!(visible("line\nRisk: low\r\t\u{0}\u{7F}\u{85}"), "line⟨U+000A⟩Risk: low⟨U+000D⟩⟨U+0009⟩⟨U+0000⟩⟨U+007F⟩⟨U+0085⟩");
        assert_eq!(visible("café ünïcode → ✓"), "café ünïcode → ✓");
        assert_eq!(visible("\u{2028}\u{2029}"), "⟨U+2028⟩⟨U+2029⟩");
    }

    #[test]
    fn ttl_is_clamped() {
        assert_eq!(clamp_ttl(1), 10);
        assert_eq!(clamp_ttl(-5), 10);
        assert_eq!(clamp_ttl(3600), 3600);
        assert_eq!(clamp_ttl(7 * 86_400), 86_400);
        let (b, _) = approve_body(Some(&json!({"reuse": "run", "ttl_s": 999999, "via": "cli", "extra": 1}))).unwrap();
        assert_eq!(b, json!({"reuse": "run", "ttl_s": 86400, "via": "ui"}));
        let (b, _) = approve_body(Some(&json!({"reuse": "once", "ttl_s": 2.4, "note": "ok"}))).unwrap();
        assert_eq!(b, json!({"reuse": "once", "ttl_s": 10, "via": "ui", "note": "ok"}));
        assert!(approve_body(Some(&json!({"reuse": "forever"}))).is_err());
        assert!(approve_body(None).is_err());
        assert!(approve_body(Some(&json!({"reuse": "once", "ttl_s": "x"}))).is_err());
    }

    #[test]
    fn low_and_medium_risk_once_or_run_need_no_dialog() {
        let a = json!([{"approval_id": "a1", "risk": "medium", "capability": "shell", "target": "npm test"}]);
        let body = json!({"reuse": "run"});
        let (c, what) = checked("approvals/a1/approve", Some(&body));
        let p = prepare(what, &c, PID, Some(&body), &approvals(a)).unwrap();
        assert!(p.dialog.is_none());
        assert_eq!(p.body, json!({"reuse": "run", "via": "ui"}));
    }

    #[test]
    fn high_or_missing_risk_and_task_reach_need_a_dialog_with_the_target_in_full() {
        let target = format!("git push --force origin main\u{202E}{}", "x".repeat(300));
        for (risk, reuse) in [(json!("high"), "once"), (Value::Null, "once"), (json!("low"), "task"), (json!("weird"), "run")] {
            let a = json!([{"approval_id": "a1", "risk": risk, "capability": "shell.exec", "target": target, "purpose": "Bash: push\nRisk: low"}]);
            let body = json!({"reuse": reuse});
            let (c, what) = checked("approvals/a1/approve", Some(&body));
            let p = prepare(what, &c, PID, Some(&body), &approvals(a)).unwrap();
            let d = p.dialog.expect("a dialog");
            assert!(d.text.contains(&visible(&target)), "{}", d.text);
            assert!(d.text.contains("⟨U+202E⟩"));
            assert!(d.text.contains("Bash: push⟨U+000A⟩Risk: low"));
            assert!(!d.text.contains("\u{202E}"));
        }
    }

    #[test]
    fn an_approval_that_is_not_pending_is_a_conflict() {
        let body = json!({"reuse": "once"});
        let (c, what) = checked("approvals/a9/approve", Some(&body));
        let e = prepare(what, &c, PID, Some(&body), &approvals(json!([{"approval_id": "a1", "risk": "low"}]))).unwrap_err();
        assert_eq!(e.status, 409);
        assert_eq!(e.code(), Some(NOT_PENDING));
    }

    #[test]
    fn a_target_too_long_to_read_is_refused() {
        let a = json!([{"approval_id": "a1", "risk": "high", "target": "y".repeat(MAX_DIALOG_CHARS + 1)}]);
        let body = json!({"reuse": "once"});
        let (c, what) = checked("approvals/a1/approve", Some(&body));
        let e = prepare(what, &c, PID, Some(&body), &approvals(a)).unwrap_err();
        assert_eq!(e.code(), Some(TOO_LONG));
    }

    #[test]
    fn trust_shows_the_loosening_and_refuses_a_changed_policy() {
        let policy = json!({"policy": {"loosening_hash": "h1", "loosening": [
            {"source": ".friday/policy.yaml", "setting": "shell.exec", "from": "ask", "to": "allow\u{200B}"}]}});
        let get = move |path: &str| {
            assert!(path.ends_with("/policy"));
            Ok(policy.clone())
        };
        let body = json!({"loosening_hash": "h1", "extra": true});
        let (c, what) = checked("policy/trust", Some(&body));
        let p = prepare(what, &c, PID, Some(&body), &get).unwrap();
        assert_eq!(p.body, json!({"loosening_hash": "h1"}));
        assert!(p.dialog.unwrap().text.contains("allow⟨U+200B⟩"));
        let stale = json!({"loosening_hash": "h0"});
        let (c, what) = checked("policy/trust", Some(&stale));
        assert_eq!(prepare(what, &c, PID, Some(&stale), &get).unwrap_err().code(), Some(CHANGED));
    }

    #[test]
    fn landing_a_goal_asks_before_a_merge_and_says_what_it_merges_into() {
        let reads = |state: &'static str| {
            move |path: &str| -> Result<Value, CmdError> {
                if path.ends_with("/goals/g1") {
                    Ok(json!({"goal": {"objective": "Discount\u{202E} codes"}}))
                } else if path.ends_with("/goals/g1/land") {
                    Ok(json!({"state": state, "into": "ma\u{202E}in", "commits": 2}))
                } else if path.ends_with("/goals/g1/diff?stat=1") {
                    Ok(json!({"branch": "friday/goal-g1", "commits_ahead": [{"sha": "a"}, {"sha": "b"}],
                        "files": [{"path": "README.md"}]}))
                } else {
                    panic!("unexpected read {path}")
                }
            }
        };
        let body = json!({"force": true});
        let (c, what) = checked("goals/g1/land", Some(&body));
        assert_eq!(what, Some(Confirm::LandGoal));
        let p = prepare(what, &c, PID, Some(&body), &reads("ready")).unwrap();
        // Nothing of the page's body is sent: the route merges the goal's own branch.
        assert_eq!(p.body, json!({}));
        let d = p.dialog.expect("a dialog");
        assert!(d.text.contains("Discount⟨U+202E⟩ codes"));
        assert!(d.text.contains("friday/goal-g1 (2 commits, 1 file) into ma⟨U+202E⟩in,"), "{}", d.text);
        assert_eq!(d.confirm, "Land the goal");
        // Nothing would merge (already there, or the daemon refuses with its reason): no question
        // is asked about a merge that will not happen, and the daemon's answer is what the person reads.
        for state in ["landed", "blocked", "in_folder", "not_completed"] {
            let p = prepare(what, &c, PID, Some(&body), &reads(state)).unwrap();
            assert!(p.dialog.is_none(), "{state}");
            assert_eq!(p.body, json!({}), "{state}");
        }
        // Only confirm_and_send sends the merge; the plan is an ordinary read.
        assert!(crate::routes::for_request("POST", &format!("{PREFIX}{PID}/goals/g1/land"), None, PID, 4310).is_err());
        assert!(crate::routes::for_request("GET", &format!("{PREFIX}{PID}/goals/g1/land"), None, PID, 4310).is_ok());
    }

    #[test]
    fn halt_cancel_stop_and_starting_agents_always_ask() {
        let get = |path: &str| -> Result<Value, CmdError> {
            if path.ends_with("/tasks/t1") {
                Ok(json!({"task": {"summary": "Fix\u{202E} the cart"}}))
            } else if path.ends_with("/goals/g1") {
                Ok(json!({"goal": {"request": "Ship checkout"}}))
            } else if path.ends_with("/agent-processes") {
                Ok(json!({"profiles": [{"agent_key": "codex-1", "host": "codex", "role": "implementer",
                    "options": {"sandbox": "danger-full-access"}}]}))
            } else {
                panic!("unexpected read {path}")
            }
        };
        for rest in ["control/halt", "tasks/t1/cancel", "goals/g1/cancel", "daemon/stop", "agent-processes/codex-1/start"] {
            let body = json!({"reason": "because", "junk": 1});
            let (c, what) = checked(rest, Some(&body));
            let p = prepare(what, &c, PID, Some(&body), &get).unwrap();
            let d = p.dialog.expect(rest);
            assert!(!p.body.to_string().contains("junk"), "{rest}");
            if rest == "tasks/t1/cancel" {
                assert!(d.text.contains("Fix⟨U+202E⟩ the cart"));
            }
            if rest.ends_with("/start") {
                assert!(d.text.contains("WARNING: danger-full-access"));
            }
        }
        // What becomes of the tasks that depend on a cancelled one is the person's choice: one of two
        // words goes on to the daemon and is said in the dialog; anything else is dropped.
        for (word, said) in [
            ("cancel", Some("are cancelled too")),
            ("release", Some("no longer wait for it")),
            ("everything", None),
        ] {
            let body = json!({"reason": "because", "dependents": word});
            let (c, what) = checked("tasks/t1/cancel", Some(&body));
            let p = prepare(what, &c, PID, Some(&body), &get).unwrap();
            let d = p.dialog.expect("a dialog");
            match said {
                Some(text) => {
                    assert_eq!(p.body, json!({"reason": "because", "dependents": word}));
                    assert!(d.text.contains(text), "{word}: {}", d.text);
                }
                None => {
                    assert_eq!(p.body, json!({"reason": "because"}));
                    assert!(!d.text.contains("depend on it"), "{}", d.text);
                }
            }
        }
        // Changing a remembered agent shows what it will run with beside what it had, sends only
        // what the route changes, and says a spending limit in words.
        let claude = |path: &str| -> Result<Value, CmdError> {
            assert!(path.ends_with("/agent-processes"), "{path}");
            Ok(json!({"profiles": [{"agent_key": "claude-1", "host": "claude-code", "role": "developer",
                "autostart": true, "options": {"max_budget_usd": 5}}]}))
        };
        let change = json!({"options": {"max_budget_usd": null, "effort": "high"}, "junk": 1, "host": "codex"});
        let (c, what) = checked("agent-processes/claude-1/update", Some(&change));
        assert_eq!(what, Some(Confirm::UpdateAgent));
        let p = prepare(what, &c, PID, Some(&change), &claude).unwrap();
        assert_eq!(p.body, json!({"options": {"max_budget_usd": null, "effort": "high"}}));
        let d = p.dialog.expect("a dialog");
        assert_eq!(d.title, "Friday: change this agent?");
        assert!(d.text.contains("Agent: claude-1\nHost: claude-code\nRole: developer\n"), "{}", d.text);
        assert!(d.text.contains("no spending limit per attempt"), "{}", d.text);
        assert!(d.text.contains("Its options until now: spending limit per attempt: $5"), "{}", d.text);
        assert!(d.text.contains("Starts with Friday: yes"), "{}", d.text);
        assert!(!d.text.contains("WARNING"), "{}", d.text);
        // A part left out is kept and shown as it is; a changed one is shown as it will be.
        let part = json!({"role": "back\u{202E}end", "autostart": false});
        let (c, what) = checked("agent-processes/claude-1/update", Some(&part));
        let p = prepare(what, &c, PID, Some(&part), &claude).unwrap();
        assert_eq!(p.body, part);
        let d = p.dialog.expect("a dialog");
        assert!(d.text.contains("Role: back⟨U+202E⟩end"), "{}", d.text);
        assert!(d.text.contains("Options: spending limit per attempt: $5\nStarts with Friday: no"), "{}", d.text);
        // Full access asked for by a change is said as loudly as at a start.
        let full = json!({"options": {"sandbox": "danger-full-access"}});
        let (c, what) = checked("agent-processes/codex-1/update", Some(&full));
        let p = prepare(what, &c, PID, Some(&full), &get).unwrap();
        assert!(p.dialog.unwrap().text.contains("WARNING: danger-full-access"));
        // An agent Friday does not remember, or a body of the wrong shape, is refused before any dialog.
        let (c, what) = checked("agent-processes/nobody/update", Some(&change));
        assert!(prepare(what, &c, PID, Some(&change), &claude).is_err());
        for bad in [json!({"options": "none"}), json!({"autostart": "yes"}), json!({"role": 5})] {
            let (c, what) = checked("agent-processes/claude-1/update", Some(&bad));
            assert!(prepare(what, &c, PID, Some(&bad), &claude).is_err(), "{bad}");
        }
        let launch = json!({"host": "codex", "agent_key": "codex-2", "role": "implementer",
            "options": {"sandbox": "danger-full-access"}, "autostart": true});
        let (c, what) = checked("agent-processes", Some(&launch));
        let p = prepare(what, &c, PID, Some(&launch), &get).unwrap();
        assert_eq!(p.body, launch);
        assert!(p.dialog.unwrap().text.contains("WARNING"));
        // No autostart in the body: the daemon would start it with Friday, so the dialog says so
        // and the body sent says so too (review M9i).
        let plain = json!({"host": "codex", "agent_key": "codex-3", "role": "developer"});
        let (c, what) = checked("agent-processes", Some(&plain));
        let p = prepare(what, &c, PID, Some(&plain), &get).unwrap();
        assert!(p.dialog.unwrap().text.contains("Starts with Friday: yes"));
        assert_eq!(p.body["autostart"], json!(true));
    }

    #[test]
    fn a_danger_body_on_another_route_asks_with_the_body_shown() {
        let body = json!({"request": "x", "options": {"sandbox": "danger-full-access"}});
        let (c, what) = checked("goals", Some(&body));
        assert_eq!(what, None);
        let p = prepare(what, &c, PID, Some(&body), &|_| panic!("no read")).unwrap();
        let d = p.dialog.unwrap();
        assert!(d.text.contains("danger-full-access"));
        assert_eq!(p.body, body);
    }
}
