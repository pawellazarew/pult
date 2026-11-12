//! Pure ZCode Route A normalization of native camelCase envelopes. Logical Pult
//! scope comes only from HostBinding and the owned fresh-process callback. Native
//! IDs are evidence candidates; only the host pins them. No process/IO/approval.
//! Result/turn-ended signals are candidates, not Driver final status. EOF/error
//! classification, process cleanup and durable native identity belong to host.
//! Install panic_guard before callbacks: catch_unwind cannot silence panic hooks.
pub use crate::claude_events::{Draft, Kind, LogRedactor};
pub use crate::codex_events::{RedactionError, Redactor, TrustedCallback};
use crate::{turn_coordinator::Ticket, turn_snapshot::SessionKey};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::io::{self, Write};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Capacity,
    Redaction,
}
/// Secret/private native metadata is deliberately not Debug/Serialize. A fresh
/// process can emit early frames before IDs are known; those frames keep their
/// host Pult scope. Receiving JSON never changes this binding.
pub struct HostBinding {
    session: SessionKey,
    ticket: Ticket,
    generation: u64,
    public_turn: String,
    native_session: Option<String>,
    native_turn: Option<String>,
}
impl HostBinding {
    pub fn new(
        session: SessionKey,
        ticket: Ticket,
        generation: u64,
        public_turn: String,
    ) -> Result<Self, Error> {
        if session.validate().is_err()
            || ticket.session() != &session
            || generation == 0
            || !id_ok(&public_turn)
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            session,
            ticket,
            generation,
            public_turn,
            native_session: None,
            native_turn: None,
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub text_units: usize,
    pub event_bytes: usize,
    pub batch_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 16 * 1024 * 1024,
            text_units: 512 * 1024,
            event_bytes: 768 * 1024,
            batch_bytes: 2 * 1024 * 1024,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(serialize_with = "serialize_num")]
    pub input_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub output_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub cache_read_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub cache_write_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub reasoning_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub total_tokens: Option<f64>,
    #[serde(serialize_with = "serialize_num")]
    pub model_request_count: Option<f64>,
}
#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum Signal {
    #[serde(rename = "session_id")]
    SessionId { id: String },
    #[serde(rename = "turn_started")]
    TurnStarted { model: Option<String> },
    #[serde(rename = "turn_ended")]
    TurnEnded {
        ok: bool,
        text: Option<String>,
        #[serde(rename = "resultType")]
        result_type: Option<String>,
    },
    #[serde(rename = "result")]
    Result {
        ok: bool,
        text: Option<String>,
        #[serde(rename = "resultType")]
        result_type: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: String,
        usage: Option<Usage>,
        #[serde(rename = "contextUsed", serialize_with = "serialize_num")]
        context_used: Option<f64>,
        #[serde(rename = "contextWindow", serialize_with = "serialize_num")]
        context_window: Option<f64>,
    },
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Live {
    Active,
    Request,
    Thinking,
    Reasoning { text: String },
    Output,
}
#[derive(Default, Serialize)]
pub struct Batch {
    pub drafts: Vec<Draft>,
    pub signals: Vec<Signal>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub live: Vec<Live>,
    #[serde(skip)]
    pub fault: Option<Error>,
    #[serde(skip)]
    pub ignored: bool,
}
pub struct Normalizer {
    binding: HostBinding,
    limits: Limits,
    redactor: Box<dyn Redactor>,
    model: Option<String>,
    started: bool,
    failed: bool,
}
struct Budget(usize);
impl Write for Budget {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if b.len() > self.0 {
            return Err(io::Error::other("ZCode budget"));
        }
        self.0 -= b.len();
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
// Bound semantic shape before recursive serde/callback work as well as wire
// bytes. Host Value input can be constructed without serde's decoder depth cap.
fn bounded_shape(value: &Value) -> bool {
    const NODES: usize = 131072;
    let mut stack = vec![(value, 0usize)];
    let mut visited = 0;
    while let Some((value, depth)) = stack.pop() {
        visited += 1;
        if depth > 128 || visited > NODES {
            return false;
        }
        match value {
            Value::Array(values) => {
                if values.len() > NODES - stack.len() {
                    return false;
                }
                stack.extend(values.iter().map(|v| (v, depth + 1)));
            }
            Value::Object(values) => {
                if values.len() > NODES - stack.len() {
                    return false;
                }
                stack.extend(values.values().map(|v| (v, depth + 1)));
            }
            _ => {}
        }
    }
    true
}
fn fits<T: Serialize + ?Sized>(v: &T, n: usize) -> bool {
    serde_json::to_writer(Budget(n), v).is_ok()
}
fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= 512 && !s.chars().any(char::is_control)
}
fn field_text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}
fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|v| v.is_finite())
}
fn jsnum(v: Option<f64>) -> Value {
    v.filter(|v| v.is_finite())
        .map(|v| {
            serde_json::from_str(ryu_js::Buffer::new().format_finite(v)).unwrap_or(Value::Null)
        })
        .unwrap_or(Value::Null)
}
fn serialize_num<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    jsnum(*v).serialize(s)
}
fn usage(v: &Value) -> Option<Usage> {
    v.as_object()?;
    Some(Usage {
        input_tokens: num(v, "inputTokens"),
        output_tokens: num(v, "outputTokens"),
        cache_read_tokens: num(v, "cacheReadTokens"),
        cache_write_tokens: num(v, "cacheWriteTokens"),
        reasoning_tokens: num(v, "reasoningTokens"),
        total_tokens: num(v, "totalTokens"),
        model_request_count: num(v, "modelRequestCount"),
    })
}
impl Normalizer {
    pub fn new(
        binding: HostBinding,
        limits: Limits,
        redactor: Box<dyn Redactor>,
    ) -> Result<Self, Error> {
        if limits.input_bytes == 0
            || limits.input_bytes > 16 * 1024 * 1024
            || limits.text_units == 0
            || limits.text_units > 4 * 1024 * 1024
            || limits.event_bytes == 0
            || limits.event_bytes > 1024 * 1024 - 4096
            || limits.batch_bytes == 0
            || limits.batch_bytes > 4 * 1024 * 1024
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            binding,
            limits,
            redactor,
            model: None,
            started: false,
            failed: false,
        })
    }
    /// Host-only monotonic pin after checking native evidence from this fresh
    /// process. Stale callback/conflicting pin is rejected without partial change.
    pub fn pin_native(
        &mut self,
        callback: &TrustedCallback,
        session: Option<&str>,
        turn: Option<&str>,
    ) -> Result<(), Error> {
        if !self.current(callback)
            || session.is_some_and(|s| {
                !id_ok(s)
                    || self
                        .binding
                        .native_session
                        .as_deref()
                        .is_some_and(|old| old != s)
            })
            || turn.is_some_and(|s| {
                !id_ok(s)
                    || self
                        .binding
                        .native_turn
                        .as_deref()
                        .is_some_and(|old| old != s)
            })
        {
            return Err(Error::Invalid);
        }
        if let Some(s) = session {
            self.binding.native_session = Some(s.into());
        }
        if let Some(s) = turn {
            self.binding.native_turn = Some(s.into());
        }
        Ok(())
    }
    fn current(&self, c: &TrustedCallback) -> bool {
        c.generation == self.binding.generation && c.ticket == self.binding.ticket
    }
    pub fn public_turn_id(&self) -> &str {
        &self.binding.public_turn
    }
    pub fn push(&mut self, c: &TrustedCallback, event: &Value) -> Batch {
        if self.failed
            || !self.current(c)
            || [
                (&self.binding.native_session, "sessionId"),
                (&self.binding.native_turn, "turnId"),
            ]
            .iter()
            .any(|(expected, key)| {
                expected.as_deref().is_some_and(|expected| {
                    event
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|actual| !actual.is_empty() && actual != expected)
                })
            })
        {
            return Batch {
                ignored: true,
                ..Default::default()
            };
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if !bounded_shape(event) || !fits(event, self.limits.input_bytes) {
                return Err(Error::Capacity);
            }
            let out = self.map(event)?;
            if !fits(&out, self.limits.batch_bytes) {
                return Err(Error::Capacity);
            }
            Ok(out)
        }))
        .unwrap_or(Err(Error::Redaction));
        match result {
            Ok(out) => out,
            Err(error) => {
                self.failed = true;
                Batch {
                    fault: Some(error),
                    ..Default::default()
                }
            }
        }
    }
    fn structural(&self, s: String) -> Result<String, Error> {
        if s.encode_utf16().count() > 512 {
            return Err(Error::Capacity);
        }
        Ok(s)
    }
    fn redacted(&mut self, v: &Value) -> Result<Value, Error> {
        if !bounded_shape(v) || !fits(v, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        let out = self.redactor.redact(v).map_err(|_| Error::Redaction)?;
        if !bounded_shape(&out) || !fits(&out, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        if out.is_object() != v.is_object()
            || out.is_string() != v.is_string()
            || out.is_array() != v.is_array()
        {
            return Err(Error::Redaction);
        }
        Ok(out)
    }
    fn safe_text(&mut self, s: String) -> Result<String, Error> {
        if s.encode_utf16().count() > self.limits.text_units {
            return Err(Error::Capacity);
        }
        let out = self.redacted(&Value::String(s))?;
        let out = out.as_str().ok_or(Error::Redaction)?;
        if out.encode_utf16().count() > self.limits.text_units {
            return Err(Error::Capacity);
        }
        Ok(out.into())
    }
    fn draft(&self, out: &mut Batch, kind: Kind, data: Value) -> Result<(), Error> {
        let draft = Draft {
            session_id: self.binding.session.name.clone(),
            provider: "zcode",
            kind,
            data,
        };
        if !fits(&draft, self.limits.event_bytes) {
            return Err(Error::Capacity);
        }
        out.drafts.push(draft);
        Ok(())
    }
    fn usage_draft(&self, out: &mut Batch, v: &Value) -> Result<(), Error> {
        if let Some(u) = usage(v) {
            let mut value = json!({"input_tokens":jsnum(u.input_tokens),"output_tokens":jsnum(u.output_tokens),"cache_read_input_tokens":jsnum(u.cache_read_tokens),"cache_creation_input_tokens":jsnum(u.cache_write_tokens),"reasoning_tokens":jsnum(u.reasoning_tokens)});
            if u.model_request_count.is_some() {
                value["modelRequestCount"] = jsnum(u.model_request_count);
            }
            self.draft(
                out,
                Kind::UsageUpdated,
                json!({"source":"result","usage":value}),
            )?;
        }
        Ok(())
    }
    fn map(&mut self, event: &Value) -> Result<Batch, Error> {
        let mut out = Batch::default();
        if !event.is_object() {
            out.ignored = true;
            return Ok(out);
        }
        let sid = field_text(event, "sessionId");
        if let Some(sid) = sid.as_ref().filter(|s| !s.is_empty()) {
            out.signals.push(Signal::SessionId {
                id: self.structural(sid.clone())?,
            });
        }
        let payload = &event["payload"];
        match event["type"].as_str() {
            Some("turn.started") => {
                let selection = payload
                    .get("intent")
                    .and_then(|v| v.get("modelSelection"))
                    .filter(|v| v.is_object())
                    .or_else(|| payload.get("modelSelection").filter(|v| v.is_object()));
                if let Some(m) = selection
                    .and_then(|v| field_text(v, "modelId"))
                    .filter(|m| !m.is_empty())
                {
                    self.model = Some(self.structural(m)?);
                }
                out.signals.push(Signal::TurnStarted {
                    model: self.model.clone(),
                });
                out.live.push(Live::Active);
                if !self.started {
                    self.started = true;
                    let mut data =
                        json!({"providerSessionId":sid,"cwd":null,"tools":null,"mcpServers":[]});
                    if let Some(model) = &self.model {
                        data["model"] = json!(model);
                    }
                    self.draft(&mut out, Kind::SessionStarted, data)?;
                }
            }
            Some("model.streaming") => match payload["kind"].as_str() {
                Some("start") => out.live.push(Live::Request),
                Some("reasoning_start") => out.live.push(Live::Thinking),
                Some("reasoning_delta") => {
                    if let Some(delta) = field_text(payload, "delta").filter(|s| !s.is_empty()) {
                        out.live.push(Live::Reasoning {
                            text: self.safe_text(delta)?,
                        });
                    }
                }
                Some("text_delta") => {
                    if let Some(delta) = field_text(payload, "delta").filter(|s| !s.is_empty()) {
                        let delta = self.safe_text(delta)?;
                        self.draft(&mut out, Kind::MessageDelta, json!({"text":delta}))?;
                        out.live.push(Live::Output);
                    }
                }
                _ => {}
            },
            Some("tool.updated") => {
                if let Some(id) = field_text(payload, "toolCallId").filter(|id| !id.is_empty()) {
                    let id = self.structural(id)?;
                    match payload["kind"].as_str() {
                        Some("scheduled") => {
                            let name = self.structural(
                                field_text(payload, "toolName").unwrap_or("tool".into()),
                            )?;
                            let empty = json!({});
                            let raw = payload
                                .get("input")
                                .filter(|v| v.is_object())
                                .unwrap_or(&empty);
                            let input = self.redacted(raw)?;
                            self.draft(
                                &mut out,
                                Kind::ToolCalled,
                                json!({"toolUseId":id,"name":name,"input":input}),
                            )?;
                        }
                        Some("result") => {
                            let result = payload.get("result").filter(|v| v.is_object());
                            let content = result
                                .and_then(|v| field_text(v, "content"))
                                .map(|s| self.safe_text(s))
                                .transpose()?;
                            self.draft(&mut out,Kind::ToolFinished,json!({"toolUseId":id,"isError":result.is_some_and(|v|v["success"]!=true),"content":content}))?;
                        }
                        _ => {}
                    }
                }
            }
            Some("turn.completed") => {
                let text = field_text(payload, "response")
                    .map(|s| self.safe_text(s))
                    .transpose()?;
                let result_type = field_text(payload, "resultType")
                    .map(|s| self.structural(s))
                    .transpose()?;
                out.signals.push(Signal::TurnEnded {
                    ok: result_type.as_deref().is_none_or(|s| s == "success"),
                    text: text.clone(),
                    result_type,
                });
                if let Some(text) = text.filter(|s| !s.is_empty()) {
                    let mut data = json!({"text":text});
                    if let Some(model) = &self.model {
                        data["model"] = json!(model);
                    }
                    self.draft(&mut out, Kind::MessageDone, data)?;
                }
                self.usage_draft(&mut out, &payload["usage"])?;
            }
            Some("result") => {
                let text = field_text(event, "response")
                    .map(|s| self.safe_text(s))
                    .transpose()?;
                let result_type = field_text(event, "resultType")
                    .map(|s| self.structural(s))
                    .transpose()?;
                let projection = &event["projection"];
                out.signals.push(Signal::Result {
                    ok: result_type.as_deref().is_none_or(|s| s == "success"),
                    text,
                    result_type,
                    session_id: sid.unwrap_or_default(),
                    usage: usage(&event["usage"]),
                    context_used: num(projection, "contextUsed"),
                    context_window: num(projection, "contextWindow"),
                });
                self.usage_draft(&mut out, &event["usage"])?;
                if let Some(used) = num(projection, "contextUsed") {
                    let mut data = json!({"used":jsnum(Some(used)),"window":jsnum(num(projection,"contextWindow"))});
                    if let Some(model) = &self.model {
                        data["model"] = json!(model);
                    }
                    self.draft(&mut out, Kind::ContextUpdated, data)?;
                }
            }
            Some(
                "session.titleUpdated"
                | "session.resumed"
                | "session.updated"
                | "streamRecovery.updated",
            ) => {}
            // An unknown envelope may still carry a native identity candidate.
            // Do not label that useful early evidence as a wholly ignored frame.
            _ => out.ignored = out.signals.is_empty(),
        }
        Ok(out)
    }
}
