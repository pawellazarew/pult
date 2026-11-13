//! Private CLI composition, not an advertisement of a qualified agent.wait backend.
use crate::cli_client::{self, OwnerClient, ResponsePolicy, RpcError};
use serde_json::{Value, json, value::RawValue};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

type Fields = HashMap<String, Box<RawValue>>;
pub struct Options {
    pub until: Option<String>,
    pub timeout: Option<String>,
    pub json: bool,
}
fn invalid() -> RpcError {
    RpcError::local("invalid_response", "invalid agent wait response")
}
fn fields(raw: &RawValue) -> Result<Fields, RpcError> {
    serde_json::from_str(raw.get()).map_err(|_| invalid())
}
fn js_space(ch: char) -> bool {
    matches!(ch as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn timeout_number(value: &str) -> f64 {
    let value = value.trim_start_matches(js_space);
    let sign = usize::from(value.starts_with(['+', '-']));
    let digits = value.as_bytes()[sign..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digits == 0 {
        return 600_000.0;
    }
    value[..sign + digits]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .unwrap_or(600_000.0)
}
fn params(name: &str, options: &Options) -> Value {
    let mut params = json!({"name":name});
    if let Some(until) = &options.until {
        let until: Vec<_> = until
            .split(',')
            .map(|s| s.trim_matches(js_space))
            .filter(|s| !s.is_empty())
            .collect();
        if !until.is_empty() {
            params["until"] = json!(until);
        }
    }
    if let Some(timeout) = &options.timeout {
        params["timeoutMs"] = json!(timeout_number(timeout));
    }
    params
}

/// Node's generic long-option parser treats `--timeout -5` as a bare timeout
/// plus an unused short flag. Explicit `--timeout=-5` passes the negative value.
/// Preserve that edge without relaxing Clap's handling of other unknown flags.
pub fn arguments(args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut args = args.into_iter().peekable();
    let mut out = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--" {
            out.push(arg);
            out.extend(args);
            break;
        }
        if arg == "--timeout"
            && args.peek().and_then(|a| a.to_str()).is_some_and(|s| {
                s.as_bytes().first() == Some(&b'-')
                    && s.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
            })
        {
            out.push(OsString::from("--timeout=600000"));
            args.next();
        } else {
            out.push(arg);
        }
    }
    out
}

fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => return at + 1,
            _ => at += 1,
        }
    }
    bytes.len()
}
fn object_end(bytes: &[u8], start: usize) -> usize {
    let mut at = start;
    let mut depth = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => at = string_end(bytes, at),
            b'{' | b'[' => {
                depth += 1;
                at += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                at += 1;
                if depth == 0 {
                    return at;
                }
            }
            _ => at += 1,
        }
    }
    bytes.len()
}
// Same iterative coercion as session_read, private here because its helper is
// crate-internal. RawValue preserves lone UTF-16 until terminal display decoding.
fn javascript_string(raw: &RawValue) -> Result<String, RpcError> {
    let text = raw.get();
    let bytes = text.as_bytes();
    let (mut at, mut arrays) = (0, 0);
    let mut out = String::new();
    while at < bytes.len() {
        match bytes[at] {
            b'[' => {
                arrays += 1;
                at += 1;
            }
            b']' => {
                arrays -= 1;
                at += 1;
            }
            b',' => {
                out.push(',');
                at += 1;
            }
            b'"' => {
                let end = string_end(bytes, at);
                let raw = RawValue::from_string(text[at..end].into()).map_err(|_| invalid())?;
                out.push_str(&pult_core::display_string(&raw).map_err(|_| invalid())?);
                at = end;
            }
            b'{' => {
                let end = object_end(bytes, at);
                let object: Fields = serde_json::from_str(&text[at..end]).map_err(|_| invalid())?;
                if object.contains_key("toString") {
                    return Err(invalid());
                }
                out.push_str("[object Object]");
                at = end;
            }
            b if b.is_ascii_whitespace() => at += 1,
            _ => {
                let start = at;
                while at < bytes.len() && !b",] \n\r\t".contains(&bytes[at]) {
                    at += 1;
                }
                let primitive = &text[start..at];
                match primitive {
                    "null" if arrays > 0 => {}
                    "null" | "true" | "false" => out.push_str(primitive),
                    _ => {
                        let number = primitive.parse::<f64>().map_err(|_| invalid())?;
                        out.push_str(ryu_js::Buffer::new().format(number));
                    }
                }
            }
        }
        if out.len() > pult_core::MAX_LINE {
            return Err(RpcError::local("capacity", "wait display exceeds limit"));
        }
    }
    Ok(out)
}
fn nullish<'a>(f: &'a Fields, key: &str) -> Option<&'a RawValue> {
    f.get(key).map(|v| &**v).filter(|v| v.get() != "null")
}
fn text(f: &Fields, key: &str, default: &str) -> Result<String, RpcError> {
    nullish(f, key)
        .map(javascript_string)
        .unwrap_or_else(|| Ok(default.into()))
}
fn string(f: &Fields, key: &str) -> Result<Option<String>, RpcError> {
    f.get(key)
        .filter(|v| v.get().starts_with('"'))
        .map(|v| pult_core::display_string(v).map_err(|_| invalid()))
        .transpose()
}
fn exit(code: Option<&str>) -> i32 {
    match code {
        Some("timeout") => 2,
        Some("blocked_network") => 4,
        Some("provider_unavailable" | "limited") => 5,
        _ => 1,
    }
}
async fn emit(mut text: String, stderr: bool) -> Result<(), RpcError> {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    cli_client::emit(text, stderr).await.map_err(Into::into)
}
async fn render(raw: &RawValue, locale: &str, json: bool) -> Result<i32, RpcError> {
    let f = fields(raw)?;
    if json {
        emit(raw.get().into(), false).await?;
    }
    let status = text(&f, "status", "?")?;
    if string(&f, "reason")?.as_deref() == Some("timeout") {
        if !json {
            emit(
                if locale == "ru" {
                    format!("таймаут: агент в состоянии {status}")
                } else {
                    format!("Timed out: agent status is {status}")
                },
                true,
            )
            .await?;
        }
        return Ok(2);
    }
    if matches!(status.as_str(), "blocked_permission" | "blocked_question") {
        if !json {
            emit(
                if locale == "ru" {
                    format!("ждёт человека: {status} — смотри pult perm list")
                } else {
                    format!("Waiting for you: {status} — see pult perm list")
                },
                true,
            )
            .await?;
        }
        return Ok(3);
    }
    let code = string(&f, "errorCode")?;
    if f.get("ok").is_some_and(|v| v.get() == "false") || code.is_some() {
        let why = nullish(&f, "message")
            .or_else(|| nullish(&f, "text"))
            .map(javascript_string)
            .transpose()?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if locale == "ru" {
                    "провайдер не объяснил причину"
                } else {
                    "Provider did not give a reason"
                }
                .into()
            });
        if !json {
            let label = text(&f, "errorCode", &status)?;
            emit(
                if locale == "ru" {
                    format!("ход не удался: {label} — {why}")
                } else {
                    format!("Turn failed: {label} — {why}")
                },
                true,
            )
            .await?;
        }
        return Ok(exit(code.as_deref()));
    }
    if !json {
        let text = text(&f, "text", "")?;
        if !text.is_empty() {
            emit(text, false).await?;
        }
    }
    Ok(0)
}
async fn exchange(
    home: &Path,
    name: &str,
    options: &Options,
    prompt: Option<Value>,
    follow: bool,
) -> Result<(Box<RawValue>, &'static str, Reply), RpcError> {
    let mut client = OwnerClient::connect(home).await?;
    if let Some(prompt) = prompt {
        let started = client
            .request("agent.prompt", prompt, ResponsePolicy::Ordinary)
            .await?;
        let f = fields(&started)?;
        if f.contains_key("queued") {
            return Ok((started, client.locale, Reply::Queued));
        }
        // A successful start must carry an actual nonempty string identity.
        // Node incidentally coerces malformed ACKs; never invent success here.
        prompt_turn(&f)?;
        if !follow {
            return Ok((started, client.locale, Reply::Started));
        }
    }
    let response = client
        .request("agent.wait", params(name, options), ResponsePolicy::Wait)
        .await?;
    Ok((response, client.locale, Reply::Wait))
}

