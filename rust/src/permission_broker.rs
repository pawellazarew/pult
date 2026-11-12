//! Bounded ordinary permission Inbox. Durable requested/resolved receipts precede
//! publication/allow. Unlike Node's finally-settle, uncertain storage never grants:
//! it latches the broker and denies all askers. Host integration must propagate
//! that latch to the driver's global storage fault policy. No RPC, rule persistence
//! or real provider is installed here. Hosts install panic_guard before callbacks.
//! Cancellation during a pending resolved-allow commit returns deny immediately;
//! the already-started audit write may still say allow. There is never a second
//! resolved event. The host must retire the departed provider independently.
use crate::turn_driver::{EventSink, Receipt};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::task::JoinSet;
use tokio::time::Instant;

pub const MAX_PENDING: usize = 128;
pub const MAX_INPUT_BYTES: usize = 256 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);
const SAFE_ID: u64 = 9_007_199_254_740_991;
const SETTLED: u8 = 4;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokerError {
    Invalid,
    Capacity,
    Closed,
    StorageUnavailable,
    InvalidScope,
    InvalidAnswers,
}
impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for BrokerError {}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope {
    Once,
    Session,
    Rule,
}
impl Scope {
    fn name(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Session => "session",
            Self::Rule => "rule",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleKind {
    Execpolicy,
    Network,
}
impl RuleKind {
    fn name(self) -> &'static str {
        match self {
            Self::Execpolicy => "execpolicy",
            Self::Network => "network",
        }
    }
}
#[derive(Clone)]
pub struct Rule {
    pub kind: RuleKind,
    pub label: String,
    pub note: String,
}
#[derive(Clone, Default)]
pub struct Offers {
    pub session: bool,
    pub rule: Option<Rule>,
}
#[derive(Clone)]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_name: String,
    pub tool_use_id: Option<String>,
    pub input: Value,
    pub offers: Offers,
    pub concealed: bool,
}
/// Provider result. Deliberately omits Debug: approved input/answers can contain
/// secrets. Only the requester receives this value; public metadata is separate.
#[derive(Clone)]
pub enum Decision {
    Allow {
        scope: Scope,
        updated_input: Option<Value>,
        answers: Option<Value>,
    },
    Deny {
        message: String,
    },
}
impl Decision {
    pub fn allow(scope: Scope) -> Self {
        Self::Allow {
            scope,
            updated_input: None,
            answers: None,
        }
    }
    pub fn deny() -> Self {
        Self::Deny {
            message: "pult: отказано".into(),
        }
    }
    fn value(&self) -> Value {
        match self {
            Self::Allow {
                scope,
                updated_input,
                answers,
            } => json!({"scope":scope.name(),"updatedInput":updated_input,"answers":answers}),
            Self::Deny { message } => json!({"message":message}),
        }
    }
}
pub type ValueRedactor = Arc<dyn Fn(&Value) -> Value + Send + Sync>;
pub type StringRedactor = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub struct Redactors {
    pub value: ValueRedactor,
    pub string: StringRedactor,
}
#[derive(Clone, Copy)]
pub struct Options {
    pub pending: usize,
    pub timeout: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            pending: MAX_PENDING,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}
