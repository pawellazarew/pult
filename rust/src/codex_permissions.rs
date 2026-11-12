//! Pure Codex server-request -> broker metadata -> native answer mapping.
//! No RPC permit, process, file write or permission grant is owned here. The host
//! captures TrustedOwner from its active worker and rechecks it when consuming
//! Prepared; never construct that identity from request JSON. Broker redacts the
//! returned PermissionRequest before publication. Persistent rules stay disabled
//! until the host explicitly wires durable rule tracking and enables capability.
//!
//! Sources: adapter.ts APPROVAL_VOCAB, offeredDecisions, codexScopedOffers,
//! approvalInput and onServerRequest; checked-in 0.163 schemas. Legacy v1 uses
//! conversationId/callId and has no turnId: its turn binding is the captured
//! trusted ticket. A supplied legacy turnId must still match. Unoffered widths
//! are rejected rather than Node's fallback narrowing. Rule objects accept only
//! the known exact union shape, never unknown fields carrying future authority.
use crate::codex_rpc::ResponseError;
use crate::permission_broker::{Decision, Offers, PermissionRequest, Rule, RuleKind, Scope};
use crate::turn_coordinator::Ticket;
use crate::turn_snapshot::SessionKey;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{self, Write};

pub const MAX_INPUT_BYTES: usize = 256 * 1024;
pub const FIELD_LIMIT: usize = 2000;
pub const ARRAY_LIMIT: usize = 40;
pub const CODEX_EXEC_RULE_NOTE: &str = "(с любыми аргументами дальше) — без песочницы и без вопроса во всех сессиях Codex; правило в ~/.codex/rules/default.rules, отозвать — «Настройки» → «Правила „Всегда“»";
pub const CODEX_NET_RULE_NOTE: &str = "— без вопроса во всех сессиях Codex; правило в ~/.codex/rules/default.rules, отозвать — «Настройки» → «Правила „Всегда“»";
const COMMAND: &str = "item/commandExecution/requestApproval";
const FILE_CHANGE: &str = "item/fileChange/requestApproval";
const USER_INPUT: &str = "item/tool/requestUserInput";
const MCP_ELICITATION: &str = "mcpServer/elicitation/request";

