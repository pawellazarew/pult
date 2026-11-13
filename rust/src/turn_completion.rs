//! Typed final answers across owned execution. No public wait or replay.
use crate::codex_events::{OutcomeCode, TurnOutcome};
use crate::turn_coordinator::{Outcome, Ticket};
use crate::turn_snapshot::SessionKey;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, Write},
};

/// Opaque result of an owned Worker future. No native/public JSON constructor.
/// Deliberately not Debug, Deserialize or Clone: answer payloads stay private.
pub struct WorkerCompletion {
    outcome: Outcome,
    answer: Answer,
}
/// Opaque loaded answer fields. Only a host-minted durable reference can load it.
pub struct CompletedAnswer {
    fields: Fields,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionUnavailable {
    Unqualified,
    Capacity,
    Disposition,
    Cancelled,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionReadError {
    Unavailable(CompletionUnavailable),
    Storage,
    Invalid,
    Version,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fields {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<OutcomeCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}
enum Answer {
    Qualified(CompletedAnswer),
    Unavailable(CompletionUnavailable),
}
impl From<Outcome> for WorkerCompletion {
    fn from(outcome: Outcome) -> Self {
        Self {
            outcome,
            answer: Answer::Unavailable(CompletionUnavailable::Unqualified),
        }
    }
}
impl WorkerCompletion {
    pub fn outcome(&self) -> &Outcome {
        &self.outcome
    }
    pub(crate) fn normalized(outcome: Outcome, terminal: TurnOutcome) -> Self {
        let fields = Fields {
            ok: terminal.ok,
            error_code: terminal.error_code,
            message: terminal.message,
            text: terminal.text,
        };
        // Public turn identity is deliberately discarded. Driver supplies it
        // from its accepted owned Started reply, never from native JSON.
        let agrees = match (&outcome, fields.ok, fields.error_code) {
            (Outcome::Success, true, None) => true,
            (Outcome::Interrupted, false, Some(OutcomeCode::Interrupted)) => true,
            (Outcome::Failure { code, .. }, false, Some(native)) => code == code_name(native),
            _ => false,
        };
        let answer = if !agrees {
            Answer::Unavailable(CompletionUnavailable::Disposition)
        } else if !fields_bounded(&fields) {
            Answer::Unavailable(CompletionUnavailable::Capacity)
        } else {
            Answer::Qualified(CompletedAnswer { fields })
        };
        Self { outcome, answer }
    }
    pub(crate) fn unqualified(outcome: Outcome, why: CompletionUnavailable) -> Self {
        Self {
            outcome,
            answer: Answer::Unavailable(why),
        }
    }
    pub(crate) fn into_parts(self) -> (Outcome, Option<CompletedAnswer>, CompletionUnavailable) {
        match self.answer {
            Answer::Qualified(a) => (self.outcome, Some(a), CompletionUnavailable::Unqualified),
            Answer::Unavailable(e) => (self.outcome, None, e),
        }
    }
}
fn code_name(code: OutcomeCode) -> &'static str {
    match code {
        OutcomeCode::Interrupted => "interrupted",
        OutcomeCode::Internal => "internal",
        OutcomeCode::ProviderUnavailable => "provider_unavailable",
        OutcomeCode::Limited => "limited",
    }
}
impl CompletedAnswer {
    pub fn ok(&self) -> bool {
        self.fields.ok
    }
    pub fn error_code(&self) -> Option<&'static str> {
        self.fields.error_code.map(code_name)
    }
    pub fn message(&self) -> Option<&str> {
        self.fields.message.as_deref()
    }
    pub fn text(&self) -> Option<&str> {
        self.fields.text.as_deref()
    }
    pub(crate) fn payload(self, key: &SessionKey, user: u64, turn: &str) -> Value {
        let mut outcome = serde_json::to_value(self.fields).expect("finite typed fields");
        outcome["turnId"] = json!(turn);
        json!({"version":1,"incarnation":key.created_at,"userEventId":user,"outcome":outcome})
    }
}
struct Budget(usize);
impl Write for Budget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| io::Error::other("completion capacity"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn fields_bounded(fields: &Fields) -> bool {
    // Existing normalizers already enforce their original source-unit limits.
    // This additional encoded bound is checked without allocating serialized
    // text, and leaves room for host identities and the journal envelope.
    let mut budget = Budget(crate::MAX_LINE - 65536);
    serde_json::to_writer(&mut budget, fields).is_ok()
}
pub(crate) fn unavailable_payload(
    key: &SessionKey,
    user: u64,
    why: CompletionUnavailable,
) -> Value {
    let why = match why {
        CompletionUnavailable::Unqualified => "unqualified",
        CompletionUnavailable::Capacity => "capacity",
        CompletionUnavailable::Disposition => "disposition",
        CompletionUnavailable::Cancelled => "cancelled",
    };
    json!({"version":1,"incarnation":key.created_at,"userEventId":user,"unavailable":why})
}
#[derive(Clone, Debug, Eq, PartialEq)]
enum Disposition {
    Success,
    Interrupted,
    Failure(String),
}
impl Disposition {
    fn from_outcome(outcome: &Outcome) -> Self {
        match outcome {
            Outcome::Success => Self::Success,
            Outcome::Interrupted => Self::Interrupted,
            Outcome::Failure { code, .. } => Self::Failure(code.clone()),
        }
    }
    fn matches(&self, event: &Value) -> bool {
        let data = &event["data"];
        match self {
            Self::Success => data["status"] == "idle",
            Self::Interrupted => data["status"] == "interrupted",
            Self::Failure(code) => data["status"] == "failed" && data["errorCode"] == *code,
        }
    }
}
/// Host-minted actual receipts, not deserializable provider/public input.
/// Clones retain only immutable bounded metadata, never final-answer bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionRef(std::sync::Arc<RefData>);
#[derive(Debug, Eq, PartialEq)]
struct RefData {
    ticket: Ticket,
    turn: String,
    user: u64,
    terminal: u64,
    disposition: Disposition,
}
impl CompletionRef {
    pub fn session(&self) -> &SessionKey {
        self.0.ticket.session()
    }
    pub fn public_turn_id(&self) -> &str {
        &self.0.turn
    }
    pub fn user_event_id(&self) -> u64 {
        self.0.user
    }
    pub fn terminal_event_id(&self) -> u64 {
        self.0.terminal
    }
    pub(crate) fn new(
        ticket: Ticket,
        turn: String,
        user: u64,
        terminal: u64,
        outcome: &Outcome,
    ) -> Self {
        Self(std::sync::Arc::new(RefData {
            ticket,
            turn,
            user,
            terminal,
            disposition: Disposition::from_outcome(outcome),
        }))
    }
}
pub(crate) struct Latest {
    by_name: HashMap<
        String,
        (
            Ticket,
            tokio::sync::watch::Receiver<crate::turn_driver::Progress>,
        ),
    >,
}
impl Latest {
    pub(crate) fn new() -> Self {
        Self {
            by_name: HashMap::new(),
        }
    }
    pub(crate) fn len(&self) -> usize {
        self.by_name.len()
    }
    pub(crate) fn contains_name(&self, name: &str) -> bool {
        self.by_name.contains_key(name)
    }
    pub(crate) fn begin(
        &mut self,
        ticket: &Ticket,
        receiver: tokio::sync::watch::Receiver<crate::turn_driver::Progress>,
    ) {
        self.by_name
            .insert(ticket.session().name.clone(), (ticket.clone(), receiver));
    }
    pub(crate) fn get(
        &self,
        key: &SessionKey,
    ) -> Option<(
        Ticket,
        tokio::sync::watch::Receiver<crate::turn_driver::Progress>,
    )> {
        self.by_name
            .get(&key.name)
            .filter(|(ticket, _)| ticket.session() == key)
            .cloned()
    }
    pub(crate) fn owns(&self, reference: &CompletionRef) -> bool {
        self.by_name.get(&reference.session().name).is_some_and(|(ticket,progress)|ticket==&reference.0.ticket && matches!(&*progress.borrow(),crate::turn_driver::Progress::Finished(Ok(terminal)) if terminal.completion_ref.as_ref()==Some(reference)))
    }
    pub(crate) fn retire(&mut self, key: &SessionKey) {
        if self
            .by_name
            .get(&key.name)
            .is_some_and(|(t, _)| t.session() == key)
        {
            self.by_name.remove(&key.name);
        }
    }
}
/// Decode only the authoritative global journal records fetched by actual IDs.
/// Receipt authority remains opaque; arbitrary Value cannot mint a reference.
pub(crate) fn decode(
    reference: &CompletionRef,
    user: &Value,
    event: &Value,
) -> Result<CompletedAnswer, CompletionReadError> {
    let invalid = CompletionReadError::Invalid;
    if !reference.0.disposition.matches(event) {
        return Err(invalid);
    }
    if reference.0.user == 0
        || reference.0.terminal <= reference.0.user
        || user["id"] != reference.0.user
        || user["sessionId"] != reference.session().name
        || user["kind"] != "message.user"
        || event["id"] != reference.0.terminal
        || event["sessionId"] != reference.session().name
        || event["kind"] != "status.changed"
        || event["data"]["turnId"] != reference.0.turn
    {
        return Err(invalid);
    }
    let p = &event["data"]["completion"];
    let map = p.as_object().ok_or(invalid)?;
    if map.keys().any(|k| {
        !matches!(
            k.as_str(),
            "version" | "incarnation" | "userEventId" | "outcome" | "unavailable"
        )
    }) {
        return Err(invalid);
    }
    if p["version"] != 1 {
        return Err(CompletionReadError::Version);
    }
    if p["incarnation"] != reference.session().created_at || p["userEventId"] != reference.0.user {
        return Err(invalid);
    }
    match p.get("unavailable") {
        None => {}
        Some(Value::String(why)) => {
            if p.get("outcome").is_some() {
                return Err(invalid);
            }
            let why = match why.as_str() {
                "unqualified" => CompletionUnavailable::Unqualified,
                "capacity" => CompletionUnavailable::Capacity,
                "disposition" => CompletionUnavailable::Disposition,
                "cancelled" => CompletionUnavailable::Cancelled,
                _ => return Err(invalid),
            };
            return Err(CompletionReadError::Unavailable(why));
        }
        Some(_) => return Err(invalid),
    }
    let o = &p["outcome"];
    if o["turnId"] != reference.0.turn {
        return Err(invalid);
    }
    let map = o.as_object().ok_or(invalid)?;
    if map.keys().any(|k| {
        !matches!(
            k.as_str(),
            "turnId" | "ok" | "errorCode" | "message" | "text"
        )
    }) {
        return Err(invalid);
    }
    let ok = o["ok"].as_bool().ok_or(invalid)?;
    let error_code = match o.get("errorCode").and_then(Value::as_str) {
        None if o.get("errorCode").is_none() => None,
        Some("interrupted") => Some(OutcomeCode::Interrupted),
        Some("internal") => Some(OutcomeCode::Internal),
        Some("provider_unavailable") => Some(OutcomeCode::ProviderUnavailable),
        Some("limited") => Some(OutcomeCode::Limited),
        _ => return Err(invalid),
    };
    if ok != error_code.is_none() {
        return Err(invalid);
    }
    let expected_status = if ok {
        "idle"
    } else if error_code == Some(OutcomeCode::Interrupted) {
        "interrupted"
    } else {
        "failed"
    };
    if event["data"]["status"] != expected_status
        || (!ok
            && expected_status == "failed"
            && event["data"]["errorCode"].as_str() != error_code.map(code_name))
    {
        return Err(invalid);
    }
    fn optional(v: &Value, key: &str) -> Result<Option<String>, CompletionReadError> {
        match v.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            _ => Err(CompletionReadError::Invalid),
        }
    }
    let fields = Fields {
        ok,
        error_code,
        message: optional(o, "message")?,
        text: optional(o, "text")?,
    };
    if !fields_bounded(&fields) {
        return Err(CompletionReadError::Unavailable(
            CompletionUnavailable::Capacity,
        ));
    }
    Ok(CompletedAnswer { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        claude_events::{self, Binding, LogRedactor, Normalizer, TrustedCallback},
        journal::EventStore,
        registry::{Record, Registry},
        turn_coordinator::Ticket,
        turn_driver::{
            DispatchDecision, Driver, Input, Options, Started, Task, Worker, WorkerError,
        },
        turn_journal::JournalSink,
        turn_snapshot::TurnSnapshot,
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::{Notify, Semaphore};
    struct Controlled {
        entered: Arc<Notify>,
        release: Arc<Semaphore>,
        sink: Arc<dyn crate::turn_driver::EventSink>,
    }
    impl Worker for Controlled {
        fn start(
            &self,
            ticket: Ticket,
            snapshot: TurnSnapshot,
            _: String,
        ) -> Task<Result<Started, WorkerError>> {
            let sink = self.sink.clone();
            Box::pin(async move {
                let mut mapper = Normalizer::new(
                    Binding {
                        session: snapshot.key,
                        ticket: ticket.clone(),
                        generation: 1,
                        provider_session_id: "native-session".into(),
                        public_turn_id: "public-turn".into(),
                        user_message_uuid: "owned-input".into(),
                        session_started: false,
                    },
                    claude_events::Limits::default(),
                    Box::new(LogRedactor),
                )
                .unwrap();
                let callback = TrustedCallback {
                    ticket,
                    generation: 1,
                };
                let interim=mapper.push(&callback,&json!({"type":"assistant","session_id":"native-session","message":{"id":"interim-id","content":[{"type":"text","text":"INTERIM_DIFFERENT_TEXT"}]}}));
                for draft in interim.drafts {
                    sink.append(serde_json::to_value(draft).unwrap())
                        .await
                        .unwrap();
                }
                let mut terminal = mapper
                    .push(
                        &callback,
                        &json!({
                            "type":"result", "session_id":"native-session", "is_error":false,
                            "terminal_reason":"completed", "num_turns":1,
                            "result":"ACTUAL_FINAL_RESULT", "user_message_uuids":["owned-input"]
                        }),
                    )
                    .terminal
                    .unwrap();
                terminal.turn_id = "forged-native-public-copy".into();
                let completion = WorkerCompletion::normalized(Outcome::Success, terminal);
                assert_eq!(
                    match &completion.answer {
                        Answer::Qualified(answer) => answer.text(),
                        _ => None,
                    },
                    Some("ACTUAL_FINAL_RESULT")
                );
                Ok(Started {
                    turn_id: "public-turn".into(),
                    done: Box::pin(async move {
                        // Carry the exact normalized answer through the owned future.
                        completion
                    }),
                })
            })
        }
        fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                Ok(())
            })
        }
    }
    async fn bounded<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), f)
            .await
            .expect("owned completion deadline")
    }
    #[tokio::test]
    async fn final_text_crosses_owned_done_only_after_cleanup_and_durable_terminal() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut record = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", "2026-11-13T00:00:00Z"),
            ("provider", "claude"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            record.set_string(k, v);
        }
        let record = registry.insert(record).unwrap();
        let snapshot = TurnSnapshot::try_from(&record).unwrap();
        let store = Arc::new(Mutex::new(journal));
        let sink = Arc::new(JournalSink::new(store.clone()).unwrap());
        let driver = Driver::new(
            sink.clone(),
            Arc::new(crate::redaction::redact_string),
            Options::default(),
        )
        .unwrap();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let mut handle = driver
            .start_input(
                snapshot,
                Input {
                    text: "current literal input".into(),
                    metadata: Default::default(),
                },
                Arc::new(Controlled {
                    entered: entered.clone(),
                    release: release.clone(),
                    sink,
                }),
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            )
            .unwrap();
        let accepted = bounded(handle.accepted()).await.unwrap();
        bounded(entered.notified()).await;
        assert_eq!(driver.active_count(), 1);
        assert!(
            store
                .lock()
                .unwrap()
                .read_from(0, Some("chat"), 20, 1024 * 1024)
                .unwrap()
                .iter()
                .all(|e| {
                    serde_json::from_str::<Value>(e.json.get()).unwrap()["data"]["completion"]
                        .is_null()
                })
        );
        release.add_permits(1);
        let terminal = bounded(handle.wait()).await.unwrap();
        assert_eq!(terminal.user_event_id, Some(accepted.user_event_id));
        let event = store
            .lock()
            .unwrap()
            .read_ids(&[terminal.terminal_event_id.unwrap()])
            .unwrap();
        let event: Value = serde_json::from_str(event[0].json.get()).unwrap();
        assert_eq!(
            event["data"]["completion"]["outcome"]["text"], "ACTUAL_FINAL_RESULT",
            "exact terminal text was lost between normalizer and durable Driver terminal"
        );
        assert_eq!(
            event["data"]["completion"]["outcome"]["turnId"],
            "public-turn"
        );
        let reference = terminal.completion_ref.unwrap();
        let answer = bounded(driver.read_completion(reference.clone()))
            .await
            .unwrap();
        assert_eq!(answer.text(), Some("ACTUAL_FINAL_RESULT"));
        assert_eq!(
            driver.latest_progress(reference.session()).unwrap().0,
            *handle.ticket()
        );
        let rows = store
            .lock()
            .unwrap()
            .read_from(0, Some("chat"), 20, crate::MAX_LINE)
            .unwrap();
        assert!(rows.iter().any(
            |r| serde_json::from_str::<Value>(r.json.get()).unwrap()["data"]["text"]
                == "INTERIM_DIFFERENT_TEXT"
        ));
    }
    struct Immediate(Mutex<Option<WorkerCompletion>>);
    impl Worker for Immediate {
        fn start(
            &self,
            _: Ticket,
            _: TurnSnapshot,
            _: String,
        ) -> Task<Result<Started, WorkerError>> {
            let completion = self.0.lock().unwrap().take().unwrap();
            Box::pin(async move {
                Ok(Started {
                    turn_id: "owned-turn".into(),
                    done: Box::pin(async move { completion }),
                })
            })
        }
        fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
            Box::pin(async { Ok(()) })
        }
    }
    fn final_answer(text: Option<String>) -> WorkerCompletion {
        WorkerCompletion::normalized(
            Outcome::Success,
            TurnOutcome {
                turn_id: "not-authority".into(),
                ok: true,
                error_code: None,
                message: None,
                text,
            },
        )
    }
    fn fixture(
        options: Options,
    ) -> (
        tempfile::TempDir,
        Arc<Driver>,
        Arc<Mutex<EventStore>>,
        TurnSnapshot,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut record = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", "2026-11-13T00:00:00Z"),
            ("provider", "claude"),
            ("cwd", home.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            record.set_string(k, v);
        }
        let snapshot = TurnSnapshot::try_from(&registry.insert(record).unwrap()).unwrap();
        let store = Arc::new(Mutex::new(journal));
        let driver = Arc::new(
            Driver::new(
                Arc::new(JournalSink::new(store.clone()).unwrap()),
                Arc::new(crate::redaction::redact_string),
                options,
            )
            .unwrap(),
        );
        (temp, driver, store, snapshot)
    }
    async fn finish_answer(
        driver: &Driver,
        snapshot: TurnSnapshot,
        completion: WorkerCompletion,
    ) -> crate::turn_driver::Terminal {
        let mut handle = driver
            .start(
                snapshot,
                "literal input".into(),
                Arc::new(Immediate(Mutex::new(Some(completion)))),
            )
            .unwrap();
        bounded(handle.accepted()).await.unwrap();
        bounded(handle.wait()).await.unwrap()
    }
    #[tokio::test]
    async fn latest_survives_global_finished_churn_and_replaces_name_incarnations_without_growth() {
        let (_temp, driver, _store, snapshot) = fixture(Options {
            latest_sessions: 2,
            ..Options::default()
        });
        let a = finish_answer(&driver, snapshot.clone(), final_answer(Some("A".into()))).await;
        let reference = a.completion_ref.unwrap();
        for i in 0..130 {
            let mut other = snapshot.clone();
            other.key.name = "neighbor".into();
            other.key.created_at = format!("incarnation-{i}");
            finish_answer(&driver, other, final_answer(Some("neighbor".into()))).await;
        }
        assert!(
            driver.result(&a.turn.ticket).is_none(),
            "global finished128 must actually churn"
        );
        assert_eq!(
            driver
                .read_completion(reference.clone())
                .await
                .unwrap()
                .text(),
            Some("A")
        );
        let mut third = snapshot.clone();
        third.key.name = "third".into();
        assert!(matches!(
            driver.start(
                third,
                "input".into(),
                Arc::new(Immediate(Mutex::new(Some(Outcome::Success.into()))))
            ),
            Err(crate::turn_driver::DriverError::Capacity)
        ));
        assert_eq!(
            driver.latest_progress(&snapshot.key).unwrap().0,
            a.turn.ticket,
            "capacity failure must preserve A"
        );
        let mut replaced = snapshot.clone();
        replaced.key.created_at = "replacement-incarnation".into();
        finish_answer(&driver, replaced.clone(), final_answer(Some("B".into()))).await;
        assert!(driver.latest_progress(&snapshot.key).is_none());
        assert!(matches!(
            driver.read_completion(reference).await,
            Err(CompletionReadError::Invalid)
        ));
        driver.retire_latest(&snapshot.key);
        assert!(driver.latest_progress(&replaced.key).is_some());
        driver.retire_latest(&replaced.key);
        assert!(driver.latest_progress(&replaced.key).is_none());
    }
    #[tokio::test]
    async fn explicit_capacity_and_host_tombstones_never_return_prior_answer() {
        let (_temp, driver, store, snapshot) = fixture(Options::default());
        let first = finish_answer(
            &driver,
            snapshot.clone(),
            final_answer(Some("prior A".into())),
        )
        .await;
        let capacity = finish_answer(
            &driver,
            snapshot.clone(),
            final_answer(Some("\0".repeat(200_000))),
        )
        .await;
        assert_eq!(capacity.turn.outcome, Outcome::Success);
        let reference = capacity.completion_ref.unwrap();
        assert!(matches!(
            driver.read_completion(reference.clone()).await,
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Capacity
            ))
        ));
        let records = store
            .lock()
            .unwrap()
            .read_ids(&[reference.terminal_event_id()])
            .unwrap();
        let event: Value = serde_json::from_str(records[0].json.get()).unwrap();
        assert_eq!(event["data"]["completion"]["unavailable"], "capacity");
        assert!(event["data"]["completion"].get("outcome").is_none());
        assert!(matches!(
            driver.read_completion(first.completion_ref.unwrap()).await,
            Err(CompletionReadError::Invalid)
        ));
        let host = finish_answer(&driver, snapshot.clone(), Outcome::Success.into()).await;
        assert!(matches!(
            driver.read_completion(host.completion_ref.unwrap()).await,
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Unqualified
            ))
        ));
        driver.begin_shutdown();
        assert!(driver.closed());
        assert!(driver.latest_progress(&snapshot.key).is_none());
    }
    #[tokio::test]
    async fn global_reader_rejects_wrong_receipts_identity_version_status_and_unknown_unavailable()
    {
        let (_temp, driver, store, snapshot) = fixture(Options::default());
        let terminal = finish_answer(&driver, snapshot, final_answer(Some("final".into()))).await;
        let reference = terminal.completion_ref.unwrap();
        let records = store
            .lock()
            .unwrap()
            .read_ids(&[reference.user_event_id(), reference.terminal_event_id()])
            .unwrap();
        let user: Value = serde_json::from_str(records[0].json.get()).unwrap();
        let event: Value = serde_json::from_str(records[1].json.get()).unwrap();
        assert_eq!(
            decode(&reference, &user, &event).unwrap().text(),
            Some("final")
        );
        for (pointer, value) in [
            ("/id", json!(999)),
            ("/sessionId", json!("neighbor")),
            ("/data/turnId", json!("wrong-turn")),
            ("/data/status", json!("failed")),
            ("/data/completion/incarnation", json!("other-incarnation")),
            ("/data/completion/userEventId", json!(999)),
            ("/data/completion/version", json!(2)),
            ("/data/completion/outcome/turnId", json!("forged")),
        ] {
            let mut changed = event.clone();
            *changed
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("missing {pointer}")) = value;
            assert!(
                decode(&reference, &user, &changed).is_err(),
                "accepted wrong {pointer}"
            );
        }
        for marker in [Value::Null, json!(false), json!(1), json!({})] {
            let mut changed = event.clone();
            changed["data"]["completion"]["unavailable"] = marker;
            assert!(
                matches!(
                    decode(&reference, &user, &changed),
                    Err(CompletionReadError::Invalid)
                ),
                "non-string marker beside valid outcome"
            );
            changed["data"]["completion"]
                .as_object_mut()
                .unwrap()
                .remove("outcome");
            assert!(
                matches!(
                    decode(&reference, &user, &changed),
                    Err(CompletionReadError::Invalid)
                ),
                "non-string marker alone"
            );
        }
        let mut mixed = event.clone();
        mixed["data"]["completion"]["unavailable"] = json!("capacity");
        assert!(
            matches!(
                decode(&reference, &user, &mixed),
                Err(CompletionReadError::Invalid)
            ),
            "marker and outcome are mutually exclusive"
        );
        let mut unknown_code = event.clone();
        unknown_code["data"]["completion"]["outcome"]["errorCode"] = json!("unknown");
        assert!(decode(&reference, &user, &unknown_code).is_err());
        let mut changed = event.clone();
        changed["data"]["completion"] = unavailable_payload(
            reference.session(),
            reference.user_event_id(),
            CompletionUnavailable::Capacity,
        );
        assert!(matches!(
            decode(&reference, &user, &changed),
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Capacity
            ))
        ));
        changed["data"]["completion"]["unavailable"] = json!("unknown");
        assert!(matches!(
            decode(&reference, &user, &changed),
            Err(CompletionReadError::Invalid)
        ));
        let mut wrong_user = user.clone();
        wrong_user["kind"] = json!("message.done");
        assert!(decode(&reference, &wrong_user, &event).is_err());
    }
    #[test]
    fn disposition_and_original_normalizer_fields_are_not_fabricated() {
        let terminal = TurnOutcome {
            turn_id: "wrong".into(),
            ok: false,
            error_code: Some(OutcomeCode::Internal),
            message: Some("original failure".into()),
            text: Some("partial answer".into()),
        };
        let mismatch = WorkerCompletion::normalized(Outcome::Success, terminal);
        assert!(matches!(
            mismatch.answer,
            Answer::Unavailable(CompletionUnavailable::Disposition)
        ));
        let valid = WorkerCompletion::normalized(
            Outcome::Failure {
                code: "internal".into(),
                message: "original failure".into(),
            },
            TurnOutcome {
                turn_id: "wrong".into(),
                ok: false,
                error_code: Some(OutcomeCode::Internal),
                message: Some("original failure".into()),
                text: Some("partial answer".into()),
            },
        );
        let (_, answer, _) = valid.into_parts();
        let answer = answer.unwrap();
        assert_eq!(answer.error_code(), Some("internal"));
        assert_eq!(answer.message(), Some("original failure"));
        assert_eq!(answer.text(), Some("partial answer"));
    }
    struct GatedSink {
        journal: JournalSink,
        read_entered: Arc<Notify>,
        read_release: Arc<Semaphore>,
        before_entered: Arc<Notify>,
        before_release: Arc<Semaphore>,
        before_ref: Arc<Mutex<Option<CompletionRef>>>,
        panic_before: bool,
    }
    impl crate::turn_driver::EventSink for GatedSink {
        fn append(
            &self,
            draft: Value,
        ) -> Task<Result<crate::turn_driver::Receipt, crate::turn_driver::SinkError>> {
            self.journal.append(draft)
        }
        fn before_release(
            &self,
            completion: crate::turn_driver::Completion,
        ) -> Task<Result<(), crate::turn_driver::SinkError>> {
            *self.before_ref.lock().unwrap() = completion.answer_ref().cloned();
            let entered = self.before_entered.clone();
            let release = self.before_release.clone();
            let panic = self.panic_before;
            Box::pin(async move {
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                assert!(!panic, "controlled completion hook panic");
                Ok(())
            })
        }
        fn read_completion(
            &self,
            reference: CompletionRef,
        ) -> Task<Result<CompletedAnswer, CompletionReadError>> {
            let entered = self.read_entered.clone();
            let release = self.read_release.clone();
            let journal = self.journal.clone();
            Box::pin(async move {
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                journal.read_completion(reference).await
            })
        }
    }
    fn gated(
        options: Options,
        reads: usize,
        before: usize,
        panic_before: bool,
    ) -> (tempfile::TempDir, Arc<Driver>, TurnSnapshot, Arc<GatedSink>) {
        let (temp, _unused, store, snapshot) = fixture(options);
        let sink = Arc::new(GatedSink {
            journal: JournalSink::new(store).unwrap(),
            read_entered: Arc::new(Notify::new()),
            read_release: Arc::new(Semaphore::new(reads)),
            before_entered: Arc::new(Notify::new()),
            before_release: Arc::new(Semaphore::new(before)),
            before_ref: Arc::new(Mutex::new(None)),
            panic_before,
        });
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                options,
            )
            .unwrap(),
        );
        (temp, driver, snapshot, sink)
    }
    #[tokio::test]
    async fn blocked_owned_read_rechecks_new_ticket_incarnation_and_shutdown_after_io() {
        for mutation in ["new-ticket", "new-incarnation", "shutdown"] {
            let (_temp, driver, snapshot, sink) = gated(Options::default(), 0, 10, false);
            let terminal = finish_answer(
                &driver,
                snapshot.clone(),
                final_answer(Some("old A".into())),
            )
            .await;
            let d = driver.clone();
            let reference = terminal.completion_ref.unwrap();
            let reading = tokio::spawn(async move { d.read_completion(reference).await });
            bounded(sink.read_entered.notified()).await;
            if mutation == "shutdown" {
                driver.begin_shutdown()
            } else {
                let mut next = snapshot;
                if mutation == "new-incarnation" {
                    next.key.created_at = "new-incarnation".into()
                }
                finish_answer(&driver, next, final_answer(Some("new B".into()))).await;
            }
            sink.read_release.add_permits(1);
            assert!(
                matches!(
                    bounded(reading).await.unwrap(),
                    Err(CompletionReadError::Invalid)
                ),
                "late A escaped {mutation}"
            );
            bounded(driver.shutdown(Duration::from_secs(1)))
                .await
                .unwrap();
        }
    }
    #[tokio::test]
    async fn dropped_read_callers_keep_owned_budget_until_known_finish_and_shutdown_drains() {
        let options = Options {
            completion_reads: 2,
            ..Options::default()
        };
        let (_temp, driver, snapshot, sink) = gated(options, 0, 10, false);
        let terminal = finish_answer(&driver, snapshot, final_answer(Some("final".into()))).await;
        let reference = terminal.completion_ref.unwrap();
        for _ in 0..2 {
            let d = driver.clone();
            let r = reference.clone();
            let caller = tokio::spawn(async move { d.read_completion(r).await });
            bounded(sink.read_entered.notified()).await;
            caller.abort();
            let _ = caller.await;
        }
        assert!(matches!(
            driver.read_completion(reference).await,
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Capacity
            ))
        ));
        assert_eq!(driver.inner_read_jobs_for_test(), 2);
        assert_eq!(
            driver.shutdown(Duration::from_millis(20)).await,
            Err(crate::turn_driver::DriverError::CleanupUnconfirmed)
        );
        sink.read_release.add_permits(2);
        bounded(driver.shutdown(Duration::from_secs(1)))
            .await
            .unwrap();
        assert_eq!(driver.inner_read_jobs_for_test(), 0);
    }
    #[tokio::test]
    async fn before_release_blocks_reference_publication_and_panic_never_becomes_native_success() {
        for panic in [false, true] {
            let (_temp, driver, snapshot, sink) = gated(Options::default(), 10, 0, panic);
            let mut handle = driver
                .start(
                    snapshot.clone(),
                    "input".into(),
                    Arc::new(Immediate(Mutex::new(Some(final_answer(Some(
                        "final".into(),
                    )))))),
                )
                .unwrap();
            bounded(handle.accepted()).await.unwrap();
            bounded(sink.before_entered.notified()).await;
            let candidate = sink.before_ref.lock().unwrap().clone().unwrap();
            let (_, progress) = driver.latest_progress(&snapshot.key).unwrap();
            assert!(!matches!(
                &*progress.borrow(),
                crate::turn_driver::Progress::Finished(_)
            ));
            assert!(matches!(
                driver.read_completion(candidate.clone()).await,
                Err(CompletionReadError::Invalid)
            ));
            sink.before_release.add_permits(1);
            let terminal = bounded(handle.wait()).await;
            if panic {
                assert!(terminal.is_err());
                assert!(driver.storage_failed());
                assert!(driver.latest_progress(&snapshot.key).is_none());
                assert!(matches!(
                    driver.read_completion(candidate).await,
                    Err(CompletionReadError::Invalid)
                ))
            } else {
                let terminal = terminal.unwrap();
                assert_eq!(terminal.completion_ref, Some(candidate.clone()));
                assert_eq!(
                    driver.read_completion(candidate).await.unwrap().text(),
                    Some("final")
                );
            }
        }
    }
    struct CloseGate {
        entered: Arc<Notify>,
        release: Arc<Semaphore>,
        calls: std::sync::atomic::AtomicUsize,
        unknown_first: bool,
    }
    impl Worker for CloseGate {
        fn start(
            &self,
            _: Ticket,
            _: TurnSnapshot,
            _: String,
        ) -> Task<Result<Started, WorkerError>> {
            Box::pin(async {
                Ok(Started {
                    turn_id: "owned-turn".into(),
                    done: Box::pin(async { final_answer(Some("native final".into())) }),
                })
            })
        }
        fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
            let first = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            let unknown = self.unknown_first;
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.acquire().await.unwrap().forget();
                if first && unknown {
                    Err(WorkerError {
                        code: "cleanup_unknown".into(),
                        message: "controlled cleanup uncertainty".into(),
                    })
                } else {
                    Ok(())
                }
            })
        }
    }
    #[tokio::test]
    async fn cancellation_or_storage_fault_before_join_never_publishes_a_qualified_native_answer() {
        for fault in [false, true] {
            let (_temp, driver, _store, snapshot) = fixture(Options::default());
            let entered = Arc::new(Notify::new());
            let release = Arc::new(Semaphore::new(0));
            let mut handle = driver
                .start(
                    snapshot.clone(),
                    "input".into(),
                    Arc::new(CloseGate {
                        entered: entered.clone(),
                        release: release.clone(),
                        calls: Default::default(),
                        unknown_first: false,
                    }),
                )
                .unwrap();
            bounded(handle.accepted()).await.unwrap();
            bounded(entered.notified()).await;
            if fault {
                driver.report_storage_failure()
            } else {
                assert!(driver.cancel(handle.ticket()))
            }
            release.add_permits(1);
            let terminal = bounded(handle.wait()).await;
            if fault {
                assert!(terminal.is_err());
                assert!(driver.storage_failed());
                assert!(driver.latest_progress(&snapshot.key).is_none())
            } else {
                let terminal = terminal.unwrap();
                assert!(terminal.turn.cancel_requested);
                assert!(matches!(
                    driver
                        .read_completion(terminal.completion_ref.unwrap())
                        .await,
                    Err(CompletionReadError::Unavailable(
                        CompletionUnavailable::Cancelled
                    ))
                ));
            }
        }
    }
    #[tokio::test]
    async fn unknown_cleanup_keeps_ownership_and_exposes_no_terminal_reference_until_retry_join() {
        let (_temp, driver, store, snapshot) = fixture(Options::default());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let mut handle = driver
            .start(
                snapshot.clone(),
                "input".into(),
                Arc::new(CloseGate {
                    entered: entered.clone(),
                    release: release.clone(),
                    calls: Default::default(),
                    unknown_first: true,
                }),
            )
            .unwrap();
        bounded(handle.accepted()).await.unwrap();
        bounded(entered.notified()).await;
        release.add_permits(1);
        let (_, mut progress) = driver.latest_progress(&snapshot.key).unwrap();
        bounded(async {
            loop {
                let current = progress.borrow_and_update().clone();
                if matches!(current, crate::turn_driver::Progress::Quarantined(_)) {
                    break;
                }
                progress.changed().await.unwrap()
            }
        })
        .await;
        assert_eq!(driver.active_count(), 1);
        assert!(
            store
                .lock()
                .unwrap()
                .read_from(0, Some("chat"), 20, crate::MAX_LINE)
                .unwrap()
                .iter()
                .all(
                    |r| serde_json::from_str::<Value>(r.json.get()).unwrap()["data"]
                        .get("completion")
                        .is_none()
                )
        );
        assert!(driver.cancel(handle.ticket()));
        bounded(entered.notified()).await;
        release.add_permits(1);
        let terminal = bounded(handle.wait()).await.unwrap();
        assert_eq!(driver.active_count(), 0);
        assert!(matches!(
            driver
                .read_completion(terminal.completion_ref.unwrap())
                .await,
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Cancelled
            ))
        ));
    }
    struct NeverStarted;
    impl Worker for NeverStarted {
        fn start(
            &self,
            _: Ticket,
            _: TurnSnapshot,
            _: String,
        ) -> Task<Result<Started, WorkerError>> {
            Box::pin(std::future::pending())
        }
        fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
            Box::pin(async { Ok(()) })
        }
    }
    #[tokio::test]
    async fn new_reservation_shadows_prior_answer_while_still_starting_and_has_no_fabricated_reference()
     {
        let (_temp, driver, _store, snapshot) = fixture(Options::default());
        let first = finish_answer(&driver, snapshot.clone(), final_answer(Some("A".into()))).await;
        let old = first.completion_ref.unwrap();
        let mut pending = driver
            .start(snapshot.clone(), "B input".into(), Arc::new(NeverStarted))
            .unwrap();
        let (ticket, progress) = driver.latest_progress(&snapshot.key).unwrap();
        assert_eq!(&ticket, pending.ticket());
        let current = progress.borrow().clone();
        assert!(matches!(current, crate::turn_driver::Progress::Starting));
        assert!(matches!(
            driver.read_completion(old).await,
            Err(CompletionReadError::Invalid)
        ));
        assert!(driver.cancel(pending.ticket()));
        let terminal = bounded(pending.wait()).await.unwrap();
        assert!(
            terminal.completion_ref.is_none(),
            "preacceptance cannot fabricate a public turn or reference"
        );
        assert!(driver.latest_progress(&snapshot.key).is_some());
    }
    #[tokio::test]
    async fn explicit_capacity_reason_survives_existing_status_error_clipping() {
        let (_temp, driver, _store, snapshot) = fixture(Options::default());
        let text = "\0".repeat(100_000);
        let result = WorkerCompletion::normalized(
            Outcome::Failure {
                code: "provider_unavailable".into(),
                message: text.clone(),
            },
            TurnOutcome {
                turn_id: "ignored".into(),
                ok: false,
                error_code: Some(OutcomeCode::ProviderUnavailable),
                message: Some(text.clone()),
                text: Some(text),
            },
        );
        let terminal = finish_answer(&driver, snapshot, result).await;
        assert!(
            matches!(&terminal.turn.outcome,Outcome::Failure{code,message} if code=="provider_unavailable" && message.chars().count()==4096)
        );
        assert!(matches!(
            driver
                .read_completion(terminal.completion_ref.unwrap())
                .await,
            Err(CompletionReadError::Unavailable(
                CompletionUnavailable::Capacity
            ))
        ));
    }
}
