//! Owned asynchronous execution. Host authorization and real adapters are separate.
use crate::turn_coordinator::{
    Coordinator, DispatchAction, FinishedTurn, Limits, Outcome, StartAction, Ticket,
};
use crate::turn_snapshot::{Approval, TurnSnapshot};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot, watch};

pub type Task<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    pub id: u64,
    pub ts: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SinkError {
    pub message: String,
}
pub trait EventSink: Send + Sync + 'static {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>>;
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}
pub struct Started {
    pub turn_id: String,
    pub done: Task<Outcome>,
}
/// Both futures must be cancellation-safe: ownership survives their drop in the
/// Worker, and close(ticket) must quiesce any partial or completed attempt.
/// close is per-ticket: it must not kill another thread in a shared app-server.
pub trait Worker: Send + Sync + 'static {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>>;
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>>;
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchDecision {
    Allow,
    Restrict(Approval),
    Deny,
}
/// Fresh, synchronous host check after durable input and before dispatch seals.
/// Must return promptly; provider preparation belongs outside this callback.
/// The initial snapshot is immutable;
/// only Coordinator's permitted approval restrictions can change dispatched data.
/// Install panic_guard at host startup to suppress callback panic payloads.
pub trait DispatchGate: Send + Sync + 'static {
    fn check(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision;
}
impl<F> DispatchGate for F
where
    F: Fn(&Ticket, &TurnSnapshot) -> DispatchDecision + Send + Sync + 'static,
{
    fn check(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision {
        self(ticket, initial)
    }
}
pub type Redactor = Arc<dyn Fn(&str) -> String + Send + Sync>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DriverError {
    Invalid,
    Busy,
    Capacity,
    Closed,
    StorageUnavailable,
    WorkerFailed,
    Cancelled,
    CleanupUnconfirmed,
    Internal,
    AccessDenied,
}
impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DriverError {}
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub limits: Limits,
    pub start_timeout: Duration,
    pub close_timeout: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            limits: Limits::default(),
            start_timeout: Duration::from_secs(30),
            close_timeout: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Accepted {
    pub turn_id: String,
    pub user_event_id: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Terminal {
    pub turn: FinishedTurn,
    pub user_event_id: Option<u64>,
    pub terminal_event_id: Option<u64>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Progress {
    Starting,
    Running(Accepted),
    Closing,
    Quarantined(Outcome),
    Finished(Result<Terminal, DriverError>),
}
pub struct Handle {
    ticket: Ticket,
    accepted: Option<oneshot::Receiver<Result<Accepted, DriverError>>>,
    progress: watch::Receiver<Progress>,
}
impl Handle {
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn progress(&self) -> Progress {
        self.progress.borrow().clone()
    }
    pub async fn accepted(&mut self) -> Result<Accepted, DriverError> {
        self.accepted
            .take()
            .ok_or(DriverError::Invalid)?
            .await
            .unwrap_or(Err(DriverError::Internal))
    }
    pub async fn wait(&mut self) -> Result<Terminal, DriverError> {
        loop {
            match self.progress.borrow_and_update().clone() {
                Progress::Finished(result) => return result,
                Progress::Quarantined(_) => return Err(DriverError::CleanupUnconfirmed),
                _ => {}
            }
            self.progress
                .changed()
                .await
                .map_err(|_| DriverError::Internal)?;
        }
    }
}

struct Control {
    cancel: watch::Sender<bool>,
    progress: watch::Sender<Progress>,
}
struct State {
    core: Coordinator,
    jobs: HashMap<Ticket, Arc<Control>>,
    closed: bool,
    storage_failed: bool,
}
struct Inner {
    state: Mutex<State>,
    sink: Arc<dyn EventSink>,
    redactor: Redactor,
    options: Options,
    changed: Notify,
}
pub struct Driver {
    inner: Arc<Inner>,
}
impl Driver {
    pub fn new(
        sink: Arc<dyn EventSink>,
        redactor: Redactor,
        options: Options,
    ) -> Result<Self, DriverError> {
        let core = Coordinator::new(options.limits).map_err(|_| DriverError::Invalid)?;
        Ok(Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    core,
                    jobs: HashMap::new(),
                    closed: false,
                    storage_failed: false,
                }),
                sink,
                redactor,
                options,
                changed: Notify::new(),
            }),
        })
    }
    /// Trusted host boundary, not an RPC authorization gate. Snapshot must have
    /// effective consent, cwd and attachment checks applied by the host already.
    /// This ordinary-message path deliberately accepts no queue/question fields.
    pub fn start(
        &self,
        snapshot: TurnSnapshot,
        text: String,
        worker: Arc<dyn Worker>,
    ) -> Result<Handle, DriverError> {
        self.start_inner(snapshot, text, worker, None)
    }
    /// Recheck current host facts once after the durable user append. Denial,
    /// expansion, or callback panic publishes only a static AccessDenied error.
    /// This is a library integration seam, not RPC authorization. The host must
    /// also recheck after asynchronous provider preparation and retire active
    /// Full processes when access is revoked. This check cannot eliminate every
    /// revocation race or authorize provider reuse by itself.
    pub fn start_checked(
        &self,
        snapshot: TurnSnapshot,
        text: String,
        worker: Arc<dyn Worker>,
        gate: Arc<dyn DispatchGate>,
    ) -> Result<Handle, DriverError> {
        self.start_inner(snapshot, text, worker, Some(gate))
    }
    fn start_inner(
        &self,
        snapshot: TurnSnapshot,
        text: String,
        worker: Arc<dyn Worker>,
        gate: Option<Arc<dyn DispatchGate>>,
    ) -> Result<Handle, DriverError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| DriverError::Internal)?;
        if text.len() > 65536 || text.trim().is_empty() {
            return Err(DriverError::Invalid);
        }
        let public_text = redact(&self.inner, &text).ok_or(DriverError::Invalid)?;
        if public_text.len() > 65536 {
            return Err(DriverError::Invalid);
        }
        let mut state = self.inner.state.lock().expect("driver state mutex");
        if state.closed {
            return Err(DriverError::Closed);
        }
        if state.storage_failed {
            return Err(DriverError::StorageUnavailable);
        }
        let ticket = state
            .core
            .reserve(snapshot.clone())
            .map_err(|e| match e.code {
                crate::turn_coordinator::ErrorCode::Busy => DriverError::Busy,
                crate::turn_coordinator::ErrorCode::Capacity => DriverError::Capacity,
                _ => DriverError::Invalid,
            })?;
        let (cancel, _) = watch::channel(false);
        let (progress, receiver) = watch::channel(Progress::Starting);
        let control = Arc::new(Control { cancel, progress });
        state.jobs.insert(ticket.clone(), control.clone());
        drop(state);
        let (accepted, accepted_rx) = oneshot::channel();
        let inner = self.inner.clone();
        let run_ticket = ticket.clone();
        runtime.spawn(async move {
            run(
                inner,
                control,
                run_ticket,
                snapshot,
                text,
                public_text,
                worker,
                gate,
                Some(accepted),
            )
            .await;
        });
        Ok(Handle {
            ticket,
            accepted: Some(accepted_rx),
            progress: receiver,
        })
    }
    /// Repeating cancel retries an unconfirmed cleanup; it never releases a slot.
    pub fn cancel(&self, ticket: &Ticket) -> bool {
        let mut state = self.inner.state.lock().expect("driver state mutex");
        let Some(control) = state.jobs.get(ticket).cloned() else {
            return false;
        };
        state.core.request_cancel(ticket);
        control.progress.send_replace(Progress::Closing);
        control.cancel.send_replace(true);
        true
    }
    pub fn active_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .core
            .active_count()
    }
    pub fn storage_failed(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .storage_failed
    }
    pub fn result(&self, ticket: &Ticket) -> Option<FinishedTurn> {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .core
            .result(ticket)
            .cloned()
    }
    pub async fn shutdown(&self, timeout: Duration) -> Result<(), DriverError> {
        close_admission(&self.inner);
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.inner.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self
                    .inner
                    .state
                    .lock()
                    .expect("driver state mutex")
                    .jobs
                    .is_empty()
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| DriverError::CleanupUnconfirmed)
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        close_admission(&self.inner);
    }
}
fn close_admission(inner: &Inner) {
    let mut state = inner.state.lock().expect("driver state mutex");
    state.closed = true;
    let controls: Vec<_> = state
        .jobs
        .iter()
        .map(|(ticket, control)| (ticket.clone(), control.clone()))
        .collect();
    for (ticket, control) in controls {
        state.core.request_cancel(&ticket);
        control.progress.send_replace(Progress::Closing);
        control.cancel.send_replace(true);
    }
}
fn latch_storage(inner: &Inner) {
    let mut state = inner.state.lock().expect("driver state mutex");
    state.storage_failed = true;
    let controls: Vec<_> = state
        .jobs
        .iter()
        .map(|(ticket, control)| (ticket.clone(), control.clone()))
        .collect();
    for (ticket, control) in controls {
        state.core.request_cancel(&ticket);
        control.progress.send_replace(Progress::Closing);
        control.cancel.send_replace(true);
    }
}
fn redact(inner: &Inner, text: &str) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (inner.redactor)(text))).ok()
}
fn failure(code: &str, message: &str) -> Outcome {
    Outcome::Failure {
        code: code.into(),
        message: message.into(),
    }
}
fn normalized(inner: &Inner, outcome: Outcome) -> Outcome {
    match outcome {
        Outcome::Failure { code, message } => {
            let (Some(code), Some(message)) = (redact(inner, &code), redact(inner, &message))
            else {
                return failure(
                    "redaction_failed",
                    "provider failure could not be safely published",
                );
            };
            let code = if !code.is_empty()
                && code.len() <= 128
                && code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            {
                code
            } else {
                "provider_error".into()
            };
            Outcome::Failure {
                code,
                message: message.chars().take(4096).collect(),
            }
        }
        other => other,
    }
}
async fn append(inner: &Arc<Inner>, draft: Value) -> Result<Receipt, DriverError> {
    let sink = inner.sink.clone();
    // Isolate trait panic; an unknown journal result must never grant permission
    // to send or acknowledge a turn. Do not cancel a durable append halfway.
    match tokio::spawn(async move { sink.append(draft).await }).await {
        Ok(Ok(receipt))
            if receipt.id > 0
                && receipt.id <= 9_007_199_254_740_991
                && !receipt.ts.is_empty()
                && receipt.ts.len() <= 128 =>
        {
            Ok(receipt)
        }
        _ => {
            latch_storage(inner);
            Err(DriverError::StorageUnavailable)
        }
    }
}
fn answer(
    sender: &mut Option<oneshot::Sender<Result<Accepted, DriverError>>>,
    result: Result<Accepted, DriverError>,
) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}
fn terminal_draft(snapshot: &TurnSnapshot, turn_id: Option<&str>, outcome: &Outcome) -> Value {
    let mut data = match outcome {
        Outcome::Success => json!({"status":"done"}),
        Outcome::Interrupted => json!({"status":"interrupted"}),
        Outcome::Failure { code, message } => {
            json!({"status":"failed","errorCode":code,"error":message})
        }
    };
    if let Some(id) = turn_id {
        data["turnId"] = json!(id);
    }
    json!({"sessionId":snapshot.key.name,"provider":snapshot.provider.as_str(),"kind":"status.changed","data":data})
}
struct End {
    outcome: Outcome,
    error: Option<DriverError>,
    touched: bool,
}
#[allow(clippy::too_many_arguments)]
async fn run(
    inner: Arc<Inner>,
    control: Arc<Control>,
    ticket: Ticket,
    snapshot: TurnSnapshot,
    text: String,
    public_text: String,
    worker: Arc<dyn Worker>,
    gate: Option<Arc<dyn DispatchGate>>,
    mut accepted: Option<oneshot::Sender<Result<Accepted, DriverError>>>,
) {
    let mut cancel = control.cancel.subscribe();
    let draft = json!({"sessionId":snapshot.key.name,"provider":snapshot.provider.as_str(),"kind":"message.user","data":{"text":public_text}});
    let receipt = match append(&inner, draft).await {
        Ok(receipt) => receipt,
        Err(error) => {
            finish(
                &inner,
                &control,
                &ticket,
                &snapshot,
                &worker,
                &mut cancel,
                &mut accepted,
                None,
                End {
                    outcome: failure(
                        "journal_unknown",
                        "journal result is unknown; execution paused",
                    ),
                    error: Some(error),
                    touched: false,
                },
            )
            .await;
            return;
        }
    };
    let end = execute(
        &inner,
        &control,
        &ticket,
        &worker,
        &mut cancel,
        &mut accepted,
        receipt.id,
        text,
        gate.as_deref(),
        &snapshot,
    )
    .await;
    finish(
        &inner,
        &control,
        &ticket,
        &snapshot,
        &worker,
        &mut cancel,
        &mut accepted,
        Some(receipt.id),
        end,
    )
    .await;
}
#[allow(clippy::too_many_arguments)]
async fn execute(
    inner: &Arc<Inner>,
    control: &Arc<Control>,
    ticket: &Ticket,
    worker: &Arc<dyn Worker>,
    cancel: &mut watch::Receiver<bool>,
    accepted: &mut Option<oneshot::Sender<Result<Accepted, DriverError>>>,
    user_event_id: u64,
    text: String,
    gate: Option<&dyn DispatchGate>,
    initial: &TurnSnapshot,
) -> End {
    if *cancel.borrow_and_update() {
        return End {
            outcome: Outcome::Interrupted,
            error: Some(DriverError::Cancelled),
            touched: false,
        };
    }
    // No await between the fresh check, applying its restriction and sealing.
    // Call outside the driver mutex: host callbacks must not poison its state.
    let decision = match gate {
        Some(gate) => {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| gate.check(ticket, initial)))
                .unwrap_or(DispatchDecision::Deny)
        }
        None => DispatchDecision::Allow,
    };
    let dispatch = {
        let mut state = inner.state.lock().expect("driver state mutex");
        if state.storage_failed {
            return End {
                outcome: failure("journal_unknown", "execution paused"),
                error: Some(DriverError::StorageUnavailable),
                touched: false,
            };
        }
        if *cancel.borrow_and_update() {
            return End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: false,
            };
        }
        let denied = match decision {
            DispatchDecision::Allow => false,
            DispatchDecision::Deny => true,
            DispatchDecision::Restrict(approval) => !matches!(
                state.core.restrict_before_start(ticket, approval),
                Ok(crate::turn_coordinator::Change::Applied
                    | crate::turn_coordinator::Change::Unchanged)
            ),
        };
        if denied {
            return End {
                outcome: failure("access_denied", "turn access denied before dispatch"),
                error: Some(DriverError::AccessDenied),
                touched: false,
            };
        }
        state.core.dispatch_start(ticket)
    };
    let snapshot = match dispatch {
        Ok(DispatchAction::Proceed(snapshot)) => snapshot,
        Ok(DispatchAction::Cancelled) => {
            return End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: false,
            };
        }
        _ => {
            return End {
                outcome: failure("driver_state", "turn could not be dispatched"),
                error: Some(DriverError::Internal),
                touched: false,
            };
        }
    };
    let owner = worker.clone();
    let key = ticket.clone();
    let mut start = tokio::spawn(async move { owner.start(key, snapshot, text).await });
    let started = tokio::select! {
        biased;
        _=cancel.changed()=>{
            start.abort();let _=start.await;
            return End{outcome:Outcome::Interrupted,error:Some(DriverError::Cancelled),touched:true};
        }
        result=tokio::time::timeout(inner.options.start_timeout,&mut start)=>match result {
            Ok(Ok(Ok(started)))=>started,
            Ok(Ok(Err(error)))=>return End{outcome:normalized(inner,Outcome::Failure{code:error.code,message:error.message}),error:Some(DriverError::WorkerFailed),touched:true},
            Ok(Err(_))=>return End{outcome:failure("worker_panic","worker start failed"),error:Some(DriverError::WorkerFailed),touched:true},
            Err(_)=>{start.abort();let _=start.await;return End{outcome:failure("provider_timeout","worker start timed out"),error:Some(DriverError::WorkerFailed),touched:true};}
        }
    };
    if redact(inner, &started.turn_id).as_deref() != Some(started.turn_id.as_str()) {
        return End {
            outcome: failure(
                "invalid_start_reply",
                "worker returned an unsafe start reply",
            ),
            error: Some(DriverError::WorkerFailed),
            touched: true,
        };
    }
    let action = inner
        .state
        .lock()
        .expect("driver state mutex")
        .core
        .provider_started(ticket, &started.turn_id);
    match action {
        Ok(StartAction::Proceed) => {}
        Ok(StartAction::CancelProvider) => {
            return End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: true,
            };
        }
        _ => {
            return End {
                outcome: failure(
                    "invalid_start_reply",
                    "worker returned an invalid start reply",
                ),
                error: Some(DriverError::WorkerFailed),
                touched: true,
            };
        }
    }
    let reply = Accepted {
        turn_id: started.turn_id,
        user_event_id,
    };
    control
        .progress
        .send_replace(Progress::Running(reply.clone()));
    answer(accepted, Ok(reply));
    let mut done = tokio::spawn(started.done);
    let outcome = tokio::select! {
        biased;
        _=cancel.changed()=>{done.abort();let _=done.await;Outcome::Interrupted},
        result=&mut done=>match result {Ok(outcome)=>normalized(inner,outcome),Err(_)=>failure("worker_panic","worker completion failed")},
    };
    End {
        outcome,
        error: None,
        touched: true,
    }
}
async fn close_worker(
    inner: &Arc<Inner>,
    worker: &Arc<dyn Worker>,
    ticket: &Ticket,
) -> Result<(), Outcome> {
    let owner = worker.clone();
    let key = ticket.clone();
    let mut close = tokio::spawn(async move { owner.close(key).await });
    match tokio::time::timeout(inner.options.close_timeout, &mut close).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(normalized(
            inner,
            Outcome::Failure {
                code: error.code,
                message: error.message,
            },
        )),
        Ok(Err(_)) => Err(failure("cleanup_panic", "worker cleanup failed")),
        Err(_) => {
            close.abort();
            let _ = close.await;
            Err(failure(
                "cleanup_timeout",
                "worker cleanup was not confirmed",
            ))
        }
    }
}
#[allow(clippy::too_many_arguments)]
async fn finish(
    inner: &Arc<Inner>,
    control: &Arc<Control>,
    ticket: &Ticket,
    snapshot: &TurnSnapshot,
    worker: &Arc<dyn Worker>,
    cancel: &mut watch::Receiver<bool>,
    accepted: &mut Option<oneshot::Sender<Result<Accepted, DriverError>>>,
    user_event_id: Option<u64>,
    mut end: End,
) {
    if end.touched {
        loop {
            match close_worker(inner, worker, ticket).await {
                Ok(()) => break,
                Err(detail) => {
                    let retry_pending = {
                        // Serialize publication with cancel(): an old failure
                        // must not overwrite a retry that arrived during close.
                        let mut state = inner.state.lock().expect("driver state mutex");
                        state.core.request_cancel(ticket);
                        if cancel.has_changed().unwrap_or(false) {
                            drop(cancel.borrow_and_update());
                            control.progress.send_replace(Progress::Closing);
                            true
                        } else {
                            control.progress.send_replace(Progress::Quarantined(detail));
                            false
                        }
                    };
                    answer(accepted, Err(DriverError::CleanupUnconfirmed));
                    // Failed cleanup never frees a slot. An already queued
                    // retry is consumed once; otherwise await an explicit one.
                    if !retry_pending && cancel.changed().await.is_err() {
                        return;
                    }
                }
            }
        }
    }
    let provider_id = inner
        .state
        .lock()
        .expect("driver state mutex")
        .core
        .active(ticket)
        .and_then(|entry| entry.provider_turn_id().map(str::to_owned));
    let storage_failed = inner
        .state
        .lock()
        .expect("driver state mutex")
        .storage_failed;
    let terminal_event_id = if storage_failed {
        end.error = Some(DriverError::StorageUnavailable);
        None
    } else {
        match append(
            inner,
            terminal_draft(snapshot, provider_id.as_deref(), &end.outcome),
        )
        .await
        {
            Ok(receipt) => Some(receipt.id),
            Err(error) => {
                end.error = Some(error);
                None
            }
        }
    };
    if end.error == Some(DriverError::StorageUnavailable) {
        end.outcome = failure(
            "journal_unknown",
            "journal result is unknown; execution paused",
        );
    }
    let result = {
        let mut state = inner.state.lock().expect("driver state mutex");
        let Some(active) = state.core.active(ticket) else {
            answer(accepted, Err(DriverError::Internal));
            return;
        };
        let turn = FinishedTurn {
            ticket: ticket.clone(),
            provider_turn_id: active.provider_turn_id().map(str::to_owned),
            outcome: end.outcome.clone(),
            cancel_requested: active.cancel_requested(),
        };
        let transition = if provider_id.is_some() {
            state.core.complete(ticket, end.outcome.clone())
        } else if end.outcome == Outcome::Interrupted {
            state.core.request_cancel(ticket);
            state.core.stopped(ticket)
        } else {
            state.core.start_failed(ticket, end.outcome.clone())
        };
        if transition.is_err() {
            answer(accepted, Err(DriverError::Internal));
            return;
        }
        state.jobs.remove(ticket);
        if end.error == Some(DriverError::StorageUnavailable) {
            Err(DriverError::StorageUnavailable)
        } else {
            Ok(Terminal {
                turn,
                user_event_id,
                terminal_event_id,
            })
        }
    };
    let error = end.error.unwrap_or(if end.outcome == Outcome::Interrupted {
        DriverError::Cancelled
    } else {
        DriverError::WorkerFailed
    });
    answer(accepted, Err(error));
    control.progress.send_replace(Progress::Finished(result));
    inner.changed.notify_waiters();
}
