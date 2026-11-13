//! Bounded, deliberately partial ZCode app-server wire profile. No process or Driver authority.
//! Sources and unsupported surface: docs/rust/R3-ZCODE-APP-SERVER-PROTOCOL.md.
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json, value::RawValue};
use std::fmt;
use std::ops::Range;

pub const APP_SERVER_ARGV: [&str; 2] = ["app-server", "--stdio"];
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OUTBOUND_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_CONTENT_BYTES: usize = 128 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const MAX_NODES: usize = 1_000_000;
pub const MAX_STRING_BYTES: usize = MAX_FRAME_BYTES;
/// Host-retained permission data, including metadata and existing correlation strings.
/// This does not lower the independent wire frame limit.
pub const MAX_PERMISSION_RETENTION_BYTES: usize = 256 * 1024;
pub const MAX_MCP_SERVERS: usize = 8;
pub const MAX_MCP_CONFIG_BYTES: usize = 64 * 1024;
pub const MAX_ENV_ENTRIES: usize = 32;
pub const MAX_ARGS: usize = 64;
const MAX_ID_BYTES: usize = 256;
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    FrameTooLarge,
    InvalidFraming,
    InvalidJson,
    BudgetExceeded,
    InvalidShape,
    Unsupported,
    CorrelationMismatch,
}
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::FrameTooLarge => "ZCode frame too large",
            Self::InvalidFraming => "invalid ZCode NDJSON framing",
            Self::InvalidJson => "invalid ZCode JSON",
            Self::BudgetExceeded => "ZCode protocol budget exceeded",
            Self::InvalidShape => "invalid ZCode message shape",
            Self::Unsupported => "unsupported ZCode message profile",
            Self::CorrelationMismatch => "ZCode correlation mismatch",
        })
    }
}
impl std::error::Error for ProtocolError {}
type Result<T> = std::result::Result<T, ProtocolError>;

// Payload-carrying types intentionally have no Debug: paths, content and MCP keys are private.
#[derive(Clone, PartialEq, Eq)]
pub enum RequestId {
    String(String),
    Integer(i64),
}
impl RequestId {
    pub fn string(value: &str) -> Result<Self> {
        identifier(value)?;
        Ok(Self::String(value.into()))
    }
    pub fn integer(value: i64) -> Result<Self> {
        if value.unsigned_abs() > JS_SAFE_INTEGER {
            return Err(ProtocolError::InvalidShape);
        }
        Ok(Self::Integer(value))
    }
    fn value(&self) -> Value {
        match self {
            Self::String(s) => Value::String(s.clone()),
            Self::Integer(n) => json!(n),
        }
    }
    fn parse(v: &Value) -> Result<Self> {
        match v {
            Value::String(s) => Self::string(s),
            Value::Number(n) => Self::integer(n.as_i64().ok_or(ProtocolError::InvalidShape)?),
            _ => Err(ProtocolError::InvalidShape),
        }
    }
}

pub struct Workspace {
    path: String,
    key: String,
}
impl Workspace {
    pub fn new(path: &str, key: &str) -> Result<Self> {
        canonical_text(path, 4096)?;
        identifier(key)?;
        if !path.starts_with('/') {
            return Err(ProtocolError::InvalidShape);
        }
        Ok(Self {
            path: path.into(),
            key: key.into(),
        })
    }
    fn value(&self) -> Value {
        json!({"workspacePath":self.path,"workspaceKey":self.key})
    }
}

