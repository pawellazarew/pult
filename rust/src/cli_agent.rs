//! Owner CLI presentation over existing RPCs. No backend or provider authority.
use crate::cli_client::{self, OwnerClient, ResponsePolicy, RpcError};
use serde_json::{Value, json, value::RawValue};
use std::path::Path;

type Fields = pult_core::RawFields;
pub(super) enum Command {
    List,
    Stop {
        name: String,
        turn_id: Option<String>,
    },
    Rename {
        name: String,
        title: String,
    },
    Archive {
        name: String,
        archived: bool,
    },
    Seen {
        name: String,
        unread: bool,
    },
}
fn invalid() -> RpcError {
    RpcError::local("invalid_response", "invalid agent response")
}
fn capacity() -> RpcError {
    RpcError::local("capacity", "agent display exceeds rendering limits")
}
fn fields(raw: &RawValue) -> Result<Fields, RpcError> {
    Fields::parse(raw).map_err(|_| invalid())
}
fn object(raw: Option<&RawValue>) -> Option<Fields> {
    raw.filter(|v| v.get().starts_with('{'))
        .and_then(|v| fields(v).ok())
}
fn string(raw: Option<&RawValue>) -> Option<String> {
    raw.filter(|v| v.get().starts_with('"'))
        .and_then(|v| pult_core::display_string(v).ok())
}
fn numeric(raw: Option<&RawValue>) -> Option<f64> {
    let raw = raw?.get();
    (!raw.starts_with(['"', '[', '{']) && !matches!(raw, "null" | "true" | "false"))
        .then(|| raw.parse().ok())
        .flatten()
}
// Display coercion only: opaque JSON output bypasses this bounded traversal.
const DISPLAY_DEPTH: usize = 64;
const DISPLAY_NODES: usize = 4096;
fn array_children(raw: &RawValue, remaining: usize) -> Result<Vec<&RawValue>, RpcError> {
    use serde::de::{Deserializer as _, Error as _, SeqAccess, Visitor};
    struct Children(usize);
    impl<'de> Visitor<'de> for Children {
        type Value = Vec<&'de RawValue>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("bounded display array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut values = Vec::new();
            while let Some(value) = seq.next_element::<&'de RawValue>()? {
                if values.len() >= self.0 {
                    return Err(A::Error::custom("display node capacity"));
                }
                values.push(value);
            }
            Ok(values)
        }
    }
    serde_json::Deserializer::from_str(raw.get())
        .deserialize_seq(Children(remaining))
        .map_err(|_| capacity())
}
fn js_string(raw: &RawValue) -> Result<String, RpcError> {
    enum Part<'a> {
        Value(&'a RawValue, usize, bool),
        Comma,
    }
    let mut pending = vec![Part::Value(raw, 0, false)];
    let mut remaining = DISPLAY_NODES - 1;
    let mut out = String::new();
    while let Some(part) = pending.pop() {
        let Part::Value(raw, depth, in_array) = part else {
            push(&mut out, ",")?;
            continue;
        };
        if depth > DISPLAY_DEPTH {
            return Err(capacity());
        }
        let text = raw.get();
        match text.as_bytes().first() {
            Some(b'"') => push(
                &mut out,
                &pult_core::display_string(raw).map_err(|_| invalid())?,
            )?,
            Some(b'[') => {
                let children = array_children(raw, remaining)?;
                remaining -= children.len(); // Reserve queued nodes before reconstruction.
                for (i, child) in children.into_iter().enumerate().rev() {
                    pending.push(Part::Value(child, depth + 1, true));
                    if i > 0 {
                        pending.push(Part::Comma);
                    }
                }
            }
            Some(b'{') => {
                if fields(raw)?.contains_key("toString") {
                    return Err(invalid());
                }
                push(&mut out, "[object Object]")?;
            }
            _ if text == "null" && in_array => {}
            _ if matches!(text, "null" | "true" | "false") => push(&mut out, text)?,
            _ => {
                let value = text.parse::<f64>().map_err(|_| invalid())?;
                push(&mut out, ryu_js::Buffer::new().format(value))?;
            }
        }
    }
    Ok(out)
}
fn display(raw: Option<&RawValue>) -> Result<String, RpcError> {
    raw.map(js_string).unwrap_or_else(|| Ok("undefined".into()))
}
fn js_space(c: char) -> bool {
    matches!(c as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn number(raw: Option<&RawValue>) -> Result<f64, RpcError> {
    let Some(raw) = raw else {
        return Ok(f64::NAN);
    };
    match raw.get() {
        "null" | "false" => return Ok(0.0),
        "true" => return Ok(1.0),
        _ => {}
    }
    if raw.get().starts_with('{') {
        if fields(raw)?.contains_key("toString") {
            return Err(invalid());
        }
        return Ok(f64::NAN);
    }
    let value = js_string(raw)?;
    let value = value.trim_matches(js_space);
    if value.is_empty() {
        return Ok(0.0);
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0b", "0B"], 2), (["0o", "0O"], 8)] {
        if let Some(digits) = prefixes.iter().find_map(|p| value.strip_prefix(p)) {
            if digits.is_empty() {
                return Ok(f64::NAN);
            }
            let mut n = 0.0;
            for c in digits.chars() {
                let Some(digit) = c.to_digit(radix) else {
                    return Ok(f64::NAN);
                };
                n = n * f64::from(radix) + f64::from(digit);
            }
            return Ok(n);
        }
    }
    if matches!(value, "Infinity" | "+Infinity" | "-Infinity") {
        return Ok(value.parse().unwrap_or(f64::NAN));
    }
    static DECIMAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let decimal = DECIMAL.get_or_init(|| {
        regex::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
            .expect("fixed JS decimal syntax")
    });
    Ok(if decimal.is_match(value) {
        value.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    })
}
fn truthy(raw: &RawValue) -> bool {
    match raw.get() {
        "null" | "false" => false,
        "true" => true,
        s if s.starts_with('"') => string(Some(raw)).is_some_and(|s| !s.is_empty()),
        s if s.starts_with(['[', '{']) => true,
        s => s.parse::<f64>().is_ok_and(|v| v != 0.0 && !v.is_nan()),
    }
}
fn get<'a>(fields: &'a Fields, key: &str) -> Option<&'a RawValue> {
    fields.get(key)
}
fn round(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    let floor = n.floor();
    if n - floor < 0.5 { floor } else { floor + 1.0 }
}
fn context(raw: Option<&RawValue>) -> Option<String> {
    let fields = object(raw)?;
    let at = string(get(&fields, "at"))?;
    if at.is_empty() {
        return None;
    }
    let positive = |key| {
        numeric(get(&fields, key))
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(round)
    };
    let used = positive("used")?;
    let window = positive("window").filter(|n| *n > 0.0);
    let (n, suffix) = window
        .map(|w| (round(used / w * 100.0), "%"))
        .unwrap_or((round(used / 1000.0), "k"));
    Some(format!("ctx {}{suffix}", ryu_js::Buffer::new().format(n)))
}
fn unread(fields: &Fields) -> bool {
    if get(fields, "markedUnread").is_some_and(|v| v.get() == "true") {
        return true;
    }
    let Some(attention) = object(get(fields, "attention")) else {
        return false;
    };
    let Some(id) = numeric(get(&attention, "id"))
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
    else {
        return false;
    };
    if !string(get(&attention, "kind")).is_some_and(|s| {
        matches!(
            s.as_str(),
            "done" | "failed" | "ask" | "limit" | "blocked" | "stalled"
        )
    }) {
        return false;
    }
    id > numeric(get(fields, "lastSeenEventId")).unwrap_or(0.0)
}
fn push(out: &mut String, value: &str) -> Result<(), RpcError> {
    if out.len().saturating_add(value.len()) > pult_core::MAX_LINE {
        return Err(capacity());
    }
    out.push_str(value);
    Ok(())
}
fn padded(value: String, width: usize) -> String {
    let missing = width.saturating_sub(value.encode_utf16().count());
    format!("{value}{}", " ".repeat(missing))
}
fn list(raw: &RawValue, ru: bool) -> Result<String, RpcError> {
    let result_fields = fields(raw)?;
    let sessions: Vec<Box<RawValue>> =
        serde_json::from_str(get(&result_fields, "sessions").ok_or_else(invalid)?.get())
            .map_err(|_| invalid())?;
    if sessions.is_empty() {
        return Ok(if ru {
            "агентов нет\n"
        } else {
            "No agents\n"
        }
        .into());
    }
    let mut out = String::new();
    for session in sessions {
        let row = fields(&session)?;
        let column = |key| display(get(&row, key));
        push(
            &mut out,
            &format!(
                "{} {} {} {} {}",
                padded(column("name")?, 16),
                if unread(&row) { '●' } else { '·' },
                padded(column("provider")?, 7),
                padded(column("lastStatus")?, 19),
                column("mode")?
            ),
        )?;
        if let Some(approval) = string(get(&row, "approval"))
            .filter(|s| matches!(s.as_str(), "read-only" | "workspace" | "full" | "inherit"))
        {
            push(&mut out, &format!(" · {approval}"))?;
        }
        if let Some(context) = context(get(&row, "context")) {
            push(&mut out, &format!(" · {context}"))?;
        }
        if number(get(&row, "pendingPermissions"))? > 0.0 {
            push(
                &mut out,
                &format!(
                    " · {}: {}",
                    if ru {
                        "ждёт решения"
                    } else {
                        "awaiting approval"
                    },
                    column("pendingPermissions")?
                ),
            )?;
        }
        if let Some(worktree) = get(&row, "worktree").filter(|v| truthy(v)) {
            let wt = object(Some(worktree)).unwrap_or_default();
            push(
                &mut out,
                &format!(
                    " · worktree {} ({})",
                    display(get(&wt, "path"))?,
                    display(get(&wt, "branch"))?
                ),
            )?;
        }
        if let Some(title) = string(get(&row, "title")) {
            push(&mut out, &format!(" · «{title}»"))?;
        }
        push(&mut out, "\n")?;
    }
    Ok(out)
}
impl Command {
    fn rpc(&self) -> (&'static str, Value) {
        match self {
            Self::List => ("agent.list", json!({})),
            Self::Stop { name, turn_id } => {
                let mut params = json!({"name":name});
                if let Some(id) = turn_id {
                    params["turnId"] = json!(id);
                }
                ("agent.stop", params)
            }
            Self::Rename { name, title } => ("agent.rename", json!({"name":name,"title":title})),
            Self::Archive { name, archived } => {
                ("agent.archive", json!({"name":name,"archived":archived}))
            }
            Self::Seen { name, unread } => ("agent.seen", json!({"name":name,"unread":unread})),
        }
    }
    fn render(&self, raw: &RawValue, locale: &str, json: bool) -> Result<String, RpcError> {
        if matches!(
            self,
            Self::Stop {
                turn_id: Some(_),
                ..
            }
        ) {
            return Ok(format!("{}\n", raw.get()));
        }
        if json {
            return Ok(if matches!(self, Self::Stop { .. }) {
                "{\"stopped\":true}\n".into()
            } else {
                format!("{}\n", raw.get())
            });
        }
        let ru = locale == "ru";
        let line = match self {
            Self::List => return list(raw, ru),
            Self::Stop { name, .. } => {
                if ru {
                    format!("агент {name} остановлен")
                } else {
                    format!("Agent {name} stopped")
                }
            }
            Self::Rename { name, .. } => {
                let fields = fields(raw)?;
                if let Some(title) = get(&fields, "title") {
                    let title = js_string(title)?;
                    if ru {
                        format!("агент {name} теперь «{title}»")
                    } else {
                        format!("Agent {name} is now “{title}”")
                    }
                } else if ru {
                    format!("агент {name}: название снято")
                } else {
                    format!("Agent {name}: title removed")
                }
            }
            Self::Archive {
                name,
                archived: true,
            } => {
                if ru {
                    format!("сессия {name} в архиве (реплика вернёт её)")
                } else {
                    format!("Session {name} archived (a message restores it)")
                }
            }
            Self::Archive {
                name,
                archived: false,
            } => {
                if ru {
                    format!("сессия {name} возвращена из архива")
                } else {
                    format!("Session {name} restored from archive")
                }
            }
            Self::Seen { name, unread: true } => {
                if ru {
                    format!("сессия {name} помечена непрочитанной")
                } else {
                    format!("Session {name} marked unread")
                }
            }
            Self::Seen {
                name,
                unread: false,
            } => {
                if ru {
                    format!("сессия {name} прочитана")
                } else {
                    format!("Session {name} marked read")
                }
            }
        };
        let mut out = String::new();
        push(&mut out, &line)?;
        push(&mut out, "\n")?;
        Ok(out)
    }
}
fn exit(code: &str) -> i32 {
    match code {
        "timeout" => 2,
        "blocked_network" => 4,
        "provider_unavailable" | "limited" => 5,
        _ => 1,
    }
}
async fn exchange(home: &Path, command: &Command, json: bool) -> Result<String, RpcError> {
    let mut client = OwnerClient::connect(home).await?;
    let (method, params) = command.rpc();
    let raw = client
        .request(method, params, ResponsePolicy::Ordinary)
        .await?;
    command.render(&raw, client.locale, json)
}
pub(super) async fn run(home: &Path, command: Command, json: bool) -> i32 {
    // Presence check precedes every owner home/config/token/socket operation.
    if [
        "PULT_MEMORY_KEY",
        "PULT_MEMORY_TURN_KEY",
        "PULT_ASK_KEY",
        "PULT_RUNTIME_KEY",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some())
    {
        let _ = cli_client::emit(
            "pult agent: forbidden — agent commands require owner authentication\n".into(),
            true,
        )
        .await;
        return 1;
    }
    let Ok(mut interrupt) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
    else {
        return 1;
    };
    let result = tokio::select! { biased; _=interrupt.recv()=>return 130, result=exchange(home,&command,json)=>result };
    let (text, stderr, code) = match result {
        Ok(text) => (text, false, 0),
        Err(error) => (
            format!("pult agent: {} — {}\n", error.code, error.message),
            true,
            exit(&error.code),
        ),
    };
    tokio::select! { biased; _=interrupt.recv()=>130, result=cli_client::emit(text,stderr)=>if result.is_ok(){code}else{1} }
}
