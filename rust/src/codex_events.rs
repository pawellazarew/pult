//! Pure, turn-scoped Codex notification normalization. Ownership is supplied by
//! the host, never inferred from JSON. No spawn, journal IO or approval decisions.
//!
//! Source: codex/mapper.ts ordinary items/context; adapter.ts applySignal and
//! finishOuter per-attempt outcomes. Final status.changed belongs exclusively
//! to the Driver after cleanup, so this module emits no status drafts.
//! Session confirmation, subagent routing,
//! account limits, image capture and capacity/network retry policy remain host
//! responsibilities. Unknown methods are ignored; generic tool items use Node's
//! bounded fallback. All exported content crosses an injected redaction boundary;
//! this module does not claim that an arbitrary redactor makes secrets safe.
//! The host must install crate::panic_guard at startup: catch_unwind cannot
//! prevent the default panic hook from printing a callback panic payload first.
use crate::turn_coordinator::Ticket;
use crate::turn_snapshot::SessionKey;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::io::{self, Write};
const JS_MAX: u64 = 9_007_199_254_740_991;
const ID_BYTES: usize = 512;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Capacity,
    Redaction,
}
#[derive(Clone, Copy, Debug)]
pub struct RedactionError;
/// Mandatory, fallible boundary. Must preserve the shape of the object and
/// string fields it receives. Stateful redaction is permitted; no implicit
/// identity implementation or fallback to raw content exists.
pub trait Redactor: Send {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError>;
}
pub struct Binding {
    pub session: SessionKey,
    pub ticket: Ticket,
    pub generation: u64,
    pub thread_id: String,
    pub provider_turn_id: String,
    pub public_turn_id: String,
    pub model: Option<String>,
    /// Trusted monotonic time, only used for durationMs. Journal assigns ts.
    pub started_ms: u64,
}
pub struct TrustedCallback {
    pub generation: u64,
    pub ticket: Ticket,
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub completed: usize,
    pub tools: usize,
    pub text_bytes: usize,
    pub event_bytes: usize,
    pub input_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            completed: 1024,
            tools: 256,
            text_bytes: 512 * 1024,
            event_bytes: 768 * 1024,
            input_bytes: 16 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub enum Kind {
    #[serde(rename = "message.delta")]
    MessageDelta,
    #[serde(rename = "message.done")]
    MessageDone,
    #[serde(rename = "tool.called")]
    ToolCalled,
    #[serde(rename = "tool.finished")]
    ToolFinished,
    #[serde(rename = "context.updated")]
    ContextUpdated,
    #[serde(rename = "usage.updated")]
    UsageUpdated,
    #[serde(rename = "limit.hit")]
    LimitHit,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub session_id: String,
    pub provider: &'static str,
    pub kind: Kind,
    pub data: Value,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub enum OutcomeCode {
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "internal")]
    Internal,
    #[serde(rename = "provider_unavailable")]
    ProviderUnavailable,
    #[serde(rename = "limited")]
    Limited,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    pub turn_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<OutcomeCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
pub enum Live {
    Active,
    Thinking,
    Reasoning(String),
    Output,
}
pub enum Signal {
    Retry {
        message: String,
        details: Option<String>,
    },
    Warning(String),
    Capacity(String),
}
#[derive(Default)]
pub struct Batch {
    pub drafts: Vec<Draft>,
    pub live: Vec<Live>,
    pub signals: Vec<Signal>,
    pub terminal: Option<TurnOutcome>,
    /// Host must cancel this owned turn. A fault always has one static terminal
    /// failure; redaction failure never returns partially redacted drafts.
    pub fault: Option<Error>,
    pub ignored: bool,
}
#[derive(Default)]
struct Tokens {
    input: f64,
    output: f64,
    cached: f64,
}
pub struct Normalizer {
    binding: Binding,
    limits: Limits,
    redactor: Box<dyn Redactor>,
    settled: bool,
    completed: HashSet<String>,
    tools: HashSet<String>,
    text: String,
    tokens: Tokens,
    window: Option<f64>,
    context: Option<(f64, Option<f64>)>,
    replay_safe: bool,
    capacity_error: Option<String>,
}
struct Budget(usize);
impl Write for Budget {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() > self.0 {
            return Err(io::Error::other("budget exceeded"));
        }
        self.0 -= data.len();
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn fits(value: &Value, limit: usize) -> bool {
    serde_json::to_writer(Budget(limit), value).is_ok()
}
fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}
fn jsnum(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= JS_MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}
fn optional_num(value: Option<f64>) -> Value {
    value.map(jsnum).unwrap_or(Value::Null)
}
fn info_name(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_object().and_then(|o| o.keys().next().cloned()))
}
fn short_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= ID_BYTES && !value.chars().any(char::is_control)
}
impl Normalizer {
    pub fn new(
        binding: Binding,
        limits: Limits,
        redactor: Box<dyn Redactor>,
    ) -> Result<Self, Error> {
        if binding.session.validate().is_err()
            || binding.ticket.session() != &binding.session
            || binding.generation == 0
            || ![
                &binding.thread_id,
                &binding.provider_turn_id,
                &binding.public_turn_id,
            ]
            .into_iter()
            .all(|s| short_id(s))
            || binding.model.as_ref().is_some_and(|s| s.len() > 256)
            || binding.started_ms > JS_MAX
            || limits.completed == 0
            || limits.completed > 4096
            || limits.tools == 0
            || limits.tools > 1024
            || limits.text_bytes == 0
            || limits.text_bytes > 4 * 1024 * 1024
            || limits.event_bytes == 0
            || limits.event_bytes > 1024 * 1024 - 4096
            || limits.input_bytes == 0
            || limits.input_bytes > 16 * 1024 * 1024
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            binding,
            limits,
            redactor,
            settled: false,
            completed: HashSet::new(),
            tools: HashSet::new(),
            text: String::new(),
            tokens: Tokens::default(),
            window: None,
            context: None,
            replay_safe: true,
            capacity_error: None,
        })
    }
    pub fn push(
        &mut self,
        callback: &TrustedCallback,
        method: &str,
        params: &Value,
        now_ms: u64,
    ) -> Batch {
        if self.settled
            || callback.generation != self.binding.generation
            || callback.ticket != self.binding.ticket
            || params.get("threadId").and_then(Value::as_str)
                != Some(self.binding.thread_id.as_str())
        {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        }
        let known = matches!(
            method,
            "turn/started"
                | "turn/completed"
                | "item/agentMessage/delta"
                | "item/started"
                | "item/completed"
                | "thread/tokenUsage/updated"
                | "model/rerouted"
                | "error"
                | "warning"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/summaryPartAdded"
                | "item/commandExecution/outputDelta"
        );
        if !known {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        }
        let turn = if matches!(method, "turn/started" | "turn/completed") {
            params
                .get("turn")
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
        } else {
            params.get("turnId").and_then(Value::as_str)
        };
        // Thread-only warnings are advisory, never a turn transition.
        if turn != Some(self.binding.provider_turn_id.as_str())
            && !(method == "warning" && turn.is_none())
        {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        }
        if now_ms < self.binding.started_ms || now_ms > JS_MAX {
            return self.fault(Error::Invalid);
        }
        if !fits(params, self.limits.input_bytes) {
            return self.fault(Error::Capacity);
        }
        let mut batch = Batch::default();
        match self.apply(method, params, now_ms, &mut batch) {
            Ok(()) => batch,
            Err(error) => self.fault(error),
        }
    }
    fn safe(&mut self, value: &Value) -> Result<Value, Error> {
        let safe =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.redactor.redact(value)))
                .map_err(|_| Error::Redaction)?
                .map_err(|_| Error::Redaction)?;
        if !safe.is_object() {
            return Err(Error::Redaction);
        }
        if !fits(&safe, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        Ok(safe)
    }
    fn safe_text(&mut self, text: &str) -> Result<String, Error> {
        let safe = self.safe(&json!({"text":text}))?;
        string(&safe, "text").ok_or(Error::Redaction)
    }
    fn draft(&mut self, batch: &mut Batch, kind: Kind, data: Value) -> Result<Value, Error> {
        let mut data = self.safe(&data)?;
        // Node rejects the complete async form when redaction expands or
        // empties any label beyond its public field contract.
        if kind == Kind::MessageDone
            && data.get("questions").is_some()
            && questions(data.get("questions")).is_none()
        {
            data.as_object_mut()
                .expect("safe object")
                .remove("questions");
        }
        batch.drafts.push(Draft {
            session_id: self.binding.session.name.clone(),
            provider: "codex",
            kind,
            data: data.clone(),
        });
        Ok(data)
    }
    fn fault(&mut self, error: Error) -> Batch {
        self.settled = true;
        self.completed.clear();
        self.tools.clear();
        self.text.clear();
        self.capacity_error = None;
        Batch {
            fault: Some(error),
            terminal: Some(TurnOutcome {
                turn_id: self.binding.public_turn_id.clone(),
                ok: false,
                error_code: Some(OutcomeCode::Internal),
                message: Some(
                    match error {
                        Error::Redaction => "Codex event redaction failed",
                        Error::Capacity => "Codex event capacity exceeded",
                        Error::Invalid => "Codex event normalization failed",
                    }
                    .into(),
                ),
                text: None,
            }),
            ..Batch::default()
        }
    }
    fn complete_id(&mut self, id: &str) -> Result<(), Error> {
        if self.completed.len() >= self.limits.completed {
            return Err(Error::Capacity);
        }
        self.completed.insert(id.into());
        self.tools.remove(id);
        Ok(())
    }
    fn finish(
        &mut self,
        batch: &mut Batch,
        ok: bool,
        code: Option<OutcomeCode>,
        message: Option<String>,
        now: u64,
    ) -> Result<(), Error> {
        let message = message.map(|s| self.safe_text(&s)).transpose()?;
        self.draft(batch,Kind::UsageUpdated,json!({"source":"result","totalCostUsd":null,"durationMs":now-self.binding.started_ms,"usage":{"input_tokens":jsnum(self.tokens.input),"output_tokens":jsnum(self.tokens.output),"cache_read_input_tokens":jsnum(self.tokens.cached)}}))?;
        batch.terminal = Some(TurnOutcome {
            turn_id: self.binding.public_turn_id.clone(),
            ok,
            error_code: code,
            message,
            text: (!self.text.is_empty()).then(|| self.text.clone()),
        });
        self.settled = true;
        self.tools.clear();
        self.completed.clear();
        self.text.clear();
        self.capacity_error = None;
        Ok(())
    }
    fn apply(&mut self, method: &str, p: &Value, now: u64, out: &mut Batch) -> Result<(), Error> {
        match method {
            "turn/started" => out.live.push(Live::Active),
            "item/reasoning/summaryTextDelta" => {
                if let Some(text) = string(p, "delta").filter(|s| !s.is_empty()) {
                    out.live.push(Live::Reasoning(self.safe_text(&text)?));
                }
            }
            "item/reasoning/summaryPartAdded" => {
                if number(p, "summaryIndex") != Some(0.0) {
                    out.live.push(Live::Reasoning("\n\n".into()));
                }
            }
            "item/commandExecution/outputDelta" => out.live.push(Live::Output),
            "item/agentMessage/delta" => {
                let Some(text) = string(p, "delta") else {
                    out.ignored = true;
                    return Ok(());
                };
                let id = string(p, "itemId");
                if id.as_ref().is_some_and(|id| self.completed.contains(id)) {
                    out.ignored = true;
                    return Ok(());
                }
                if id.as_ref().is_some_and(|s| !short_id(s)) {
                    return Err(Error::Capacity);
                }
                self.draft(out, Kind::MessageDelta, json!({"text":text,"itemId":id}))?;
                self.replay_safe = false;
            }
            "item/started" | "item/completed" => self.item(p, method == "item/completed", out)?,
            "thread/tokenUsage/updated" => self.usage(p, out)?,
            "model/rerouted" => {
                if let Some(model) = string(p, "toModel") {
                    if model.len() > 256 {
                        return Err(Error::Capacity);
                    }
                    if self.binding.model.as_ref() != Some(&model) {
                        self.binding.model = Some(model);
                        self.window = None;
                    }
                }
            }
            "warning" => {
                if let Some(text) = string(p, "message") {
                    out.signals.push(Signal::Warning(self.safe_text(&text)?));
                }
            }
            "error" => self.provider_error(p, now, out)?,
            "turn/completed" => {
                let turn = &p["turn"];
                let status = turn["status"].as_str().unwrap_or("unknown");
                let message = string(&turn["error"], "message");
                let info = info_name(&turn["error"]["codexErrorInfo"]);
                match status {
                    "completed" => self.finish(out, true, None, None, now)?,
                    "interrupted" => {
                        let reason = message
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "агент остановлен".into());
                        self.finish(
                            out,
                            false,
                            Some(OutcomeCode::Interrupted),
                            Some(format!(
                                "ход {} прерван: {reason}",
                                self.binding.public_turn_id
                            )),
                            now,
                        )?;
                    }
                    _ => {
                        let message = message
                            .filter(|s| !s.is_empty())
                            .or_else(|| self.capacity_error.clone())
                            .unwrap_or_else(|| format!("ход завершился со статусом {status}"));
                        self.finish(
                            out,
                            false,
                            Some(if info.as_deref() == Some("unauthorized") {
                                OutcomeCode::ProviderUnavailable
                            } else {
                                OutcomeCode::Internal
                            }),
                            Some(message),
                            now,
                        )?;
                    }
                }
            }
            _ => out.ignored = true,
        }
        Ok(())
    }
    fn item(&mut self, p: &Value, done: bool, out: &mut Batch) -> Result<(), Error> {
        let Some(item) = p.get("item").filter(|v| v.is_object()) else {
            out.ignored = true;
            return Ok(());
        };
        let kind = item["type"].as_str().unwrap_or("?");
        if kind == "reasoning" && !done {
            out.live.push(Live::Thinking);
        }
        if matches!(
            kind,
            "userMessage" | "hookPrompt" | "reasoning" | "plan" | "subAgentActivity"
        ) {
            out.ignored = out.live.is_empty();
            return Ok(());
        }
        let Some(id) = string(item, "id") else {
            out.ignored = true;
            return Ok(());
        };
        if !short_id(&id) || kind.len() > ID_BYTES {
            return Err(Error::Capacity);
        }
        if self.completed.contains(&id) {
            out.ignored = true;
            return Ok(());
        }
        if kind == "agentMessage" {
            if !done {
                out.ignored = true;
                return Ok(());
            }
            self.complete_id(&id)?;
            let mut data = json!({"text":item["text"].as_str().unwrap_or(""),"itemId":id});
            if let Some(phase) = string(item, "phase").filter(|s| !s.is_empty()) {
                data["phase"] = json!(phase);
            }
            if let Some(questions) = questions(item.get("questions")) {
                data["questions"] = questions;
            }
            let safe = self.draft(out, Kind::MessageDone, data)?;
            let text = safe["text"].as_str().ok_or(Error::Redaction)?;
            if !text.is_empty() {
                let separator = usize::from(!self.text.is_empty());
                if self
                    .text
                    .len()
                    .checked_add(separator)
                    .and_then(|n| n.checked_add(text.len()))
                    .is_none_or(|n| n > self.limits.text_bytes)
                {
                    return Err(Error::Capacity);
                }
                if separator > 0 {
                    self.text.push('\n');
                }
                self.text.push_str(text);
            }
            self.replay_safe = false;
            return Ok(());
        }
        if !done && self.tools.contains(&id) {
            out.ignored = true;
            return Ok(());
        }
        if done {
            self.complete_id(&id)?;
        } else {
            if self.tools.len() >= self.limits.tools {
                return Err(Error::Capacity);
            }
            self.tools.insert(id.clone());
        }
        let status = item.get("status").and_then(Value::as_str);
        let mut data = json!({"toolUseId":id,"name":kind});
        if kind == "commandExecution" {
            if done {
                data["isError"] = json!(status != Some("completed"));
                data["status"] = json!(status);
                data["exitCode"] = optional_num(number(item, "exitCode"));
            } else {
                data["input"] = selected(item, &["command", "cwd"]);
            }
        } else if kind == "collabAgentToolCall" {
            data["name"] = json!(item["tool"].as_str().unwrap_or("collabAgentTool"));
            if done {
                data["isError"] = json!(status == Some("failed"));
                data["status"] = json!(status);
            } else {
                data["input"] = selected(item, &["senderThreadId", "receiverThreadIds", "prompt"]);
            }
        } else if kind == "mcpToolCall" {
            data["name"] = json!(format!(
                "mcp__{}__{}",
                item["server"].as_str().unwrap_or("mcp"),
                item["tool"].as_str().unwrap_or("tool")
            ));
            if done {
                let error = item.get("error").filter(|v| v.is_object());
                data["isError"] = json!(status == Some("failed") || error.is_some());
                data["status"] = json!(status);
                if let Some(content) = item
                    .get("result")
                    .filter(|v| v.is_object())
                    .and_then(|v| v.get("content"))
                {
                    data["content"] = strip_blobs(content, 0)?;
                }
                if let Some(error) = error {
                    data["content"] = json!(error["message"].as_str().unwrap_or("ошибка"));
                }
            } else {
                data["input"] = item
                    .get("arguments")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
            }
        } else if done {
            if kind != "imageView" {
                data["isError"] = json!(status == Some("failed"));
                data["status"] = json!(status);
            }
        } else {
            data["input"] = json!({});
        }
        self.draft(
            out,
            if done {
                Kind::ToolFinished
            } else {
                Kind::ToolCalled
            },
            data,
        )?;
        self.replay_safe = false;
        Ok(())
    }
    fn usage(&mut self, p: &Value, out: &mut Batch) -> Result<(), Error> {
        let usage = &p["tokenUsage"];
        let Some(last) = usage.get("last").filter(|v| v.is_object()) else {
            out.ignored = true;
            return Ok(());
        };
        self.tokens.input += number(last, "inputTokens").unwrap_or(0.0);
        self.tokens.output += number(last, "outputTokens").unwrap_or(0.0);
        self.tokens.cached += number(last, "cachedInputTokens").unwrap_or(0.0);
        if ![self.tokens.input, self.tokens.output, self.tokens.cached]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(Error::Capacity);
        }
        let Some(total) = number(last, "totalTokens") else {
            return Ok(());
        };
        let used = total - number(last, "reasoningOutputTokens").unwrap_or(0.0);
        if !used.is_finite() {
            return Err(Error::Capacity);
        }
        if used <= 0.0 {
            return Ok(());
        }
        if let Some(window) = number(usage, "modelContextWindow").filter(|n| *n > 0.0) {
            self.window = Some(window);
        }
        if self.context == Some((used, self.window)) {
            return Ok(());
        }
        self.context = Some((used, self.window));
        self.draft(out,Kind::ContextUpdated,json!({"used":jsnum(used),"window":optional_num(self.window),"model":self.binding.model}))?;
        Ok(())
    }
    fn provider_error(&mut self, p: &Value, now: u64, out: &mut Batch) -> Result<(), Error> {
        let err = &p["error"];
        let message = string(err, "message").unwrap_or_default();
        let info = info_name(&err["codexErrorInfo"]);
        if matches!(
            info.as_deref(),
            Some("usageLimitExceeded" | "rateLimitExceeded")
        ) || message.to_lowercase().contains("hit your usage limit")
        {
            let info = info.unwrap_or_else(|| "usageLimitText".into());
            self.draft(
                out,
                Kind::LimitHit,
                json!({"source":"limit","reason":info,"message":message}),
            )?;
            return self.finish(out, false, Some(OutcomeCode::Limited), Some(message), now);
        }
        if p["willRetry"] == true {
            out.signals.push(Signal::Retry {
                message: self.safe_text(&message)?,
                details: string(err, "additionalDetails")
                    .map(|s| self.safe_text(&s))
                    .transpose()?,
            });
            return Ok(());
        }
        if self.replay_safe
            && regex::Regex::new(
                r"(?i)(?:selected model is at capacity|model[^\n]{0,60}(?:at capacity|overloaded))",
            )
            .map_err(|_| Error::Invalid)?
            .is_match(&message)
        {
            let safe = self.safe_text(&message)?;
            self.capacity_error = Some(safe.clone());
            out.signals.push(Signal::Capacity(safe));
            return Ok(());
        }
        self.finish(
            out,
            false,
            Some(if info.as_deref() == Some("unauthorized") {
                OutcomeCode::ProviderUnavailable
            } else {
                OutcomeCode::Internal
            }),
            Some(if message.is_empty() {
                "ход провален без текста".into()
            } else {
                message
            }),
            now,
        )
    }
}
fn selected(item: &Value, keys: &[&str]) -> Value {
    let mut map = Map::new();
    for key in keys {
        if let Some(value) = item.get(*key) {
            map.insert((*key).into(), value.clone());
        }
    }
    Value::Object(map)
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn questions(value: Option<&Value>) -> Option<Value> {
    let values = value?.as_array()?;
    if values.is_empty() || values.len() > 8 {
        return None;
    }
    let mut out = Vec::new();
    for value in values {
        let title = value.get("title")?.as_str()?;
        if title.trim_matches(js_space).is_empty() || title.encode_utf16().count() > 2000 {
            return None;
        }
        let options = match value.get("options") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Array(values)) => {
                if values.len() > 12 {
                    return None;
                }
                for value in values {
                    let text = value.as_str()?;
                    if text.trim_matches(js_space).is_empty() || text.encode_utf16().count() > 500 {
                        return None;
                    }
                }
                Value::Array(values.clone())
            }
            _ => return None,
        };
        out.push(json!({"title":title,"options":options}));
    }
    Some(Value::Array(out))
}
fn placeholder(chars: usize, what: &str) -> Value {
    json!(format!(
        "[{what}, {} КБ]",
        ((chars as f64 * 0.75 / 1024.0).round() as usize).max(1)
    ))
}
fn strip_blobs(value: &Value, depth: usize) -> Result<Value, Error> {
    if depth > 32 {
        return Err(Error::Capacity);
    }
    match value {
        Value::String(text) => {
            let lower = text.get(..11).unwrap_or(text).to_ascii_lowercase();
            if lower.starts_with("data:image/") && text.to_ascii_lowercase().contains(";base64,") {
                return Ok(placeholder(text.encode_utf16().count(), "изображение"));
            }
            if text.len() >= 16 * 1024
                && text
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/=\r\n".contains(&c))
            {
                return Ok(placeholder(text.len(), "данные"));
            }
            Ok(value.clone())
        }
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|v| strip_blobs(v, depth + 1))
                .collect::<Result<_, _>>()?,
        )),
        Value::Object(values) => {
            if values.get("type").and_then(Value::as_str) == Some("image")
                && let Some(data) = values.get("data").and_then(Value::as_str).or_else(|| {
                    values
                        .get("source")
                        .and_then(|v| v.get("data"))
                        .and_then(Value::as_str)
                })
            {
                return Ok(
                    json!({"type":"text","text":placeholder(data.encode_utf16().count(),"изображение")}),
                );
            }
            let mut out = Map::new();
            for (key, value) in values {
                out.insert(key.clone(), strip_blobs(value, depth + 1)?);
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}