/// Explicit private stdio MCP configuration. Never place its env entries in argv/global env.
pub struct StdioMcpServer {
    value: Value,
}
impl StdioMcpServer {
    pub fn new(
        name: &str,
        command: &str,
        cwd: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<Self> {
        identifier(name)?;
        // The pinned native adapter uses a normal JS object indexed by server name.
        if name == "__proto__" {
            return Err(ProtocolError::InvalidShape);
        }
        canonical_text(command, 4096)?;
        canonical_text(cwd, 4096)?;
        if !cwd.starts_with('/') || args.len() > MAX_ARGS || env.len() > MAX_ENV_ENTRIES {
            return Err(ProtocolError::InvalidShape);
        }
        let mut env_values = Vec::new();
        let mut names = std::collections::HashSet::new();
        for arg in args {
            text(arg, 4096, false)?;
        }
        for (name, value) in env {
            text(name, 128, true)?;
            text(value, 16 * 1024, false)?;
            if !name
                .bytes()
                .enumerate()
                .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
                || !names.insert(name)
            {
                return Err(ProtocolError::InvalidShape);
            }
            env_values.push(json!({"name":name,"value":value}));
        }
        let value = json!({"name":name,"command":command,"cwd":cwd,"args":args,"env":env_values,"isolation":"session"});
        validate_value_budget(&value)?;
        if serde_json::to_vec(&value)
            .map_err(|_| ProtocolError::InvalidShape)?
            .len()
            > MAX_MCP_CONFIG_BYTES
        {
            return Err(ProtocolError::BudgetExceeded);
        }
        Ok(Self { value })
    }
    pub fn protocol_version(mut self, version: &str) -> Result<Self> {
        if !["legacy", "auto", "2026-07-28"].contains(&version) {
            return Err(ProtocolError::InvalidShape);
        }
        self.value["protocolVersion"] = json!(version);
        Ok(self)
    }
    pub fn timeout_ms(mut self, timeout: u32) -> Result<Self> {
        if timeout == 0 || timeout > 300_000 {
            return Err(ProtocolError::InvalidShape);
        }
        self.value["timeoutMs"] = json!(timeout);
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryKind {
    DesktopContinuous,
    WebRemoteReplayable,
}
impl DeliveryKind {
    fn wire(self) -> &'static str {
        match self {
            Self::DesktopContinuous => "desktop-continuous",
            Self::WebRemoteReplayable => "web-remote-replayable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionMode {
    Plan,
    Build,
    Edit,
    Yolo,
    Guarded,
    Auto,
}
impl SessionMode {
    fn wire(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Build => "build",
            Self::Edit => "edit",
            Self::Yolo => "yolo",
            Self::Guarded => "guarded",
            Self::Auto => "auto",
        }
    }
    fn parse(value: &Value) -> Result<Self> {
        match value.as_str() {
            Some("plan") => Ok(Self::Plan),
            Some("build") => Ok(Self::Build),
            Some("edit") => Ok(Self::Edit),
            Some("yolo") => Ok(Self::Yolo),
            Some("guarded") => Ok(Self::Guarded),
            Some("auto") => Ok(Self::Auto),
            _ => Err(ProtocolError::InvalidShape),
        }
    }
}

pub struct OutboundRequest {
    id: RequestId,
    method: &'static str,
    params: Value,
}
impl OutboundRequest {
    pub fn create(
        id: RequestId,
        session_id: &str,
        workspace: Workspace,
        servers: Vec<StdioMcpServer>,
    ) -> Result<Self> {
        identifier(session_id)?;
        Ok(Self {
            id,
            method: "session/create",
            params: json!({"sessionId":session_id,"workspace":workspace.value(),"mcpServers":servers_value(servers)?,"titleGenerationEnabled":false}),
        })
    }
    /// Set only an explicitly captured native mode; this enum conveys no host approval.
    pub fn with_mode(mut self, mode: SessionMode) -> Result<Self> {
        if self.method != "session/create" {
            return Err(ProtocolError::Unsupported);
        }
        self.params["mode"] = json!(mode.wire());
        Ok(self)
    }
    pub fn set_mode(
        id: RequestId,
        session_id: &str,
        mode: SessionMode,
        expected_revision: Option<u64>,
    ) -> Result<Self> {
        identifier(session_id)?;
        let mut params = json!({"sessionId":session_id,"mode":mode.wire()});
        if let Some(revision) = expected_revision {
            if revision > JS_SAFE_INTEGER {
                return Err(ProtocolError::InvalidShape);
            }
            params["expectedRevision"] = json!(revision);
        }
        Ok(Self {
            id,
            method: "session/setMode",
            params,
        })
    }
    /// Only the future worker can establish that resume is cold in a fresh dedicated process.
    pub fn resume(
        id: RequestId,
        session_id: &str,
        workspace: Workspace,
        servers: Vec<StdioMcpServer>,
    ) -> Result<Self> {
        identifier(session_id)?;
        Ok(Self {
            id,
            method: "session/resume",
            params: json!({"sessionId":session_id,"workspace":workspace.value(),"mcpServers":servers_value(servers)?}),
        })
    }
    /// Native legacy events require an explicit subscription before send.
    pub fn subscribe(
        id: RequestId,
        session_id: &str,
        delivery_kind: DeliveryKind,
        after_seq: Option<u64>,
    ) -> Result<Self> {
        identifier(session_id)?;
        let mut params = json!({"sessionId":session_id,"deliveryKind":delivery_kind.wire(),"includeSnapshot":false});
        if let Some(seq) = after_seq {
            if seq > JS_SAFE_INTEGER {
                return Err(ProtocolError::InvalidShape);
            }
            params["afterSeq"] = json!(seq);
        }
        Ok(Self {
            id,
            method: "session/subscribe",
            params,
        })
    }
    /// Encoding does not mean delivery. Unknown send outcomes must never be automatically replayed.
    pub fn send(
        id: RequestId,
        session_id: &str,
        input_id: &str,
        query_id: &str,
        content: &str,
    ) -> Result<Self> {
        identifier(session_id)?;
        identifier(input_id)?;
        identifier(query_id)?;
        text(content, MAX_CONTENT_BYTES, false)?;
        Ok(Self {
            id,
            method: "session/send",
            params: json!({"sessionId":session_id,"inputId":input_id,"queryId":query_id,"content":content}),
        })
    }
    pub fn close(id: RequestId, session_id: &str) -> Result<Self> {
        identifier(session_id)?;
        Ok(Self {
            id,
            method: "session/close",
            params: json!({"sessionId":session_id}),
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        RequestId::parse(&self.id.value())?;
        encode(json!({"id":self.id.value(),"method":self.method,"params":self.params}))
    }
}
fn servers_value(servers: Vec<StdioMcpServer>) -> Result<Value> {
    // Upstream [] falls back to GLOBAL config. Refuse it instead of promising MCP isolation.
    if servers.is_empty() || servers.len() > MAX_MCP_SERVERS {
        return Err(ProtocolError::InvalidShape);
    }
    let mut names = std::collections::HashSet::new();
    for server in &servers {
        if !names.insert(
            server.value["name"]
                .as_str()
                .ok_or(ProtocolError::InvalidShape)?,
        ) {
            return Err(ProtocolError::InvalidShape);
        }
    }
    let value = Value::Array(servers.into_iter().map(|s| s.value).collect());
    if serde_json::to_vec(&value)
        .map_err(|_| ProtocolError::InvalidShape)?
        .len()
        > MAX_MCP_CONFIG_BYTES
    {
        return Err(ProtocolError::BudgetExceeded);
    }
    Ok(value)
}

/// Validated outer envelope, not evidence of execution, acceptance, authorization or cleanup.
pub enum Incoming {
    Response(Response),
    TurnStarted(TurnStartedCandidate),
    Reverse(ReverseRequest),
    Notification(BoundedNotification),
}
/// Recognized, bounded observability only. It must never mint Driver or owner authority.
pub struct BoundedNotification {
    method: &'static str,
    params: Value,
}
impl BoundedNotification {
    pub fn method(&self) -> &'static str {
        self.method
    }
    pub fn untrusted_params(&self) -> &Value {
        &self.params
    }
}

pub struct Response {
    id: RequestId,
    outcome: ResponseOutcome,
}
enum ResponseOutcome {
    Result(Value),
    Error { code: i64 },
}
pub struct SendAcknowledgement {
    pub session_id: String,
    pub state_revision: u64,
}
pub struct CloseAcknowledgement {
    pub closed: Option<bool>,
}
/// Subscription header ACK only; replayed events remain untrusted until individually parsed.
pub struct SubscribeAcknowledgement {
    pub session_id: String,
    pub event_seq: u64,
    events: Vec<Value>,
    snapshot: Option<Value>,
}
impl SubscribeAcknowledgement {
    pub fn untrusted_events(&self) -> &[Value] {
        &self.events
    }
    pub fn untrusted_snapshot(&self) -> Option<&Value> {
        self.snapshot.as_ref()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotMethod {
    Create,
    Resume,
    SetMode,
}
/// Pinned identity/header extraction only; opaque sections are NOT fully schema validated.
pub struct SnapshotAcknowledgement {
    pub method: SnapshotMethod,
    pub session_mode: SessionMode,
    pub session_id: String,
    pub workspace_path: String,
    pub workspace_key: String,
    pub state_revision: u64,
    pub event_seq: u64,
    pub active_turn_id: Option<String>,
    opaque_snapshot: Value,
}
impl SnapshotAcknowledgement {
    /// Untrusted bounded data for a future projection parser. It conveys no execution authority.
    pub fn untrusted_snapshot(&self) -> &Value {
        &self.opaque_snapshot
    }
}
impl Response {
    pub fn id(&self) -> &RequestId {
        &self.id
    }
    /// Correlate errors as strictly as success ACKs. The caller still binds the pending method.
    pub fn error_code(&self, expected: &RequestId) -> Result<Option<i64>> {
        if self.id != *expected {
            return Err(ProtocolError::CorrelationMismatch);
        }
        Ok(match &self.outcome {
            ResponseOutcome::Error { code } => Some(*code),
            _ => None,
        })
    }
    fn result(self, expected: &RequestId) -> Result<Value> {
        if self.id != *expected {
            return Err(ProtocolError::CorrelationMismatch);
        }
        match self.outcome {
            ResponseOutcome::Result(v) => Ok(v),
            _ => Err(ProtocolError::Unsupported),
        }
    }
    pub fn send_ack(
        self,
        expected: &RequestId,
        expected_session_id: &str,
    ) -> Result<SendAcknowledgement> {
        let v = self.result(expected)?;
        let o = object(&v)?;
        fields(o, &["sessionId", "accepted", "stateRevision"], &[])?;
        identifier(expected_session_id)?;
        if id_field(o, "sessionId")? != expected_session_id {
            return Err(ProtocolError::CorrelationMismatch);
        }
        if o["accepted"] != true {
            return Err(ProtocolError::InvalidShape);
        }
        Ok(SendAcknowledgement {
            session_id: id_field(o, "sessionId")?.into(),
            state_revision: uint(&o["stateRevision"])?,
        })
    }
    pub fn subscribe_ack(
        self,
        expected: &RequestId,
        expected_session_id: &str,
    ) -> Result<SubscribeAcknowledgement> {
        let v = self.result(expected)?;
        let o = object(&v)?;
        fields(o, &["sessionId", "eventSeq", "events"], &["snapshot"])?;
        identifier(expected_session_id)?;
        if id_field(o, "sessionId")? != expected_session_id {
            return Err(ProtocolError::CorrelationMismatch);
        }
        let events = array(&o["events"], 0, MAX_NODES)?;
        for event in events {
            session_event_envelope(event)?;
            if id_field(object(event)?, "sessionId")? != expected_session_id {
                return Err(ProtocolError::CorrelationMismatch);
            }
        }
        if let Some(snapshot) = o.get("snapshot") {
            object(snapshot)?;
        }
        Ok(SubscribeAcknowledgement {
            session_id: expected_session_id.into(),
            event_seq: uint(&o["eventSeq"])?,
            events: events.clone(),
            snapshot: o.get("snapshot").cloned(),
        })
    }
    pub fn close_ack(self, expected: &RequestId) -> Result<CloseAcknowledgement> {
        let v = self.result(expected)?;
        let o = object(&v)?;
        fields(o, &[], &["closed"])?;
        Ok(CloseAcknowledgement {
            closed: o
                .get("closed")
                .map(|v| v.as_bool().ok_or(ProtocolError::InvalidShape))
                .transpose()?,
        })
    }
    /// The caller supplies the pending request method, never a peer-provided authorization tag.
    pub fn snapshot_ack(
        self,
        expected: &RequestId,
        expected_session_id: &str,
        method: SnapshotMethod,
    ) -> Result<SnapshotAcknowledgement> {
        let v = self.result(expected)?;
        let o = object(&v)?;
        fields(
            o,
            &[
                "protocol",
                "session",
                "settings",
                "projection",
                "runtime",
                "messages",
            ],
            &["goalStats", "todos", "todoGroups", "slashCommands"],
        )?;
        let protocol = object(&o["protocol"])?;
        fields(protocol, &["name", "version"], &[])?;
        if protocol["name"] != "ZCode Protocol" || protocol["version"] != 1 {
            return Err(ProtocolError::Unsupported);
        }
        let session = object(&o["session"])?;
        fields(
            session,
            &[
                "sessionId",
                "workspace",
                "sessionKind",
                "title",
                "mode",
                "status",
                "createdAt",
                "updatedAt",
            ],
            &[
                "directorySessionId",
                "parentSessionId",
                "traceId",
                "titleSource",
                "model",
                "target",
            ],
        )?;
        let session_id = id_field(session, "sessionId")?.to_owned();
        identifier(expected_session_id)?;
        if session_id != expected_session_id {
            return Err(ProtocolError::CorrelationMismatch);
        }
        for k in ["directorySessionId", "parentSessionId", "traceId"] {
            optional_id(session, k)?;
        }
        string_field(session, "title", MAX_STRING_BYTES, false)?;
        uint(&session["createdAt"])?;
        uint(&session["updatedAt"])?;
        enum_string(
            &session["sessionKind"],
            &[
                "interactive",
                "fork",
                "selection_side_chat",
                "workflow_parent",
                "workflow_child",
                "subagent_child",
                "nested_workflow_child",
            ],
        )?;
        let session_mode = SessionMode::parse(&session["mode"])?;
        enum_string(
            &session["status"],
            &["idle", "running", "waiting", "paused", "completed", "error"],
        )?;
        if let Some(v) = session.get("titleSource") {
            enum_string(v, &["default", "first_input", "generated", "custom"])?;
        }
        workspace(&session["workspace"])?;
        let w = object(&session["workspace"])?;
        let workspace_path = string_field(w, "workspacePath", 4096, true)?.to_owned();
        let workspace_key = id_field(w, "workspaceKey")?.to_owned();
        object(&o["settings"])?;
        let projection = object(&o["projection"])?;
        if id_field(projection, "sessionId")? != session_id {
            return Err(ProtocolError::CorrelationMismatch);
        }
        let runtime = object(&o["runtime"])?;
        fields(
            runtime,
            &["eventSeq", "stateRevision", "pendingRequestIds"],
            &[
                "deliveryKind",
                "activeTurnId",
                "activeTurnKind",
                "apiRetry",
                "contextUsage",
                "goalVerifications",
                "goalVerificationTimeline",
            ],
        )?;
        let state_revision = uint(&runtime["stateRevision"])?;
        let event_seq = uint(&runtime["eventSeq"])?;
        let active_turn_id = optional_id(runtime, "activeTurnId")?;
        if let Some(v) = runtime.get("deliveryKind") {
            enum_string(v, &["desktop-continuous", "web-remote-replayable"])?;
        }
        if let Some(v) = runtime.get("activeTurnKind") {
            enum_string(v, &["regular", "compact", "rewind"])?;
        }
        for id in array(&runtime["pendingRequestIds"], 0, MAX_NODES)? {
            identifier(id.as_str().ok_or(ProtocolError::InvalidShape)?)?;
        }
        if !o["messages"].is_array() {
            return Err(ProtocolError::InvalidShape);
        }
        for k in ["todos", "todoGroups", "slashCommands"] {
            if let Some(v) = o.get(k)
                && !v.is_array()
            {
                return Err(ProtocolError::InvalidShape);
            }
        }
        if let Some(v) = o.get("goalStats") {
            object(v)?;
        }
        Ok(SnapshotAcknowledgement {
            method,
            session_mode,
            session_id,
            workspace_path,
            workspace_key,
            state_revision,
            event_seq,
            active_turn_id,
            opaque_snapshot: v,
        })
    }
}

/// Transport evidence only. Future Actor must match SID/TID and its host-issued inputId.
pub struct TurnStartedCandidate {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub input_id: Option<String>,
    pub query_id: Option<String>,
    pub seq: u64,
}
pub enum ReverseRequest {
    RuntimePreferences {
        id: RequestId,
        session_id: String,
        scope: RuntimePreferencesScope,
    },
    Permission {
        id: RequestId,
        session_id: String,
        request_id: String,
        payload: NativePermissionPayload,
    },
    UserInput {
        id: RequestId,
        session_id: String,
        request_id: String,
    },
}
/// Strictly validated but UNTRUSTED native data. Neither state authorizes a reply.
/// Secret-bearing payloads deliberately implement no Clone, Debug or serde traits.
/// ```compile_fail
/// fn requires<T: Clone>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionPayload>();
/// ```
/// ```compile_fail
/// fn requires<T: std::fmt::Debug>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionPayload>();
/// ```
/// ```compile_fail
/// fn requires<T: serde::Serialize>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionPayload>();
/// ```
/// ```compile_fail
/// fn requires<T: serde::Deserialize<'static>>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionPayload>();
/// ```
pub enum NativePermissionPayload {
    Retained(NativePermissionData),
    ConservativeOnly(PermissionPayloadLimit),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionPayloadLimit {
    RetentionBudget,
}

/// One immutable original params allocation; field spans never own another copy.
/// These are native claims, not an accepted source, consent or a permission receipt.
/// ```compile_fail
/// fn requires<T: Clone>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionData>();
/// ```
/// ```compile_fail
/// fn requires<T: std::fmt::Debug>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionData>();
/// ```
/// ```compile_fail
/// fn requires<T: serde::Serialize>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionData>();
/// ```
/// ```compile_fail
/// fn requires<T: serde::Deserialize<'static>>() {}
/// requires::<pult_core::zcode_appserver_protocol::NativePermissionData>();
/// ```
pub struct NativePermissionData {
    params: Box<RawValue>,
    fields: [Range<usize>; 6],
    turn_id: Option<Range<usize>>,
    origin: Option<Range<usize>>,
}
impl NativePermissionData {
    pub fn untrusted_params(&self) -> &RawValue {
        &self.params
    }
    pub fn untrusted_tool_call_id(&self) -> String {
        self.text(0)
    }
    pub fn untrusted_tool_name(&self) -> String {
        self.text(1)
    }
    pub fn untrusted_reason(&self) -> String {
        self.text(2)
    }
    pub fn untrusted_risk_level(&self) -> String {
        self.text(3)
    }
    pub fn untrusted_input(&self) -> &RawValue {
        self.raw(&self.fields[4])
    }
    pub fn untrusted_options(&self) -> &RawValue {
        self.raw(&self.fields[5])
    }
    pub fn untrusted_turn_id(&self) -> Option<String> {
        self.turn_id
            .as_ref()
            .map(|span| serde_json::from_str(self.slice(span)).expect("validated permission text"))
    }
    pub fn untrusted_origin(&self) -> Option<&RawValue> {
        self.origin.as_ref().map(|span| self.raw(span))
    }
    fn text(&self, field: usize) -> String {
        serde_json::from_str(self.slice(&self.fields[field])).expect("validated permission text")
    }
    fn slice(&self, span: &Range<usize>) -> &str {
        // Spans are checked against this exact immutable backing before construction.
        &self.params.get()[span.clone()]
    }
    fn raw(&self, span: &Range<usize>) -> &RawValue {
        serde_json::from_str(self.slice(span)).expect("validated permission raw field")
    }
}

// These temporary borrowed views are used ONLY after strict duplicate/depth/node/shape
// validation. RawValue is not an alternative decoder or an authorization boundary.
#[derive(serde::Deserialize)]
struct RawParams<'a> {
    #[serde(borrow)]
    params: &'a RawValue,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPermissionFields<'a> {
    #[serde(borrow)]
    tool_call_id: &'a RawValue,
    #[serde(borrow)]
    tool_name: &'a RawValue,
    #[serde(borrow)]
    reason: &'a RawValue,
    #[serde(borrow)]
    risk_level: &'a RawValue,
    #[serde(borrow)]
    input: &'a RawValue,
    #[serde(borrow)]
    options: &'a RawValue,
    #[serde(borrow)]
    turn_id: Option<&'a RawValue>,
    #[serde(borrow)]
    origin: Option<&'a RawValue>,
}
fn raw_span(parent: &RawValue, field: &RawValue) -> Result<Range<usize>> {
    // Address arithmetic only locates a borrowed subslice; bounds and exact contents
    // are checked without pointer dereference, unsafe or self-referential storage.
    let start = (field.get().as_ptr() as usize)
        .checked_sub(parent.get().as_ptr() as usize)
        .ok_or(ProtocolError::InvalidJson)?;
    let end = start
        .checked_add(field.get().len())
        .ok_or(ProtocolError::InvalidJson)?;
    if parent.get().get(start..end) != Some(field.get()) {
        return Err(ProtocolError::InvalidJson);
    }
    Ok(start..end)
}
fn permission_payload(
    body: &[u8],
    id: &RequestId,
    session_id: &str,
    request_id: &str,
) -> Result<NativePermissionPayload> {
    let raw: RawParams<'_> =
        serde_json::from_slice(body).map_err(|_| ProtocolError::InvalidJson)?;
    // Count the one raw backing, fixed fields/enum metadata and correlation strings
    // already retained by ReverseRequest. There are no retained input/options copies.
    let id_bytes = match id {
        RequestId::String(s) => s.len(),
        RequestId::Integer(_) => 0,
    };
    let retained = raw
        .params
        .get()
        .len()
        .saturating_add(std::mem::size_of::<ReverseRequest>())
        .saturating_add(id_bytes)
        .saturating_add(session_id.len())
        .saturating_add(request_id.len());
    if retained > MAX_PERMISSION_RETENTION_BYTES {
        return Ok(NativePermissionPayload::ConservativeOnly(
            PermissionPayloadLimit::RetentionBudget,
        ));
    }
    let p: RawPermissionFields<'_> =
        serde_json::from_str(raw.params.get()).map_err(|_| ProtocolError::InvalidJson)?;
    let fields = [
        p.tool_call_id,
        p.tool_name,
        p.reason,
        p.risk_level,
        p.input,
        p.options,
    ]
    .map(|field| raw_span(raw.params, field));
    let [a, b, c, d, e, f] = fields;
    let fields = [a?, b?, c?, d?, e?, f?];
    let turn_id = p
        .turn_id
        .map(|field| raw_span(raw.params, field))
        .transpose()?;
    let origin = p
        .origin
        .map(|field| raw_span(raw.params, field))
        .transpose()?;
    Ok(NativePermissionPayload::Retained(NativePermissionData {
        params: raw.params.to_owned(),
        fields,
        turn_id,
        origin,
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimePreferencesScope {
    RuntimeMaterialization,
    UserExecution,
}
impl ReverseRequest {
    pub fn id(&self) -> &RequestId {
        match self {
            Self::RuntimePreferences { id, .. }
            | Self::Permission { id, .. }
            | Self::UserInput { id, .. } => id,
        }
    }
    /// Static conservative reply. Never reflect JSON-provided options into authority.
    pub fn default_deny(&self) -> Result<Vec<u8>> {
        RequestId::parse(&self.id().value())?;
        let result = match self {
            Self::RuntimePreferences { .. } => {
                json!({"nativeSearchEnhancementsEnabled":false,"toolSearchMode":"off","subagentRuntimeConfigEnabled":false,"appControlEnabled":false,"memoryEnabled":false,"askUserQuestionAutoResolutionEnabled":false,"modelContextBudgetStrategy":"preflight-v1"})
            }
            Self::Permission { .. } => {
                json!({"decision":"deny","reason":"Host approval is unavailable"})
            }
            Self::UserInput { .. } => {
                json!({"action":"cancel","reason":"Host input is unavailable"})
            }
        };
        encode(json!({"id":self.id().value(),"result":result}))
    }
}

/// Exactly one LF-terminated NDJSON frame, or CRLF; no Codex Content-Length/JSON-RPC framing.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    pub frame_bytes: usize,
    pub depth: usize,
    pub nodes: usize,
    pub string_bytes: usize,
}
impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            frame_bytes: MAX_FRAME_BYTES,
            depth: MAX_DEPTH,
            nodes: MAX_NODES,
            string_bytes: MAX_STRING_BYTES,
        }
    }
}
impl DecodeLimits {
    fn validate(self) -> Result<()> {
        if self.frame_bytes == 0
            || self.frame_bytes > 16 * 1024 * 1024
            || self.depth == 0
            || self.depth > 64
            || self.nodes == 0
            || self.nodes > 1_000_000
            || self.string_bytes == 0
            || self.string_bytes > MAX_FRAME_BYTES
        {
            return Err(ProtocolError::BudgetExceeded);
        }
        Ok(())
    }
}
pub fn decode_frame(frame: &[u8]) -> Result<Incoming> {
    decode_frame_with_limits(frame, DecodeLimits::default())
}
pub fn decode_frame_with_limits(frame: &[u8], limits: DecodeLimits) -> Result<Incoming> {
    limits.validate()?;
    if frame.len() > limits.frame_bytes {
        return Err(ProtocolError::FrameTooLarge);
    }
    let body = frame
        .strip_suffix(b"\n")
        .ok_or(ProtocolError::InvalidFraming)?;
    let body = body.strip_suffix(b"\r").unwrap_or(body);
    if body.is_empty() || body.contains(&b'\n') || body.contains(&b'\r') {
        return Err(ProtocolError::InvalidFraming);
    }
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let mut budget = limits.nodes;
    let v = JsonSeed {
        depth: 0,
        budget: &mut budget,
        limits,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| {
        if error.to_string().starts_with("ZCode capacity exceeded") {
            ProtocolError::BudgetExceeded
        } else {
            ProtocolError::InvalidJson
        }
    })?;
    deserializer.end().map_err(|_| ProtocolError::InvalidJson)?;
    let o = object(&v)?;
    if o.contains_key("result") || o.contains_key("error") {
        fields(o, &["id"], &["result", "error"])?;
        let id = RequestId::parse(&o["id"])?;
        let outcome = match (o.get("result"), o.get("error")) {
            (Some(v), None) => ResponseOutcome::Result(v.clone()),
            (None, Some(v)) => {
                let e = object(v)?;
                fields(e, &["code", "message"], &["data"])?;
                string_field(e, "message", 4096, true)?;
                let code = e["code"]
                    .as_i64()
                    .filter(|n| n.unsigned_abs() <= JS_SAFE_INTEGER)
                    .ok_or(ProtocolError::InvalidShape)?;
                ResponseOutcome::Error { code }
            }
            _ => return Err(ProtocolError::InvalidShape),
        };
        return Ok(Incoming::Response(Response { id, outcome }));
    }
    fields(o, &["method", "params"], &["id", "trace"])?;
    if let Some(v) = o.get("trace") {
        protocol_trace(v)?;
    }
    let method = string_field(o, "method", 128, true)?;
    if !o.contains_key("id") {
        return match method {
            "session/event" => {
                session_event_envelope(&o["params"])?;
                if o["params"]["type"] == "turn.started" {
                    turn_started(&o["params"]).map(Incoming::TurnStarted)
                } else {
                    Ok(Incoming::Notification(BoundedNotification {
                        method: "session/event",
                        params: o["params"].clone(),
                    }))
                }
            }
            "state.updated" => {
                state_updated(&o["params"])?;
                Ok(Incoming::Notification(BoundedNotification {
                    method: "state.updated",
                    params: o["params"].clone(),
                }))
            }
            "startup/pluginsDegraded" => {
                let p = object(&o["params"])?;
                fields(p, &["reason"], &[])?;
                if p["reason"] != "timeout" {
                    return Err(ProtocolError::InvalidShape);
                }
                Ok(Incoming::Notification(BoundedNotification {
                    method: "startup/pluginsDegraded",
                    params: o["params"].clone(),
                }))
            }
            _ => Err(ProtocolError::Unsupported),
        };
    }
    let id = RequestId::parse(o.get("id").ok_or(ProtocolError::Unsupported)?)?;
    reverse(id, method, &o["params"], body).map(Incoming::Reverse)
}
const SESSION_EVENT_TYPES: &[&str] = &[
    "session.created",
    "session.resumed",
    "session.updated",
    "session.titleUpdated",
    "session.closed",
    "turn.started",
    "turn.steerQueued",
    "turn.steerDrained",
    "turn.completed",
    "turn.failed",
    "message.upserted",
    "message.removed",
    "part.started",
    "part.delta",
    "part.upserted",
    "part.removed",
    "model.streaming",
    "tool.updated",
    "permission.requested",
    "permission.resolved",
    "userInput.requested",
    "userInput.resolved",
    "checkpoint.created",
    "rewind.triggered",
    "streamRecovery.updated",
];
fn session_event_envelope(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(
        o,
        &["eventId", "sessionId", "seq", "timestamp", "type"],
        &["turnId", "traceId", "deliveryKind", "payload"],
    )?;
    id_field(o, "eventId")?;
    id_field(o, "sessionId")?;
    uint(&o["seq"])?;
    uint(&o["timestamp"])?;
    optional_id(o, "turnId")?;
    optional_id(o, "traceId")?;
    enum_string(&o["type"], SESSION_EVENT_TYPES)?;
    if let Some(v) = o.get("deliveryKind") {
        enum_string(v, &["desktop-continuous", "web-remote-replayable"])?;
    }
    if let Some(v) = o.get("payload") {
        object(v)?;
    }
    Ok(())
}
fn state_updated(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(
        o,
        &["type", "scope", "revision", "patch"],
        &["workspace", "sessionId", "reason"],
    )?;
    if o["type"] != "state.updated" {
        return Err(ProtocolError::InvalidShape);
    }
    enum_string(&o["scope"], &["server", "workspace", "session"])?;
    uint(&o["revision"])?;
    optional_id(o, "sessionId")?;
    optional_text(o, "reason", MAX_STRING_BYTES)?;
    if let Some(v) = o.get("workspace") {
        workspace(v)?;
    }
    Ok(())
}

fn turn_started(v: &Value) -> Result<TurnStartedCandidate> {
    let o = object(v)?;
    fields(
        o,
        &["eventId", "sessionId", "seq", "timestamp", "type"],
        &["turnId", "traceId", "deliveryKind", "payload"],
    )?;
    id_field(o, "eventId")?;
    let session_id = id_field(o, "sessionId")?.into();
    let seq = uint(&o["seq"])?;
    uint(&o["timestamp"])?;
    optional_id(o, "traceId")?;
    if let Some(v) = o.get("deliveryKind") {
        enum_string(v, &["desktop-continuous", "web-remote-replayable"])?;
    }
    if o["type"] != "turn.started" {
        return Err(ProtocolError::Unsupported);
    }
    // Other valid upstream optional fields require an explicit extension, never silent acceptance.
    let p = object(o.get("payload").ok_or(ProtocolError::InvalidShape)?)?;
    fields(
        p,
        &["turnNumber", "input"],
        &[
            "inputId",
            "queryId",
            "executionStartedAt",
            "epilogueStart",
            "automationId",
            "offPeakTaskId",
            "offPeakRunType",
            "inputOrigin",
            "inputVisibility",
            "executionKind",
            "targetId",
            "messageId",
            "foregroundExecutionId",
            "backgroundSource",
            "intent",
            "originMeta",
            "attachments",
            "inputSource",
        ],
    )?;
    for key in ["intent", "originMeta"] {
        if let Some(v) = p.get(key) {
            object(v)?;
        }
    }
    if let Some(v) = p.get("attachments") {
        for attachment in array(v, 0, MAX_NODES)? {
            object(attachment)?;
        }
    }
    if let Some(v) = p.get("inputSource") {
        enum_string(
            v,
            &[
                "agent_listing_delta",
                "background_task",
                "fork",
                "goal_state_change",
                "goal-continuation",
                "plugin_reference",
                "bot_topic_context",
                "rewind",
                "selection_side_chat",
                "subagent",
                "subagent_message",
                "todo_reminder",
                "workflow_launch",
                "shared_context",
            ],
        )?;
    }
    uint(&p["turnNumber"])?;
    string_field(p, "input", MAX_STRING_BYTES, false)?;
    for k in [
        "automationId",
        "offPeakTaskId",
        "targetId",
        "messageId",
        "foregroundExecutionId",
    ] {
        optional_id(p, k)?;
    }
    if let Some(v) = p.get("epilogueStart") {
        uint(v)?;
    }
    if let Some(v) = p.get("executionStartedAt")
        && !v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
    {
        return Err(ProtocolError::InvalidShape);
    }
    for (key, allowed) in [
        ("offPeakRunType", &["init", "resume"][..]),
        ("inputOrigin", &["desktop", "mobile"][..]),
        ("inputVisibility", &["user-visible", "model-only"][..]),
        ("executionKind", &["agent", "controlOnly"][..]),
        ("backgroundSource", &["bash", "subagent"][..]),
    ] {
        if let Some(v) = p.get(key) {
            enum_string(v, allowed)?;
        }
    }
    Ok(TurnStartedCandidate {
        session_id,
        turn_id: optional_id(o, "turnId")?,
        input_id: optional_id(p, "inputId")?,
        query_id: optional_id(p, "queryId")?,
        seq,
    })
}
fn reverse(id: RequestId, method: &str, v: &Value, body: &[u8]) -> Result<ReverseRequest> {
    let o = object(v)?;
    match method {
        "session/requestRuntimePreferences" => {
            fields(
                o,
                &["sessionId", "scope"],
                &["workspace", "directorySessionId"],
            )?;
            optional_id(o, "directorySessionId")?;
            if let Some(w) = o.get("workspace") {
                workspace(w)?;
            }
            let scope = match o["scope"].as_str() {
                Some("runtime-materialization") => RuntimePreferencesScope::RuntimeMaterialization,
                Some("user-execution") => RuntimePreferencesScope::UserExecution,
                _ => return Err(ProtocolError::InvalidShape),
            };
            Ok(ReverseRequest::RuntimePreferences {
                id,
                session_id: id_field(o, "sessionId")?.into(),
                scope,
            })
        }
        "interaction/requestPermission" => {
            fields(
                o,
                &[
                    "requestId",
                    "sessionId",
                    "toolCallId",
                    "toolName",
                    "reason",
                    "riskLevel",
                    "input",
                    "options",
                ],
                &["turnId", "origin"],
            )?;
            for k in ["toolCallId", "toolName"] {
                id_field(o, k)?;
            }
            string_field(o, "reason", 16 * 1024, false)?;
            enum_string(&o["riskLevel"], &["low", "medium", "high", "critical"])?;
            optional_id(o, "turnId")?;
            if let Some(v) = o.get("origin") {
                origin(v)?;
            }
            let options = array(&o["options"], 1, 16)?;
            let mut seen = std::collections::HashSet::new();
            for option in options {
                let p = object(option)?;
                fields(
                    p,
                    &["optionId", "kind", "name", "response"],
                    &["description"],
                )?;
                if !seen.insert(id_field(p, "optionId")?) {
                    return Err(ProtocolError::InvalidShape);
                }
                id_field(p, "kind")?;
                string_field(p, "name", 4096, true)?;
                optional_text(p, "description", 16 * 1024)?;
                permission_response(&p["response"])?;
            }
            let session_id = id_field(o, "sessionId")?;
            let request_id = id_field(o, "requestId")?;
            let payload = permission_payload(body, &id, session_id, request_id)?;
            Ok(ReverseRequest::Permission {
                id,
                session_id: session_id.into(),
                request_id: request_id.into(),
                payload,
            })
        }
        "interaction/requestUserInput" => {
            fields(
                o,
                &["requestId", "sessionId"],
                &[
                    "turnId",
                    "toolCallId",
                    "toolName",
                    "prompt",
                    "questions",
                    "input",
                    "origin",
                    "schema",
                ],
            )?;
            for k in ["turnId", "toolCallId", "toolName"] {
                optional_id(o, k)?;
            }
            optional_text(o, "prompt", 16 * 1024)?;
            if let Some(v) = o.get("origin") {
                origin(v)?;
            }
            if let Some(v) = o.get("questions") {
                for q in array(v, 1, 16)? {
                    let q = object(q)?;
                    fields(q, &["question", "header", "options"], &["multiSelect"])?;
                    string_field(q, "question", 16 * 1024, true)?;
                    string_field(q, "header", 4096, true)?;
                    if let Some(v) = q.get("multiSelect")
                        && !v.is_boolean()
                    {
                        return Err(ProtocolError::InvalidShape);
                    }
                    let mut seen = std::collections::HashSet::new();
                    for op in array(&q["options"], 1, 32)? {
                        let p = object(op)?;
                        fields(p, &["value", "label"], &["description", "preview"])?;
                        if !seen.insert(string_field(p, "value", 4096, true)?) {
                            return Err(ProtocolError::InvalidShape);
                        }
                        string_field(p, "label", 4096, true)?;
                        optional_text(p, "description", 16 * 1024)?;
                        optional_text(p, "preview", 16 * 1024)?;
                    }
                }
            }
            Ok(ReverseRequest::UserInput {
                id,
                session_id: id_field(o, "sessionId")?.into(),
                request_id: id_field(o, "requestId")?.into(),
            })
        }
        _ => Err(ProtocolError::Unsupported),
    }
}
fn permission_response(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(
        o,
        &["decision"],
        &["reason", "modifiedInput", "permissionUpdates"],
    )?;
    enum_string(&o["decision"], &["allow", "deny", "escalate", "modify"])?;
    optional_text(o, "reason", 16 * 1024)?;
    if let Some(v) = o.get("permissionUpdates") {
        for u in array(v, 0, 16)? {
            let p = object(u)?;
            fields(p, &["type", "behavior", "rules"], &[])?;
            if p["type"] != "addRules" {
                return Err(ProtocolError::InvalidShape);
            }
            enum_string(&p["behavior"], &["allow", "deny", "ask"])?;
            for r in array(&p["rules"], 1, 32)? {
                let r = object(r)?;
                fields(r, &["toolName"], &["ruleContent"])?;
                id_field(r, "toolName")?;
                optional_text(r, "ruleContent", 16 * 1024)?;
            }
        }
    }
    Ok(())
}
fn origin(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(
        o,
        &[
            "kind",
            "agentId",
            "agentType",
            "childSessionId",
            "parentSessionId",
        ],
        &[
            "childTurnId",
            "description",
            "parentToolCallId",
            "parentTurnId",
        ],
    )?;
    if o["kind"] != "subagent" {
        return Err(ProtocolError::InvalidShape);
    }
    for k in ["agentId", "agentType", "childSessionId", "parentSessionId"] {
        id_field(o, k)?;
    }
    for k in ["childTurnId", "parentToolCallId", "parentTurnId"] {
        optional_id(o, k)?;
    }
    optional_text(o, "description", 16 * 1024)?;
    Ok(())
}
// Exact pinned trace.ts shape, retained only as validated untrusted metadata.
fn protocol_trace(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(o, &[], &["traceId", "parentId", "spanId", "traceparent"])?;
    for value in o.values() {
        let value = value.as_str().ok_or(ProtocolError::InvalidShape)?;
        // Upstream min(1), without trim; whitespace is not an authorization signal.
        if value.is_empty() || value.len() > MAX_ID_BYTES || value.contains('\0') {
            return Err(ProtocolError::InvalidShape);
        }
    }
    Ok(())
}

fn workspace(v: &Value) -> Result<()> {
    let o = object(v)?;
    fields(
        o,
        &["workspacePath", "workspaceKey"],
        &["workspaceIdentity", "remoteSessionId"],
    )?;
    string_field(o, "workspacePath", 4096, true)?;
    id_field(o, "workspaceKey")?;
    optional_text(o, "workspaceIdentity", 4096)?;
    optional_id(o, "remoteSessionId")?;
    Ok(())
}
fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or(ProtocolError::InvalidShape)
}
fn fields(o: &Map<String, Value>, required: &[&str], optional: &[&str]) -> Result<()> {
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        Err(ProtocolError::InvalidShape)
    } else {
        Ok(())
    }
}
fn text(s: &str, max: usize, nonempty: bool) -> Result<()> {
    if s.len() > max || s.contains('\0') || (nonempty && s.trim().is_empty()) {
        Err(ProtocolError::InvalidShape)
    } else {
        Ok(())
    }
}
fn canonical_text(s: &str, max: usize) -> Result<()> {
    text(s, max, true)?;
    if s != s.trim() {
        return Err(ProtocolError::InvalidShape);
    }
    Ok(())
}
fn identifier(s: &str) -> Result<()> {
    canonical_text(s, MAX_ID_BYTES)?;
    Ok(())
}
fn string_field<'a>(
    o: &'a Map<String, Value>,
    key: &str,
    max: usize,
    nonempty: bool,
) -> Result<&'a str> {
    let s = o
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ProtocolError::InvalidShape)?;
    text(s, max, nonempty)?;
    Ok(s)
}
fn id_field<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    let value = string_field(o, key, MAX_ID_BYTES, true)?;
    identifier(value)?;
    Ok(value)
}
fn optional_id(o: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    o.get(key)
        .map(|_| id_field(o, key).map(str::to_owned))
        .transpose()
}
fn optional_text(o: &Map<String, Value>, key: &str, max: usize) -> Result<()> {
    if o.contains_key(key) {
        string_field(o, key, max, false)?;
    }
    Ok(())
}
fn uint(v: &Value) -> Result<u64> {
    v.as_u64()
        .filter(|n| *n <= JS_SAFE_INTEGER)
        .ok_or(ProtocolError::InvalidShape)
}
fn enum_string(v: &Value, allowed: &[&str]) -> Result<()> {
    if v.as_str().is_some_and(|s| allowed.contains(&s)) {
        Ok(())
    } else {
        Err(ProtocolError::InvalidShape)
    }
}
fn array(v: &Value, min: usize, max: usize) -> Result<&Vec<Value>> {
    let a = v.as_array().ok_or(ProtocolError::InvalidShape)?;
    if a.len() < min || a.len() > max {
        Err(ProtocolError::InvalidShape)
    } else {
        Ok(a)
    }
}
fn encode(v: Value) -> Result<Vec<u8>> {
    validate_value_budget(&v)?;
    let mut bytes = serde_json::to_vec(&v).map_err(|_| ProtocolError::InvalidJson)?;
    if bytes.len() >= MAX_OUTBOUND_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    bytes.push(b'\n');
    Ok(bytes)
}
fn validate_value_budget(v: &Value) -> Result<()> {
    fn walk(v: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
        if depth > MAX_DEPTH || *nodes == 0 {
            return Err(ProtocolError::BudgetExceeded);
        }
        *nodes -= 1;
        match v {
            Value::String(s) => {
                if s.len() > MAX_STRING_BYTES {
                    return Err(ProtocolError::BudgetExceeded);
                }
            }
            Value::Array(a) => {
                for v in a {
                    walk(v, depth + 1, nodes)?
                }
            }
            Value::Object(o) => {
                for (k, v) in o {
                    if k.len() > 256 {
                        return Err(ProtocolError::BudgetExceeded);
                    }
                    walk(v, depth + 1, nodes)?
                }
            }
            _ => (),
        }
        Ok(())
    }
    let mut nodes = MAX_NODES;
    walk(v, 0, &mut nodes)
}
// A custom bounded visitor rejects duplicate keys before serde_json can overwrite them.
struct JsonSeed<'a> {
    depth: usize,
    budget: &'a mut usize,
    limits: DecodeLimits,
}
impl<'de> DeserializeSeed<'de> for JsonSeed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        if self.depth > self.limits.depth || *self.budget == 0 {
            return Err(de::Error::custom("ZCode capacity exceeded"));
        }
        *self.budget -= 1;
        d.deserialize_any(JsonVisitor {
            depth: self.depth,
            budget: self.budget,
            limits: self.limits,
        })
    }
}
struct JsonVisitor<'a> {
    depth: usize,
    budget: &'a mut usize,
    limits: DecodeLimits,
}
impl<'de> Visitor<'de> for JsonVisitor<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| de::Error::custom("number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        if v.len() > self.limits.string_bytes {
            return Err(de::Error::custom("ZCode capacity exceeded"));
        }
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        if v.len() > self.limits.string_bytes {
            return Err(de::Error::custom("ZCode capacity exceeded"));
        }
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut a = Vec::new();
        while let Some(v) = seq.next_element_seed(JsonSeed {
            depth: self.depth + 1,
            budget: &mut *self.budget,
            limits: self.limits,
        })? {
            a.push(v);
        }
        Ok(Value::Array(a))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut o = Map::new();
        while let Some(k) = map.next_key::<String>()? {
            if k.len() > 256 {
                return Err(de::Error::custom("ZCode capacity exceeded"));
            }
            if o.contains_key(&k) {
                return Err(de::Error::custom("duplicate key"));
            }
            let v = map.next_value_seed(JsonSeed {
                depth: self.depth + 1,
                budget: &mut *self.budget,
                limits: self.limits,
            })?;
            o.insert(k, v);
        }
        Ok(Value::Object(o))
    }
}