enum Reply {
    Wait,
    Queued,
    Started,
}
fn prompt_turn(f: &Fields) -> Result<&RawValue, RpcError> {
    f.get("turnId")
        .map(|raw| &**raw)
        .filter(|raw| raw.get().starts_with('"') && raw.get() != "\"\"")
        .ok_or_else(|| RpcError::local("invalid_response", "invalid agent prompt response"))
}
async fn execute(
    home: &Path,
    name: &str,
    options: Options,
    prompt: Option<Value>,
    follow: bool,
) -> Result<i32, RpcError> {
    let (raw, locale, reply) = exchange(home, name, &options, prompt, follow).await?;
    // exchange has dropped its socket before formatting/output can block.
    if matches!(reply, Reply::Queued) {
        if options.json {
            emit(raw.get().into(), false).await?;
        } else {
            let f = fields(&raw)?;
            let id = f
                .get("id")
                .map(|v| javascript_string(v))
                .transpose()?
                .unwrap_or_else(|| "undefined".into());
            emit(
                if locale == "ru" {
                    format!("реплика в очереди ({id}): уйдёт, когда ход {name} кончится")
                } else {
                    format!("Message queued ({id}): will send when turn {name} ends")
                },
                false,
            )
            .await?;
        }
        Ok(0)
    } else if matches!(reply, Reply::Started) {
        let f = fields(&raw)?;
        let turn = prompt_turn(&f)?;
        if options.json {
            emit(
                format!("{{\"turnId\":{},\"waiting\":false}}", turn.get()),
                false,
            )
            .await?;
        } else {
            let turn = pult_core::display_string(turn).map_err(|_| invalid())?;
            emit(
                if locale == "ru" {
                    format!("ход {turn} запущен")
                } else {
                    format!("Turn {turn} started")
                },
                false,
            )
            .await?;
        }
        Ok(0)
    } else {
        render(&raw, locale, options.json).await
    }
}
pub async fn run(home: &Path, name: &str, options: Options, prompt: Option<Value>) -> i32 {
    run_inner(home, name, options, prompt, true).await
}
pub async fn run_prompt(
    home: &Path,
    name: &str,
    options: Options,
    prompt: Value,
    wait: bool,
) -> i32 {
    run_inner(home, name, options, Some(prompt), wait).await
}
async fn run_inner(
    home: &Path,
    name: &str,
    options: Options,
    prompt: Option<Value>,
    follow: bool,
) -> i32 {
    let mut interrupt =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
            Ok(signal) => signal,
            Err(_) => return 1,
        };
    let result = tokio::select! {
        _=interrupt.recv()=>return 130,
        result=execute(home,name,options,prompt,follow)=>result,
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            let code = exit(Some(&error.code));
            if emit(
                format!("pult agent: {} — {}", error.code, error.message),
                true,
            )
            .await
            .is_err()
            {
                return 1;
            }
            code
        }
    }
}
