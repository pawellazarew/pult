//! Pure ordinary-turn Claude stream-json normalization. The host owns transport,
//! generation, session and input UUID; none are learned from untrusted frames.
//! Driver alone publishes final status after worker cleanup. No processes or IO.
//!
//! Subagent trees, background task lifetime, command-completion fallback, command
//! catalogs and image capture are explicitly deferred host responsibilities.
//! Deferred must be routed or cause owned retirement, never assumed full parity.
//! Retry/account-block/limit signals require host policy; only a current result
//! produces the ordinary terminal. Unknown safe noise is ignored like Node.
//! Typed Value loses raw modelUsage insertion order. Ambiguous prefix matches
//! with different windows return no window, rather than choosing an arbitrary
//! one; exact/single/equal matches remain supported. Ordered raw-frame parity
//! and cross-turn context carry belong to future process integration.
//! Install panic_guard before callbacks; catch_unwind does not silence the hook.
pub use crate::codex_events::{
    OutcomeCode, RedactionError, Redactor, TrustedCallback, TurnOutcome,
};
use crate::turn_coordinator::Ticket;
use crate::turn_snapshot::SessionKey;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{self, Write};
const ID_UNITS: usize = 512;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Capacity,
    Redaction,
}
/// Real production filter, preserving Node's field-sensitive treatment. Do not
/// redact known numeric usage keys with the secret-name regex (TOKEN matches).
pub struct LogRedactor;
impl Redactor for LogRedactor {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
        Ok(crate::redaction::redact(value))
    }
}
pub struct Binding {
    pub session: SessionKey,
    pub ticket: Ticket,
    pub generation: u64,
    pub provider_session_id: String,
    pub public_turn_id: String,
    pub user_message_uuid: String,
    /// Carried by the trusted process facade between turns; init isn't a new
    /// session when a warm process sends another init.
    pub session_started: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub tool_ids: usize,
    pub events: usize,
    pub text_units: usize,
    pub input_bytes: usize,
    pub event_bytes: usize,
    pub batch_bytes: usize,
    pub retry_ceiling: u32,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            tool_ids: 256,
            events: 128,
            text_units: 512 * 1024,
            input_bytes: 16 * 1024 * 1024,
            event_bytes: 768 * 1024,
            batch_bytes: 2 * 1024 * 1024,
            retry_ceiling: 3,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Kind {
    #[serde(rename = "session.started")]
    SessionStarted,
    #[serde(rename = "message.delta")]
    MessageDelta,
    #[serde(rename = "message.done")]
    MessageDone,
    #[serde(rename = "tool.called")]
    ToolCalled,
    #[serde(rename = "tool.finished")]
    ToolFinished,
    #[serde(rename = "usage.updated")]
    UsageUpdated,
    #[serde(rename = "context.updated")]
    ContextUpdated,
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
pub enum Live {
    Active,
    Request,
    Thinking,
    Reasoning(String),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Deferred {
    Subagent,
    Background,
    ForeignResult,
    CommandCatalog,
    CommandLifecycleFallback,
}
pub enum Signal {
    SessionConfirmed,
    Started { permission_mode: Option<String> },
    Command { state: Option<String> },
    RetryStorm { retries: u32, last_error: Value },
    ProviderBlocked { text: String },
    Limit { status: String },
    Deferred(Deferred),
}
#[derive(Default)]
pub struct Batch {
    pub drafts: Vec<Draft>,
    pub live: Vec<Live>,
    pub signals: Vec<Signal>,
    pub terminal: Option<TurnOutcome>,
    pub fault: Option<Error>,
    pub ignored: bool,
}
pub struct Normalizer {
    binding: Binding,
    limits: Limits,
    redactor: Box<dyn Redactor>,
    settled: bool,
    started: bool,
    retries: u32,
    tools: HashSet<String>,
    agents: HashSet<String>,
    acked: bool,
    pending_notices: usize,
    context_used: Option<f64>,
    context_window: Option<f64>,
    context_model: Option<String>,
    context_sent: Option<(f64, Option<f64>)>,
}
struct Budget(usize);
impl Write for Budget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::other("Claude event budget"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn fits<T: Serialize + ?Sized>(value: &T, bytes: usize) -> bool {
    serde_json::to_writer(Budget(bytes), value).is_ok()
}
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}
fn jsnum(value: Option<f64>) -> Value {
    value
        .filter(|n| n.is_finite())
        .map(|n| {
            serde_json::from_str(ryu_js::Buffer::new().format_finite(n)).unwrap_or(Value::Null)
        })
        .unwrap_or(Value::Null)
}
fn id_ok(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= ID_UNITS
        && !value.chars().any(char::is_control)
}
fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}
fn account_block(text: &str) -> bool {
    text.to_ascii_lowercase()
        .contains("disabled claude subscription access")
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
                &binding.provider_session_id,
                &binding.public_turn_id,
                &binding.user_message_uuid,
            ]
            .iter()
            .all(|s| id_ok(s))
            || limits.tool_ids == 0
            || limits.tool_ids > 1024
            || limits.events == 0
            || limits.events > 1024
            || limits.text_units == 0
            || limits.text_units > 4 * 1024 * 1024
            || limits.input_bytes == 0
            || limits.input_bytes > 16 * 1024 * 1024
            || limits.event_bytes == 0
            || limits.event_bytes > 1024 * 1024 - 4096
            || limits.batch_bytes == 0
            || limits.batch_bytes > 4 * 1024 * 1024
            || limits.retry_ceiling == 0
            || limits.retry_ceiling > 64
        {
            return Err(Error::Invalid);
        }
        let started = binding.session_started;
        Ok(Self {
            binding,
            limits,
            redactor,
            settled: false,
            started,
            retries: 0,
            tools: HashSet::new(),
            agents: HashSet::new(),
            acked: false,
            pending_notices: 0,
            context_used: None,
            context_window: None,
            context_model: None,
            context_sent: None,
        })
    }
    pub fn push(&mut self, callback: &TrustedCallback, event: &Value) -> Batch {
        if self.settled
            || callback.generation != self.binding.generation
            || callback.ticket != self.binding.ticket
            || event.get("session_id").and_then(Value::as_str)
                != Some(self.binding.provider_session_id.as_str())
        {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        }
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        };
        if !matches!(
            kind,
            "system"
                | "stream_event"
                | "assistant"
                | "user"
                | "rate_limit_event"
                | "result"
                | "command_lifecycle"
        ) {
            return Batch {
                ignored: true,
                ..Batch::default()
            };
        }
        if !fits(event, self.limits.input_bytes) {
            return self.fault(Error::Capacity);
        }
        if matches!(kind, "assistant" | "user" | "stream_event") {
            self.retries = 0;
        }
        match event.get("parent_tool_use_id") {
            Some(Value::String(parent)) if !parent.is_empty() => {
                return Batch {
                    signals: vec![Signal::Deferred(Deferred::Subagent)],
                    ..Batch::default()
                };
            }
            None | Some(Value::Null) | Some(Value::String(_)) => {}
            _ => return self.fault(Error::Invalid),
        }
        let mut batch = Batch::default();
        match self.apply(kind, event, &mut batch) {
            Ok(()) => {
                batch.ignored = batch.drafts.is_empty()
                    && batch.live.is_empty()
                    && batch.signals.is_empty()
                    && batch.terminal.is_none();
                batch
            }
            Err(error) => self.fault(error),
        }
    }
    fn safe_value(&mut self, value: &Value) -> Result<Value, Error> {
        let safe =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.redactor.redact(value)))
                .map_err(|_| Error::Redaction)?
                .map_err(|_| Error::Redaction)?;
        if std::mem::discriminant(value) != std::mem::discriminant(&safe) {
            return Err(Error::Redaction);
        }
        if !fits(&safe, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        Ok(safe)
    }
    fn safe_text(&mut self, value: &str) -> Result<String, Error> {
        let safe = self.safe_value(&Value::String(value.into()))?;
        let safe = safe.as_str().ok_or(Error::Redaction)?;
        if safe.encode_utf16().count() > self.limits.text_units {
            return Err(Error::Capacity);
        }
        Ok(safe.into())
    }
    fn optional_text(&mut self, value: Option<String>) -> Result<Value, Error> {
        value
            .map(|s| self.safe_text(&s).map(Value::String))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    fn draft(&self, out: &mut Batch, kind: Kind, data: Value) -> Result<(), Error> {
        if out.drafts.len() >= self.limits.events || !fits(&data, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        out.drafts.push(Draft {
            session_id: self.binding.session.name.clone(),
            provider: "claude",
            kind,
            data,
        });
        if !fits(&out.drafts, self.limits.batch_bytes) {
            return Err(Error::Capacity);
        }
        Ok(())
    }
    fn fault(&mut self, error: Error) -> Batch {
        self.settled = true;
        self.tools.clear();
        self.agents.clear();
        self.context_model = None;
        Batch {
            fault: Some(error),
            terminal: Some(TurnOutcome {
                turn_id: self.binding.public_turn_id.clone(),
                ok: false,
                error_code: Some(OutcomeCode::Internal),
                message: Some(
                    match error {
                        Error::Invalid => "Claude event normalization failed",
                        Error::Capacity => "Claude event capacity exceeded",
                        Error::Redaction => "Claude event redaction failed",
                    }
                    .into(),
                ),
                text: None,
            }),
            ..Batch::default()
        }
    }
    fn context(&mut self, out: &mut Batch) -> Result<(), Error> {
        let Some(used) = self.context_used else {
            return Ok(());
        };
        if self.context_sent == Some((used, self.context_window)) {
            return Ok(());
        }
        self.context_sent = Some((used, self.context_window));
        let model = self.optional_text(self.context_model.clone())?;
        self.draft(
            out,
            Kind::ContextUpdated,
            json!({"used":jsnum(Some(used)),"window":jsnum(self.context_window),"model":model}),
        )
    }
    fn apply(&mut self, kind: &str, event: &Value, out: &mut Batch) -> Result<(), Error> {
        match kind {
            "system" => match event["subtype"].as_str() {
                Some("init") => {
                    out.signals.push(Signal::SessionConfirmed);
                    out.signals.push(Signal::Started {
                        permission_mode: nonempty(text(event, "permissionMode"))
                            .map(|s| self.safe_text(&s))
                            .transpose()?,
                    });
                    out.live.push(Live::Active);
                    if event["slash_commands"].is_array() {
                        out.signals.push(Signal::Deferred(Deferred::CommandCatalog));
                    }
                    if !self.started {
                        self.started = true;
                        let model = self.optional_text(text(event, "model"))?;
                        let cwd = self.optional_text(text(event, "cwd"))?;
                        let servers = self.safe_value(
                            event
                                .get("mcp_servers")
                                .filter(|v| !v.is_null())
                                .unwrap_or(&json!([])),
                        )?;
                        let sid = self.safe_text(&self.binding.provider_session_id.clone())?;
                        self.draft(out,Kind::SessionStarted,json!({"providerSessionId":sid,"model":model,"cwd":cwd,"tools":event["tools"].as_array().map_or(0,Vec::len),"mcpServers":servers}))?;
                    }
                }
                Some("api_retry") => {
                    self.retries += 1;
                    if self.retries >= self.limits.retry_ceiling {
                        let last_error =
                            self.safe_value(event.get("error").unwrap_or(&Value::Null))?;
                        out.signals.push(Signal::RetryStorm {
                            retries: self.retries,
                            last_error,
                        });
                        self.retries = 0;
                    }
                }
                Some("task_notification") => {
                    self.pending_notices =
                        self.pending_notices.checked_add(1).ok_or(Error::Capacity)?;
                    out.signals.push(Signal::Deferred(Deferred::Background));
                }
                Some(
                    "background_tasks_changed" | "task_started" | "task_progress" | "task_updated",
                ) => out.signals.push(Signal::Deferred(Deferred::Background)),
                _ => {}
            },
            "stream_event" => {
                let inner = &event["event"];
                match inner["type"].as_str() {
                    Some("message_start") => out.live.push(Live::Request),
                    Some("content_block_start")
                        if matches!(
                            inner["content_block"]["type"].as_str(),
                            Some("thinking" | "redacted_thinking")
                        ) =>
                    {
                        out.live.push(Live::Thinking)
                    }
                    Some("content_block_delta") => {
                        if inner["delta"]["type"] == "thinking_delta" {
                            if let Some(thought) = nonempty(text(&inner["delta"], "thinking")) {
                                out.live.push(Live::Reasoning(self.safe_text(&thought)?));
                            }
                        } else if inner["delta"]["type"] == "text_delta"
                            && let Some(text) = text(&inner["delta"], "text")
                        {
                            let text = self.safe_text(&text)?;
                            self.draft(
                                out,
                                Kind::MessageDelta,
                                json!({"text":text,"index":jsnum(number(inner,"index"))}),
                            )?;
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => self.assistant(event, out)?,
            "user" => self.tool_results(event, out)?,
            "rate_limit_event" => self.limit(event, out)?,
            "result" => self.result(event, out)?,
            "command_lifecycle"
                if event["command_uuid"].as_str()
                    == Some(self.binding.user_message_uuid.as_str()) =>
            {
                self.acked = true;
                let state = self.optional_text(text(event, "state"))?;
                out.signals.push(Signal::Command {
                    state: state.as_str().map(str::to_owned),
                });
                if event["state"] == "completed" {
                    out.signals
                        .push(Signal::Deferred(Deferred::CommandLifecycleFallback));
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn assistant(&mut self, event: &Value, out: &mut Batch) -> Result<(), Error> {
        let msg = &event["message"];
        let model = text(msg, "model");
        let block_error = event.get("error").and_then(Value::as_str).is_some()
            || event["is_api_error_message"] == true;
        let blocks = msg["content"].as_array().map_or(&[][..], Vec::as_slice);
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => {
                    let raw = text(block, "text").unwrap_or_default();
                    let safe = self.safe_text(&raw)?;
                    if block_error && account_block(&raw) {
                        out.signals
                            .push(Signal::ProviderBlocked { text: safe.clone() });
                    }
                    let mut data = json!({"text":safe});
                    if let Some(model) = nonempty(model.clone()) {
                        data["model"] = json!(self.safe_text(&model)?);
                    }
                    if let Some(error) = nonempty(text(event, "error")) {
                        data["error"] = json!(self.safe_text(&error)?);
                    }
                    self.draft(out, Kind::MessageDone, data)?;
                }
                Some("tool_use") => {
                    let Some(id) = text(block, "id") else {
                        continue;
                    };
                    if !id_ok(&id) {
                        return Err(Error::Capacity);
                    }
                    if !self.tools.contains(&id) && self.tools.len() >= self.limits.tool_ids {
                        return Err(Error::Capacity);
                    }
                    self.tools.insert(id.clone());
                    let name = text(block, "name").unwrap_or_else(|| "tool".into());
                    if name == "Agent" || name == "Task" {
                        self.agents.insert(id);
                        if out.signals.len() >= self.limits.events {
                            return Err(Error::Capacity);
                        }
                        out.signals.push(Signal::Deferred(Deferred::Subagent));
                        continue;
                    }
                    let input = block
                        .get("input")
                        .filter(|v| v.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let input = self.safe_value(&input)?;
                    let name = self.safe_text(&name)?;
                    // Structural opaque IDs correlate tool calls/results; filtering
                    // them can alias distinct hex IDs into the same token marker.
                    self.draft(
                        out,
                        Kind::ToolCalled,
                        json!({"toolUseId":id,"name":name,"input":input}),
                    )?;
                }
                _ => {}
            }
        }
        if let Some(usage) = msg.get("usage").filter(|v| v.is_object()) {
            let used = number(usage, "input_tokens").unwrap_or(0.0)
                + number(usage, "cache_creation_input_tokens").unwrap_or(0.0)
                + number(usage, "cache_read_input_tokens").unwrap_or(0.0);
            if !used.is_finite() {
                return Err(Error::Capacity);
            }
            if used > 0.0 {
                if model.is_some() && self.context_model.is_some() && model != self.context_model {
                    self.context_window = None;
                }
                if let Some(model) = model {
                    if !id_ok(&model) {
                        return Err(Error::Capacity);
                    }
                    self.context_model = Some(model);
                }
                self.context_used = Some(used);
                self.context(out)?;
            }
        }
        Ok(())
    }
    fn tool_results(&mut self, event: &Value, out: &mut Batch) -> Result<(), Error> {
        let blocks = event["message"]["content"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        for block in blocks {
            if block["type"] != "tool_result" {
                continue;
            }
            let Some(id) = text(block, "tool_use_id") else {
                continue;
            };
            if !id_ok(&id) {
                return Err(Error::Capacity);
            }
            if self.agents.contains(&id) {
                if out.signals.len() >= self.limits.events {
                    return Err(Error::Capacity);
                }
                out.signals.push(Signal::Deferred(Deferred::Subagent));
                continue;
            }
            let mut data = json!({"toolUseId":id,"isError":block["is_error"]==true});
            if let Some(content) = block.get("content") {
                data["content"] = self.safe_value(&strip_blobs(content, 0)?)?;
            }
            self.draft(out, Kind::ToolFinished, data)?;
        }
        Ok(())
    }
    fn limit(&mut self, event: &Value, out: &mut Batch) -> Result<(), Error> {
        let Some(info) = event.get("rate_limit_info").filter(|v| v.is_object()) else {
            return Ok(());
        };
        let status = text(info, "status").unwrap_or_else(|| "unknown".into());
        let mut windows = json!({});
        for name in ["five_hour", "seven_day"] {
            let value = &info["unifiedWindows"][name];
            windows[name] = if value.is_object() {
                json!({"utilization":jsnum(number(value,"utilization")),"resetsAt":jsnum(number(value,"resetsAt"))})
            } else {
                Value::Null
            };
        }
        let safe_status = self.safe_text(&status)?;
        let limit_type = self.optional_text(text(info, "rateLimitType"))?;
        let data = json!({"source":"rate_limit_event","status":safe_status,"rateLimitType":limit_type,"resetsAt":jsnum(number(info,"resetsAt")),"isUsingOverage":info["isUsingOverage"]==true,"windows":windows});
        self.draft(out, Kind::UsageUpdated, data.clone())?;
        if status != "allowed" && status != "allowed_warning" {
            self.draft(out, Kind::LimitHit, data)?;
            out.signals.push(Signal::Limit {
                status: safe_status,
            });
        }
        Ok(())
    }
    fn result(&mut self, event: &Value, out: &mut Batch) -> Result<(), Error> {
        let tags = event.get("user_message_uuids").and_then(Value::as_array);
        let mine = tags.is_some_and(|a| {
            a.iter()
                .any(|v| v.as_str() == Some(self.binding.user_message_uuid.as_str()))
        });
        let reason = text(event, "terminal_reason");
        let ok = event["is_error"] != true
            && (reason.is_none() || reason.as_deref() == Some("completed"));
        let raw_text = text(event, "result");
        if !mine
            && (self.acked
                || tags.is_some()
                || (ok
                    && number(event, "num_turns") == Some(0.0)
                    && raw_text.as_deref().is_none_or(str::is_empty)
                    && self.pending_notices > 0))
        {
            self.pending_notices = 0;
            out.signals.push(Signal::Deferred(Deferred::ForeignResult));
            return Ok(());
        }
        let mut denials = vec![];
        if let Some(items) = event["permission_denials"].as_array() {
            // Count before invoking callbacks or expanding tiny input objects.
            // Denials share the bounded tool-ID cardinality policy.
            if items.len() > self.limits.tool_ids {
                return Err(Error::Capacity);
            }
            let mut remaining = self
                .limits
                .event_bytes
                .min(self.limits.batch_bytes)
                .checked_sub(2)
                .ok_or(Error::Capacity)?; // array brackets
            for item in items {
                let data = if item.is_object() {
                    let id = text(item, "tool_use_id");
                    if id.as_deref().is_some_and(|id| !id_ok(id)) {
                        return Err(Error::Capacity);
                    }
                    let mut data = json!({"toolName":self.optional_text(text(item,"tool_name"))?,"toolUseId":id});
                    if let Some(input) = item.get("tool_input") {
                        data["input"] = self.safe_value(input)?;
                    }
                    data
                } else {
                    json!({"toolName":null,"toolUseId":null,"input":null})
                };
                if !denials.is_empty() {
                    remaining = remaining.checked_sub(1).ok_or(Error::Capacity)?;
                }
                // Measure without allocating another encoded copy. Stop before
                // retaining another row, including callback-expanded values.
                let mut budget = Budget(remaining);
                serde_json::to_writer(&mut budget, &data).map_err(|_| Error::Capacity)?;
                remaining = budget.0;
                denials.push(data);
            }
        }
        let usage=event.get("usage").filter(|v|v.is_object()).map(|v|json!({"input_tokens":jsnum(number(v,"input_tokens")),"cache_creation_input_tokens":jsnum(number(v,"cache_creation_input_tokens")),"cache_read_input_tokens":jsnum(number(v,"cache_read_input_tokens")),"output_tokens":jsnum(number(v,"output_tokens"))})).unwrap_or(Value::Null);
        self.draft(out,Kind::UsageUpdated,json!({"source":"result","totalCostUsd":jsnum(number(event,"total_cost_usd")),"durationMs":jsnum(number(event,"duration_ms")),"numTurns":jsnum(number(event,"num_turns")),"permissionDenials":denials,"usage":usage}))?;
        if let Some(window) =
            window_from_usage(&event["modelUsage"], self.context_model.as_deref())?
        {
            self.context_window = Some(window);
            self.context(out)?;
        }
        if raw_text.as_deref().is_some_and(account_block)
            && (event["is_error"] == true || reason.as_deref() == Some("api_error"))
        {
            out.signals.push(Signal::ProviderBlocked {
                text: self.safe_text(raw_text.as_deref().unwrap())?,
            });
        }
        let fallback = if !ok {
            event["errors"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .filter(|v| !v.is_empty())
                .map(|v| v.join("; "))
        } else {
            None
        };
        let message = raw_text
            .or(fallback)
            .map(|s| self.safe_text(&s))
            .transpose()?;
        if number(&event["subagent_stats"], "started_in_background").is_some_and(|n| n > 0.0) {
            out.signals.push(Signal::Deferred(Deferred::Background));
        }
        let error_code = if ok {
            None
        } else if reason.as_deref() == Some("api_error") {
            Some(OutcomeCode::ProviderUnavailable)
        } else {
            Some(OutcomeCode::Internal)
        };
        let failure = if ok {
            None
        } else {
            Some(message.clone().unwrap_or_else(|| {
                format!(
                    "ход завершился ошибкой ({})",
                    reason.as_deref().unwrap_or("?")
                )
            }))
        };
        // terminal_reason is provider text too; redact any synthesized message.
        let failure = failure.map(|s| self.safe_text(&s)).transpose()?;
        out.terminal = Some(TurnOutcome {
            turn_id: self.binding.public_turn_id.clone(),
            ok,
            error_code,
            message: failure,
            text: message.filter(|s| !s.is_empty()),
        });
        self.settled = true;
        self.tools.clear();
        self.agents.clear();
        self.context_model = None;
        Ok(())
    }
}
fn window_from_usage(usage: &Value, model: Option<&str>) -> Result<Option<f64>, Error> {
    let Some(values) = usage.as_object() else {
        return Ok(None);
    };
    if values.len() > 128 {
        return Err(Error::Capacity);
    }
    let candidates = values
        .iter()
        .filter_map(|(key, value)| {
            number(value, "contextWindow")
                .filter(|n| *n > 0.0)
                .map(|n| (key.as_str(), n))
        })
        .collect::<Vec<_>>();
    if let Some(model) = model {
        if let Some((_, window)) = candidates.iter().find(|(key, _)| *key == model) {
            return Ok(Some(*window));
        }
        let mut prefixed = candidates.iter().filter(|(key, _)| key.starts_with(model));
        if let Some((_, window)) = prefixed.next() {
            return Ok(prefixed.all(|(_, next)| next == window).then_some(*window));
        }
    }
    Ok(if candidates.len() == 1 {
        Some(candidates[0].1)
    } else {
        None
    })
}
fn placeholder(text: &str, what: &str) -> Value {
    json!(format!(
        "[{what}, {} КБ]",
        ((text.encode_utf16().count() as f64 * 0.75 / 1024.0).round() as usize).max(1)
    ))
}
fn strip_blobs(value: &Value, depth: u8) -> Result<Value, Error> {
    if depth > 32 {
        return Err(Error::Capacity);
    }
    match value {
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            let data_url = lower
                .strip_prefix("data:image/")
                .and_then(|v| v.split_once(";base64,"))
                .is_some_and(|(mime, _)| !mime.is_empty() && !mime.contains([',', ';']));
            if data_url {
                Ok(placeholder(text, "изображение"))
            } else if text.len() >= 16 * 1024
                && text
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/=\r\n".contains(&c))
            {
                Ok(placeholder(text, "данные"))
            } else {
                Ok(value.clone())
            }
        }
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|v| strip_blobs(v, depth + 1))
                .collect::<Result<_, _>>()?,
        )),
        Value::Object(values) => {
            if value["type"] == "image"
                && let Some(data) = value["data"]
                    .as_str()
                    .or_else(|| value["source"]["data"].as_str())
            {
                return Ok(json!({"type":"text","text":placeholder(data,"изображение")}));
            }
            Ok(Value::Object(
                values
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), strip_blobs(v, depth + 1)?)))
                    .collect::<Result<_, Error>>()?,
            ))
        }
        _ => Ok(value.clone()),
    }
}
