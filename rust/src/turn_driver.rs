//! Owned asynchronous execution. Host authorization and real adapters are separate.
use crate::prompt_attachments::{
    AttachmentKind, MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, PromptAttachment,
};
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

/// Trusted host metadata. Queue identity strings are opaque UTF-8, retained
/// exactly (including an empty `queue_item_at`), each bounded to 1024 bytes.
#[derive(Clone, Default)]
pub struct InputMetadata {
    pub attachments: Vec<PromptAttachment>,
    pub question_id: Option<u64>,
    pub queue_item_id: Option<String>,
    pub queue_item_at: Option<String>,
}
impl std::fmt::Debug for InputMetadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputMetadata")
            .field("attachments", &self.attachments.len())
            .field("has_question", &self.question_id.is_some())
            .field("has_queue", &self.queue_item_id.is_some())
            .finish()
    }
}
#[derive(Clone)]
pub struct Input {
    pub text: String,
    pub metadata: InputMetadata,
}
impl std::fmt::Debug for Input {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Input")
            .field("text_bytes", &self.text.len())
            .field("metadata", &self.metadata)
            .finish()
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    pub id: u64,
    pub ts: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SinkError {
    pub message: String,
}
/// Typed completion authority supplied only by Driver after native cleanup and
/// durable terminal append, before the exact ticket's slot can be released.
/// A sink may consume it for checked metadata IO; JSON events are not authority.
pub struct Completion {
    ticket: Ticket,
    outcome: Outcome,
}
impl Completion {
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn outcome(&self) -> &Outcome {
        &self.outcome
    }
}
pub trait EventSink: Send + Sync + 'static {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>>;
    /// Once polled, owned IO must finish even if a caller stops waiting.
    /// Runs outside Driver locks. Error or panic closes execution admission.
    fn before_release(&self, _completion: Completion) -> Task<Result<(), SinkError>> {
        Box::pin(async { Ok(()) })
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}
pub struct Started {
    /// Public Pult turn identity used by CLI/journal; adapters keep the native
    /// provider turn identity separately for interrupt and callback routing.
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
/// Fresh, synchronous host check immediately before dispatch seals. Ordinary
/// input is already durable; queue/question receipts follow the start checkpoint.
/// Runs in an owned blocking step, including its dispatch seal. Registry and
/// filesystem checks may block; provider preparation belongs outside this callback.
/// Cancellation revokes dispatch but retains the ticket until the check returns.
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
    pub fn subscribe_progress(&self) -> watch::Receiver<Progress> {
        self.progress.clone()
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
    spawn_sealed: std::sync::atomic::AtomicBool,
    spawn_brand: std::sync::OnceLock<Arc<()>>,
    input_sealed: std::sync::atomic::AtomicBool,
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
/// Opaque admission state for one trusted memory mutation. Cancellation before
/// seal wins; a sealed operation owns its subsequent commit outcome.
pub(crate) struct MemoryAction {
    state: std::sync::atomic::AtomicU8,
    deadline: std::time::Instant,
}
impl MemoryAction {
    pub(crate) fn new(deadline: std::time::Instant) -> Self {
        Self {
            state: std::sync::atomic::AtomicU8::new(0),
            deadline,
        }
    }
    pub(crate) fn cancel(&self) {
        let _ = self.state.compare_exchange(
            0,
            2,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        );
    }
    fn seal(&self) -> bool {
        if std::time::Instant::now() >= self.deadline {
            return false;
        }
        self.state
            .compare_exchange(
                0,
                1,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
}

/// Trusted-host admission for one exact ticket's Route A process spawn.
/// No native IDs, callbacks, filesystem work or OS process are stored here.
/// A successful seal is irreversible: cancellation afterwards may observe a
/// new PID and must stop/join it; it is never proof that nothing was spawned.
/// This capability is deliberately neither Debug nor Serialize nor Clone.
pub struct SpawnAction {
    brand: Arc<()>,
    ticket: Ticket,
    deadline: std::time::Instant,
    state: std::sync::atomic::AtomicU8,
}
impl SpawnAction {
    pub fn new(ticket: Ticket, deadline: std::time::Instant) -> Self {
        Self {
            brand: Arc::new(()),
            ticket,
            deadline,
            state: std::sync::atomic::AtomicU8::new(0),
        }
    }
    /// Wins only before seal. Repeating cancellation preserves NeverSent;
    /// cancellation after a successful seal cannot erase possible dispatch.
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(
                0,
                2,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
    pub fn sealed(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::Acquire) == 1
    }
    /// This proves no successful Driver seal, not completion of owned IO.
    /// It cannot by itself authorize clearing durable markers/releasing leases.
    pub fn never_sent(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::Acquire) == 2
    }
    fn seal(&self) -> bool {
        if std::time::Instant::now() >= self.deadline {
            return false;
        }
        self.state
            .compare_exchange(
                0,
                1,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
}

/// Trusted-host admission for the first native input after an owned process
/// spawn. Construction inherits the exact process action's ticket and absolute
/// deadline; it does not enqueue, poll, write or acknowledge native input.
/// The host must finish fresh policy checks before Driver::seal_input and seal
/// before the first possible enqueue/write. This is not provider acceptance or
/// a process/IO cleanup receipt. Deliberately not Debug, Serialize or Clone.
pub struct InputAction {
    process_spawn: Arc<SpawnAction>,
    state: std::sync::atomic::AtomicU8,
}
impl InputAction {
    pub fn new(process_spawn: Arc<SpawnAction>) -> Self {
        Self {
            process_spawn,
            state: std::sync::atomic::AtomicU8::new(0),
        }
    }
    /// Wins only before seal; a later cancel cannot erase possible delivery.
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(
                0,
                2,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
    pub fn sealed(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::Acquire) == 1
    }
    /// No successful seal for this action, after local cancellation. This does
    /// not exclude another action for the Ticket, native startup execution,
    /// process cleanup or admitted external IO.
    pub fn never_enqueued(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::Acquire) == 2
    }
    fn seal(&self) -> bool {
        if std::time::Instant::now() >= self.process_spawn.deadline {
            return false;
        }
        self.state
            .compare_exchange(
                0,
                1,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
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
        self.start_inner(
            snapshot,
            Input {
                text,
                metadata: InputMetadata::default(),
            },
            worker,
            None,
        )
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
        self.start_inner(
            snapshot,
            Input {
                text,
                metadata: InputMetadata::default(),
            },
            worker,
            Some(gate),
        )
    }
    /// The host must filesystem-validate attachments and give the exact same
    /// metadata to its Worker facade. The Worker trait remains text-only.
    /// Queue/question receipts are deferred until the initial completion poll.
    pub fn start_input(
        &self,
        snapshot: TurnSnapshot,
        input: Input,
        worker: Arc<dyn Worker>,
        gate: Arc<dyn DispatchGate>,
    ) -> Result<Handle, DriverError> {
        self.start_inner(snapshot, input, worker, Some(gate))
    }
    fn start_inner(
        &self,
        snapshot: TurnSnapshot,
        input: Input,
        worker: Arc<dyn Worker>,
        gate: Option<Arc<dyn DispatchGate>>,
    ) -> Result<Handle, DriverError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| DriverError::Internal)?;
        let deferred =
            input.metadata.question_id.is_some() || input.metadata.queue_item_id.is_some();
        let draft = input_draft(&self.inner, &snapshot, &input)?;
        let text = input.text;
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
        let control = Arc::new(Control {
            cancel,
            progress,
            spawn_sealed: std::sync::atomic::AtomicBool::new(false),
            spawn_brand: std::sync::OnceLock::new(),
            input_sealed: std::sync::atomic::AtomicBool::new(false),
        });
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
                draft,
                deferred,
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
    /// Trusted owner query. Clone outside this lock before filesystem checks or
    /// injected callbacks; absence revokes new provider dispatch authority.
    pub fn snapshot_for_dispatch(&self, ticket: &Ticket) -> Option<TurnSnapshot> {
        let state = self.inner.state.lock().expect("driver state mutex");
        if state.closed || state.storage_failed {
            return None;
        }
        state
            .core
            .active(ticket)
            .filter(|turn| !turn.cancel_requested())
            .map(|turn| turn.snapshot().clone())
    }
    /// Diagnostic snapshot includes cancellation until cleanup is proved. Never
    /// use it for dispatch authority; snapshot_for_dispatch revokes that scope.
    pub fn execution_snapshot(&self, ticket: &Ticket) -> Option<TurnSnapshot> {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .core
            .active(ticket)
            .map(|turn| turn.snapshot().clone())
    }
    /// Trusted host observation for lazy provenance. Starting has no accepted
    /// user receipt; only Progress::Running carries a durable accepted event.
    /// This does not grant dispatch or memory authority.
    pub(crate) fn progress_for_ticket(&self, ticket: &Ticket) -> Option<watch::Receiver<Progress>> {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .jobs
            .get(ticket)
            .map(|control| control.progress.subscribe())
    }
    /// Trusted host-only linearization. This contains no callback or IO and
    /// must be invoked only after source policy/capability checks under their
    /// own gates. It never invents acceptance for a pending/unknown native send.
    pub(crate) fn seal_memory_action(
        &self,
        ticket: &Ticket,
        action: &MemoryAction,
        expected: &Accepted,
    ) -> Option<Accepted> {
        let state = self.inner.state.lock().expect("driver state mutex");
        if state.closed || state.storage_failed {
            return None;
        }
        let active = state.core.active(ticket)?;
        if active.cancel_requested() || active.provider_turn_id().is_none() {
            return None;
        }
        let control = state.jobs.get(ticket)?;
        let Progress::Running(accepted) = control.progress.borrow().clone() else {
            return None;
        };
        if &accepted != expected
            || accepted.user_event_id == 0
            || accepted.user_event_id > 9_007_199_254_740_991
            || !action.seal()
        {
            return None;
        }
        Some(accepted)
    }
    /// Bounded in-memory linearization against Driver cancel/fault/shutdown.
    /// Host policy/filesystem callbacks and launch validation must finish first.
    /// Only the exact Dispatching snapshot can seal; even a new SpawnAction
    /// cannot grant a second spawn for the same ticket. No IO/callback/OS spawn
    /// occurs under this mutex. Invoke from Process's actual SpawnGate frontier;
    /// after true, retain process/IO ownership through cancellation and failure.
    pub fn seal_spawn(
        &self,
        ticket: &Ticket,
        expected: &TurnSnapshot,
        action: &SpawnAction,
    ) -> bool {
        let state = self.inner.state.lock().expect("driver state mutex");
        if state.closed || state.storage_failed || &action.ticket != ticket {
            return false;
        }
        let Some(active) = state.core.active(ticket) else {
            return false;
        };
        if active.phase() != crate::turn_coordinator::Phase::Dispatching
            || active.cancel_requested()
            || active.snapshot() != expected
        {
            return false;
        }
        let Some(control) = state.jobs.get(ticket) else {
            return false;
        };
        if *control.cancel.borrow()
            || control
                .spawn_sealed
                .load(std::sync::atomic::Ordering::Relaxed)
            || !action.seal()
        {
            return false;
        }
        control
            .spawn_brand
            .set(action.brand.clone())
            .expect("spawn brand is assigned only after the unique spawn seal");
        control
            .spawn_sealed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        true
    }
    /// Bounded linearization of the first native input against Driver
    /// cancellation, fault and shutdown. The exact process action must already
    /// be sealed by this Control. A second action cannot grant another input.
    /// Caller retains its fresh source-policy admission through the first
    /// enqueue/write; no callback, IO, native ACK or phase transition occurs here.
    /// After true, cancellation cannot prove that input was never delivered.
    pub fn seal_input(
        &self,
        ticket: &Ticket,
        expected: &TurnSnapshot,
        action: &InputAction,
    ) -> bool {
        let state = self.inner.state.lock().expect("driver state mutex");
        if state.closed || state.storage_failed || &action.process_spawn.ticket != ticket {
            return false;
        }
        let Some(active) = state.core.active(ticket) else {
            return false;
        };
        if active.phase() != crate::turn_coordinator::Phase::Dispatching
            || active.cancel_requested()
            || active.snapshot() != expected
        {
            return false;
        }
        let Some(control) = state.jobs.get(ticket) else {
            return false;
        };
        if *control.cancel.borrow()
            || !control
                .spawn_sealed
                .load(std::sync::atomic::Ordering::Relaxed)
            || !action.process_spawn.sealed()
            || !control
                .spawn_brand
                .get()
                .is_some_and(|brand| Arc::ptr_eq(brand, &action.process_spawn.brand))
            || control
                .input_sealed
                .load(std::sync::atomic::Ordering::Relaxed)
            || !action.seal()
        {
            return false;
        }
        control
            .input_sealed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        true
    }
    pub async fn wait_for_storage_failure(&self) {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.storage_failed() {
                return;
            }
            changed.await;
        }
    }
    /// Includes cancelling jobs so stop/archive can address the exact incarnation.
    pub fn active_ticket(&self, key: &crate::turn_snapshot::SessionKey) -> Option<Ticket> {
        let state = self.inner.state.lock().expect("driver state mutex");
        state
            .core
            .by_name(&key.name)
            .filter(|turn| turn.ticket().session() == key)
            .map(|turn| turn.ticket().clone())
    }
    /// Owner cancellation lookup only; never dispatch authority.
    pub fn active_ticket_for_name(&self, name: &str) -> Option<Ticket> {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .core
            .by_name(name)
            .map(|turn| turn.ticket().clone())
    }
    /// Pult public ID returned by Worker::start, never a native provider turn ID.
    pub fn public_turn_id(&self, ticket: &Ticket) -> Option<String> {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .core
            .active(ticket)
            .and_then(|turn| turn.provider_turn_id().map(str::to_owned))
    }
    /// Trusted host bridge for a failed provider/broker journal write. An
    /// unknown outcome must stop admission and cancel every owned execution.
    pub fn report_storage_failure(&self) {
        latch_storage(&self.inner);
    }
    pub fn storage_failed(&self) -> bool {
        self.inner
            .state
            .lock()
            .expect("driver state mutex")
            .storage_failed
    }
    /// Waits for this exact ticket's final cleanup proof, never a status event.
    pub async fn wait_ticket(&self, ticket: &Ticket) {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self
                .inner
                .state
                .lock()
                .expect("driver state mutex")
                .jobs
                .contains_key(ticket)
            {
                return;
            }
            changed.await;
        }
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
    /// Synchronous stop barrier; no new dispatch is authorized after return.
    pub fn begin_shutdown(&self) {
        close_admission(&self.inner);
    }
    pub async fn shutdown(&self, timeout: Duration) -> Result<(), DriverError> {
        self.begin_shutdown();
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
    drop(state);
    inner.changed.notify_waiters();
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
fn js_whitespace(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}
fn input_draft(
    inner: &Inner,
    snapshot: &TurnSnapshot,
    input: &Input,
) -> Result<Value, DriverError> {
    let metadata = &input.metadata;
    if input.text.len()
        > if input.metadata.queue_item_id.is_some() {
            200_000
        } else {
            65536
        }
        || (input.text.trim_matches(js_whitespace).is_empty() && metadata.attachments.is_empty())
        || metadata.attachments.len() > MAX_PROMPT_ATTACHMENTS
        || metadata
            .question_id
            .is_some_and(|id| id == 0 || id > 9_007_199_254_740_991)
        || metadata.queue_item_id.is_some() != metadata.queue_item_at.is_some()
        || metadata
            .queue_item_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 1024)
        || metadata
            .queue_item_at
            .as_ref()
            .is_some_and(|at| at.len() > 1024)
    {
        return Err(DriverError::Invalid);
    }
    for a in &metadata.attachments {
        if !std::path::Path::new(&a.path).is_absolute()
            || a.path.contains(['\0', '\r', '\n'])
            || a.path.encode_utf16().count() > 16_384
            || a.name.trim_matches(js_whitespace).is_empty()
            || a.name.contains(['\0', '\r', '\n'])
            || a.name.encode_utf16().count() > 512
            || a.mime.is_empty()
            || a.mime.encode_utf16().count() > 128
            || a.bytes > MAX_PROMPT_ATTACHMENT_BYTES
            || (a.kind == AttachmentKind::Directory
                && (a.bytes != 0 || a.mime != "inode/directory"))
        {
            return Err(DriverError::Invalid);
        }
    }
    let public_text = redact(inner, &input.text)
        .filter(|s| {
            s.len()
                <= if metadata.queue_item_id.is_some() {
                    200_000
                } else {
                    65536
                }
        })
        .ok_or(DriverError::Invalid)?;
    let mut data = json!({"text":public_text});
    if !metadata.attachments.is_empty() {
        data["attachments"] = Value::Array(
            metadata
                .attachments
                .iter()
                .map(PromptAttachment::value)
                .collect(),
        );
    }
    if let Some(id) = metadata.question_id {
        data["questionId"] = json!(id);
    }
    if let (Some(id), Some(at)) = (&metadata.queue_item_id, &metadata.queue_item_at) {
        data["queueItemId"] = json!(id);
        data["queueItemAt"] = json!(at);
    }
    let draft = json!({"sessionId":snapshot.key.name,"provider":snapshot.provider.as_str(),"kind":"message.user","data":data});
    // Reserve enough bytes for the journal's safe integer id, timestamp and
    // framing fields before any provider can begin an external send.
    if serde_json::to_vec(&draft)
        .map_err(|_| DriverError::Invalid)?
        .len()
        > crate::MAX_LINE - 512
    {
        return Err(DriverError::Invalid);
    }
    Ok(draft)
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
    draft: Value,
    deferred: bool,
    worker: Arc<dyn Worker>,
    gate: Option<Arc<dyn DispatchGate>>,
    mut accepted: Option<oneshot::Sender<Result<Accepted, DriverError>>>,
) {
    let mut cancel = control.cancel.subscribe();
    let mut user_event_id = None;
    let deferred_draft = if deferred {
        Some(draft)
    } else {
        match append(&inner, draft).await {
            Ok(receipt) => user_event_id = Some(receipt.id),
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
        }
        None
    };
    let end = execute(
        &inner,
        &control,
        &ticket,
        &worker,
        &mut cancel,
        &mut accepted,
        &mut user_event_id,
        text,
        gate,
        &snapshot,
        deferred_draft,
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
        user_event_id,
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
    user_event_id: &mut Option<u64>,
    text: String,
    gate: Option<Arc<dyn DispatchGate>>,
    initial: &TurnSnapshot,
    deferred_draft: Option<Value>,
) -> End {
    if *cancel.borrow_and_update() {
        return End {
            outcome: Outcome::Interrupted,
            error: Some(DriverError::Cancelled),
            touched: false,
        };
    }
    // The owned run waits for this check even after cancellation. It retains
    // the ticket until blocking policy IO ends; the callback and seal have no
    // await between them, and no external callback runs under the driver lock.
    let owner = inner.clone();
    let scope = ticket.clone();
    let initial = initial.clone();
    let cancellation = control.cancel.subscribe();
    let checked = tokio::task::spawn_blocking(move || {
        if *cancellation.borrow() {
            return Err(End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: false,
            });
        }
        let decision = match gate {
            Some(gate) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                gate.check(&scope, &initial)
            }))
            .unwrap_or(DispatchDecision::Deny),
            None => DispatchDecision::Allow,
        };
        let mut state = owner.state.lock().expect("driver state mutex");
        if state.storage_failed {
            return Err(End {
                outcome: failure("journal_unknown", "execution paused"),
                error: Some(DriverError::StorageUnavailable),
                touched: false,
            });
        }
        if *cancellation.borrow() {
            return Err(End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: false,
            });
        }
        let denied = match decision {
            DispatchDecision::Allow => false,
            DispatchDecision::Deny => true,
            DispatchDecision::Restrict(approval) => !matches!(
                state.core.restrict_before_start(&scope, approval),
                Ok(crate::turn_coordinator::Change::Applied
                    | crate::turn_coordinator::Change::Unchanged)
            ),
        };
        if denied {
            return Err(End {
                outcome: failure("access_denied", "turn access denied before dispatch"),
                error: Some(DriverError::AccessDenied),
                touched: false,
            });
        }
        Ok(state.core.dispatch_start(&scope))
    })
    .await;
    let dispatch = match checked {
        Ok(Ok(dispatch)) => dispatch,
        Ok(Err(end)) => return end,
        Err(_) => {
            return End {
                outcome: failure("worker_panic", "dispatch check failed"),
                error: Some(DriverError::WorkerFailed),
                touched: false,
            };
        }
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
    if started.turn_id.is_empty()
        || started.turn_id.len() > 256
        || started.turn_id.chars().any(char::is_control)
        || redact(inner, &started.turn_id).as_deref() != Some(started.turn_id.as_str())
    {
        return End {
            outcome: failure(
                "invalid_start_reply",
                "worker returned an unsafe start reply",
            ),
            error: Some(DriverError::WorkerFailed),
            touched: true,
        };
    }
    let Started { turn_id, done } = started;
    let mut pending_done = Some(done);
    let deferred = deferred_draft.is_some();
    let mut completion = if deferred {
        let (checkpoint, checkpoint_rx) = oneshot::channel();
        let mut handle = tokio::spawn(checkpoint_done(
            pending_done.take().expect("unpolled completion"),
            checkpoint,
        ));
        let first = tokio::select! {
            biased;
            _=cancel.changed()=>{
                stop_completion(&mut handle).await;
                return End { outcome: Outcome::Interrupted, error: Some(DriverError::Cancelled), touched: true };
            }
            result=checkpoint_rx=>result,
        };
        match first {
            Ok(InitialPoll::Pending) | Ok(InitialPoll::Ready(Outcome::Success)) => {}
            Ok(InitialPoll::Ready(outcome)) => {
                stop_completion(&mut handle).await;
                return End {
                    outcome: normalized(inner, outcome),
                    error: Some(DriverError::WorkerFailed),
                    touched: true,
                };
            }
            Err(_) => {
                stop_completion(&mut handle).await;
                return End {
                    outcome: failure("worker_panic", "worker completion failed"),
                    error: Some(DriverError::WorkerFailed),
                    touched: true,
                };
            }
        }
        Some(handle)
    } else {
        None
    };
    let action = inner
        .state
        .lock()
        .expect("driver state mutex")
        .core
        .provider_started(ticket, &turn_id);
    match action {
        Ok(StartAction::Proceed) => {}
        action => {
            stop_owned_completion(&mut completion).await;
            let cancelled = matches!(action, Ok(StartAction::CancelProvider));
            return End {
                outcome: if cancelled {
                    Outcome::Interrupted
                } else {
                    failure(
                        "invalid_start_reply",
                        "worker returned an invalid start reply",
                    )
                },
                error: Some(if cancelled {
                    DriverError::Cancelled
                } else {
                    DriverError::WorkerFailed
                }),
                touched: true,
            };
        }
    }
    if let Some(draft) = deferred_draft {
        if *cancel.borrow_and_update() {
            stop_owned_completion(&mut completion).await;
            return End {
                outcome: Outcome::Interrupted,
                error: Some(DriverError::Cancelled),
                touched: true,
            };
        }
        match append(inner, draft).await {
            Ok(receipt) => *user_event_id = Some(receipt.id),
            Err(error) => {
                stop_owned_completion(&mut completion).await;
                return End {
                    outcome: failure(
                        "journal_unknown",
                        "journal result is unknown; execution paused",
                    ),
                    error: Some(error),
                    touched: true,
                };
            }
        }
    }
    // Serialize the fresh deferred cancellation check and Accepted publication
    // with cancel()/the global journal latch. No await while holding the lock.
    let refused = {
        let state = inner.state.lock().expect("driver state mutex");
        if deferred && state.storage_failed {
            Some(DriverError::StorageUnavailable)
        } else if deferred && *cancel.borrow_and_update() {
            Some(DriverError::Cancelled)
        } else {
            let reply = Accepted {
                turn_id,
                user_event_id: user_event_id.expect("durable input receipt"),
            };
            control
                .progress
                .send_replace(Progress::Running(reply.clone()));
            answer(accepted, Ok(reply));
            None
        }
    };
    if let Some(error) = refused {
        stop_owned_completion(&mut completion).await;
        return End {
            outcome: if error == DriverError::Cancelled {
                Outcome::Interrupted
            } else {
                failure("journal_unknown", "execution paused")
            },
            error: Some(error),
            touched: true,
        };
    }
    // Ordinary input preserves the original ordering: start polling completion
    // only after Accepted. Deferred input already owns its checkpoint task.
    let mut done = completion.take().unwrap_or_else(|| {
        tokio::spawn(pending_done.take().expect("unpolled ordinary completion"))
    });
    let outcome = tokio::select! {
        biased;
        _=cancel.changed()=>{stop_completion(&mut done).await;Outcome::Interrupted},
        result=&mut done=>match result {Ok(outcome)=>normalized(inner,outcome),Err(_)=>failure("worker_panic","worker completion failed")},
    };
    End {
        outcome,
        error: None,
        touched: true,
    }
}

enum InitialPoll {
    Ready(Outcome),
    Pending,
}
async fn checkpoint_done(
    mut done: Task<Outcome>,
    checkpoint: oneshot::Sender<InitialPoll>,
) -> Outcome {
    let mut checkpoint = Some(checkpoint);
    std::future::poll_fn(move |cx| {
        let result = done.as_mut().poll(cx);
        if let Some(sender) = checkpoint.take() {
            let initial = match &result {
                std::task::Poll::Ready(outcome) => InitialPoll::Ready(outcome.clone()),
                std::task::Poll::Pending => InitialPoll::Pending,
            };
            let _ = sender.send(initial);
        }
        result
    })
    .await
}
async fn stop_completion(done: &mut tokio::task::JoinHandle<Outcome>) {
    done.abort();
    let _ = done.await;
}
async fn stop_owned_completion(done: &mut Option<tokio::task::JoinHandle<Outcome>>) {
    if let Some(done) = done.as_mut() {
        stop_completion(done).await;
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
    if terminal_event_id.is_some() && end.error != Some(DriverError::StorageUnavailable) {
        let sink = inner.sink.clone();
        let completion = Completion {
            ticket: ticket.clone(),
            outcome: end.outcome.clone(),
        };
        if !matches!(
            tokio::spawn(async move { sink.before_release(completion).await }).await,
            Ok(Ok(()))
        ) {
            latch_storage(inner);
            end.error = Some(DriverError::StorageUnavailable);
        }
    }
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
