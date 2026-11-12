//! Ordinary Codex Worker over one owned, shared app-server connection. Trusted
//! host configuration only; no RPC endpoint or provider login/model selection IO.
//! Browser setup, subagents and background execution are deliberately unsupported:
//! observing them retires the host safely instead of claiming complete parity.
//! Host installs panic_guard before callbacks. Driver owns the final status event.
//! Automatic model-capacity replay and ephemeral UI phase delivery are excluded.
//! Three consecutive provider retry notifications block only their owned ticket.
use crate::codex_events::{self, Normalizer, Redactor};
use crate::codex_process::{self, Cleanup, CleanupStatus, Connection};
use crate::codex_rpc::{Client, Event, ResponsePermit, RpcError};
use crate::prompt_attachments::{self, PromptAttachment, PromptAttachmentScope};
use crate::turn_coordinator::{Outcome, Ticket};
use crate::turn_driver::{
    DispatchDecision, DispatchGate, EventSink, Started, Task, Worker, WorkerError,
};
use crate::turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot};
use crate::worker_process::Launch;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::future::{Future, poll_fn};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
};
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;
const PREPARING: u8 = 0;
const EXECUTING: u8 = 1;
const TERMINAL: u8 = 2;
const QUARANTINED: u8 = 3;
fn error(code: &str, message: &str) -> WorkerError {
    WorkerError {
        code: code.into(),
        message: message.into(),
    }
}
fn failure(code: &str, message: &str) -> Outcome {
    Outcome::Failure {
        code: code.into(),
        message: message.into(),
    }
}
fn unavailable() -> WorkerError {
    error("provider_unavailable", "Codex host is unavailable")
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostStatus {
    Starting,
    Ready,
    Retiring,
    Stopped,
    Unconfirmed,
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub sessions: usize,
    pub jobs: usize,
    pub event_slots: usize,
    pub event_bytes: usize,
    pub approvals: usize,
    pub completed_turns: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            sessions: 64,
            jobs: 64,
            event_slots: 8,
            event_bytes: 32 * 1024 * 1024,
            approvals: 8,
            completed_turns: 1024,
        }
    }
}
#[derive(Clone, Copy)]
pub struct Timeouts {
    pub process: codex_process::Timeouts,
    pub control: Duration,
    pub interrupt: Duration,
}
impl Default for Timeouts {
    fn default() -> Self {
        Self {
            process: codex_process::Timeouts::default(),
            control: Duration::from_secs(30),
            interrupt: Duration::from_secs(3),
        }
    }
}
pub struct HostConfig {
    pub launch: Launch,
    pub fingerprint: String,
    pub limits: Limits,
    pub timeouts: Timeouts,
}
pub type RedactorFactory = Arc<dyn Fn() -> Box<dyn Redactor> + Send + Sync>;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    Full,
}
/// Validated, bounded provider policy. This is authority metadata, never redacted JSON.
pub struct PreparedSandbox {
    pub mode: SandboxMode,
    pub network_access: Option<bool>,
    pub writable_roots: Vec<PathBuf>,
    pub exclude_slash_tmp: Option<bool>,
    pub exclude_tmpdir_env_var: Option<bool>,
}
/// Immutable trusted persistence request, freshly created for every prepare,
/// including warm reuse. The store must check session incarnation and ticket.
pub struct ThreadPrepared {
    session: SessionKey,
    ticket: Ticket,
    native_thread_id: String,
    cwd: PathBuf,
    model: String,
    sandbox: PreparedSandbox,
    seal: Arc<()>,
}
impl ThreadPrepared {
    pub fn session(&self) -> &SessionKey {
        &self.session
    }
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn native_thread_id(&self) -> &str {
        &self.native_thread_id
    }
    pub fn cwd(&self) -> &std::path::Path {
        &self.cwd
    }
    pub fn model(&self) -> &str {
        &self.model
    }
    pub fn sandbox(&self) -> &PreparedSandbox {
        &self.sandbox
    }
    /// Call only after the exact request has durably committed, or an idempotent
    /// checked read proves that its current incarnation already has this value.
    pub fn acknowledge(self) -> ThreadReceipt {
        ThreadReceipt { seal: self.seal }
    }
}
/// Single-use proof bound privately to one prepare request; not forgeable or cloneable.
pub struct ThreadReceipt {
    seal: Arc<()>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ThreadStoreError {
    /// Known rejection before mutation, e.g. removed/archived/stale session.
    Rejected,
    /// Persistence outcome is unconfirmed; closes admission and latches storage failure.
    Unknown,
}
pub trait ThreadStore: Send + Sync + 'static {
    /// Once polled this IO stays owned until completion, including cancellation.
    /// A permanently pending store keeps cleanup unconfirmed and retains ownership.
    fn persist(&self, request: ThreadPrepared) -> Task<Result<ThreadReceipt, ThreadStoreError>>;
}
pub struct Services {
    pub sink: Arc<dyn EventSink>,
    pub redactors: RedactorFactory,
    pub fresh_gate: Arc<dyn DispatchGate>,
    pub approval: Option<Arc<dyn ApprovalHandler>>,
    pub fatal_storage: Arc<dyn Fn() + Send + Sync>,
    pub thread_store: Arc<dyn ThreadStore>,
}
/// This capability is routed only for the active trusted ticket and native turn.
/// Raw params/permission data are intentionally not Debug or journaled here.
pub struct ApprovalContext {
    pub responder: ScopedResponder,
    pub session: SessionKey,
    pub ticket: Ticket,
    pub thread_id: String,
    pub native_turn_id: String,
    pub effective_approval: Approval,
    pub method: String,
    pub params: RawParams,
}
/// Raw input with its byte reservation. Private fields prevent async closure
/// disjoint captures from dropping the reservation while retaining the value.
/// Deliberate copies made by a trusted handler belong to that handler's budget.
pub struct RawParams {
    value: Value,
    _budget: OwnedSemaphorePermit,
}
impl std::ops::Deref for RawParams {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
/// Single-use reply authority. It has no public Client or ResponsePermit escape.
/// The only lock spans the first poll of our own Client.respond enqueue; no
/// user callback runs under it. A terminal or cancellation permanently revokes it.
pub struct ScopedResponder {
    client: Client,
    permit: Option<ResponsePermit>,
    job: Arc<Job>,
}
impl ScopedResponder {
    pub async fn respond(
        mut self,
        answer: Result<Value, crate::codex_rpc::ResponseError>,
    ) -> Result<(), RpcError> {
        let client = self.client.clone();
        let permit = self.permit.take().ok_or(RpcError::InvalidPermit)?;
        let mut response = std::pin::pin!(client.respond(permit, answer));
        let mut first = true;
        poll_fn(|cx| {
            if first {
                let revoked = self.job.approval_closed.borrow();
                if *revoked {
                    return Poll::Ready(Err(RpcError::InvalidPermit));
                }
                first = false;
                response.as_mut().poll(cx)
            } else {
                response.as_mut().poll(cx)
            }
        })
        .await
    }
}
impl ScopedResponder {
    /// The check and first enqueue poll share one blocking step. Its Job guard
    /// survives an aborted approval waiter, so cleanup cannot abandon policy IO.
    pub(crate) async fn respond_checked(
        self,
        gate: Arc<dyn DispatchGate>,
        snapshot: TurnSnapshot,
        expected: Approval,
        answer: Result<Value, crate::codex_rpc::ResponseError>,
    ) -> Result<(), RpcError> {
        let io = CheckGuard::new(&self.job);
        let checked = tokio::task::spawn_blocking(move || {
            let _io = io;
            if *self.job.approval_closed.borrow() {
                return Err(RpcError::InvalidPermit);
            }
            let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                gate.check(&self.job.ticket, &snapshot)
            }))
            .unwrap_or(DispatchDecision::Deny);
            let effective = match decision {
                DispatchDecision::Allow => snapshot.settings.approval,
                DispatchDecision::Restrict(mode) => mode,
                DispatchDecision::Deny => return Err(RpcError::InvalidPermit),
            };
            if effective != expected {
                return Err(RpcError::InvalidPermit);
            }
            // respond rechecks the revocable scope and synchronously enqueues
            // on its first poll, without external callbacks under its guard.
            Ok(first_poll(Box::pin(self.respond(answer))))
        })
        .await
        .map_err(|_| RpcError::InvalidPermit)??;
        checked.finish().await
    }
}
struct FirstPoll<T> {
    future: Task<T>,
    result: Poll<T>,
}
fn first_poll<T>(mut future: Task<T>) -> FirstPoll<T> {
    let result = future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()));
    FirstPoll { future, result }
}
impl<T> FirstPoll<T> {
    async fn finish(self) -> T {
        match self.result {
            Poll::Ready(result) => result,
            Poll::Pending => self.future.await,
        }
    }
}
impl Drop for ScopedResponder {
    fn drop(&mut self) {
        drop(self.permit.take());
        self.job.responders.fetch_sub(1, Ordering::AcqRel);
        self.job.changed.notify_waiters();
    }
}
/// Construction must return promptly. No lock is held through this callback or
/// its future. Stashing a responder is revocable and retains its bounded slot.
pub trait ApprovalHandler: Send + Sync + 'static {
    fn handle(&self, context: ApprovalContext) -> Task<()>;
}
pub struct SessionSpec {
    pub key: SessionKey,
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub resume_id: Option<String>,
    pub broker: bool,
    pub attachments: Vec<PromptAttachment>,
}
struct Session {
    broker: bool,
    home: PathBuf,
    cwd: PathBuf,
    thread: Option<String>,
    attached: bool,
    confirmed: bool,
    model: Option<String>,
    sandbox: Option<Value>,
    busy: Option<Ticket>,
}
struct Route {
    ticket: Ticket,
    job: Arc<Job>,
    sender: mpsc::Sender<Envelope>,
}
struct State {
    status: HostStatus,
    sessions: HashMap<SessionKey, Session>,
    jobs: HashMap<Ticket, Arc<Job>>,
    routes: HashMap<String, Route>,
    completed: HashSet<(String, String)>,
}
struct Shared {
    state: Mutex<State>,
    client: watch::Sender<Option<Client>>,
    changed: Notify,
    bytes: Arc<Semaphore>,
    limits: Limits,
    timeouts: Timeouts,
    services: Services,
    cleanup: Cleanup,
    storage_failed: AtomicBool,
    unsupported_background: AtomicBool,
    fingerprint: String,
}
pub struct CodexHost {
    shared: Arc<Shared>,
}
pub struct CodexWorker {
    host: Arc<CodexHost>,
    spec: Arc<SessionSpec>,
}
struct StartWaiter(Option<Arc<Job>>);
struct PendingStart {
    waiter: StartWaiter,
    receiver: oneshot::Receiver<Result<Started, WorkerError>>,
}
impl Drop for StartWaiter {
    fn drop(&mut self) {
        if let Some(job) = &self.0 {
            cancel_job(job);
        }
    }
}
struct Info {
    thread: Option<String>,
    native: Option<String>,
    model: Option<String>,
    effective: Approval,
    thread_inflight: bool,
    dispatched: bool,
    acknowledged: bool,
    uncertain_start: bool,
    dispatch_started: Option<Instant>,
    provider_terminal: bool,
    unsupported: bool,
    open_tools: HashSet<String>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Closed {
    Pending,
    Confirmed,
    Unconfirmed,
}
struct Job {
    ticket: Ticket,
    public_id: String,
    info: Mutex<Info>,
    execution: AtomicU8,
    cancel: watch::Sender<bool>,
    approval_closed: watch::Sender<bool>,
    responders: AtomicUsize,
    checks: AtomicUsize,
    event_stop: watch::Sender<bool>,
    closed: watch::Sender<Closed>,
    changed: Notify,
    persistence: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
// Only synchronous checks consume blocking-pool threads. A guard is registered
// before spawn and moved into its closure; async cancellation cannot detach IO
// from the Job's final cleanup proof.
struct CheckGuard(Arc<Job>);
impl CheckGuard {
    fn new(job: &Arc<Job>) -> Self {
        job.checks.fetch_add(1, Ordering::AcqRel);
        Self(job.clone())
    }
}
impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.0.checks.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}
async fn wait_checks(job: &Job) {
    loop {
        let changed = job.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if job.checks.load(Ordering::Acquire) == 0 {
            return;
        }
        changed.await;
    }
}
struct Envelope {
    event: Event,
    _budget: OwnedSemaphorePermit,
}
impl CodexHost {
    pub fn start(config: HostConfig, services: Services) -> Result<Arc<Self>, WorkerError> {
        tokio::runtime::Handle::try_current().map_err(|_| unavailable())?;
        if config
            .launch
            .env
            .contains_key(std::ffi::OsStr::new("PULT_MEMORY_KEY"))
        {
            return Err(error(
                "invalid_params",
                "shared Codex host cannot inherit session memory authority",
            ));
        }
        let l = config.limits;
        if config.fingerprint.is_empty()
            || config.fingerprint.len() > 256
            || l.sessions == 0
            || l.sessions > 256
            || l.jobs == 0
            || l.jobs > 128
            || l.event_slots == 0
            || l.event_slots > 64
            || l.event_bytes < 16 * 1024 * 1024
            || l.event_bytes > 64 * 1024 * 1024
            || l.approvals == 0
            || l.approvals > 32
            || l.completed_turns == 0
            || l.completed_turns > 4096
            || config.timeouts.control.is_zero()
            || config.timeouts.control > Duration::from_secs(120)
            || config.timeouts.interrupt.is_zero()
            || config.timeouts.interrupt > Duration::from_secs(30)
        {
            return Err(error("invalid_params", "invalid Codex host limits"));
        }
        let connection = codex_process::start(config.launch, config.timeouts.process)
            .map_err(|_| unavailable())?;
        let cleanup = connection.cleanup();
        let (client, _) = watch::channel(None);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                status: HostStatus::Starting,
                sessions: HashMap::new(),
                jobs: HashMap::new(),
                routes: HashMap::new(),
                completed: HashSet::new(),
            }),
            client,
            changed: Notify::new(),
            bytes: Arc::new(Semaphore::new(l.event_bytes)),
            limits: l,
            timeouts: config.timeouts,
            services,
            cleanup,
            storage_failed: AtomicBool::new(false),
            unsupported_background: AtomicBool::new(false),
            fingerprint: config.fingerprint,
        });
        tokio::spawn(route(shared.clone(), connection));
        Ok(Arc::new(Self { shared }))
    }
    pub fn status(&self) -> HostStatus {
        self.shared.state.lock().expect("Codex host state").status
    }
    pub fn unsupported_background(&self) -> bool {
        self.shared.unsupported_background.load(Ordering::Acquire)
    }
    pub fn fingerprint(&self) -> &str {
        &self.shared.fingerprint
    }
    pub fn cleanup(&self) -> Cleanup {
        self.shared.cleanup.clone()
    }
    pub fn retry_cleanup(&self) -> bool {
        self.shared.cleanup.retry()
    }
    pub fn worker(self: &Arc<Self>, spec: SessionSpec) -> Result<Arc<CodexWorker>, WorkerError> {
        if spec.key.validate().is_err()
            || !spec.home.is_absolute()
            || !spec.cwd.is_absolute()
            || spec.home.as_os_str().len() > 4096
            || spec.cwd.as_os_str().len() > 4096
            || spec.resume_id.as_ref().is_some_and(|s| !id(s))
            || spec.attachments.len() > prompt_attachments::MAX_PROMPT_ATTACHMENTS
        {
            return Err(error("invalid_params", "invalid trusted Codex session"));
        }
        let mut state = self.shared.state.lock().expect("Codex host state");
        if matches!(
            state.status,
            HostStatus::Retiring | HostStatus::Stopped | HostStatus::Unconfirmed
        ) {
            return Err(unavailable());
        }
        if let Some(existing) = state.sessions.get(&spec.key) {
            if existing.home != spec.home
                || existing.cwd != spec.cwd
                || existing.broker != spec.broker
            {
                return Err(error("invalid_params", "Codex session scope changed"));
            }
        } else {
            if state.sessions.len() >= self.shared.limits.sessions
                || state.sessions.keys().any(|k| k.name == spec.key.name)
            {
                return Err(error("capacity", "Codex session capacity reached"));
            }
            state.sessions.insert(
                spec.key.clone(),
                Session {
                    broker: spec.broker,
                    home: spec.home.clone(),
                    cwd: spec.cwd.clone(),
                    thread: spec.resume_id.clone(),
                    attached: false,
                    confirmed: spec.resume_id.is_some(),
                    model: None,
                    sandbox: None,
                    busy: None,
                },
            );
        }
        Ok(Arc::new(CodexWorker {
            host: self.clone(),
            spec: Arc::new(spec),
        }))
    }
    /// Adds input to one confirmed active ticket. Native identities never leave
    /// this host. Authorization and the first RPC poll share a blocking step;
    /// dropping the waiter cannot abandon a send or its durable receipt.
    pub fn steer(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        home: std::path::PathBuf,
        input: crate::turn_driver::Input,
        cancelled: Option<watch::Receiver<bool>>,
    ) -> Task<Result<String, WorkerError>> {
        let shared = self.shared.clone();
        let job = shared
            .state
            .lock()
            .expect("Codex host state")
            .jobs
            .get(&ticket)
            .cloned();
        let Some(job) = job else {
            return Box::pin(async { Err(error("invalid_params", "no active Codex turn")) });
        };
        let io = CheckGuard::new(&job);
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let _io = io;
            let result = steer_owned(shared, job, snapshot, home, input, cancelled).await;
            let _ = send.send(result);
        });
        Box::pin(async move { receive.await.unwrap_or_else(|_| Err(unavailable())) })
    }
    /// The owned router performs cleanup even if this waiting future is dropped.
    pub fn shutdown(&self) -> Task<Result<(), WorkerError>> {
        retire(&self.shared, true);
        let shared = self.shared.clone();
        Box::pin(async move {
            loop {
                let notified = shared.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let (status, quiet) = {
                    let state = shared.state.lock().expect("Codex host state");
                    (state.status, state.jobs.is_empty())
                };
                match status {
                    HostStatus::Stopped if quiet => return Ok(()),
                    HostStatus::Unconfirmed => {
                        return Err(error(
                            "cleanup_unconfirmed",
                            "Codex host cleanup is unconfirmed",
                        ));
                    }
                    _ => {}
                }
                notified.await;
            }
        })
    }
}
impl Drop for CodexHost {
    fn drop(&mut self) {
        retire(&self.shared, true);
    }
}
impl Worker for CodexWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let result = begin(
            self.host.shared.clone(),
            self.spec.clone(),
            ticket,
            snapshot,
            text,
        );
        // Construct outside the future, so dropping an unpolled start also
        // revokes dispatch synchronously against the final cancellation gate.
        Box::pin(async move {
            match result {
                Ok(PendingStart {
                    mut waiter,
                    receiver,
                }) => {
                    let result = receiver.await.unwrap_or_else(|_| Err(unavailable()));
                    if result.is_ok() {
                        waiter.0 = None;
                    }
                    result
                }
                Err(error) => Err(error),
            }
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        if ticket.session() != &self.spec.key {
            return Box::pin(async { Err(error("invalid_params", "foreign Codex ticket")) });
        }
        let job = self
            .host
            .shared
            .state
            .lock()
            .expect("Codex host state")
            .jobs
            .get(&ticket)
            .cloned();
        if let Some(job) = &job {
            cancel_job(job);
            job.changed.notify_waiters();
        }
        Box::pin(async move {
            let Some(job) = job else {
                return Ok(());
            };
            let mut closed = job.closed.subscribe();
            loop {
                match *closed.borrow_and_update() {
                    Closed::Confirmed => return Ok(()),
                    Closed::Unconfirmed => {
                        return Err(error(
                            "cleanup_unconfirmed",
                            "Codex turn cleanup is unconfirmed",
                        ));
                    }
                    Closed::Pending => {}
                }
                closed.changed().await.map_err(|_| unavailable())?;
            }
        })
    }
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
// ECMAScript String.trim whitespace, matching Driver input validation.
fn js_space(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
fn public_id() -> Result<String, WorkerError> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    Ok(format!(
        "pult-{}-{}",
        bytes[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        bytes[8..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
fn begin(
    shared: Arc<Shared>,
    spec: Arc<SessionSpec>,
    ticket: Ticket,
    snapshot: TurnSnapshot,
    text: String,
) -> Result<PendingStart, WorkerError> {
    if snapshot.validate().is_err()
        || snapshot.provider != Provider::Codex
        || snapshot.key != spec.key
        || ticket.session() != &spec.key
        || snapshot.cwd != spec.cwd
        || text.len() > 1024 * 1024
        || (text.chars().all(js_space) && spec.attachments.is_empty())
        || snapshot.settings.browser.is_some()
    {
        return Err(error(
            "invalid_params",
            "unsupported or mismatched Codex turn snapshot",
        ));
    }
    let (cancel, _) = watch::channel(false);
    let (approval_closed, _) = watch::channel(false);
    let (event_stop, _) = watch::channel(false);
    let (closed, _) = watch::channel(Closed::Pending);
    let job = Arc::new(Job {
        ticket: ticket.clone(),
        public_id: public_id()?,
        info: Mutex::new(Info {
            thread: None,
            native: None,
            model: snapshot.settings.model.clone(),
            effective: snapshot.settings.approval,
            thread_inflight: false,
            dispatched: false,
            acknowledged: false,
            uncertain_start: false,
            dispatch_started: None,
            provider_terminal: false,
            unsupported: false,
            open_tools: HashSet::new(),
        }),
        execution: AtomicU8::new(PREPARING),
        cancel,
        approval_closed,
        responders: AtomicUsize::new(0),
        checks: AtomicUsize::new(0),
        event_stop,
        closed,
        changed: Notify::new(),
        persistence: Mutex::new(None),
    });
    {
        let mut state = shared.state.lock().expect("Codex host state");
        if shared.storage_failed.load(Ordering::Acquire)
            || !matches!(state.status, HostStatus::Starting | HostStatus::Ready)
        {
            return Err(if shared.unsupported_background.load(Ordering::Acquire) {
                error(
                    "unsupported_background",
                    "Codex server-initiated work is unsupported",
                )
            } else {
                unavailable()
            });
        }
        if state.jobs.len() >= shared.limits.jobs {
            return Err(error("capacity", "Codex job capacity reached"));
        }
        let session = state.sessions.get_mut(&spec.key).ok_or_else(unavailable)?;
        if session.busy.is_some() {
            return Err(error("busy", "Codex session already owns a turn"));
        }
        session.busy = Some(ticket.clone());
        state.jobs.insert(ticket, job.clone());
    }
    let (sender, receiver) = mpsc::channel(shared.limits.event_slots);
    let (started, started_rx) = oneshot::channel();
    tokio::spawn(run_job(
        shared,
        spec,
        job.clone(),
        snapshot,
        text,
        sender,
        receiver,
        started,
    ));
    Ok(PendingStart {
        waiter: StartWaiter(Some(job)),
        receiver: started_rx,
    })
}
fn cancel_job(job: &Job) {
    job.approval_closed.send_replace(true);
    job.cancel.send_replace(true);
    job.changed.notify_waiters();
}
fn retire(shared: &Shared, cancel_all: bool) {
    let jobs = {
        let mut state = shared.state.lock().expect("Codex host state");
        if matches!(state.status, HostStatus::Starting | HostStatus::Ready) {
            state.status = HostStatus::Retiring;
        }
        state.jobs.values().cloned().collect::<Vec<_>>()
    };
    if cancel_all {
        for job in jobs {
            cancel_job(&job);
        }
    }
    shared.changed.notify_waiters();
}
fn fatal_storage(shared: &Shared) {
    let already_failed = shared.storage_failed.swap(true, Ordering::AcqRel);
    retire(shared, true);
    if already_failed {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (shared.services.fatal_storage)()
    }));
}
fn native(shared: &Shared, job: &Job, value: &str) -> Result<(), WorkerError> {
    if job.info.lock().expect("Codex job").native.as_deref() == Some(value) {
        return Ok(());
    }
    if !id(value) {
        return Err(error(
            "provider_unavailable",
            "malformed Codex turn identity",
        ));
    }
    let thread = job
        .info
        .lock()
        .expect("Codex job")
        .thread
        .clone()
        .ok_or_else(unavailable)?;
    if shared
        .state
        .lock()
        .expect("Codex host state")
        .completed
        .contains(&(thread, value.into()))
    {
        return Err(error("provider_unavailable", "stale Codex turn identity"));
    }
    {
        let mut info = job.info.lock().expect("Codex job");
        if info.native.as_ref().is_some_and(|old| old != value) {
            return Err(error(
                "provider_unavailable",
                "conflicting Codex turn identity",
            ));
        }
        info.native = Some(value.into());
    }
    job.changed.notify_waiters();
    Ok(())
}
struct Count {
    bytes: usize,
}
impl Write for Count {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(data.len())
            .filter(|n| *n <= codex_rpc_limit())
            .ok_or_else(|| io::Error::other("event budget"))?;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn codex_rpc_limit() -> usize {
    crate::codex_rpc::MAX_PAYLOAD
}
fn event_bytes(event: &Event) -> Option<usize> {
    let value = match event {
        Event::Notification { method, params } => json!({"method":method,"params":params}),
        Event::ServerRequest {
            method,
            params,
            permit,
        } => json!({"method":method,"params":params,"id":permit.id()}),
    };
    let mut count = Count { bytes: 0 };
    serde_json::to_writer(&mut count, &value).ok()?;
    Some(count.bytes)
}
fn event_thread(event: &Event) -> Option<&str> {
    match event {
        Event::Notification { params, .. } | Event::ServerRequest { params, .. } => {
            params.get("threadId").and_then(Value::as_str)
        }
    }
}
async fn route(shared: Arc<Shared>, mut connection: Connection) {
    loop {
        let changed = shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if shared.state.lock().expect("Codex host state").status == HostStatus::Retiring {
            connection.shutdown();
            break;
        }
        let ready = tokio::select! {ready=connection.ready()=>Some(ready),_=&mut changed=>None};
        let retiring =
            shared.state.lock().expect("Codex host state").status == HostStatus::Retiring;
        if retiring {
            connection.shutdown();
            break;
        }
        if let Some(ready) = ready {
            match ready {
                Ok(client) => {
                    shared.client.send_replace(Some(client));
                    let mut state = shared.state.lock().expect("Codex host state");
                    if state.status == HostStatus::Starting {
                        state.status = HostStatus::Ready;
                    }
                    drop(state);
                    shared.changed.notify_waiters();
                    break;
                }
                Err(_) => {
                    retire(&shared, true);
                    break;
                }
            }
        }
    }
    loop {
        let changed = shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let stop = {
            let state = shared.state.lock().expect("Codex host state");
            state.status == HostStatus::Retiring
                && state
                    .jobs
                    .values()
                    .all(|j| j.execution.load(Ordering::Acquire) != EXECUTING)
        };
        if stop {
            connection.shutdown();
            break;
        }
        let event = tokio::select! {event=connection.events.recv()=>event,_=&mut changed=>continue};
        let Some(event) = event else {
            retire(&shared, true);
            break;
        };
        let Some(thread) = event_thread(&event).filter(|s| id(s)).map(str::to_owned) else {
            continue;
        };
        let route = {
            let state = shared.state.lock().expect("Codex host state");
            state
                .routes
                .get(&thread)
                .map(|r| (r.ticket.clone(), r.job.clone(), r.sender.clone()))
        };
        let Some((ticket, job, sender)) = route else {
            if let Event::Notification { method, params } = &event
                && method == "turn/started"
                && params["turn"]["status"] == "inProgress"
                && let Some(native) = params["turn"]["id"].as_str().filter(|v| id(v))
            {
                let known_idle = {
                    let state = shared.state.lock().expect("Codex host state");
                    state
                        .sessions
                        .values()
                        .any(|s| s.thread.as_deref() == Some(thread.as_str()))
                        && !state.completed.contains(&(thread.clone(), native.into()))
                };
                if known_idle {
                    shared.unsupported_background.store(true, Ordering::Release);
                    retire(&shared, false);
                }
            }
            continue;
        };
        if ticket != job.ticket {
            continue;
        }
        let mut unsupported = false;
        let mut terminal_turn = None;
        match &event {
            Event::Notification { method, params } => {
                if !matches!(
                    method.as_str(),
                    "turn/started"
                        | "turn/completed"
                        | "item/started"
                        | "item/completed"
                        | "item/agentMessage/delta"
                        | "thread/tokenUsage/updated"
                        | "model/rerouted"
                        | "error"
                        | "warning"
                        | "item/reasoning/summaryTextDelta"
                        | "item/reasoning/summaryPartAdded"
                        | "item/commandExecution/outputDelta"
                ) {
                    continue;
                }
                let turn = if matches!(method.as_str(), "turn/started" | "turn/completed") {
                    params["turn"]["id"].as_str()
                } else {
                    params["turnId"].as_str()
                };
                let (finished, expected) = {
                    let info = job.info.lock().expect("Codex job");
                    (info.provider_terminal, info.native.clone())
                };
                if finished
                    || (expected.is_none() && job.execution.load(Ordering::Acquire) != EXECUTING)
                {
                    if method == "turn/started"
                        && params["turn"]["status"] == "inProgress"
                        && let Some(new_turn) = turn.filter(|v| id(v))
                    {
                        let stale = shared
                            .state
                            .lock()
                            .expect("Codex host state")
                            .completed
                            .contains(&(thread.clone(), new_turn.into()));
                        if !stale {
                            shared.unsupported_background.store(true, Ordering::Release);
                            job.info.lock().expect("Codex job").unsupported = true;
                            cancel_job(&job);
                            retire(&shared, false);
                        }
                    }
                    continue;
                }
                if expected
                    .as_ref()
                    .is_some_and(|id| turn.is_some_and(|t| t != id))
                {
                    if method == "turn/started"
                        && params["turn"]["status"] == "inProgress"
                        && let Some(turn) = turn.filter(|v| id(v))
                    {
                        let stale = shared
                            .state
                            .lock()
                            .expect("Codex host state")
                            .completed
                            .contains(&(thread.clone(), turn.into()));
                        if !stale {
                            {
                                let mut info = job.info.lock().expect("Codex job");
                                info.unsupported = true;
                                info.uncertain_start = true;
                            }
                            cancel_job(&job);
                            retire(&shared, false);
                        }
                    }
                    continue;
                }
                if method == "turn/started" {
                    if job.execution.load(Ordering::Acquire) != EXECUTING {
                        continue;
                    }
                    let Some(turn) = turn else {
                        continue;
                    };
                    if native(&shared, &job, turn).is_err() {
                        continue;
                    }
                } else if turn.is_none() && method != "warning" {
                    continue;
                }
                if method == "item/started" {
                    let kind = params["item"]["type"].as_str().unwrap_or("");
                    if matches!(kind, "subAgentActivity" | "collabAgentToolCall") {
                        unsupported = true;
                    }
                    if matches!(kind, "commandExecution" | "mcpToolCall")
                        && let Some(tool) = params["item"]["id"].as_str().filter(|v| id(v))
                    {
                        let mut info = job.info.lock().expect("Codex job");
                        if info.open_tools.len() >= 256 {
                            unsupported = true;
                        } else {
                            info.open_tools.insert(tool.into());
                        }
                    }
                }
                if method == "item/completed"
                    && let Some(tool) = params["item"]["id"].as_str()
                {
                    job.info.lock().expect("Codex job").open_tools.remove(tool);
                }
                if method == "turn/completed"
                    && let Some(turn) = turn
                {
                    if !matches!(
                        params["turn"]["status"].as_str(),
                        Some("completed" | "interrupted" | "failed")
                    ) {
                        continue;
                    }
                    let matches =
                        job.info.lock().expect("Codex job").native.as_deref() == Some(turn);
                    if !matches {
                        continue;
                    }
                    job.approval_closed.send_replace(true);
                    unsupported |= !job.info.lock().expect("Codex job").open_tools.is_empty();
                    terminal_turn = Some(turn.to_owned());
                }
            }
            Event::ServerRequest { params, .. } => {
                if shared.services.approval.is_none() {
                    continue;
                }
                let expected = job.info.lock().expect("Codex job").native.clone();
                if expected.is_none() && job.execution.load(Ordering::Acquire) != EXECUTING {
                    continue;
                }
                if job.cancel.borrow().to_owned()
                    || expected
                        .as_ref()
                        .is_some_and(|id| params["turnId"].as_str() != Some(id.as_str()))
                {
                    continue;
                }
            }
        }
        if unsupported {
            shared.unsupported_background.store(true, Ordering::Release);
            job.info.lock().expect("Codex job").unsupported = true;
            cancel_job(&job);
            retire(&shared, false);
        }
        let budget = event_bytes(&event)
            .and_then(|n| shared.bytes.clone().try_acquire_many_owned(n as u32).ok());
        let Some(budget) = budget else {
            job.info.lock().expect("Codex job").unsupported = true;
            cancel_job(&job);
            job.execution.store(QUARANTINED, Ordering::Release);
            retire(&shared, false);
            continue;
        };
        if sender
            .try_send(Envelope {
                event,
                _budget: budget,
            })
            .is_err()
        {
            job.info.lock().expect("Codex job").unsupported = true;
            cancel_job(&job);
            job.execution.store(QUARANTINED, Ordering::Release);
            retire(&shared, false);
        } else if let Some(turn) = terminal_turn {
            // Queue the terminal frame BEFORE publishing cleanup proof. A
            // closer may immediately close the receiver after observing it.
            job.info.lock().expect("Codex job").provider_terminal = true;
            job.execution.store(TERMINAL, Ordering::Release);
            let exhausted = {
                let mut state = shared.state.lock().expect("Codex host state");
                if state.completed.len() >= shared.limits.completed_turns {
                    true
                } else {
                    state.completed.insert((thread, turn));
                    false
                }
            };
            if exhausted {
                retire(&shared, false);
            }
            shared.changed.notify_waiters();
            job.changed.notify_waiters();
        }
    }
    connection.shutdown();
    {
        shared
            .state
            .lock()
            .expect("Codex host state")
            .routes
            .clear();
    }
    shared.changed.notify_waiters();
    let mut cleanup = connection.cleanup();
    let mut changes = cleanup.subscribe();
    loop {
        let status = cleanup.finished().await;
        shared.state.lock().expect("Codex host state").status = if status == CleanupStatus::Stopped
        {
            HostStatus::Stopped
        } else {
            HostStatus::Unconfirmed
        };
        shared.changed.notify_waiters();
        if status == CleanupStatus::Stopped {
            break;
        }
        if changes.changed().await.is_err() {
            break;
        }
    }
}
async fn ready_client(shared: &Shared, job: &Job) -> Result<Client, WorkerError> {
    let mut client = shared.client.subscribe();
    let mut cancel = job.cancel.subscribe();
    loop {
        if *cancel.borrow() {
            return Err(error("interrupted", "Codex start cancelled"));
        }
        if let Some(value) = client.borrow().clone() {
            return Ok(value);
        }
        let state = shared.state.lock().expect("Codex host state").status;
        if matches!(
            state,
            HostStatus::Retiring | HostStatus::Stopped | HostStatus::Unconfirmed
        ) {
            return Err(unavailable());
        }
        tokio::select! {_=client.changed()=>{},_=cancel.changed()=>{},_=shared.changed.notified()=>{}}
    }
}
fn policy(approval: Approval, broker: bool) -> (&'static str, &'static str) {
    let sandbox = match approval {
        Approval::ReadOnly => "read-only",
        Approval::Full => "danger-full-access",
        _ => "workspace-write",
    };
    (
        sandbox,
        if broker && matches!(approval, Approval::ReadOnly | Approval::Ask) {
            "on-request"
        } else {
            "never"
        },
    )
}
fn narrowing(old: Approval, new: Approval) -> bool {
    old == new
        || match old {
            Approval::Full => matches!(
                new,
                Approval::Workspace | Approval::Ask | Approval::ReadOnly
            ),
            Approval::Workspace => matches!(new, Approval::Ask | Approval::ReadOnly),
            Approval::Ask => new == Approval::ReadOnly,
            _ => false,
        }
}
fn typed_sandbox(value: &Value) -> Result<Value, WorkerError> {
    let kind = value["type"].as_str().ok_or_else(unavailable)?;
    if !matches!(kind, "readOnly" | "workspaceWrite" | "dangerFullAccess") {
        return Err(error(
            "provider_policy",
            "unsupported reported Codex sandbox",
        ));
    }
    let mut out = json!({"type":kind});
    for key in ["networkAccess", "excludeSlashTmp", "excludeTmpdirEnvVar"] {
        if let Some(value) = value.get(key) {
            if !value.is_boolean() {
                return Err(error("provider_policy", "malformed reported Codex sandbox"));
            }
            out[key] = value.clone();
        }
    }
    if let Some(roots) = value.get("writableRoots") {
        let roots = roots
            .as_array()
            .filter(|a| a.len() <= 32)
            .ok_or_else(unavailable)?;
        if roots.iter().any(|r| {
            !r.as_str()
                .is_some_and(|s| s.len() <= 4096 && std::path::Path::new(s).is_absolute())
        }) {
            return Err(error("provider_policy", "malformed Codex writable roots"));
        }
        out["writableRoots"] = Value::Array(roots.clone());
    }
    Ok(out)
}
fn workspace_config(value: &Value) -> Result<Value, WorkerError> {
    let config = &value["config"]["sandbox_workspace_write"];
    let mut out = json!({"type":"workspaceWrite"});
    for (from, to) in [
        ("network_access", "networkAccess"),
        ("exclude_slash_tmp", "excludeSlashTmp"),
        ("exclude_tmpdir_env_var", "excludeTmpdirEnvVar"),
        ("writable_roots", "writableRoots"),
    ] {
        if let Some(value) = config.get(from) {
            out[to] = value.clone();
        }
    }
    typed_sandbox(&out)
}
fn sandbox_rank(value: &Value) -> u8 {
    match value["type"].as_str() {
        Some("readOnly") => 0,
        Some("workspaceWrite") => 1,
        _ => 2,
    }
}
async fn persist_thread(
    shared: &Arc<Shared>,
    spec: &SessionSpec,
    job: &Arc<Job>,
    thread: &str,
    actual: &Value,
    model: &str,
) -> Result<(), WorkerError> {
    if *job.cancel.borrow() || shared.storage_failed.load(Ordering::Acquire) {
        return Err(unavailable());
    }
    let seal = Arc::new(());
    let request = ThreadPrepared {
        session: spec.key.clone(),
        ticket: job.ticket.clone(),
        native_thread_id: thread.to_owned(),
        cwd: spec.cwd.clone(),
        model: model.to_owned(),
        sandbox: PreparedSandbox {
            mode: match actual["type"].as_str() {
                Some("readOnly") => SandboxMode::ReadOnly,
                Some("workspaceWrite") => SandboxMode::WorkspaceWrite,
                _ => SandboxMode::Full,
            },
            network_access: actual["networkAccess"].as_bool(),
            writable_roots: actual["writableRoots"]
                .as_array()
                .map(|roots| {
                    roots
                        .iter()
                        .filter_map(Value::as_str)
                        .map(PathBuf::from)
                        .collect()
                })
                .unwrap_or_default(),
            exclude_slash_tmp: actual["excludeSlashTmp"].as_bool(),
            exclude_tmpdir_env_var: actual["excludeTmpdirEnvVar"].as_bool(),
        },
        seal: seal.clone(),
    };
    let (completed, mut result) = watch::channel(None);
    let store = shared.services.thread_store.clone();
    let owner = shared.clone();
    let task = tokio::spawn(async move {
        let outcome = match tokio::spawn(async move { store.persist(request).await }).await {
            Ok(Ok(receipt)) if Arc::ptr_eq(&receipt.seal, &seal) => Ok(()),
            Ok(Err(ThreadStoreError::Rejected)) => Err(ThreadStoreError::Rejected),
            _ => Err(ThreadStoreError::Unknown),
        };
        if outcome == Err(ThreadStoreError::Unknown) {
            fatal_storage(&owner);
        }
        completed.send_replace(Some(outcome));
    });
    *job.persistence.lock().expect("Codex persistence") = Some(task);
    loop {
        if let Some(outcome) = *result.borrow_and_update() {
            return outcome.map_err(|fault| match fault {
                ThreadStoreError::Rejected => error(
                    "thread_store_rejected",
                    "Codex thread persistence was rejected",
                ),
                ThreadStoreError::Unknown => error(
                    "storage_unavailable",
                    "Codex thread persistence is unconfirmed",
                ),
            });
        }
        result.changed().await.map_err(|_| unavailable())?;
    }
}
async fn prepare(
    shared: Arc<Shared>,
    spec: Arc<SessionSpec>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    sender: mpsc::Sender<Envelope>,
) -> Result<(), WorkerError> {
    let client = ready_client(&shared, &job).await?;
    let initial = snapshot.settings.approval;
    let (sandbox, approval) = policy(initial, spec.broker);
    let existing = {
        let state = shared.state.lock().expect("Codex host state");
        let session = state.sessions.get(&spec.key).ok_or_else(unavailable)?;
        (
            session.thread.clone(),
            session.attached,
            session.confirmed,
            session.sandbox.clone(),
            session.model.clone(),
        )
    };
    let (thread, actual, model) = if existing.1 {
        (
            existing.0.ok_or_else(unavailable)?,
            existing.3.ok_or_else(unavailable)?,
            existing.4,
        )
    } else {
        let mut params = json!({"cwd":spec.cwd,"sandbox":sandbox,"approvalPolicy":approval,"serviceTier":snapshot.settings.service_tier.map(|v|v.as_str()).unwrap_or("default"),"config":{"features.default_mode_request_user_input":true}});
        if let Some(model) = &snapshot.settings.model {
            params["model"] = json!(model);
        }
        let mut resume = existing.0.filter(|_| existing.2);
        let method = if resume.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        if let Some(id) = &resume {
            params["threadId"] = json!(id);
            params["excludeTurns"] = json!(true);
        }
        job.info.lock().expect("Codex job").thread_inflight = true;
        let mut reply = client
            .request(method, params.clone(), shared.timeouts.control)
            .await;
        // A definite no-rollout error is before any turn dispatch. Only this
        // measured resume failure permits a new thread; uncertain IO never does.
        if resume.is_some()
            && matches!(&reply,Err(RpcError::Remote(error)) if error.message.to_lowercase().contains("no rollout found for thread id"))
        {
            resume = None;
            {
                let mut state = shared.state.lock().expect("Codex host state");
                if let Some(session) = state.sessions.get_mut(&spec.key) {
                    session.thread = None;
                    session.attached = false;
                    session.confirmed = false;
                    session.sandbox = None;
                }
            }
            params
                .as_object_mut()
                .expect("thread params")
                .remove("threadId");
            params
                .as_object_mut()
                .expect("thread params")
                .remove("excludeTurns");
            reply = client
                .request("thread/start", params, shared.timeouts.control)
                .await;
        }
        let reply = match reply {
            Ok(reply) => reply,
            Err(RpcError::Remote(_)) => {
                job.info.lock().expect("Codex job").thread_inflight = false;
                return Err(error(
                    "provider_unavailable",
                    "Codex thread preparation was rejected",
                ));
            }
            Err(_) => {
                return Err(error(
                    "start_unknown",
                    "Codex thread preparation outcome is unknown",
                ));
            }
        };
        let thread = reply["thread"]["id"]
            .as_str()
            .filter(|v| id(v))
            .ok_or_else(|| error("start_unknown", "Codex thread reply is malformed"))?
            .to_owned();
        if resume.as_ref().is_some_and(|id| id != &thread) {
            return Err(error("start_unknown", "Codex resumed a different thread"));
        }
        if reply["cwd"]
            .as_str()
            .is_none_or(|cwd| std::path::Path::new(cwd) != spec.cwd)
        {
            return Err(error(
                "start_unknown",
                "Codex thread cwd differs from trusted scope",
            ));
        }
        let actual = typed_sandbox(&reply["sandbox"])?;
        let requested_rank = match initial {
            Approval::ReadOnly => 0,
            Approval::Full => 2,
            _ => 1,
        };
        if sandbox_rank(&actual) > requested_rank {
            job.info.lock().expect("Codex job").unsupported = true;
            return Err(error(
                "provider_policy",
                "Codex reported a wider sandbox than requested",
            ));
        }
        let model = reply["model"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .map(str::to_owned);
        if model.is_none() {
            return Err(error(
                "start_unknown",
                "Codex thread model reply is malformed",
            ));
        }
        {
            let mut state = shared.state.lock().expect("Codex host state");
            let session = state.sessions.get_mut(&spec.key).ok_or_else(unavailable)?;
            session.thread = Some(thread.clone());
            session.attached = true;
            session.sandbox = Some(actual.clone());
            session.model = model.clone();
        }
        job.info.lock().expect("Codex job").thread_inflight = false;
        (thread, actual, model)
    };
    {
        let mut info = job.info.lock().expect("Codex job");
        info.thread = Some(thread.clone());
        info.model = snapshot.settings.model.clone().or_else(|| model.clone());
    }
    persist_thread(
        &shared,
        &spec,
        &job,
        &thread,
        &actual,
        model.as_deref().ok_or_else(unavailable)?,
    )
    .await?;
    {
        let mut state = shared.state.lock().expect("Codex host state");
        if state.routes.contains_key(&thread) {
            job.info.lock().expect("Codex job").unsupported = true;
            return Err(error("start_unknown", "Codex thread is already owned"));
        }
        state.routes.insert(
            thread.clone(),
            Route {
                ticket: job.ticket.clone(),
                job: job.clone(),
                sender,
            },
        );
    }
    // Complete all async preparation before the final fresh synchronous gate.
    let config = client
        .request(
            "config/read",
            json!({"cwd":spec.cwd}),
            shared.timeouts.control,
        )
        .await
        .map_err(|_| {
            error(
                "provider_policy",
                "Codex workspace policy could not be read",
            )
        })?;
    let workspace = workspace_config(&config)?;
    let checking_spec = spec.clone();
    let io = CheckGuard::new(&job);
    let mut input = tokio::task::spawn_blocking(move || {
        let _io = io;
        prompt_attachments::codex_prompt_input(
            &PromptAttachmentScope {
                home: &checking_spec.home,
                session_id: &checking_spec.key.name,
            },
            &text,
            &checking_spec.attachments,
        )
        .map_err(|_| error("invalid_params", "Codex prompt attachment is unavailable"))
    })
    .await
    .map_err(|_| unavailable())??;
    // A previous terminal status must not survive into a newly dispatched turn.
    // Persist before the final fresh gate and before any native permission event:
    // writing after turn/start could overwrite an early blocked-permission state.
    append(
        &shared,
        json!({"sessionId":spec.key.name,"provider":"codex",
        "kind":"status.changed","data":{"status":"working","turnId":job.public_id}}),
    )
    .await?;
    let checking = shared.clone();
    let checking_job = job.clone();
    let io = CheckGuard::new(&job);
    // This blocking step contains the fresh host check, policy selection and
    // first request poll. There is no await between authorization and enqueue.
    let sealed = tokio::task::spawn_blocking(move || {
        let _io = io;
        if *checking_job.cancel.borrow() || checking.storage_failed.load(Ordering::Acquire) {
            return Err(error("interrupted", "Codex start cancelled"));
        }
        let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            checking.services.fresh_gate.check(&checking_job.ticket, &snapshot)
        })).unwrap_or(DispatchDecision::Deny);
        let effective = match decision {
            DispatchDecision::Allow => initial,
            DispatchDecision::Restrict(mode) if narrowing(initial, mode) => mode,
            _ => return Err(error("access_denied", "fresh Codex authority check denied dispatch")),
        };
        let (sandbox, approval) = policy(effective, spec.broker);
        let target_type = match sandbox {
            "read-only" => "readOnly",
            "danger-full-access" => "dangerFullAccess",
            _ => "workspaceWrite",
        };
        let effective_sandbox = if actual["type"] == target_type { actual }
            else if target_type == "workspaceWrite" { workspace }
            else { json!({"type":target_type}) };
        input.push(json!({"type":"text","text":approval_context(effective,spec.broker)}));
        let mut params = json!({"threadId":thread,"input":input,"serviceTier":snapshot.settings.service_tier.map(|v|v.as_str()).unwrap_or("default"),"approvalPolicy":approval,"sandboxPolicy":effective_sandbox});
        if let Some(model) = &snapshot.settings.model { params["model"] = json!(model); }
        if let Some(effort) = &snapshot.settings.effort { params["effort"] = json!(effort); }
        let timeout = checking.timeouts.control;
        let request = Box::pin(async move { client.request("turn/start", params, timeout).await });
        let state = checking.state.lock().expect("Codex host state");
        let cancellation = checking_job.cancel.borrow();
        if *cancellation || state.status != HostStatus::Ready || checking.storage_failed.load(Ordering::Acquire) {
            return Err(error("interrupted", "Codex start cancelled"));
        }
        checking_job.execution.store(EXECUTING, Ordering::Release);
        {
            let mut info = checking_job.info.lock().expect("Codex job");
            info.effective = effective;
            info.dispatched = true;
            info.dispatch_started = Some(Instant::now());
        }
        // Client.request enqueues synchronously before its first await. Never
        // replace this with merely constructing an unpolled request future.
        Ok(first_poll(request))
    }).await.map_err(|_| unavailable())??;
    let reply = sealed.finish().await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(_) if *job.cancel.borrow() => {
            return Err(error("interrupted", "Codex start cancelled"));
        }
        Err(_) => {
            {
                let mut info = job.info.lock().expect("Codex job");
                info.unsupported = true;
                info.uncertain_start = true;
            }
            return Err(error(
                "start_unknown",
                "Codex turn start outcome is unknown",
            ));
        }
    };
    let turn = reply["turn"]["id"].as_str().filter(|v| id(v));
    if turn.is_none_or(|turn| native(&shared, &job, turn).is_err()) {
        {
            let mut info = job.info.lock().expect("Codex job");
            info.unsupported = true;
            info.uncertain_start = true;
        }
        return Err(error(
            "start_unknown",
            "Codex turn identity could not be confirmed",
        ));
    }
    job.info.lock().expect("Codex job").acknowledged = true;
    job.changed.notify_waiters();
    Ok(())
}
async fn steer_owned(
    shared: Arc<Shared>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    home: std::path::PathBuf,
    input: crate::turn_driver::Input,
    cancelled: Option<watch::Receiver<bool>>,
) -> Result<String, WorkerError> {
    if input.text.chars().count() > 50_000
        || input.text.len() > 200_000
        || (input.text.chars().all(js_space) && input.metadata.attachments.is_empty())
    {
        return Err(error("invalid_params", "empty steering input"));
    }
    let checking = shared.clone();
    let checking_job = job.clone();
    let metadata = input.metadata.clone();
    let (sealed, public_text) = tokio::task::spawn_blocking(move || {
        let mut redact = redactor(&checking)?;
        let safe = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            redact.redact(&json!(input.text))
        }))
        .map_err(|_| error("redaction_failed", "steering redaction failed"))?
        .map_err(|_| error("redaction_failed", "steering redaction failed"))?;
        let public_text = safe
            .as_str()
            .filter(|s| s.len() <= 200_000)
            .ok_or_else(|| error("redaction_failed", "invalid steering redaction"))?
            .to_owned();
        let blocks = prompt_attachments::codex_prompt_input(
            &PromptAttachmentScope {
                home: &home,
                session_id: &checking_job.ticket.session().name,
            },
            &input.text,
            &input.metadata.attachments,
        )
        .map_err(|_| error("invalid_params", "steering attachment unavailable"))?;
        let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            checking
                .services
                .fresh_gate
                .check(&checking_job.ticket, &snapshot)
        }))
        .unwrap_or(DispatchDecision::Deny);
        // Steering cannot mutate the sandbox of the active turn. A newly
        // narrowed policy must stop the old turn instead of granting its input.
        let effective = checking_job.info.lock().expect("Codex job").effective;
        if !matches!(decision, DispatchDecision::Allow)
            && decision != DispatchDecision::Restrict(effective)
        {
            return Err(error("access_denied", "fresh steering authority denied"));
        }
        let client = checking.client.borrow().clone().ok_or_else(unavailable)?;
        let cancellation = cancelled.as_ref().map(|cancel| cancel.borrow());
        if cancellation.as_ref().is_some_and(|v| **v) {
            return Err(error("interrupted", "steering command was stopped"));
        }
        let state = checking.state.lock().expect("Codex host state");
        let cancelled = checking_job.cancel.borrow();
        let info = checking_job.info.lock().expect("Codex job");
        if state.status != HostStatus::Ready
            || *cancelled
            || info.provider_terminal
            || !info.acknowledged
            || checking.storage_failed.load(Ordering::Acquire)
        {
            return Err(error("interrupted", "steering scope is closed"));
        }
        let thread = info.thread.clone().ok_or_else(unavailable)?;
        let native = info.native.clone().ok_or_else(unavailable)?;
        let params = json!({"threadId":thread,"expectedTurnId":native,"input":blocks});
        let timeout = checking.timeouts.control;
        Ok((
            first_poll(Box::pin(async move {
                let expected = params["expectedTurnId"].as_str().map(str::to_owned);
                let reply = client.request("turn/steer", params, timeout).await?;
                if reply["turnId"].as_str() != expected.as_deref() {
                    return Err(RpcError::InvalidFrame);
                }
                Ok(reply)
            })),
            public_text,
        ))
    })
    .await
    .map_err(|_| unavailable())??;
    match sealed.finish().await {
        Ok(_) => {}
        Err(RpcError::Remote(_)) => return Err(error("invalid_params", "Codex rejected steering")),
        Err(_) => {
            cancel_job(&job);
            return Err(error(
                "send_unknown",
                "steering outcome is unknown; do not retry automatically",
            ));
        }
    }
    let mut data = json!({"text":public_text,"steering":true,"turnId":job.public_id});
    if !metadata.attachments.is_empty() {
        data["attachments"] = json!(
            metadata
                .attachments
                .iter()
                .map(|a| a.value())
                .collect::<Vec<_>>()
        );
    }
    if let Some(id) = metadata.queue_item_id {
        data["queueItemId"] = json!(id);
        data["queueItemAt"] = json!(metadata.queue_item_at);
    }
    append(&shared,json!({"sessionId":job.ticket.session().name,"provider":"codex","kind":"message.user","data":data})).await?;
    Ok(job.public_id.clone())
}