struct Control {
    session: String,
    sequence: u64,
    created: Instant,
    cancelled: AtomicU8,
    public: Mutex<Option<Value>>,
}
struct Shared {
    commands: mpsc::Sender<Command>,
    controls: Mutex<HashMap<String, Arc<Control>>>,
    slots: Arc<Semaphore>,
    notify: Notify,
    changed: Notify,
    closed: AtomicBool,
    failed: AtomicBool,
    // Serializes successful settlement against global storage fault/shutdown.
    // Per-question cancellation competes with the SETTLED CAS under this gate.
    settlement: Mutex<()>,
    sequence: AtomicU64,
    generation: String,
    redactors: Redactors,
    timeout: Duration,
}
struct Admission(Arc<Shared>);
impl Drop for Admission {
    fn drop(&mut self) {
        close(&self.0);
    }
}
#[derive(Clone)]
pub struct Broker {
    admission: Arc<Admission>,
}
pub struct RequestHandle {
    id: String,
    control: Arc<Control>,
    shared: Arc<Shared>,
    receiver: Option<oneshot::Receiver<Decision>>,
}
impl RequestHandle {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub async fn decision(&mut self) -> Decision {
        let _cancel_on_drop = DecisionWait {
            control: self.control.clone(),
            shared: self.shared.clone(),
        };
        match self.receiver.take() {
            Some(receiver) => receiver.await.unwrap_or_else(|_| storage_deny()),
            None => Decision::deny(),
        }
    }
}
struct DecisionWait {
    control: Arc<Control>,
    shared: Arc<Shared>,
}
impl Drop for DecisionWait {
    fn drop(&mut self) {
        cancel(&self.control, 1);
        self.shared.notify.notify_one();
    }
}
impl Drop for RequestHandle {
    fn drop(&mut self) {
        cancel(&self.control, 1);
        self.shared.notify.notify_one();
    }
}
/// Dropping a resolution waiter does not cancel its owned journal operation.
pub struct Resolution(oneshot::Receiver<Result<bool, BrokerError>>);
impl Resolution {
    pub async fn wait(self) -> Result<bool, BrokerError> {
        self.0.await.unwrap_or(Err(BrokerError::Closed))
    }
}
struct Entry {
    id: String,
    request: PermissionRequest,
    card: Value,
    control: Arc<Control>,
    created: Instant,
    deadline: Instant,
    asker: Option<oneshot::Sender<Decision>>,
    stage: Stage,
    // An event observer may answer before the actor receives Requested's
    // receipt. Keep only its first validated choice; start no resolved IO yet.
    pending_choice: Option<PendingChoice>,
    _slot: OwnedSemaphorePermit,
}
struct PendingChoice {
    decision: Decision,
    by: String,
    reply: oneshot::Sender<Result<bool, BrokerError>>,
}
enum Stage {
    Requesting,
    Visible,
    Resolving {
        decision: Decision,
        reply: Option<oneshot::Sender<Result<bool, BrokerError>>>,
    },
}
enum Command {
    Request(Box<Entry>),
    Resolve {
        id: String,
        decision: Decision,
        by: String,
        reply: oneshot::Sender<Result<bool, BrokerError>>,
    },
}
#[derive(Clone, Copy)]
enum Phase {
    Requested,
    Resolved,
}
type IoResult = (String, Phase, Result<Receipt, BrokerError>);
fn cancel(control: &Control, reason: u8) {
    let _ = control
        .cancelled
        .compare_exchange(0, reason, Ordering::SeqCst, Ordering::SeqCst);
}
fn bounded(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|b| b.len() <= MAX_INPUT_BYTES)
}
fn public_string(shared: &Shared, text: &str) -> Result<String, BrokerError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (shared.redactors.string)(text)
    }))
    .map_err(|_| BrokerError::Invalid)
}
fn public_value(shared: &Shared, value: &Value) -> Result<Value, BrokerError> {
    let value = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (shared.redactors.value)(value)
    }))
    .map_err(|_| BrokerError::Invalid)?;
    if !bounded(&value) {
        return Err(BrokerError::Invalid);
    }
    Ok(value)
}
fn storage_deny() -> Decision {
    Decision::Deny {
        message: "pult: журнал недоступен — отказ".into(),
    }
}
fn cancellation_deny(reason: u8) -> Decision {
    Decision::Deny {
        message: match reason {
            2 => "pult: демон останавливается",
            3 => "pult: никто не ответил — отказ по таймауту",
            _ => "pult: процесс агента завершился",
        }
        .into(),
    }
}
impl Broker {
    pub fn new(
        sink: Arc<dyn EventSink>,
        redactors: Redactors,
        options: Options,
    ) -> Result<Self, BrokerError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| BrokerError::Invalid)?;
        if options.pending == 0
            || options.pending > MAX_PENDING
            || options.timeout.is_zero()
            || options.timeout > DEFAULT_TIMEOUT
        {
            return Err(BrokerError::Invalid);
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| BrokerError::Invalid)?;
        let generation = random.iter().map(|b| format!("{b:02x}")).collect();
        let (commands, receiver) = mpsc::channel(MAX_PENDING);
        let shared = Arc::new(Shared {
            commands,
            controls: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(options.pending)),
            notify: Notify::new(),
            changed: Notify::new(),
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            settlement: Mutex::new(()),
            sequence: AtomicU64::new(1),
            generation,
            redactors,
            timeout: options.timeout,
        });
        runtime.spawn(run(shared.clone(), receiver, sink));
        Ok(Self {
            admission: Arc::new(Admission(shared)),
        })
    }
    fn shared(&self) -> &Arc<Shared> {
        &self.admission.0
    }
    pub fn storage_failed(&self) -> bool {
        self.shared().failed.load(Ordering::SeqCst)
    }
    pub fn request(&self, request: PermissionRequest) -> Result<RequestHandle, BrokerError> {
        let shared = self.shared();
        if shared.failed.load(Ordering::SeqCst) {
            return Err(BrokerError::StorageUnavailable);
        }
        if shared.closed.load(Ordering::SeqCst) {
            return Err(BrokerError::Closed);
        }
        if !crate::session_model::is_name(&request.session_id)
            || request.tool_name.is_empty()
            || request.tool_name.len() > 256
            || request
                .tool_use_id
                .as_ref()
                .is_some_and(|id| id.len() > 4096)
            || !request.input.is_object()
            || !bounded(&request.input)
        {
            return Err(BrokerError::Invalid);
        }
        let slot = shared
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| BrokerError::Capacity)?;
        let seq = shared
            .sequence
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n <= SAFE_ID).then_some(n + 1)
            })
            .map_err(|_| BrokerError::Capacity)?;
        let id = format!("p{seq}-{}", shared.generation);
        let input = public_value(shared, &request.input)?;
        if !input.is_object() {
            return Err(BrokerError::Invalid);
        }
        let mut offers = json!({});
        if request.offers.session {
            offers["session"] = json!(true);
        }
        if let Some(rule) = &request.offers.rule {
            if rule.label.len() + rule.note.len() > MAX_INPUT_BYTES {
                return Err(BrokerError::Invalid);
            }
            if public_string(shared, &rule.label)? == rule.label {
                offers["rule"] =
                    json!({"kind":rule.kind.name(),"label":rule.label,"note":rule.note});
            }
        }
        let public_offers = public_value(shared, &offers)?;
        // Redaction cannot add capability width, or hide a rule's actual label.
        if request.offers.session && public_offers.get("session") == Some(&Value::Bool(true)) {
            offers["session"] = json!(true);
        } else {
            offers.as_object_mut().unwrap().remove("session");
        }
        if offers.get("rule").is_some()
            && public_offers.get("rule").and_then(|v| v.get("label"))
                == offers.get("rule").and_then(|v| v.get("label"))
        {
            offers["rule"] = public_offers["rule"].clone();
        } else {
            offers.as_object_mut().unwrap().remove("rule");
        }
        let mut card = json!({"id":id,"sessionId":request.session_id,"toolName":public_string(shared,&request.tool_name)?,"input":input,"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        if let Some(tool_id) = &request.tool_use_id {
            card["toolUseId"] = json!(public_string(shared, tool_id)?);
        }
        if offers.as_object().is_some_and(|o| !o.is_empty()) {
            card["offers"] = offers;
        }
        if request.concealed || card["input"] != request.input {
            card["concealed"] = json!(true);
        }
        if !bounded(&card) {
            return Err(BrokerError::Invalid);
        }
        let created = Instant::now();
        let control = Arc::new(Control {
            session: request.session_id.clone(),
            sequence: seq,
            created,
            cancelled: AtomicU8::new(0),
            public: Mutex::new(None),
        });
        let (asker, receiver) = oneshot::channel();
        let entry = Entry {
            id: id.clone(),
            request,
            card,
            control: control.clone(),
            created,
            deadline: created + shared.timeout,
            asker: Some(asker),
            stage: Stage::Requesting,
            pending_choice: None,
            _slot: slot,
        };
        shared
            .controls
            .lock()
            .expect("permission controls")
            .insert(id.clone(), control.clone());
        if shared
            .commands
            .try_send(Command::Request(Box::new(entry)))
            .is_err()
        {
            shared
                .controls
                .lock()
                .expect("permission controls")
                .remove(&id);
            shared.changed.notify_waiters();
            return Err(BrokerError::Capacity);
        }
        Ok(RequestHandle {
            id,
            control,
            shared: shared.clone(),
            receiver: Some(receiver),
        })
    }
    pub fn list(&self, session: Option<&str>) -> Vec<Value> {
        if self.shared().failed.load(Ordering::SeqCst)
            || self.shared().closed.load(Ordering::SeqCst)
        {
            return vec![];
        }
        let mut out: Vec<_> = self
            .shared()
            .controls
            .lock()
            .expect("permission controls")
            .values()
            .filter(|c| session.is_none_or(|s| s == c.session))
            .filter(|c| c.cancelled.load(Ordering::SeqCst) == 0)
            .filter_map(|c| {
                c.public
                    .lock()
                    .expect("permission public")
                    .clone()
                    .map(|mut card| {
                        card["waitingMs"] =
                            json!(c.created.elapsed().as_millis().min(SAFE_ID as u128) as u64);
                        (c.sequence, card)
                    })
            })
            .collect();
        out.sort_by_key(|(sequence, _)| *sequence);
        out.into_iter().map(|(_, card)| card).collect()
    }
    pub fn pending_count(&self) -> usize {
        self.list(None).len()
    }
    /// Includes unpublished requests and unresolved owned journal writes.
    pub fn reserved_count(&self) -> usize {
        self.shared()
            .controls
            .lock()
            .expect("permission controls")
            .len()
    }
    /// Wait for known journal outcomes. A hung append deliberately retains its
    /// bounded reservation; hosts may impose their own shutdown deadline.
    pub async fn drain(&self) {
        loop {
            let notified = self.shared().changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.reserved_count() == 0 {
                return;
            }
            notified.await;
        }
    }
    /// Starts an owned resolution now. Invalid scope/answers keep the card open.
    /// updated_input is a trusted host override, not an RPC command replacement.
    pub fn resolve(
        &self,
        id: &str,
        decision: Decision,
        by: &str,
    ) -> Result<Resolution, BrokerError> {
        if self.storage_failed() {
            return Err(BrokerError::StorageUnavailable);
        }
        if id.len() > 128 || by.len() > 1024 || !bounded(&decision.value()) {
            return Err(BrokerError::Invalid);
        }
        let (reply, receiver) = oneshot::channel();
        self.shared()
            .commands
            .try_send(Command::Resolve {
                id: id.into(),
                decision,
                by: by.into(),
                reply,
            })
            .map_err(|_| BrokerError::Capacity)?;
        Ok(Resolution(receiver))
    }
    pub fn provider_gone(&self, session: &str) -> usize {
        let mut n = 0;
        for control in self
            .shared()
            .controls
            .lock()
            .expect("permission controls")
            .values()
        {
            if control.session == session {
                cancel(control, 1);
                n += 1;
            }
        }
        self.shared().notify.notify_one();
        n
    }
    pub fn shutdown(&self) -> usize {
        close(self.shared());
        let n = self
            .shared()
            .controls
            .lock()
            .expect("permission controls")
            .len();
        self.shared().notify.notify_one();
        n
    }
}
fn answer(entry: &mut Entry, decision: Decision) {
    if let Some(asker) = entry.asker.take() {
        let _ = asker.send(decision);
    }
}
fn reject_pending(entry: &mut Entry, result: Result<bool, BrokerError>) {
    if let Some(choice) = entry.pending_choice.take() {
        let _ = choice.reply.send(result);
    }
}
fn close(shared: &Shared) {
    {
        let _settlement = shared.settlement.lock().expect("permission settlement");
        shared.closed.store(true, Ordering::SeqCst);
    }
    shared.notify.notify_one();
}
fn storage_fault(shared: &Shared) {
    {
        let _settlement = shared.settlement.lock().expect("permission settlement");
        shared.failed.store(true, Ordering::SeqCst);
    }
    shared.notify.notify_one();
}
fn remove(shared: &Shared, entries: &mut HashMap<String, Entry>, id: &str) {
    entries.remove(id);
    shared
        .controls
        .lock()
        .expect("permission controls")
        .remove(id);
    shared.changed.notify_waiters();
}
fn hide(entry: &Entry) {
    *entry.control.public.lock().expect("permission public") = None;
}
fn journal(
    tasks: &mut JoinSet<IoResult>,
    sink: &Arc<dyn EventSink>,
    shared: &Arc<Shared>,
    id: String,
    phase: Phase,
    draft: Value,
) {
    let sink = sink.clone();
    let shared = shared.clone();
    tasks.spawn(async move {
        // Isolate sink construction and future panic; never abort an owned write.
        let result = tokio::spawn(async move { sink.append(draft).await }).await;
        let result = match result {
            Ok(Ok(receipt))
                if receipt.id > 0
                    && receipt.id <= SAFE_ID
                    && !receipt.ts.is_empty()
                    && receipt.ts.len() <= 128 =>
            {
                Ok(receipt)
            }
            _ => Err(BrokerError::StorageUnavailable),
        };
        if result.is_err() {
            storage_fault(&shared);
        }
        (id, phase, result)
    });
}
fn requested(entry: &Entry) -> Value {
    let mut data = entry.card.clone();
    let data = data.as_object_mut().expect("permission card");
    data.remove("sessionId");
    data.remove("createdAt");
    json!({"sessionId":entry.request.session_id,"provider":"pult","kind":"permission.requested","data":data})
}
fn finish_begin(
    entry: &mut Entry,
    decision: Decision,
    by: String,
    reply: Option<oneshot::Sender<Result<bool, BrokerError>>>,
    shared: &Arc<Shared>,
    sink: &Arc<dyn EventSink>,
    tasks: &mut JoinSet<IoResult>,
) {
    hide(entry);
    let mut data = json!({"id":entry.id,"toolName":entry.card["toolName"],"by":by,"waitingMs":entry.created.elapsed().as_millis().min(SAFE_ID as u128) as u64});
    if let Some(id) = entry.card.get("toolUseId") {
        data["toolUseId"] = id.clone();
    }
    match &decision {
        Decision::Allow { scope, .. } => {
            data["decision"] = json!("allow");
            data["scope"] = json!(scope.name());
            if *scope == Scope::Rule
                && let Some(rule) = entry.card.get("offers").and_then(|v| v.get("rule"))
            {
                data["rule"] = json!({"kind":rule["kind"],"label":rule["label"]});
            }
        }
        Decision::Deny { message } => {
            data["decision"] = json!("deny");
            data["message"] = json!(message);
        }
    }
    let draft = json!({"sessionId":entry.request.session_id,"provider":"pult","kind":"permission.resolved","data":data});
    // All variable public fields were redacted at admission/selection.
    entry.stage = Stage::Resolving { decision, reply };
    journal(
        tasks,
        sink,
        shared,
        entry.id.clone(),
        Phase::Resolved,
        draft,
    );
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
fn answers<'a>(raw: &'a Value, key: &str) -> Result<&'a Vec<Value>, BrokerError> {
    raw.get(key)
        .and_then(|a| a.get("answers"))
        .and_then(Value::as_array)
        .filter(|a| {
            !a.is_empty()
                && a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|s| !s.trim_matches(js_space).is_empty())
                })
        })
        .ok_or(BrokerError::InvalidAnswers)
}
fn validate(entry: &Entry, decision: Decision, shared: &Shared) -> Result<Decision, BrokerError> {
    let Decision::Allow {
        scope,
        updated_input,
        answers: given,
    } = decision
    else {
        let Decision::Deny { message } = decision else {
            unreachable!()
        };
        let message = public_string(shared, &message)?;
        if message.len() > MAX_INPUT_BYTES {
            return Err(BrokerError::Invalid);
        }
        return Ok(Decision::Deny { message });
    };
    if entry.request.tool_name == "requestUserInput" {
        let questions = entry
            .request
            .input
            .get("questions")
            .and_then(Value::as_array)
            .ok_or(BrokerError::InvalidAnswers)?;
        let given = given
            .filter(Value::is_object)
            .ok_or(BrokerError::InvalidAnswers)?;
        let mut ids = HashSet::new();
        for q in questions {
            let id = q
                .get("id")
                .and_then(Value::as_str)
                .ok_or(BrokerError::InvalidAnswers)?;
            ids.insert(id);
            let selected = answers(&given, id)?;
            if let Some(options) = q
                .get("options")
                .and_then(Value::as_array)
                .filter(|o| !o.is_empty())
                && !truthy(q.get("isOther"))
                && selected
                    .iter()
                    .any(|answer| !options.iter().any(|o| o.get("label") == Some(answer)))
            {
                return Err(BrokerError::InvalidAnswers);
            }
        }
        if given
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !ids.contains(k.as_str()))
        {
            return Err(BrokerError::InvalidAnswers);
        }
        return Ok(Decision::Allow {
            scope: Scope::Once,
            updated_input: None,
            answers: Some(given),
        });
    }
    if entry.request.tool_name == "AskUserQuestion" && given.is_some() {
        let questions = entry
            .request
            .input
            .get("questions")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let given = given
            .filter(Value::is_object)
            .ok_or(BrokerError::InvalidAnswers)?;
        let mut out = serde_json::Map::new();
        for q in questions {
            let question = q
                .get("question")
                .and_then(Value::as_str)
                .ok_or(BrokerError::InvalidAnswers)?;
            let selected = answers(&given, question)?;
            if q.get("multiSelect") != Some(&Value::Bool(true)) && selected.len() > 1 {
                return Err(BrokerError::InvalidAnswers);
            }
            out.insert(
                question.into(),
                Value::String(
                    selected
                        .iter()
                        .map(|v| v.as_str().unwrap().trim_matches(js_space))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            );
        }
        if given
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !out.contains_key(k))
        {
            return Err(BrokerError::InvalidAnswers);
        }
        let mut updated = entry.request.input.clone();
        updated["answers"] = Value::Object(out);
        if !bounded(&updated) {
            return Err(BrokerError::InvalidAnswers);
        }
        return Ok(Decision::Allow {
            scope: Scope::Once,
            updated_input: Some(updated),
            answers: None,
        });
    }
    let offers = entry.card.get("offers");
    if (scope == Scope::Session
        && offers.and_then(|o| o.get("session")) != Some(&Value::Bool(true)))
        || (scope == Scope::Rule && offers.and_then(|o| o.get("rule")).is_none())
    {
        return Err(BrokerError::InvalidScope);
    }
    let updated = updated_input.unwrap_or_else(|| entry.request.input.clone());
    if !updated.is_object() {
        return Err(BrokerError::Invalid);
    }
    Ok(Decision::Allow {
        scope,
        updated_input: Some(updated),
        answers: None,
    })
}
async fn run(shared: Arc<Shared>, mut commands: mpsc::Receiver<Command>, sink: Arc<dyn EventSink>) {
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut tasks = JoinSet::new();
    loop {
        let failed = shared.failed.load(Ordering::SeqCst);
        let closed = shared.closed.load(Ordering::SeqCst);
        let mut remove_ids = Vec::new();
        for entry in entries.values_mut() {
            if closed {
                cancel(&entry.control, 2);
            }
            if Instant::now() >= entry.deadline {
                cancel(&entry.control, 3);
            }
            let reason = entry.control.cancelled.load(Ordering::SeqCst);
            if failed {
                hide(entry);
                answer(entry, storage_deny());
                reject_pending(entry, Err(BrokerError::StorageUnavailable));
                if matches!(entry.stage, Stage::Visible) {
                    remove_ids.push(entry.id.clone());
                }
            } else if reason != 0 {
                hide(entry);
                answer(entry, cancellation_deny(reason));
                reject_pending(entry, Ok(false));
                if matches!(entry.stage, Stage::Visible) {
                    let by = match reason {
                        2 => "shutdown",
                        3 => "timeout",
                        _ => "provider_gone",
                    };
                    finish_begin(
                        entry,
                        cancellation_deny(reason),
                        by.into(),
                        None,
                        &shared,
                        &sink,
                        &mut tasks,
                    );
                }
            }
        }
        for id in remove_ids {
            remove(&shared, &mut entries, &id);
        }
        if (closed || failed)
            && shared
                .controls
                .lock()
                .expect("permission controls")
                .is_empty()
            && tasks.is_empty()
        {
            break;
        }
        let deadline = entries
            .values()
            .filter(|e| e.control.cancelled.load(Ordering::SeqCst) == 0)
            .map(|e| e.deadline)
            .min()
            .unwrap_or(Instant::now() + DEFAULT_TIMEOUT);
        tokio::select! {
            _=shared.notify.notified()=>{},
            _=tokio::time::sleep_until(deadline)=>{},
            result=tasks.join_next(),if !tasks.is_empty()=>{
                let Some(Ok((id,phase,result)))=result else {storage_fault(&shared);continue;};
                if result.is_err() {storage_fault(&shared);}
                let Some(entry)=entries.get_mut(&id) else {continue;};
                if shared.failed.load(Ordering::SeqCst) {
                    answer(entry,storage_deny());reject_pending(entry,Err(BrokerError::StorageUnavailable));if let Stage::Resolving {reply:Some(reply),..}=std::mem::replace(&mut entry.stage,Stage::Visible) {let _=reply.send(Err(BrokerError::StorageUnavailable));}
                    remove(&shared,&mut entries,&id);continue;
                }
                if shared.closed.load(Ordering::SeqCst) {cancel(&entry.control,2);}
                if Instant::now()>=entry.deadline {cancel(&entry.control,3);}
                let reason=entry.control.cancelled.load(Ordering::SeqCst);
                match phase {
                    Phase::Requested=>{
                        entry.stage=Stage::Visible;
                        if reason==0 {
                            if let Some(choice)=entry.pending_choice.take() {
                                // The requested write is now known. Only now may
                                // its first validated choice start resolved IO.
                                finish_begin(entry,choice.decision,choice.by,Some(choice.reply),&shared,&sink,&mut tasks);
                            } else {*entry.control.public.lock().expect("permission public")=Some(entry.card.clone());}
                        } else {reject_pending(entry,Ok(false));}
                        // Cancellation is handled at the top before any next command.
                    },
                    Phase::Resolved=>{
                        // This is the grant linearization boundary. No await,
                        // IO or callback under the gate. Fault/shutdown cannot
                        // publish until send finishes; cancellation can win only
                        // by changing 0 before the SETTLED CAS below.
                        let _settlement=shared.settlement.lock().expect("permission settlement");
                        if let Stage::Resolving {decision,reply}=std::mem::replace(&mut entry.stage,Stage::Visible) {
                            if shared.failed.load(Ordering::SeqCst) {
                                answer(entry,storage_deny());
                                if let Some(reply)=reply {let _=reply.send(Err(BrokerError::StorageUnavailable));}
                            } else {
                                if shared.closed.load(Ordering::SeqCst) {cancel(&entry.control,2);}
                                if Instant::now()>=entry.deadline {cancel(&entry.control,3);}
                                let won=entry.control.cancelled.compare_exchange(0,SETTLED,Ordering::SeqCst,Ordering::SeqCst).is_ok();
                                if won {answer(entry,decision);} else {answer(entry,cancellation_deny(entry.control.cancelled.load(Ordering::SeqCst)));}
                                if let Some(reply)=reply {let _=reply.send(Ok(won));}
                            }
                        }
                        remove(&shared,&mut entries,&id);
                    }
                }
            },
            command=commands.recv()=>{
                let Some(command)=command else {close(&shared);continue;};
                match command {
                    Command::Request(mut entry)=>{
                        if shared.failed.load(Ordering::SeqCst) || shared.closed.load(Ordering::SeqCst) {
                            let decision=if shared.failed.load(Ordering::SeqCst) {storage_deny()} else {cancellation_deny(2)};answer(&mut entry,decision);shared.controls.lock().expect("permission controls").remove(&entry.id);shared.changed.notify_waiters();continue;
                        }
                        let draft=requested(&entry);journal(&mut tasks,&sink,&shared,entry.id.clone(),Phase::Requested,draft);entries.insert(entry.id.clone(),*entry);
                    },
                    Command::Resolve {id,decision,by,reply}=>{
                        if shared.failed.load(Ordering::SeqCst) {let _=reply.send(Err(BrokerError::StorageUnavailable));continue;}
                        let Some(entry)=entries.get_mut(&id).filter(|e|matches!(e.stage,Stage::Visible|Stage::Requesting) && e.pending_choice.is_none() && e.control.cancelled.load(Ordering::SeqCst)==0) else {let _=reply.send(Ok(false));continue;};
                        let chosen=validate(entry,decision,&shared);let by=public_string(&shared,&by);
                        match (chosen,by) {
                            (Ok(decision),Ok(by)) if by.len()<=4096=>{
                                if matches!(entry.stage,Stage::Requesting) {
                                    entry.pending_choice=Some(PendingChoice{decision,by,reply});
                                } else {finish_begin(entry,decision,by,Some(reply),&shared,&sink,&mut tasks);}
                            },
                            (Err(error),_)=>{let _=reply.send(Err(error));},
                            _=>{let _=reply.send(Err(BrokerError::Invalid));},
                        }
                    }
                }
            }
        }
    }
}