#[derive(Clone, Eq, PartialEq)]
pub struct TrustedOwner {
    pub session: SessionKey,
    pub ticket: Ticket,
    pub thread_id: String,
    pub provider_turn_id: String,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Capabilities {
    pub persistent_rules: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reject {
    Unsupported,
    Invalid,
    WrongOwner,
    Capacity,
    UnofferedScope,
    InvalidAnswers,
    Forbidden,
}
impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Reject {}
impl Reject {
    /// Immediate native denial, without publishing a broker request. Hosts must
    /// check this before using response_error for a rejected preparation.
    pub fn static_response(self) -> Option<Value> {
        (self == Self::Forbidden).then(|| json!({"action":"decline"}))
    }
    /// Safe wire error: no remote method, input, answer, path or rule is echoed.
    pub fn response_error(self) -> ResponseError {
        ResponseError {
            code: if self == Self::Unsupported {
                -32601
            } else {
                -32600
            },
            message: match self {
                Self::Unsupported => "pult: unsupported server request",
                Self::WrongOwner => "pult: request owner changed or does not match",
                Self::UnofferedScope => "pult: permission scope was not offered",
                Self::InvalidAnswers => "pult: invalid question answers",
                Self::Capacity => "pult: permission payload too large",
                Self::Invalid => "pult: invalid permission request",
                Self::Forbidden => "pult: tool is not permitted",
            }
            .into(),
            data: None,
        }
    }
}
#[derive(Clone, Copy)]
struct Vocab {
    yes: &'static str,
    session: &'static str,
    no: &'static str,
    cancel: &'static str,
    tool: &'static str,
    available: bool,
    legacy: bool,
}
fn vocab(method: &str) -> Option<Vocab> {
    let (yes, session, no, cancel, tool, available, legacy) = match method {
        COMMAND => (
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
            "commandExecution",
            true,
            false,
        ),
        FILE_CHANGE => (
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
            "fileChange",
            false,
            false,
        ),
        "execCommandApproval" => (
            "approved",
            "approved_for_session",
            "denied",
            "abort",
            "execCommand",
            false,
            true,
        ),
        "applyPatchApproval" => (
            "approved",
            "approved_for_session",
            "denied",
            "abort",
            "applyPatch",
            false,
            true,
        ),
        _ => return None,
    };
    Some(Vocab {
        yes,
        session,
        no,
        cancel,
        tool,
        available,
        legacy,
    })
}
/// Private native rule and owner bindings deliberately have no Debug/Serialize.
/// This is a response plan, not a response capability; the Worker must retain the
/// original generation-bound ResponsePermit and call Broker before consuming it.
pub struct Prepared {
    owner: TrustedOwner,
    request: PermissionRequest,
    plan: Plan,
}
enum Plan {
    Approval {
        vocab: Vocab,
        offered: Vec<String>,
        rule: Option<Value>,
    },
    Questions(Value),
    McpElicitation,
}
impl Prepared {
    /// Provider-controlled metadata, capped but not yet secret-redacted. Give
    /// this only to Broker::request; it is not a public Inbox representation.
    pub fn request(&self) -> PermissionRequest {
        self.request.clone()
    }
    /// Consumes the plan once. current must be freshly obtained from the host's
    /// active worker; a broker decision is not accepted across ticket reuse.
    /// updated_input never replaces a native approval's original command.
    pub fn resolve(self, current: &TrustedOwner, decision: Decision) -> Result<Value, Reject> {
        if !valid_owner(current) || current != &self.owner {
            return Err(Reject::WrongOwner);
        }
        match self.plan {
            Plan::Approval {
                vocab,
                offered,
                rule,
            } => {
                let chosen = match decision {
                    Decision::Deny { .. } => json!(vocab.no),
                    Decision::Allow {
                        scope: Scope::Once, ..
                    } => json!(if offered.iter().any(|s| s == vocab.yes) {
                        vocab.yes
                    } else {
                        vocab.no
                    }),
                    Decision::Allow {
                        scope: Scope::Session,
                        ..
                    } => {
                        if !self.request.offers.session
                            || !offered.iter().any(|s| s == vocab.session)
                        {
                            return Err(Reject::UnofferedScope);
                        }
                        json!(vocab.session)
                    }
                    Decision::Allow {
                        scope: Scope::Rule, ..
                    } => rule
                        .filter(|_| self.request.offers.rule.is_some())
                        .ok_or(Reject::UnofferedScope)?,
                };
                Ok(json!({"decision":chosen}))
            }
            Plan::McpElicitation => match decision {
                Decision::Deny { .. } => Ok(json!({"action":"decline"})),
                Decision::Allow {
                    scope: Scope::Once, ..
                } => Ok(json!({"action":"accept","content":{}})),
                Decision::Allow { .. } => Err(Reject::UnofferedScope),
            },
            Plan::Questions(questions) => match decision {
                Decision::Deny { .. } => Ok(json!({"answers":{}})),
                Decision::Allow { scope, answers, .. } => {
                    if scope != Scope::Once {
                        return Err(Reject::UnofferedScope);
                    }
                    let answers = answers.ok_or(Reject::InvalidAnswers)?;
                    validate_answers(&questions, &answers)?;
                    Ok(json!({"answers":answers}))
                }
            },
        }
    }
}
struct Budget(usize);
impl Write for Budget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::other("permission payload capacity"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn fits(value: &Value) -> bool {
    serde_json::to_writer(Budget(MAX_INPUT_BYTES), value).is_ok()
}
fn short(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
fn valid_owner(owner: &TrustedOwner) -> bool {
    owner.session.validate().is_ok()
        && owner.ticket.session() == &owner.session
        && short(&owner.thread_id)
        && short(&owner.provider_turn_id)
}
fn check_route(params: &Value, owner: &TrustedOwner, legacy: bool) -> Result<(), Reject> {
    if !valid_owner(owner) {
        return Err(Reject::WrongOwner);
    }
    let mut found = false;
    for key in if legacy {
        &["threadId", "conversationId"][..]
    } else {
        &["threadId"][..]
    } {
        if let Some(value) = params.get(key) {
            if value.as_str() != Some(&owner.thread_id) {
                return Err(Reject::WrongOwner);
            }
            found = true;
        }
    }
    if !found {
        return Err(Reject::WrongOwner);
    }
    match params.get("turnId") {
        Some(value) if value.as_str() == Some(&owner.provider_turn_id) => {}
        None if legacy => {}
        _ => return Err(Reject::WrongOwner),
    }
    Ok(())
}
fn item_id(params: &Value, legacy: bool) -> Result<String, Reject> {
    let id = if legacy {
        params.get("callId").or_else(|| params.get("itemId"))
    } else {
        params.get("itemId")
    }
    .and_then(Value::as_str)
    .filter(|s| short(s))
    .ok_or(Reject::Invalid)?;
    if legacy
        && let Some(alias) = params.get("itemId")
        && alias.as_str() != Some(id)
    {
        return Err(Reject::Invalid);
    }
    match params.get("approvalId") {
        None | Some(Value::Null) => Ok(id.into()),
        Some(Value::String(value)) if value.is_empty() => Ok(id.into()),
        Some(Value::String(value)) if short(value) => Ok(format!("{id}:{value}")),
        _ => Err(Reject::Invalid),
    }
}
fn offered(params: &Value, vocab: Vocab) -> Vec<String> {
    if !vocab.available {
        return [vocab.yes, vocab.session, vocab.no, vocab.cancel]
            .into_iter()
            .map(str::to_owned)
            .collect();
    }
    params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn cap(value: &Value, depth: usize, concealed: &mut bool) -> Result<Value, Reject> {
    if depth > 32 {
        return Err(Reject::Capacity);
    }
    match value {
        Value::String(text) if text.encode_utf16().count() > FIELD_LIMIT => {
            *concealed = true;
            // Broker uses scalar Rust strings: a UTF-16 slice ending inside an
            // astral character uses U+FFFD for the half, never silently raw data.
            let prefix = String::from_utf16_lossy(
                &text.encode_utf16().take(FIELD_LIMIT).collect::<Vec<_>>(),
            );
            Ok(json!(format!("{prefix}…(обрезано)")))
        }
        Value::Array(values) => {
            let mut out = values
                .iter()
                .take(ARRAY_LIMIT)
                .map(|v| cap(v, depth + 1, concealed))
                .collect::<Result<Vec<_>, _>>()?;
            if values.len() > ARRAY_LIMIT {
                *concealed = true;
                out.push(json!(format!("…(ещё {})", values.len() - ARRAY_LIMIT)));
            }
            Ok(Value::Array(out))
        }
        Value::Object(values) => {
            let mut out = serde_json::Map::new();
            for (key, value) in values {
                out.insert(key.clone(), cap(value, depth + 1, concealed)?);
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}
fn display(params: &Value, offered: &[String]) -> Result<(Value, bool), Reject> {
    let mut concealed = false;
    let mut out = serde_json::Map::new();
    for (key, value) in params.as_object().ok_or(Reject::Invalid)? {
        if ["threadId", "turnId", "startedAtMs", "availableDecisions"].contains(&key.as_str()) {
            continue;
        }
        out.insert(key.clone(), cap(value, 0, &mut concealed)?);
    }
    out.insert("availableDecisions".into(), json!(offered));
    let input = Value::Object(out);
    if !fits(&input) {
        return Err(Reject::Capacity);
    }
    Ok((input, concealed))
}
fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|key| o.contains_key(*key)))
}
fn strings(value: &Value) -> Option<Vec<&str>> {
    value
        .as_array()
        .filter(|a| !a.is_empty())?
        .iter()
        .map(|v| v.as_str().filter(|s| !s.is_empty()))
        .collect()
}
fn shell_join(argv: &[&str]) -> String {
    argv.iter()
        .map(|arg| {
            if !arg.is_empty()
                && arg
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-./=:@%+,".contains(&c))
            {
                (*arg).into()
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}
fn rule_offer(params: &Value) -> Option<(Rule, Value)> {
    let candidates = params.get("availableDecisions")?.as_array()?;
    if let Some(proposal) = params.get("proposedExecpolicyAmendment").and_then(strings) {
        for candidate in candidates {
            let body = &candidate["acceptWithExecpolicyAmendment"];
            if exact_keys(candidate, &["acceptWithExecpolicyAmendment"])
                && exact_keys(body, &["execpolicy_amendment"])
                && strings(&body["execpolicy_amendment"]).as_ref() == Some(&proposal)
            {
                return Some((
                    Rule {
                        kind: RuleKind::Execpolicy,
                        label: shell_join(&proposal),
                        note: CODEX_EXEC_RULE_NOTE.into(),
                    },
                    candidate.clone(),
                ));
            }
        }
    }
    let proposed = params.get("proposedNetworkPolicyAmendments")?.as_array()?;
    for candidate in candidates {
        let body = &candidate["applyNetworkPolicyAmendment"];
        let amendment = &body["network_policy_amendment"];
        let host = amendment["host"].as_str().filter(|s| !s.is_empty());
        if exact_keys(candidate, &["applyNetworkPolicyAmendment"])
            && exact_keys(body, &["network_policy_amendment"])
            && exact_keys(amendment, &["host", "action"])
            && amendment["action"] == "allow"
            && let Some(host) = host
            && proposed.iter().any(|p| {
                p.get("action") == Some(&json!("allow"))
                    && p.get("host").and_then(Value::as_str) == Some(host)
            })
        {
            return Some((
                Rule {
                    kind: RuleKind::Network,
                    label: host.into(),
                    note: CODEX_NET_RULE_NOTE.into(),
                },
                candidate.clone(),
            ));
        }
    }
    None
}

/// Trusted, host-captured fallback from an unfinished MCP item in this same
/// thread/turn. Do not construct owner from elicitation params. No Debug/Serialize:
/// arguments may contain private material and are only broker input.
pub struct PendingMcpCall {
    pub owner: TrustedOwner,
    pub server: String,
    pub tool: String,
    pub arguments: Value,
}
/// Optional metadata from the host's native request envelope and live item map.
/// request_id is String(native JSON-RPC id), solely for display correlation;
/// response authority always remains the original generation-bound permit.
#[derive(Default)]
pub struct McpApprovalContext {
    pub request_id: Option<String>,
    pub pending: Option<PendingMcpCall>,
}
/// Node's known tool-approval elicitation, with once-only decisions. Missing
/// turnId binds to the captured current ticket; supplied turnId must match.
/// Compared with Node, malformed schema/required/string metadata is rejected
/// rather than guessed. Generic required-field forms remain unsupported. Tool
/// names must fit the broker's 256-byte bound and contain no control characters;
/// trusted native display ids use the existing nonempty 512-byte id bound.
/// Stale/mismatched pending context is rejected rather than silently ignored.
///
/// Worker bridge TODO: accept this missing-turn variant using its captured owner,
/// pass outer request id and same-owner pending item, and handle static_response
/// before RPC errors. This pure mapper does not make that integration automatic.
pub fn prepare_mcp_tool_approval(
    params: &Value,
    owner: TrustedOwner,
    context: McpApprovalContext,
) -> Result<Prepared, Reject> {
    if !params.is_object() {
        return Err(Reject::Invalid);
    }
    if !fits(params) {
        return Err(Reject::Capacity);
    }
    let meta = params
        .get("_meta")
        .and_then(Value::as_object)
        .ok_or(Reject::Unsupported)?;
    if meta.get("codex_approval_kind").and_then(Value::as_str) != Some("mcp_tool_call") {
        return Err(Reject::Unsupported);
    }
    if params
        .get("mode")
        .is_some_and(|v| v.as_str() != Some("form"))
    {
        return Err(Reject::Unsupported);
    }
    if let Some(schema) = params.get("requestedSchema") {
        let schema = schema.as_object().ok_or(Reject::Invalid)?;
        if let Some(required) = schema.get("required") {
            let required = required.as_array().ok_or(Reject::Invalid)?;
            if !required.is_empty() {
                return Err(Reject::Unsupported);
            }
        }
    }
    // Unlike legacy requests, no conversationId alias is recognized here.
    if !valid_owner(&owner)
        || params.get("threadId").and_then(Value::as_str) != Some(&owner.thread_id)
        || params
            .get("turnId")
            .is_some_and(|v| v.as_str() != Some(&owner.provider_turn_id))
    {
        return Err(Reject::WrongOwner);
    }
    for key in ["serverName", "message"] {
        if params.get(key).is_some_and(|v| !v.is_string()) {
            return Err(Reject::Invalid);
        }
    }
    for key in ["tool_name", "toolName", "tool", "tool_title"] {
        if meta.get(key).is_some_and(|v| !v.is_string()) {
            return Err(Reject::Invalid);
        }
    }
    let server = params
        .get("serverName")
        .and_then(Value::as_str)
        .unwrap_or("mcp");
    let message = params.get("message").and_then(Value::as_str);
    let from_message = message.and_then(|s| {
        s.match_indices("run tool \"").find_map(|(start, prefix)| {
            let tail = &s[start + prefix.len()..];
            let end = tail.find('"')?;
            (end > 0).then_some(&tail[..end])
        })
    });
    let meta_tool = ["tool_name", "toolName", "tool"]
        .into_iter()
        .find_map(|key| meta.get(key).and_then(Value::as_str))
        .or(from_message);
    // Refuse stale context even if params could supply all display fields: no
    // prior ticket's private arguments may be repurposed by this preparation.
    if let Some(pending) = &context.pending {
        if pending.owner != owner
            || pending.server != server
            || meta_tool.is_some_and(|tool| tool != pending.tool)
        {
            return Err(Reject::WrongOwner);
        }
        if !fits(&pending.arguments) {
            return Err(Reject::Capacity);
        }
    }
    let tool = meta_tool
        .or_else(|| context.pending.as_ref().map(|p| p.tool.as_str()))
        .or_else(|| meta.get("tool_title").and_then(Value::as_str))
        .unwrap_or("tool");
    if server == "pult_browser"
        && [
            "browser_run_code_unsafe",
            "browser_run_code",
            "browser_evaluate",
        ]
        .contains(&tool)
    {
        return Err(Reject::Forbidden);
    }
    if server.len() > 256 || tool.len() > 256 {
        return Err(Reject::Invalid);
    }
    let tool_name = format!("mcp__{server}__{tool}");
    if tool_name.len() > 256 || tool_name.chars().any(char::is_control) {
        return Err(Reject::Invalid);
    }
    let args = ["tool_params", "arguments", "tool_arguments"]
        .into_iter()
        .filter_map(|key| meta.get(key))
        .find(|v| !v.is_null())
        .or_else(|| context.pending.as_ref().map(|p| &p.arguments))
        .filter(|v| !v.is_null());
    let mut raw_input = json!({"arguments": args.cloned().unwrap_or_else(|| json!("аргументы не пришли — Codex не прислал их ни в вопросе, ни в начале вызова"))});
    if let Some(message) = message {
        raw_input["message"] = json!(message);
    }
    let (input, concealed) = display(&raw_input, &["accept".into(), "decline".into()])?;
    let tool_use_id = match (params.get("turnId"), context.request_id) {
        (_, Some(ref id)) if !short(id) => return Err(Reject::Invalid),
        (Some(_), Some(id)) => Some(format!("{}:{id}", owner.provider_turn_id)),
        _ => None,
    };
    let request = PermissionRequest {
        session_id: owner.session.name.clone(),
        tool_name,
        tool_use_id,
        input,
        offers: Offers::default(),
        concealed,
    };
    Ok(Prepared {
        owner,
        request,
        plan: Plan::McpElicitation,
    })
}

/// Unknown requests and generic elicitation produce a static protocol error.
/// Known MCP tool approvals use empty fallback context here; hosts with captured
/// pending-call metadata should use prepare_mcp_tool_approval instead.
pub fn prepare(
    method: &str,
    params: &Value,
    owner: TrustedOwner,
    capabilities: Capabilities,
) -> Result<Prepared, Reject> {
    if method == MCP_ELICITATION {
        return prepare_mcp_tool_approval(params, owner, McpApprovalContext::default());
    }
    let vocabulary = vocab(method);
    if vocabulary.is_none() && method != USER_INPUT {
        return Err(Reject::Unsupported);
    }
    if !params.is_object() {
        return Err(Reject::Invalid);
    }
    if !fits(params) {
        return Err(Reject::Capacity);
    }
    let legacy = vocabulary.is_some_and(|v| v.legacy);
    check_route(params, &owner, legacy)?;
    let tool_use_id = Some(item_id(params, legacy)?);
    let (tool, input, offers, concealed, plan) = if method == USER_INPUT {
        let questions = params
            .get("questions")
            .filter(|v| v.is_array())
            .ok_or(Reject::InvalidAnswers)?
            .clone();
        // Validate the parts Broker uses without guessing required display text.
        for q in questions.as_array().unwrap() {
            if q.get("id").and_then(Value::as_str).is_none() {
                return Err(Reject::InvalidAnswers);
            }
        }
        let mut input = json!({"questions":questions});
        if let Some(blocking) = params.get("isBlocking") {
            if !blocking.is_boolean() {
                return Err(Reject::Invalid);
            }
            input["isBlocking"] = blocking.clone();
        }
        (
            "requestUserInput",
            input,
            Offers::default(),
            false,
            Plan::Questions(questions),
        )
    } else {
        let vocab = vocabulary.ok_or(Reject::Unsupported)?;
        let offered = offered(params, vocab);
        let (input, concealed) = display(params, &offered)?;
        let mut offers = Offers {
            session: offered.iter().any(|s| s == vocab.session),
            rule: None,
        };
        let mut rule = None;
        if method == COMMAND
            && capabilities.persistent_rules
            && let Some((description, native)) = rule_offer(params)
        {
            offers.rule = Some(description);
            rule = Some(native);
        }
        (
            vocab.tool,
            input,
            offers,
            concealed,
            Plan::Approval {
                vocab,
                offered,
                rule,
            },
        )
    };
    let request = PermissionRequest {
        session_id: owner.session.name.clone(),
        tool_name: tool.into(),
        tool_use_id,
        input,
        offers,
        concealed,
    };
    Ok(Prepared {
        owner,
        request,
        plan,
    })
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn validate_answers(questions: &Value, answers: &Value) -> Result<(), Reject> {
    if !fits(answers) {
        return Err(Reject::Capacity);
    }
    let answers = answers.as_object().ok_or(Reject::InvalidAnswers)?;
    let mut ids = HashSet::new();
    for q in questions.as_array().ok_or(Reject::InvalidAnswers)? {
        let id = q
            .get("id")
            .and_then(Value::as_str)
            .ok_or(Reject::InvalidAnswers)?;
        ids.insert(id);
        let answer = answers
            .get(id)
            .and_then(|v| v.get("answers"))
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .ok_or(Reject::InvalidAnswers)?;
        if answer.iter().any(|v| {
            v.as_str()
                .is_none_or(|s| s.trim_matches(js_space).is_empty())
        }) {
            return Err(Reject::InvalidAnswers);
        }
        if let Some(options) = q
            .get("options")
            .and_then(Value::as_array)
            .filter(|o| !o.is_empty())
            && !truthy(q.get("isOther"))
            && answer
                .iter()
                .any(|a| !options.iter().any(|o| o.get("label") == Some(a)))
        {
            return Err(Reject::InvalidAnswers);
        }
    }
    if answers.keys().any(|k| !ids.contains(k.as_str())) {
        return Err(Reject::InvalidAnswers);
    }
    Ok(())
}