async fn append(shared: &Shared, draft: Value) -> Result<(), WorkerError> {
    if shared.storage_failed.load(Ordering::Acquire) {
        return Err(error("storage_unavailable", "Codex journal is unavailable"));
    }
    let sink = shared.services.sink.clone();
    let receipt = tokio::spawn(async move { sink.append(draft).await }).await;
    match receipt {
        Ok(Ok(receipt))
            if receipt.id > 0
                && receipt.id <= 9_007_199_254_740_991
                && !receipt.ts.is_empty()
                && receipt.ts.len() <= 128 =>
        {
            Ok(())
        }
        _ => {
            fatal_storage(shared);
            Err(error(
                "storage_unavailable",
                "Codex journal outcome is unknown",
            ))
        }
    }
}
fn redactor(shared: &Shared) -> Result<Box<dyn Redactor>, WorkerError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (shared.services.redactors)()
    }))
    .map_err(|_| error("redaction_failed", "Codex event redactor is unavailable"))
}
async fn session_started(
    shared: &Shared,
    spec: &SessionSpec,
    job: &Job,
    snapshot: &TurnSnapshot,
) -> Result<(), WorkerError> {
    let needed = {
        let state = shared.state.lock().expect("Codex host state");
        state.sessions.get(&spec.key).is_some_and(|s| !s.confirmed)
    };
    if !needed {
        return Ok(());
    }
    let (thread, model, effective) = {
        let info = job.info.lock().expect("Codex job");
        (info.thread.clone(), info.model.clone(), info.effective)
    };
    let data = json!({"providerSessionId":thread,"model":model,"cwd":snapshot.cwd,"sandbox":policy(effective,spec.broker).0});
    let mut redact = redactor(shared)?;
    let safe = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| redact.redact(&data)))
        .map_err(|_| error("redaction_failed", "Codex metadata redaction failed"))?
        .map_err(|_| error("redaction_failed", "Codex metadata redaction failed"))?;
    if !safe.is_object() || serde_json::to_vec(&safe).map_or(true, |v| v.len() > 768 * 1024) {
        return Err(error(
            "redaction_failed",
            "Codex metadata exceeded its budget",
        ));
    }
    append(
        shared,
        json!({"sessionId":spec.key.name,"provider":"codex","kind":"session.started","data":safe}),
    )
    .await?;
    if let Some(session) = shared
        .state
        .lock()
        .expect("Codex host state")
        .sessions
        .get_mut(&spec.key)
    {
        session.confirmed = true;
    }
    Ok(())
}
fn mapped_outcome(outcome: codex_events::TurnOutcome) -> Outcome {
    if outcome.ok {
        Outcome::Success
    } else {
        match outcome.error_code {
            Some(codex_events::OutcomeCode::Interrupted) => Outcome::Interrupted,
            Some(codex_events::OutcomeCode::ProviderUnavailable) => failure(
                "provider_unavailable",
                outcome
                    .message
                    .as_deref()
                    .unwrap_or("Codex provider unavailable"),
            ),
            Some(codex_events::OutcomeCode::Limited) => failure(
                "limited",
                outcome.message.as_deref().unwrap_or("Codex limit reached"),
            ),
            _ => failure(
                "internal",
                outcome.message.as_deref().unwrap_or("Codex turn failed"),
            ),
        }
    }
}
fn publish_outcome(sender: &mut Option<oneshot::Sender<Outcome>>, outcome: Outcome) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(outcome);
    }
}
async fn events(
    shared: Arc<Shared>,
    spec: Arc<SessionSpec>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    mut receiver: mpsc::Receiver<Envelope>,
    outcome: oneshot::Sender<Outcome>,
) {
    let mut outcome = Some(outcome);
    let mut stop = job.event_stop.subscribe();
    let mut cancel = job.cancel.subscribe();
    let mut approvals = JoinSet::new();
    let mut closing = *cancel.borrow();
    let mut retries = 0u8;
    let mut stormed = false;
    let mut forced_outcome = None;
    let identities = loop {
        let changed = job.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if *stop.borrow() {
            publish_outcome(&mut outcome, Outcome::Interrupted);
            return;
        }
        let identities = {
            let info = job.info.lock().expect("Codex job");
            if info.acknowledged {
                info.thread
                    .clone()
                    .zip(info.native.clone())
                    .map(|(thread, native)| (thread, native, info.model.clone()))
            } else {
                None
            }
        };
        if let Some(ids) = identities {
            break ids;
        }
        tokio::select! {_=&mut changed=>{},_=stop.changed()=>{}}
    };
    let (thread, native, model) = identities;
    let mut normalizer = match redactor(&shared).and_then(|r| {
        Normalizer::new(
            codex_events::Binding {
                session: spec.key.clone(),
                ticket: job.ticket.clone(),
                generation: 1,
                thread_id: thread.clone(),
                provider_turn_id: native.clone(),
                public_turn_id: job.public_id.clone(),
                model,
                started_ms: 0,
            },
            codex_events::Limits::default(),
            r,
        )
        .map_err(|_| error("normalization_failed", "Codex normalizer could not start"))
    }) {
        Ok(n) => Some(n),
        Err(_) => {
            publish_outcome(
                &mut outcome,
                failure("normalization_failed", "Codex normalizer could not start"),
            );
            cancel_job(&job);
            None
        }
    };
    let callback = codex_events::TrustedCallback {
        generation: 1,
        ticket: job.ticket.clone(),
    };
    loop {
        if !closing && *cancel.borrow() {
            closing = true;
            approvals.abort_all();
            while approvals.join_next().await.is_some() {}
        }
        let envelope = tokio::select! {
            envelope=receiver.recv()=>envelope,
            _=cancel.changed(),if !closing=>continue,
            _=approvals.join_next(),if !approvals.is_empty()=>continue,
            _=stop.changed()=>{receiver.close();continue;}
        };
        let Some(envelope) = envelope else {
            break;
        };
        match envelope.event {
            Event::ServerRequest {
                method,
                params,
                permit,
            } => {
                if closing
                    || outcome.is_none()
                    || *job.approval_closed.borrow()
                    || !spec.broker
                    || params["threadId"] != thread
                    || params["turnId"] != native
                {
                    continue;
                }
                let Some(handler) = shared.services.approval.clone() else {
                    continue;
                };
                if approvals.len() >= shared.limits.approvals
                    || job.responders.load(Ordering::Acquire) >= shared.limits.approvals
                {
                    job.info.lock().expect("Codex job").unsupported = true;
                    cancel_job(&job);
                    retire(&shared, false);
                    continue;
                }
                let Some(client) = shared.client.borrow().clone() else {
                    continue;
                };
                job.responders.fetch_add(1, Ordering::AcqRel);
                let context = ApprovalContext {
                    session: spec.key.clone(),
                    responder: ScopedResponder {
                        client,
                        permit: Some(permit),
                        job: job.clone(),
                    },
                    ticket: job.ticket.clone(),
                    thread_id: thread.clone(),
                    native_turn_id: native.clone(),
                    effective_approval: job.info.lock().expect("Codex job").effective,
                    method,
                    params: RawParams {
                        value: params,
                        _budget: envelope._budget,
                    },
                };
                let job = job.clone();
                approvals.spawn(async move {
                    // No internal guard through external construction or poll:
                    // handlers may synchronously re-enter host shutdown/close.
                    let mut revoked = job.approval_closed.subscribe();
                    if *revoked.borrow() {
                        return;
                    }
                    let pending = handler.handle(context);
                    tokio::pin!(pending);
                    tokio::select! {biased;_=revoked.changed()=>{},_=&mut pending=>{}}
                });
            }
            Event::Notification { method, params } => {
                if method == "turn/started"
                    && outcome.is_some()
                    && let Err(error) = session_started(&shared, &spec, &job, &snapshot).await
                {
                    publish_outcome(&mut outcome, failure(&error.code, &error.message));
                    cancel_job(&job);
                    normalizer = None;
                }
                let Some(mapper) = normalizer.as_mut() else {
                    continue;
                };
                let elapsed_ms = {
                    job.info
                        .lock()
                        .expect("Codex job")
                        .dispatch_started
                        .map(|t| t.elapsed().as_millis().min(9_007_199_254_740_991) as u64)
                        .unwrap_or(0)
                };
                let batch = mapper.push(&callback, &method, &params, elapsed_ms);
                if batch
                    .drafts
                    .iter()
                    .any(|d| d.kind == codex_events::Kind::MessageDone)
                {
                    retries = 0;
                }
                let mut io_failed = false;
                for draft in batch.drafts {
                    let value = match serde_json::to_value(draft) {
                        Ok(value) => value,
                        Err(_) => {
                            io_failed = true;
                            break;
                        }
                    };
                    if append(&shared, value).await.is_err() {
                        io_failed = true;
                        break;
                    }
                }
                if io_failed {
                    publish_outcome(
                        &mut outcome,
                        failure("storage_unavailable", "Codex event could not be committed"),
                    );
                    normalizer = None;
                    closing = true;
                    continue;
                }
                for signal in batch.signals {
                    if let codex_events::Signal::Retry { message, .. } = signal
                        && !stormed
                    {
                        retries = retries.saturating_add(1);
                        if retries >= 3 {
                            stormed = true;
                            let draft = json!({"sessionId":spec.key.name,"provider":"codex","kind":"net.blocked","data":{"reason":"error_retry_storm","retries":retries,"turnId":job.public_id,"message":message}});
                            if append(&shared, draft).await.is_err() {
                                publish_outcome(
                                    &mut outcome,
                                    failure(
                                        "storage_unavailable",
                                        "Codex retry outcome could not be committed",
                                    ),
                                );
                                normalizer = None;
                            } else {
                                forced_outcome = Some(failure(
                                    "blocked_network",
                                    &format!(
                                        "{retries} подряд error/willRetry — ход прерван: {message}"
                                    ),
                                ));
                            }
                            // The owner interrupts independently; never await our
                            // own event task from a policy signal.
                            cancel_job(&job);
                        }
                    }
                }
                if batch.fault.is_some() {
                    cancel_job(&job);
                }
                if let Some(terminal) = batch.terminal {
                    let (unsupported, uncertain) = {
                        let info = job.info.lock().expect("Codex job");
                        (info.unsupported, info.uncertain_start)
                    };
                    publish_outcome(
                        &mut outcome,
                        if uncertain {
                            failure(
                                "start_unknown",
                                "Codex turn identity could not be confirmed",
                            )
                        } else if unsupported {
                            failure(
                                "unsupported_background",
                                "Codex background execution is unsupported",
                            )
                        } else {
                            forced_outcome
                                .take()
                                .unwrap_or_else(|| mapped_outcome(terminal))
                        },
                    );
                }
            }
        }
    }
    approvals.abort_all();
    while approvals.join_next().await.is_some() {}
    let (unsupported, uncertain) = {
        let info = job.info.lock().expect("Codex job");
        (info.unsupported, info.uncertain_start)
    };
    publish_outcome(
        &mut outcome,
        if uncertain {
            failure(
                "start_unknown",
                "Codex turn identity could not be confirmed",
            )
        } else if let Some(forced) = forced_outcome {
            forced
        } else if unsupported {
            failure(
                "unsupported_background",
                "Codex background execution is unsupported",
            )
        } else if *cancel.borrow() {
            Outcome::Interrupted
        } else {
            failure(
                "provider_unavailable",
                "Codex event stream ended before a terminal notification",
            )
        },
    );
}
#[allow(clippy::too_many_arguments)]
async fn run_job(
    shared: Arc<Shared>,
    spec: Arc<SessionSpec>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    sender: mpsc::Sender<Envelope>,
    receiver: mpsc::Receiver<Envelope>,
    mut started: oneshot::Sender<Result<Started, WorkerError>>,
) {
    if started.is_closed() {
        cancel_job(&job);
    }
    let (done, done_rx) = oneshot::channel();
    let event_owner = tokio::spawn(events(
        shared.clone(),
        spec.clone(),
        job.clone(),
        snapshot.clone(),
        receiver,
        done,
    ));
    let mut preparation = tokio::spawn(prepare(
        shared.clone(),
        spec.clone(),
        job.clone(),
        snapshot,
        text,
        sender,
    ));
    let mut cancel = job.cancel.subscribe();
    let prepared = if *cancel.borrow() {
        preparation.abort();
        let _ = preparation.await;
        Err(error("interrupted", "Codex start cancelled"))
    } else {
        tokio::select! {result=&mut preparation=>result.unwrap_or_else(|_|Err(error("provider_unavailable","Codex preparation failed"))),_=cancel.changed()=>{preparation.abort();let _=preparation.await;Err(error("interrupted","Codex start cancelled"))},_=started.closed()=>{cancel_job(&job);preparation.abort();let _=preparation.await;Err(error("interrupted","Codex start waiter dropped"))}}
    };
    if prepared.is_ok() {
        let result = Started {
            turn_id: job.public_id.clone(),
            done: Box::pin(async move {
                done_rx
                    .await
                    .unwrap_or_else(|_| failure("provider_unavailable", "Codex event owner failed"))
            }),
        };
        if started.send(Ok(result)).is_err() {
            cancel_job(&job);
        }
        while !*cancel.borrow() {
            if cancel.changed().await.is_err() {
                break;
            }
        }
    } else {
        let uncertain = job.info.lock().expect("Codex job").uncertain_start;
        let failure = if uncertain {
            error(
                "start_unknown",
                "Codex turn identity could not be confirmed",
            )
        } else {
            prepared.err().unwrap_or_else(unavailable)
        };
        let _ = started.send(Err(failure));
        cancel_job(&job);
    }
    cleanup_job(&shared, &job).await;
    // Revoke/interrupt/stop above before waiting on policy IO. A stopped OS
    // process alone cannot prove a detached host filesystem check has finished.
    wait_checks(&job).await;
    // Removing the only route sender closes the per-ticket queue in order. Its
    // owner drains queued terminal/tail frames and joins all approval tasks.
    {
        let thread = job.info.lock().expect("Codex job").thread.clone();
        if let Some(thread) = thread {
            let mut state = shared.state.lock().expect("Codex host state");
            if state
                .routes
                .get(&thread)
                .is_some_and(|r| r.ticket == job.ticket)
            {
                state.routes.remove(&thread);
            }
        }
    }
    job.event_stop.send_replace(true);
    job.changed.notify_waiters();
    let _ = event_owner.await;
    {
        let mut state = shared.state.lock().expect("Codex host state");
        state.jobs.remove(&job.ticket);
        if let Some(session) = state.sessions.get_mut(&spec.key)
            && session.busy.as_ref() == Some(&job.ticket)
        {
            session.busy = None;
        }
    }
    job.closed.send_replace(Closed::Confirmed);
    shared.changed.notify_waiters();
}
async fn cleanup_job(shared: &Shared, job: &Job) {
    // Never release the ticket/daemon ownership while its durable write can
    // still mutate the registry. Preparation cancellation cannot detach this IO.
    let persistence = { job.persistence.lock().expect("Codex persistence").take() };
    if let Some(persistence) = persistence {
        let _ = persistence.await;
    }
    let responders_quiet = tokio::time::timeout(shared.timeouts.interrupt, async {
        loop {
            let changed = job.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if job.responders.load(Ordering::Acquire) == 0 {
                return;
            }
            changed.await;
        }
    })
    .await
    .is_ok();
    let (thread, native, dispatched, terminal, unknown, unsupported) = {
        let info = job.info.lock().expect("Codex job");
        (
            info.thread.clone(),
            info.native.clone(),
            info.dispatched,
            info.provider_terminal,
            info.thread_inflight,
            info.unsupported,
        )
    };
    let mut confirmed = !dispatched && !unknown && !unsupported && responders_quiet;
    if dispatched && terminal && !unsupported && responders_quiet {
        confirmed = true;
    }
    if !confirmed
        && dispatched
        && let Some((thread, native)) = thread.zip(native)
    {
        let client = { shared.client.borrow().clone() };
        if let Some(client) = client {
            let timeout = shared.timeouts.interrupt;
            let wait = async {
                let _ = client
                    .request(
                        "turn/interrupt",
                        json!({"threadId":thread,"turnId":native}),
                        timeout,
                    )
                    .await;
                loop {
                    if job.info.lock().expect("Codex job").provider_terminal {
                        return;
                    }
                    tokio::select! {_=job.changed.notified()=>{},_=shared.changed.notified()=>{}}
                }
            };
            let _ = tokio::time::timeout(timeout, wait).await;
        }
        {
            let info = job.info.lock().expect("Codex job");
            confirmed = info.provider_terminal && !info.unsupported && responders_quiet;
        }
    }
    if confirmed {
        job.execution.store(TERMINAL, Ordering::Release);
        shared.changed.notify_waiters();
        return;
    }
    job.execution.store(QUARANTINED, Ordering::Release);
    retire(shared, false);
    loop {
        let notified = shared.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let status = shared.state.lock().expect("Codex host state").status;
        match status {
            HostStatus::Stopped => return,
            HostStatus::Unconfirmed => {
                job.closed.send_replace(Closed::Unconfirmed);
            }
            _ => {}
        }
        notified.await;
    }
}
fn approval_context(mode: Approval, broker: bool) -> String {
    let label = match mode {
        Approval::ReadOnly => "Только чтение",
        Approval::Ask => "Спрашивать",
        Approval::Workspace => "Правки в папке без вопросов",
        Approval::Full => "Полный доступ",
        Approval::Inherit => "Как в настройках Claude",
    };
    let (sandbox, policy) = policy(mode, broker);
    let mut lines = vec![
        "<pult_runtime_context>".into(),
        format!(
            "Контекст Пульта для этого хода: провайдер codex; выбран режим «{label}» ({}). При смене режима ориентируйся на контекст текущего хода и действующие ограничения инструментов.",
            mode.as_str()
        ),
        format!("Codex: sandbox={sandbox}, approval_policy={policy}."),
    ];
    if mode == Approval::ReadOnly {
        lines.push("Песочница разрешает чтение; расширение доступа запрашивается отдельно.".into());
    }
    if mode == Approval::Workspace {
        lines.push("Разрешены правки в рабочей папке. Запросить запуск вне песочницы в этом режиме нельзя: «без вопросов» означает автоматический отказ для действий, требующих расширения доступа.".into());
    }
    if policy == "on-request" {
        lines.push("Для необходимого действия за пределами песочницы используй штатный запрос разрешения: он приходит человеку в Inbox Пульта.".into());
    }
    if mode != Approval::Full {
        lines.push("Вложенные процессы, включая claude и codex, наследуют песочницу. Сеть, localhost, Keychain или файлы авторизации могут быть недоступны, даже когда CLI работает в обычном терминале.".into());
    }
    if mode == Approval::Workspace && broker {
        lines.push("Если задача требует выхода из песочницы, объясни причину и предложи пользователю переключить режим этой сессии на «Спрашивать», затем повторить запрос. Сам режим не меняй и ограничения не обходи.".into());
    }
    if !broker {
        lines.push("Сейчас брокер разрешений недоступен: действия, требующие подтверждения, отклоняются. Объясни это пользователю; подтверждение в тексте чата не заменяет разрешение инструмента.".into());
    }
    if mode == Approval::Full {
        lines.push("Пульт не ставит свою песочницу или запросы разрешений в этом режиме. Это не гарантирует доступ к сети, Keychain, учётной записи или ресурсам ОС.".into());
    }
    lines.push("При отказе доступа или ответе вложенной CLI «Not logged in» сначала различай ограничения текущего процесса и состояние входа пользователя. Сообщай наблюдаемый факт и источник ограничения; такой ответ сам по себе не доказывает, что пользователь вышел из аккаунта. Повторный вход предлагай после подтверждения проблемы авторизации вне ограниченного процесса.".into());
    lines.push("</pult_runtime_context>".into());
    lines.join("\n")
}

#[cfg(test)]
mod blocking_check_tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_approval_waiter_retains_blocked_check_until_it_finishes() {
        let snapshot = TurnSnapshot {
            key: SessionKey {
                name: "fixture".into(),
                created_at: "fixture".into(),
            },
            provider: Provider::Codex,
            cwd: "/fixture".into(),
            settings: Default::default(),
        };
        let ticket = crate::turn_coordinator::Coordinator::new(Default::default())
            .unwrap()
            .reserve(snapshot.clone())
            .unwrap();
        let job = Arc::new(Job {
            ticket,
            public_id: "fixture".into(),
            info: Mutex::new(Info {
                thread: None,
                native: None,
                model: None,
                effective: snapshot.settings.approval,
                thread_inflight: false,
                dispatched: false,
                acknowledged: true,
                uncertain_start: false,
                dispatch_started: None,
                provider_terminal: false,
                unsupported: false,
                open_tools: HashSet::new(),
            }),
            execution: AtomicU8::new(EXECUTING),
            cancel: watch::channel(false).0,
            approval_closed: watch::channel(false).0,
            responders: AtomicUsize::new(1),
            checks: AtomicUsize::new(0),
            event_stop: watch::channel(false).0,
            closed: watch::channel(Closed::Pending).0,
            changed: Notify::new(),
            persistence: Mutex::new(None),
        });
        let (wire, mut peer) = crate::codex_rpc::memory_wire(2);
        let (client, mut events) = crate::codex_rpc::spawn(wire, Default::default()).unwrap();
        peer.outbound
            .send(Ok(json!({"id":"approval","method":"approve","params":{}})))
            .await
            .unwrap();
        let Event::ServerRequest { permit, .. } = events.recv().await.unwrap() else {
            panic!("server request");
        };
        let responder = ScopedResponder {
            client: client.clone(),
            permit: Some(permit),
            job: job.clone(),
        };
        let entered = Arc::new(Notify::new());
        let arriving = entered.clone();
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let barrier = release.clone();
        let gate = Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
            arriving.notify_one();
            let (lock, changed) = &*barrier;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
            DispatchDecision::Allow
        });
        let expected = snapshot.settings.approval;
        let task = tokio::spawn(responder.respond_checked(
            gate,
            snapshot,
            expected,
            Ok(json!({"decision":"allow"})),
        ));
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        cancel_job(&job);
        task.abort();
        let _ = task.await;
        let retained = job.checks.load(Ordering::Acquire) == 1;
        let mut waiting = Box::pin(wait_checks(&job));
        let pending = waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending();
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), peer.inbound.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            retained && pending,
            "cancelled handler detached an unfinished policy check"
        );
        assert!(
            frame.get("error").is_some(),
            "revoked check sent a late native allow"
        );
        assert_eq!(job.responders.load(Ordering::Acquire), 0);
        client.shutdown();
    }

    #[tokio::test]
    async fn first_poll_enqueues_request_and_response_before_async_wait() {
        let (wire, mut peer) = crate::codex_rpc::memory_wire(2);
        let (client, mut events) = crate::codex_rpc::spawn(wire, Default::default()).unwrap();
        let request_client = client.clone();
        let request = first_poll(Box::pin(async move {
            request_client
                .request("fixture", json!({}), Duration::from_secs(5))
                .await
        }));
        assert!(request.result.is_pending());
        // Never repoll the request until the peer observes its enqueued frame.
        let frame = tokio::time::timeout(Duration::from_secs(5), peer.inbound.recv())
            .await
            .unwrap()
            .unwrap();
        peer.outbound
            .send(Ok(json!({"id":frame["id"],"result":{}})))
            .await
            .unwrap();
        request.finish().await.unwrap();
        peer.outbound
            .send(Ok(json!({"id":"fixture","method":"approve","params":{}})))
            .await
            .unwrap();
        let Event::ServerRequest { permit, .. } = events.recv().await.unwrap() else {
            panic!("server request");
        };
        let response_client = client.clone();
        let response = first_poll(Box::pin(async move {
            response_client
                .respond(permit, Ok(json!({"decision":"deny"})))
                .await
        }));
        let frame = tokio::time::timeout(Duration::from_secs(5), peer.inbound.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame["id"], "fixture");
        assert_eq!(frame["result"]["decision"], "deny");
        response.finish().await.unwrap();
        client.shutdown();
    }
}
