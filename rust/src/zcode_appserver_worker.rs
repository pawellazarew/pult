//! Dedicated Route B execution. No Runtime activation or production memory wiring.
use crate::turn_completion::{CompletionUnavailable, WorkerCompletion};
use crate::{
    memory_policy::Policy,
    prompt_attachments::{self, PromptAttachment},
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{
        DispatchDecision, DispatchGate, Driver, EventSink, Progress, Started, Task, Worker,
        WorkerError,
    },
    turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot},
    worker_process::{
        Framing, Launch, PreparedInput, Process, SpawnDenied, SpawnGate, SpawnPermit,
        StartingProcess, StderrPolicy, StopSignal,
    },
    zcode_appserver_protocol::{
        self as codec, Incoming, OutboundRequest, RequestId, Response, ReverseRequest, SessionMode,
        SnapshotMethod, StdioMcpServer, Workspace,
    },
    zcode_events::{self, HostBinding, Normalizer, TrustedCallback},
    zcode_host_services::{
        AppServerAttempt, AppServerInputFrontier, AppServerNativeObserver, AppServerSessionStore,
        AppServerStartedEvidence, HostInputIds, JoinedCleanup, ReserveRequest, ZcodeOwner,
    },
    zcode_launch::ContextLanguage,
    zcode_worker::SpawnGateFactory,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
const QUEUE: usize = 16;
const EARLY_BYTES: usize = 2 * 1024 * 1024;
fn error(code: &str) -> WorkerError {
    WorkerError {
        code: code.into(),
        message: "ZCode app-server operation failed".into(),
    }
}
fn unavailable() -> WorkerError {
    error("provider_unavailable")
}
fn interrupted() -> WorkerError {
    error("interrupted")
}
fn protocol() -> WorkerError {
    error("protocol_error")
}
fn failure(e: &WorkerError) -> Outcome {
    Outcome::Failure {
        code: e.code.clone(),
        message: e.message.clone(),
    }
}
fn random(prefix: &str) -> Result<String, WorkerError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    Ok(format!(
        "{prefix}{}",
        bytes
            .iter()
            .enumerate()
            .map(|(i, b)| {
                format!(
                    "{}{b:02x}",
                    if [4, 6, 8, 10].contains(&i) { "-" } else { "" }
                )
            })
            .collect::<String>()
    ))
}
/// Held through synchronous first-input handoff. No IO/callback in Drop.
pub trait InputPermit {}
pub trait InputGate: Send + Sync {
    fn enter(&self) -> Result<Box<dyn InputPermit + '_>, WorkerError>;
}
pub type InputGateFactory = Arc<
    dyn Fn(AppServerAttempt, TurnSnapshot) -> Result<Arc<dyn InputGate>, WorkerError> + Send + Sync,
>;
#[derive(Clone)]
pub struct ResourceContext {
    pub ticket: Ticket,
    pub snapshot: TurnSnapshot,
    pub generation: u64,
    pub public_turn: String,
}
pub struct PreparedResources {
    context: ResourceContext,
    servers: Vec<StdioMcpServer>,
}
impl PreparedResources {
    /// Host factory only: memory-off must return unavailable instead of a dummy server.
    pub fn new(
        context: ResourceContext,
        servers: Vec<StdioMcpServer>,
    ) -> Result<Self, WorkerError> {
        if servers.is_empty() || servers.len() > codec::MAX_MCP_SERVERS {
            return Err(unavailable());
        }
        Ok(Self { context, servers })
    }
}
pub trait ResourcePermit {}
pub trait ScopedResources: Send + Sync {
    /// Own preparation through cancellation. V1 is memory-on only.
    fn prepare(&self, context: ResourceContext) -> Task<Result<PreparedResources, WorkerError>>;
    fn catalog(&self, ticket: Ticket, generation: u64)
    -> Task<Result<Option<String>, WorkerError>>;
    /// Consent/Registry/Runtime are already held. Read current metadata from the
    /// frontier; never reacquire Registry or perform FS/DB/callback work here.
    fn check<'a>(
        &'a self,
        frontier: &'a AppServerInputFrontier<'_>,
        ticket: &Ticket,
        generation: u64,
    ) -> Result<Box<dyn ResourcePermit + 'a>, WorkerError>;
    fn revoke(&self, ticket: &Ticket, generation: u64);
    fn drain(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>>;
}
#[derive(Clone)]
pub struct ReverseContext {
    pub ticket: Ticket,
    pub generation: u64,
}
pub struct BoundReverseReply {
    id: RequestId,
    bytes: Vec<u8>,
}
impl BoundReverseReply {
    /// V1 deliberately has no grant/modified-input constructor.
    pub fn default_deny(request: &ReverseRequest) -> Result<Self, WorkerError> {
        Ok(Self {
            id: request.id().clone(),
            bytes: request.default_deny().map_err(|_| protocol())?,
        })
    }
}
pub trait NativeInteractions: Send + Sync {
    fn handle(
        &self,
        context: ReverseContext,
        request: ReverseRequest,
    ) -> Task<Result<BoundReverseReply, WorkerError>>;
    fn revoke(&self, ticket: &Ticket, generation: u64);
}
pub struct DenyInteractions;
impl NativeInteractions for DenyInteractions {
    fn handle(
        &self,
        _: ReverseContext,
        request: ReverseRequest,
    ) -> Task<Result<BoundReverseReply, WorkerError>> {
        Box::pin(async move { BoundReverseReply::default_deny(&request) })
    }
    fn revoke(&self, _: &Ticket, _: u64) {}
}
pub struct Config {
    pub session: SessionKey,
    pub home: PathBuf,
    pub launch: Launch,
    pub workspace_key: String,
    pub native_mode: SessionMode,
    pub captured_approval: Approval,
    pub start_deadline: Instant,
    pub reverse_timeout: Duration,
    pub attachments: Vec<PromptAttachment>,
    pub language: ContextLanguage,
}
pub struct Services {
    pub driver: Weak<Driver>,
    pub owner: Arc<ZcodeOwner>,
    pub store: Arc<dyn AppServerSessionStore>,
    pub sink: Arc<dyn EventSink>,
    pub gate: Arc<dyn DispatchGate>,
    pub spawn_gate: SpawnGateFactory,
    pub input_gate: InputGateFactory,
    pub resources: Arc<dyn ScopedResources>,
    pub interactions: Arc<dyn NativeInteractions>,
    pub redactors: Arc<dyn Fn() -> Box<dyn zcode_events::Redactor> + Send + Sync>,
    pub fatal_storage: Arc<dyn Fn() + Send + Sync>,
}
struct State {
    used: bool,
    closed: bool,
    active: Option<Arc<Job>>,
}
struct Inner {
    config: Config,
    services: Services,
    state: Mutex<State>,
}
struct Vault {
    starting: Option<StartingProcess>,
    process: Option<Process>,
}
struct Write {
    frame: PreparedInput,
    first_input: bool,
}
enum Pending {
    Bootstrap(oneshot::Sender<Response>),
    Send { expected: RequestId, sid: String },
}
struct Wire {
    pending: HashMap<String, Pending>,
    observer: AppServerNativeObserver,
    sid: String,
    reverse_ids: Vec<RequestId>,
}
enum Event {
    Accepted(AppServerStartedEvidence),
    Native(BufferedEvent),
    Eof,
}
struct BufferedEvent {
    event: Option<event_profile::Event>,
    bytes: usize,
    budget: Arc<AtomicUsize>,
}
impl BufferedEvent {
    fn new(event: event_profile::Event, budget: Arc<AtomicUsize>) -> Result<Self, WorkerError> {
        let bytes = event.bytes();
        budget
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes).filter(|n| *n <= EARLY_BYTES)
            })
            .map_err(|_| error("capacity"))?;
        Ok(Self {
            event: Some(event),
            bytes,
            budget,
        })
    }
    fn take(mut self) -> event_profile::Event {
        self.event.take().expect("owned buffered event")
    }
}
impl Drop for BufferedEvent {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
#[derive(Clone, Copy)]
enum Closed {
    Pending,
    Unconfirmed,
    Confirmed,
}
/// Observe owned cleanup without abandoning its supervisor/process. Unknown
/// cleanup wakes the Driver so its existing close/quarantine protocol can run.
/// Confirmed cleanup alone never invents a native start result or turn outcome.
async fn await_owned<T>(
    mut receive: oneshot::Receiver<T>,
    mut closed: watch::Receiver<Closed>,
) -> Result<T, WorkerError> {
    loop {
        let phase = *closed.borrow_and_update();
        match phase {
            Closed::Unconfirmed => return Err(error("cleanup_unconfirmed")),
            Closed::Confirmed => return receive.await.map_err(|_| unavailable()),
            Closed::Pending => {}
        }
        tokio::select! {
            biased;
            changed = closed.changed() => {
                if changed.is_err() {
                    let confirmed = matches!(*closed.borrow(), Closed::Confirmed);
                    return if confirmed {
                        receive.await.map_err(|_| unavailable())
                    } else {
                        Err(error("cleanup_unconfirmed"))
                    };
                }
            }
            result = &mut receive => {
                // Cover a publication between changed()'s Pending poll and
                // the ready result branch; unknown cleanup wins over success.
                if matches!(*closed.borrow(), Closed::Unconfirmed) {
                    return Err(error("cleanup_unconfirmed"));
                }
                return result.map_err(|_| unavailable());
            }
        }
    }
}
struct Job {
    ticket: Ticket,
    generation: u64,
    public_turn: String,
    cancel: watch::Sender<bool>,
    closed: watch::Sender<Closed>,
    failure: watch::Sender<Option<WorkerError>>,
    retry: Notify,
    publication: AtomicU8,
    uncertain_io: AtomicBool,
    closing: AtomicBool,
    buffered_bytes: Arc<AtomicUsize>,
    pending_input_write: AtomicBool,
    attempt: Mutex<Option<AppServerAttempt>>,
    signal: Mutex<Option<StopSignal>>,
    vault: tokio::sync::Mutex<Vault>,
    writer: Mutex<Option<mpsc::Sender<Write>>>,
    wire: Mutex<Option<Arc<Mutex<Wire>>>>,
    reader_task: Mutex<Option<JoinHandle<Result<(), WorkerError>>>>,
    writer_task: Mutex<Option<JoinHandle<Result<(), WorkerError>>>>,
    reverse_tasks: Mutex<Vec<JoinHandle<Result<(), WorkerError>>>>,
}
impl Job {
    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
    fn fail(&self, failure: WorkerError) {
        // Revoke Ready input before waiting on any resource admission lock.
        if let Some(a) = self.attempt.lock().expect("attempt").as_ref() {
            a.attempt().cancel_before_spawn();
            a.cancel_before_input();
        }
        self.failure.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(failure);
            true
        });
        self.stop();
    }
    fn stop(&self) {
        if let Some(s) = self.signal.lock().expect("signal").as_ref() {
            s.request_stop();
        }
    }
    fn cancel(&self) {
        let _ = self
            .publication
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
        self.cancel.send_replace(true);
        if let Some(a) = self.attempt.lock().expect("attempt").as_ref() {
            a.attempt().cancel_before_spawn();
            a.cancel_before_input();
        }
        self.stop();
        self.retry.notify_one();
    }
}
pub struct ZcodeAppServerWorker(Arc<Inner>);
impl ZcodeAppServerWorker {
    pub fn new(config: Config, services: Services) -> Result<Arc<Self>, WorkerError> {
        if !config.home.is_absolute()
            || config.session.validate().is_err()
            || !config.launch.args.is_empty()
            || config.workspace_key.is_empty()
            || config
                .launch
                .env
                .contains_key(std::ffi::OsStr::new("PULT_MEMORY_KEY"))
            || config.reverse_timeout.is_zero()
            || config.reverse_timeout > Duration::from_secs(120)
        {
            return Err(unavailable());
        }
        config.launch.validate_shape().map_err(|_| unavailable())?;
        Ok(Arc::new(Self(Arc::new(Inner {
            config,
            services,
            state: Mutex::new(State {
                used: false,
                closed: false,
                active: None,
            }),
        }))))
    }
    pub fn is_retired(&self) -> bool {
        let s = self.0.state.lock().expect("worker state");
        s.used && s.active.is_none()
    }
    /// Sticky real Pending poll of the first input write; diagnostic, not delivery/cleanup authority.
    pub fn observed_pending_input_write(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("worker state")
            .active
            .as_ref()
            .is_some_and(|j| j.pending_input_write.load(Ordering::Acquire))
    }
    pub fn begin_shutdown(&self) {
        let job = {
            let mut s = self.0.state.lock().expect("worker state");
            s.closed = true;
            s.active.clone()
        };
        if let Some(j) = job {
            j.cancel();
        }
    }
}
impl Drop for ZcodeAppServerWorker {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}
impl Worker for ZcodeAppServerWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>> {
        static GENERATION: AtomicU64 = AtomicU64::new(1);
        let result = (|| {
            let mut state = self.0.state.lock().map_err(|_| unavailable())?;
            if state.used
                || state.closed
                || ticket.session() != &self.0.config.session
                || snapshot.key != self.0.config.session
            {
                return Err(unavailable());
            }
            let public_turn = random("pult-turn-")?;
            let (cancel, _) = watch::channel(false);
            let (closed, _) = watch::channel(Closed::Pending);
            let (failure, _) = watch::channel(None);
            let job = Arc::new(Job {
                ticket,
                generation: GENERATION.fetch_add(1, Ordering::Relaxed),
                public_turn,
                cancel,
                closed,
                failure,
                retry: Notify::new(),
                publication: AtomicU8::new(0),
                uncertain_io: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                buffered_bytes: Arc::new(AtomicUsize::new(0)),
                pending_input_write: AtomicBool::new(false),
                attempt: Mutex::new(None),
                signal: Mutex::new(None),
                vault: tokio::sync::Mutex::new(Vault {
                    starting: None,
                    process: None,
                }),
                writer: Mutex::new(None),
                wire: Mutex::new(None),
                reader_task: Mutex::new(None),
                writer_task: Mutex::new(None),
                reverse_tasks: Mutex::new(Vec::new()),
            });
            state.used = true;
            state.active = Some(job.clone());
            Ok(job)
        })();
        let inner = self.0.clone();
        match result {
            Err(e) => Box::pin(async move { Err(e) }),
            Ok(job) => {
                let (tx, rx) = oneshot::channel();
                let closed = job.closed.subscribe();
                tokio::spawn(supervise(inner, job, snapshot, text, tx));
                Box::pin(async move { await_owned(rx, closed).await? })
            }
        }
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        let job = self
            .0
            .state
            .lock()
            .expect("worker state")
            .active
            .clone()
            .filter(|j| j.ticket == ticket);
        if let Some(j) = &job {
            j.cancel();
        }
        Box::pin(async move {
            let Some(job) = job else {
                return Ok(());
            };
            let mut closed = job.closed.subscribe();
            loop {
                match *closed.borrow_and_update() {
                    Closed::Confirmed => return Ok(()),
                    Closed::Unconfirmed => return Err(error("cleanup_unconfirmed")),
                    Closed::Pending => {}
                }
                closed
                    .changed()
                    .await
                    .map_err(|_| error("cleanup_unconfirmed"))?;
            }
        })
    }
}
fn live(inner: &Inner, job: &Job) -> Result<(), WorkerError> {
    if let Some(e) = job.failure.borrow().as_ref() {
        return Err(e.clone());
    }
    if job.closing.load(Ordering::Acquire) {
        return Err(interrupted());
    }
    if job.cancelled() {
        return Err(interrupted());
    }
    if Instant::now() >= inner.config.start_deadline {
        return Err(error("start_unknown"));
    }
    if !inner
        .services
        .driver
        .upgrade()
        .is_some_and(|d| d.snapshot_for_dispatch(&job.ticket).is_some())
    {
        return Err(interrupted());
    }
    Ok(())
}
fn policy(inner: &Inner, job: &Job, snapshot: &TurnSnapshot) -> Result<(), WorkerError> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inner.services.gate.check(&job.ticket, snapshot)
    }));
    match result {
        Ok(DispatchDecision::Allow) => Ok(()),
        Ok(DispatchDecision::Restrict(a)) if a == snapshot.settings.approval => Ok(()),
        _ => Err(error("access_changed")),
    }
}
struct CheckedSpawn {
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    host: Arc<dyn SpawnGate>,
}
impl SpawnGate for CheckedSpawn {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        live(&self.inner, &self.job).map_err(|_| SpawnDenied)?;
        policy(&self.inner, &self.job, &self.snapshot).map_err(|_| SpawnDenied)?;
        self.host.enter()
    }
}
fn fatal(inner: &Inner, job: &Job) {
    job.uncertain_io.store(true, Ordering::Release);
    fault(inner);
}
fn fault(inner: &Inner) {
    if let Some(d) = inner.services.driver.upgrade() {
        d.report_storage_failure();
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (inner.services.fatal_storage)()
    }));
}
async fn external<T: Send + 'static>(
    inner: &Inner,
    job: &Job,
    task: Task<Result<T, WorkerError>>,
) -> Result<T, WorkerError> {
    match tokio::spawn(task).await {
        Ok(r) => r,
        Err(_) => {
            fatal(inner, job);
            Err(error("storage_unavailable"))
        }
    }
}
async fn store<T: Send + 'static>(
    inner: &Inner,
    job: &Job,
    task: Task<Result<T, crate::zcode_host_services::Error>>,
) -> Result<T, WorkerError> {
    let result = external(
        inner,
        job,
        Box::pin(async move { task.await.map_err(|e| error(e.code())) }),
    )
    .await;
    if result
        .as_ref()
        .is_err_and(|e| e.code == "storage_unavailable")
        && let Some(d) = inner.services.driver.upgrade()
    {
        d.report_storage_failure();
    }
    result
}
async fn append(inner: &Inner, job: &Job, draft: Value) -> Result<(), WorkerError> {
    let sink = inner.services.sink.clone();
    let result = external(
        inner,
        job,
        Box::pin(async move {
            sink.append(draft)
                .await
                .map_err(|_| error("storage_unavailable"))
        }),
    )
    .await;
    match result {
        Ok(r) if r.id > 0 && r.id <= 9_007_199_254_740_991 && !r.ts.is_empty() => Ok(()),
        _ => {
            fault(inner);
            Err(error("storage_unavailable"))
        }
    }
}
async fn supervise(
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    start: oneshot::Sender<Result<Started, WorkerError>>,
) {
    let start = Arc::new(Mutex::new(Some(start)));
    let (done, done_rx) = oneshot::channel();
    let i = inner.clone();
    let j = job.clone();
    let s = start.clone();
    let result =
        match tokio::spawn(async move { turn(i, j, snapshot, text, s, done_rx).await }).await {
            Ok(r) => r,
            Err(_) => Err(error("worker_panic")),
        };
    revoke(&inner, &job);
    if result.is_ok() && !job.cancelled() && !job.uncertain_io.load(Ordering::Acquire) {
        close_native(&job).await;
    }
    cleanup(&inner, &job).await;
    inner.state.lock().expect("worker state").active = None;
    job.closed.send_replace(Closed::Confirmed);
    let sender = start.lock().expect("start").take();
    if let Some(sender) = sender {
        let _ = sender.send(Err(result.err().unwrap_or_else(unavailable)));
    } else {
        let _ = done.send(if job.cancelled() {
            Outcome::Interrupted.into()
        } else {
            result.unwrap_or_else(|e| failure(&e).into())
        });
    }
}
async fn close_native(job: &Job) {
    let wire = job.wire.lock().expect("wire").clone();
    let writer = job.writer.lock().expect("writer").clone();
    let (Some(wire), Some(writer)) = (wire, writer) else {
        return;
    };
    let id = RequestId::string("cleanup-close").expect("static ID");
    let (send, recv) = oneshot::channel();
    let request = {
        let mut w = match wire.lock() {
            Ok(w) => w,
            Err(_) => return,
        };
        if w.pending.len() >= QUEUE {
            return;
        }
        let request = match OutboundRequest::close(id.clone(), &w.sid).and_then(|r| r.encode()) {
            Ok(r) => r,
            Err(_) => return,
        };
        w.pending
            .insert("cleanup-close".into(), Pending::Bootstrap(send));
        request
    };
    let frame = match framing().and_then(|f| f.prepare_raw(request).map_err(|_| protocol())) {
        Ok(f) => f,
        Err(_) => return,
    };
    if writer
        .try_send(Write {
            frame,
            first_input: false,
        })
        .is_err()
    {
        return;
    }
    if let Ok(Ok(response)) = tokio::time::timeout(Duration::from_millis(100), recv).await {
        let _ = response.close_ack(&id);
    }
}
fn revoke(inner: &Inner, job: &Job) {
    if job.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    let resource_revoke = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inner.services.resources.revoke(&job.ticket, job.generation)
    }));
    let interaction_revoke = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inner
            .services
            .interactions
            .revoke(&job.ticket, job.generation)
    }));
    if resource_revoke.is_err() || interaction_revoke.is_err() {
        fatal(inner, job);
    }
}
async fn cleanup(inner: &Inner, job: &Job) {
    if let Some(a) = job.attempt.lock().expect("attempt").as_ref() {
        a.attempt().cancel_before_spawn();
        a.cancel_before_input();
    }
    revoke(inner, job);
    job.stop();
    job.writer.lock().expect("writer").take();
    for slot in [&job.reader_task, &job.writer_task] {
        let handle = slot.lock().expect("task").take();
        if let Some(h) = handle {
            let _ = h.await;
        }
    }
    let tasks = std::mem::take(&mut *job.reverse_tasks.lock().expect("reverse"));
    for task in tasks {
        if task.await.is_err() {
            fatal(inner, job);
        }
    }
    loop {
        let stopped = {
            let mut vault = job.vault.lock().await;
            if let Some(s) = vault.starting.take() {
                vault.process = Some(s.into_process());
            }
            match vault.process.as_mut() {
                None => true,
                Some(p) => p.stop().await.is_ok(),
            }
        };
        if stopped {
            break;
        }
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
        job.closed.send_replace(Closed::Pending);
    }
    let resources = inner.services.resources.clone();
    let ticket = job.ticket.clone();
    let generation = job.generation;
    if external(
        inner,
        job,
        Box::pin(async move { resources.drain(ticket, generation).await }),
    )
    .await
    .is_err()
    {
        fatal(inner, job);
    }
    // Unknown external completion is not JoinedCleanup, even when there was
    // no native PID. Keep the exact Attempt/marker and quarantine ownership.
    while job.uncertain_io.load(Ordering::Acquire) {
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
    }
    let attempt = job.attempt.lock().expect("attempt").clone();
    if let Some(a) = attempt {
        let proof = JoinedCleanup::from_owned_join(a.attempt());
        let service = inner.services.store.clone();
        let retiring = a.clone();
        let result = if a.attempt().spawn_action().never_sent() {
            store(
                inner,
                job,
                Box::pin(async move { service.clear_before_bootstrap(retiring, proof).await }),
            )
            .await
        } else {
            store(
                inner,
                job,
                Box::pin(async move { service.retire(retiring, proof).await }),
            )
            .await
        };
        if result.is_err() && !job.uncertain_io.load(Ordering::Acquire) {
            let proof = JoinedCleanup::from_owned_join(a.attempt());
            let service = inner.services.store.clone();
            let _ = store(
                inner,
                job,
                Box::pin(async move { service.retire(a, proof).await }),
            )
            .await;
        }
    }
    while job.uncertain_io.load(Ordering::Acquire) {
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
    }
}
fn prepared(request: OutboundRequest) -> Result<PreparedInput, WorkerError> {
    framing()?
        .prepare_raw(request.encode().map_err(|_| protocol())?)
        .map_err(|_| protocol())
}
fn framing() -> Result<Framing, WorkerError> {
    Framing::raw_ndjson(codec::MAX_FRAME_BYTES, codec::MAX_OUTBOUND_FRAME_BYTES)
        .map_err(|_| protocol())
}
fn writer(job: Arc<Job>, mut rx: mpsc::Receiver<Write>) -> JoinHandle<Result<(), WorkerError>> {
    let writing_job = job.clone();
    let writing = tokio::spawn(async move {
        let job = writing_job;
        while let Some(command) = rx.recv().await {
            let mut vault = job.vault.lock().await;
            let process = vault.process.as_mut().ok_or_else(unavailable)?;
            let mut writing = Box::pin(process.send_prepared(command.frame));
            let first = std::future::poll_fn(|cx| {
                std::task::Poll::Ready(match writing.as_mut().poll(cx) {
                    std::task::Poll::Ready(result) => Some(result),
                    std::task::Poll::Pending => None,
                })
            })
            .await;
            let result = match first {
                Some(result) => result,
                None => {
                    if command.first_input {
                        job.pending_input_write.store(true, Ordering::Release);
                    }
                    writing.await
                }
            };
            result.map_err(|_| error("start_unknown"))?;
        }
        Ok(())
    });
    tokio::spawn(async move {
        let result = writing
            .await
            .unwrap_or_else(|_| Err(error("start_unknown")));
        if let Err(e) = &result {
            job.fail(error(&e.code));
        }
        result
    })
}
async fn rpc(
    inner: &Inner,
    job: &Job,
    wire: &Mutex<Wire>,
    tx: &mpsc::Sender<Write>,
    request: OutboundRequest,
    id: &str,
) -> Result<Response, WorkerError> {
    live(inner, job)?;
    let frame = prepared(request)?;
    let (send, recv) = oneshot::channel();
    {
        let mut w = wire.lock().map_err(|_| protocol())?;
        if w.pending.len() >= QUEUE
            || w.pending
                .insert(id.into(), Pending::Bootstrap(send))
                .is_some()
        {
            return Err(protocol());
        }
    }
    tx.try_send(Write {
        frame,
        first_input: false,
    })
    .map_err(|_| error("capacity"))?;
    let mut cancel = job.cancel.subscribe();
    let mut failure_rx = job.failure.subscribe();
    if let Some(e) = failure_rx.borrow_and_update().as_ref() {
        return Err(e.clone());
    }
    tokio::select! {r=recv=>r.map_err(|_|protocol()),_=cancel.changed()=>Err(interrupted()),_=failure_rx.changed()=>Err(failure_rx.borrow().clone().unwrap_or_else(protocol)),_=tokio::time::sleep_until(inner.config.start_deadline.into())=>Err(error("start_unknown"))}
}
fn reverse(
    inner: Arc<Inner>,
    job: Arc<Job>,
    request: ReverseRequest,
    wire: Arc<Mutex<Wire>>,
    tx: mpsc::Sender<Write>,
) -> Result<(), WorkerError> {
    if job.closing.load(Ordering::Acquire) {
        let frame = framing()?
            .prepare_raw(request.default_deny().map_err(|_| protocol())?)
            .map_err(|_| protocol())?;
        tx.try_send(Write {
            frame,
            first_input: false,
        })
        .map_err(|_| error("capacity"))?;
        return Ok(());
    }
    let id = request.id().clone();
    {
        let mut w = wire.lock().map_err(|_| protocol())?;
        if w.reverse_ids.len() >= 128 || w.reverse_ids.contains(&id) {
            return Err(protocol());
        }
        let sid = match &request {
            ReverseRequest::RuntimePreferences { session_id, .. }
            | ReverseRequest::Permission { session_id, .. }
            | ReverseRequest::UserInput { session_id, .. } => session_id,
        };
        if sid != &w.sid {
            return Err(protocol());
        }
        w.reverse_ids.push(id.clone());
    }
    let j = job.clone();
    let handle = tokio::spawn(async move {
        let result = async {
        let context = ReverseContext {
            ticket: j.ticket.clone(),
            generation: j.generation,
        };
        let handler = inner.services.interactions.clone();
        // Own callback construction/poll through cancellation and timeout. A
        // timeout does not abort the admitted callback; stop still waits for it.
        let mut work = tokio::spawn(async move { handler.handle(context, request).await });
        let mut cancel = j.cancel.subscribe();
        let timeout = if j.publication.load(Ordering::Acquire) == 0 {
            inner.config.reverse_timeout.min(
                inner
                    .config
                    .start_deadline
                    .saturating_duration_since(Instant::now()),
            )
        } else {
            inner.config.reverse_timeout
        };
        let reply = tokio::select! {
            r=&mut work=>r,
            _=cancel.changed()=>{let _=work.await;return Ok(());},
            _=tokio::time::sleep(timeout)=>{j.fail(error("interaction_timeout"));let _=work.await;return Ok(());}
        };
        let reply = match reply {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                return Err(e);
            }
            Err(_) => {
                fatal(&inner, &j);
                return Err(error("storage_unavailable"));
            }
        };
        if j.cancelled() || j.closing.load(Ordering::Acquire) {
            return Ok(());
        }
        if reply.id != id {
            return Err(protocol());
        }
        let frame = framing()?
            .prepare_raw(reply.bytes)
            .map_err(|_| protocol())?;
        tx.try_send(Write {
            frame,
            first_input: false,
        })
        .map_err(|_| error("capacity"))?;
        Ok(())
        }.await;
        if let Err(e) = &result {
            j.fail(error(&e.code));
        }
        result
    });
    job.reverse_tasks
        .lock()
        .map_err(|_| protocol())?
        .push(handle);
    Ok(())
}
fn reader(
    inner: Arc<Inner>,
    job: Arc<Job>,
    wire: Arc<Mutex<Wire>>,
    tx: mpsc::Sender<Write>,
    events: mpsc::Sender<Event>,
    mut output: mpsc::Receiver<anyhow::Result<crate::worker_process::RawFrame>>,
) -> JoinHandle<Result<(), WorkerError>> {
    tokio::spawn(async move {
        let result = async {
            while let Some(frame) = output.recv().await {
                let frame = frame.map_err(|_| protocol())?;
                let incoming = codec::decode_frame(frame.as_bytes()).map_err(|_| protocol())?;
                match incoming {
                    Incoming::Response(response) => {
                        let key = match response.id() {
                            RequestId::String(s) => s.clone(),
                            RequestId::Integer(_) => return Err(protocol()),
                        };
                        let pending = wire
                            .lock()
                            .map_err(|_| protocol())?
                            .pending
                            .remove(&key)
                            .ok_or_else(protocol)?;
                        match pending {
                            Pending::Bootstrap(reply) => {
                                let _ = reply.send(response);
                            }
                            Pending::Send { expected, sid } => {
                                let ack = response
                                    .send_ack(&expected, &sid)
                                    .map_err(|_| error("start_unknown"))?;
                                let evidence = {
                                    let mut w = wire.lock().map_err(|_| protocol())?;
                                    w.observer
                                        .observe_send_ack(
                                            &key,
                                            &ack.session_id,
                                            true,
                                            ack.state_revision,
                                        )
                                        .map_err(|_| protocol())?;
                                    w.observer.take_started_evidence()
                                };
                                if let Some(e) = evidence {
                                    events
                                        .try_send(Event::Accepted(e))
                                        .map_err(|_| error("capacity"))?;
                                }
                            }
                        }
                    }
                    Incoming::TurnStarted(start) => {
                        let evidence = {
                            let mut w = wire.lock().map_err(|_| protocol())?;
                            w.observer
                                .observe_turn_started(
                                    &start.session_id,
                                    start.turn_id.as_deref(),
                                    start.input_id.as_deref(),
                                    start.query_id.as_deref(),
                                )
                                .map_err(|_| protocol())?;
                            w.observer.take_started_evidence()
                        };
                        if let Some(e) = evidence {
                            events
                                .try_send(Event::Accepted(e))
                                .map_err(|_| error("capacity"))?;
                        }
                    }
                    Incoming::Reverse(request) => reverse(
                        inner.clone(),
                        job.clone(),
                        request,
                        wire.clone(),
                        tx.clone(),
                    )?,
                    Incoming::Notification(notification) => {
                        if let Some(event) = event_profile::parse(notification)? {
                            events
                                .try_send(Event::Native(BufferedEvent::new(
                                    event,
                                    job.buffered_bytes.clone(),
                                )?))
                                .map_err(|_| error("capacity"))?;
                        }
                    }
                }
            }
            let _ = events.try_send(Event::Eof);
            Ok(())
        }
        .await;
        wire.lock().map_err(|_| protocol())?.pending.clear();
        if let Err(e) = &result {
            job.fail(error(&e.code));
        }
        result
    })
}
async fn receipt_ready(inner: &Inner, job: &Job) -> bool {
    let Some(mut progress) = inner
        .services
        .driver
        .upgrade()
        .and_then(|d| d.progress_for_ticket(&job.ticket))
    else {
        return false;
    };
    let mut cancel = job.cancel.subscribe();
    loop {
        if job.cancelled() {
            return false;
        }
        let p = progress.borrow_and_update().clone();
        match p {
            Progress::Running(a) => return a.turn_id == job.public_turn && a.user_event_id > 0,
            Progress::Starting => {}
            _ => return false,
        }
        tokio::select! {_=cancel.changed()=>return false,r=progress.changed()=>if r.is_err(){return false;}}
    }
}
type StartReply = Arc<Mutex<Option<oneshot::Sender<Result<Started, WorkerError>>>>>;
async fn turn(
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    start: StartReply,
    done: oneshot::Receiver<WorkerCompletion>,
) -> Result<WorkerCompletion, WorkerError> {
    live(&inner, &job)?;
    let checking = inner.clone();
    let scope = job.clone();
    let initial = snapshot.clone();
    tokio::task::spawn_blocking(move || policy(&checking, &scope, &initial))
        .await
        .map_err(|_| unavailable())??;
    if snapshot.provider != Provider::Zcode
        || snapshot.settings.approval != inner.config.captured_approval
        || snapshot.cwd != inner.config.launch.cwd
        || snapshot.settings.model.is_some()
        || snapshot.settings.effort.is_some()
        || snapshot.settings.service_tier.is_some()
        || snapshot.settings.browser.is_some()
        || !matches!(
            inner.config.native_mode,
            SessionMode::Plan | SessionMode::Guarded | SessionMode::Yolo
        )
        || (inner.config.native_mode == SessionMode::Yolo
            && snapshot.settings.approval != Approval::Full)
        || (snapshot.settings.approval == Approval::ReadOnly
            && inner.config.native_mode != SessionMode::Plan)
    {
        return Err(unavailable());
    }
    let context = ResourceContext {
        ticket: job.ticket.clone(),
        snapshot: snapshot.clone(),
        generation: job.generation,
        public_turn: job.public_turn.clone(),
    };
    let resources = inner.services.resources.clone();
    let captured = context.clone();
    let prepared_resources = external(
        &inner,
        &job,
        Box::pin(async move { resources.prepare(captured).await }),
    )
    .await?;
    if prepared_resources.context.ticket != job.ticket
        || prepared_resources.context.snapshot != snapshot
        || prepared_resources.context.generation != job.generation
        || prepared_resources.context.public_turn != job.public_turn
    {
        return Err(unavailable());
    }
    live(&inner, &job)?;
    let resources = inner.services.resources.clone();
    let ticket = job.ticket.clone();
    let generation = job.generation;
    let catalog = external(
        &inner,
        &job,
        Box::pin(async move { resources.catalog(ticket, generation).await }),
    )
    .await?;
    if catalog
        .as_ref()
        .is_some_and(|c| c.len() > 16_000 || c.chars().count() > 4_000)
    {
        return Err(error("capacity"));
    }
    let service = inner.services.store.clone();
    let request = ReserveRequest::new(
        job.ticket.clone(),
        snapshot.clone(),
        job.generation,
        job.public_turn.clone(),
        inner.config.start_deadline,
    );
    let ids = HostInputIds::new(random("input-")?, random("query-")?).map_err(|_| unavailable())?;
    let attempt = store(
        &inner,
        &job,
        Box::pin(async move { service.reserve(request, ids).await }),
    )
    .await?;
    if attempt.attempt().ticket() != &job.ticket
        || attempt.attempt().generation() != job.generation
        || attempt.attempt().public_turn() != job.public_turn
    {
        return Err(protocol());
    }
    *job.attempt.lock().expect("attempt") = Some(attempt.clone());
    live(&inner, &job)?;
    let mut launch = inner.config.launch.clone();
    launch
        .args
        .extend(codec::APP_SERVER_ARGV.into_iter().map(Into::into));
    let prepared_launch = Process::prepare_launch(launch, framing()?, StderrPolicy::CountOnly)
        .await
        .map_err(|_| unavailable())?;
    live(&inner, &job)?;
    let build = inner.services.spawn_gate.clone();
    let a = attempt.attempt().clone();
    let initial = snapshot.clone();
    let gate =
        tokio::task::spawn_blocking(move || build(a, initial.clone(), initial.settings.approval))
            .await
            .map_err(|_| unavailable())??;
    live(&inner, &job)?;
    append(&inner,&job,json!({"sessionId":snapshot.key.name,"provider":"zcode","kind":"status.changed","data":{"status":"working","turnId":job.public_turn}})).await?;
    live(&inner, &job)?;
    let gate = CheckedSpawn {
        inner: inner.clone(),
        job: job.clone(),
        snapshot: snapshot.clone(),
        host: gate,
    };
    let spawning = job.clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _runtime = runtime.enter();
        let mut v = spawning.vault.try_lock().map_err(|_| unavailable())?;
        match Process::begin_spawn(prepared_launch, &gate) {
            Ok(s) => {
                *spawning.signal.lock().expect("signal") = Some(s.stop_signal());
                v.starting = Some(s);
                Ok(())
            }
            Err(e) => {
                v.process = e.process.map(|p| *p);
                Err(unavailable())
            }
        }
    })
    .await
    .map_err(|_| unavailable())??;
    {
        let mut v = job.vault.lock().await;
        let result = v
            .starting
            .as_mut()
            .ok_or_else(unavailable)?
            .acknowledge()
            .await;
        let s = v.starting.take().ok_or_else(unavailable)?;
        v.process = Some(s.into_process());
        result.map_err(|_| unavailable())?;
    }
    live(&inner, &job)?;
    let native_sid = attempt
        .attempt()
        .resume_session_id()
        .map(str::to_owned)
        .unwrap_or(random("pult-session-")?);
    let observer = AppServerNativeObserver::from_owned_process(&attempt, job.generation)
        .map_err(|_| protocol())?;
    let wire = Arc::new(Mutex::new(Wire {
        pending: HashMap::new(),
        observer,
        sid: native_sid.clone(),
        reverse_ids: Vec::new(),
    }));
    *job.wire.lock().expect("wire") = Some(wire.clone());
    let (writes, write_rx) = mpsc::channel(QUEUE);
    *job.writer.lock().expect("writer") = Some(writes.clone());
    *job.writer_task.lock().expect("writer task") = Some(writer(job.clone(), write_rx));
    let output = job
        .vault
        .lock()
        .await
        .process
        .as_mut()
        .ok_or_else(unavailable)?
        .take_raw_output()
        .map_err(|_| protocol())?;
    let (event_tx, mut events) = mpsc::channel(128);
    *job.reader_task.lock().expect("reader task") = Some(reader(
        inner.clone(),
        job.clone(),
        wire.clone(),
        writes.clone(),
        event_tx,
        output,
    ));
    let workspace = Workspace::new(
        snapshot.cwd.to_str().ok_or_else(unavailable)?,
        &inner.config.workspace_key,
    )
    .map_err(|_| unavailable())?;
    let method = if attempt.attempt().resume_session_id().is_some() {
        SnapshotMethod::Resume
    } else {
        SnapshotMethod::Create
    };
    let rid = RequestId::string("bootstrap").map_err(|_| protocol())?;
    let request = if method == SnapshotMethod::Resume {
        OutboundRequest::resume(
            rid.clone(),
            &native_sid,
            workspace,
            prepared_resources.servers,
        )
    } else {
        OutboundRequest::create(
            rid.clone(),
            &native_sid,
            workspace,
            prepared_resources.servers,
        )
        .and_then(|r| r.with_mode(inner.config.native_mode))
    }
    .map_err(|_| protocol())?;
    let ack = rpc(&inner, &job, &wire, &writes, request, "bootstrap")
        .await?
        .snapshot_ack(&rid, &native_sid, method)
        .map_err(|_| protocol())?;
    if ack.workspace_path != snapshot.cwd.to_str().ok_or_else(unavailable)?
        || ack.workspace_key != inner.config.workspace_key
        || ack.active_turn_id.is_some()
    {
        return Err(protocol());
    }
    let service = inner.services.store.clone();
    let a = attempt.clone();
    let sid = native_sid.clone();
    let identity = store(
        &inner,
        &job,
        Box::pin(async move { service.record_session(a, sid).await }),
    )
    .await?;
    if ack.session_mode != inner.config.native_mode {
        let id = RequestId::string("set-mode").map_err(|_| protocol())?;
        let request = OutboundRequest::set_mode(
            id.clone(),
            &native_sid,
            inner.config.native_mode,
            Some(ack.state_revision),
        )
        .map_err(|_| protocol())?;
        let mode = rpc(&inner, &job, &wire, &writes, request, "set-mode")
            .await?
            .snapshot_ack(&id, &native_sid, SnapshotMethod::SetMode)
            .map_err(|_| protocol())?;
        if mode.session_mode != inner.config.native_mode
            || mode.workspace_path != ack.workspace_path
            || mode.workspace_key != ack.workspace_key
        {
            return Err(protocol());
        }
    }
    let id = RequestId::string("subscribe").map_err(|_| protocol())?;
    let request = OutboundRequest::subscribe(
        id.clone(),
        &native_sid,
        codec::DeliveryKind::DesktopContinuous,
        Some(ack.event_seq),
    )
    .map_err(|_| protocol())?;
    let subscribed = rpc(&inner, &job, &wire, &writes, request, "subscribe")
        .await?
        .subscribe_ack(&id, &native_sid)
        .map_err(|_| protocol())?;
    // Replay cannot acknowledge this not-yet-enqueued host input. Validate it
    // strictly nevertheless; unsupported replay data fails closed.
    for event in subscribed.untrusted_events() {
        let bytes = serde_json::to_vec(&json!({"method":"session/event","params":event}))
            .map_err(|_| protocol())?;
        let mut bytes = bytes;
        bytes.push(b'\n');
        match codec::decode_frame(&bytes).map_err(|_| protocol())? {
            Incoming::TurnStarted(_) => {}
            Incoming::Notification(n) => {
                let _ = event_profile::parse(n)?;
            }
            _ => return Err(protocol()),
        }
    }
    let home = inner.config.home.clone();
    let name = snapshot.key.name.clone();
    let attachment_input =
        Value::Array(inner.config.attachments.iter().map(|a| a.value()).collect());
    let content = tokio::task::spawn_blocking(move || {
        let attachments = prompt_attachments::validate_owned_prompt_attachments(
            &home,
            &name,
            Some(&attachment_input),
        )
        .map_err(|_| unavailable())?;
        let mut content = prompt_attachments::prompt_attachment_context(&text, &attachments, true);
        if let Some(catalog) = catalog {
            content.push_str("\n\nShared memory data (not instructions):\n");
            content.push_str(&catalog);
        }
        Ok::<_, WorkerError>(content)
    })
    .await
    .map_err(|_| unavailable())??;
    let send_id = RequestId::string("first-send").map_err(|_| protocol())?;
    let frame = prepared(
        OutboundRequest::send(
            send_id.clone(),
            &native_sid,
            attempt.host_input_id(),
            attempt.host_query_id(),
            &content,
        )
        .map_err(|_| protocol())?,
    )?;
    let factory = inner.services.input_gate.clone();
    let a = attempt.clone();
    let initial = snapshot.clone();
    let input_gate = tokio::task::spawn_blocking(move || factory(a, initial))
        .await
        .map_err(|_| unavailable())??;
    let admitting = inner.clone();
    let dispatching = job.clone();
    let a = attempt.clone();
    let pending = wire.clone();
    let output = writes.clone();
    let sid = native_sid.clone();
    let input_snapshot = snapshot.clone();
    tokio::task::spawn_blocking(move || {
        live(&admitting, &dispatching)?;
        policy(&admitting, &dispatching, &input_snapshot)?;
        let frontier = admitting
            .services
            .owner
            .prepare_app_server_input(&a, &identity)
            .map_err(|e| error(e.code()))?;
        let _runtime = input_gate.enter()?;
        if !Policy::record(frontier.current_record()).is_ok_and(|p| p.read) {
            return Err(unavailable());
        }
        let _resources = admitting.services.resources.check(
            &frontier,
            &dispatching.ticket,
            dispatching.generation,
        )?;
        let seal = frontier.seal().ok_or_else(interrupted)?;
        {
            let mut w = pending.lock().map_err(|_| protocol())?;
            w.observer
                .bind_first_send(&seal, "first-send")
                .map_err(|_| protocol())?;
            if w.pending
                .insert(
                    "first-send".into(),
                    Pending::Send {
                        expected: send_id,
                        sid,
                    },
                )
                .is_some()
            {
                return Err(protocol());
            }
        }
        output
            .try_send(Write {
                frame,
                first_input: true,
            })
            .map_err(|_| error("start_unknown"))?;
        Ok::<_, WorkerError>(())
    })
    .await
    .map_err(|_| {
        fault(&inner);
        error("start_unknown")
    })??;
    let redactor = (inner.services.redactors)();
    let mut mapper = Normalizer::new(
        HostBinding::new(
            snapshot.key.clone(),
            job.ticket.clone(),
            job.generation,
            job.public_turn.clone(),
        )
        .map_err(|_| protocol())?,
        Default::default(),
        redactor,
    )
    .map_err(|_| protocol())?;
    let callback = TrustedCallback {
        ticket: job.ticket.clone(),
        generation: job.generation,
    };
    let mut accepted = false;
    let mut tid = None;
    let mut done = Some(done);
    let mut early = Vec::new();
    let mut early_bytes = 0usize;
    let mut cancel = job.cancel.subscribe();
    let mut failure_rx = job.failure.subscribe();
    loop {
        if job.cancelled() {
            return Err(interrupted());
        }
        let event = tokio::select! {biased;
            v=events.recv()=>v.ok_or_else(protocol)?,
            _=cancel.changed()=>return Err(interrupted()),
            e=async {failure_rx.wait_for(|e| e.is_some()).await.ok().and_then(|e| e.clone())}=>return Err(e.unwrap_or_else(protocol)),
            _=tokio::time::sleep_until(inner.config.start_deadline.into()),if !accepted=>return Err(error("start_unknown"))
        };
        match event {
            Event::Accepted(evidence) => {
                if accepted {
                    return Err(protocol());
                }
                let service = inner.services.store.clone();
                let a = attempt.clone();
                let receipt = store(
                    &inner,
                    &job,
                    Box::pin(async move { service.accept_started(a, evidence).await }),
                )
                .await?;
                if !receipt.matches(attempt.attempt()) || receipt.native_session_id() != native_sid
                {
                    return Err(protocol());
                }
                tid = Some(receipt.native_turn_id().to_owned());
                mapper
                    .pin_native(&callback, Some(&native_sid), tid.as_deref())
                    .map_err(|_| protocol())?;
                live(&inner, &job)?;
                if job
                    .publication
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err(interrupted());
                }
                let sender = start
                    .lock()
                    .expect("start")
                    .take()
                    .ok_or_else(unavailable)?;
                let completion = done.take().ok_or_else(unavailable)?;
                let closed = job.closed.subscribe();
                let _ = sender.send(Ok(Started {
                    turn_id: job.public_turn.clone(),
                    done: Box::pin(async move {
                        await_owned(completion, closed)
                            .await
                            .unwrap_or_else(|error| failure(&error).into())
                    }),
                }));
                accepted = true;
                if !receipt_ready(&inner, &job).await {
                    return Err(interrupted());
                }
                let started =
                    json!({"type":"turn.started","sessionId":native_sid,"turnId":tid,"payload":{}});
                normalized(&inner, &job, &mut mapper, &callback, &started).await?;
                for e in std::mem::take(&mut early) {
                    if let Some(outcome) = process_event(
                        &inner,
                        &job,
                        &mut mapper,
                        &callback,
                        e,
                        NativeTurn {
                            sid: &native_sid,
                            tid: tid.as_deref().unwrap(),
                            input: attempt.host_input_id(),
                        },
                    )
                    .await?
                    {
                        return Ok(outcome);
                    }
                }
            }
            Event::Native(event) => {
                if !accepted {
                    early_bytes = early_bytes.saturating_add(event.bytes);
                    if early.len() >= 128 || early_bytes > EARLY_BYTES {
                        return Err(error("capacity"));
                    }
                    early.push(event);
                } else if let Some(outcome) = process_event(
                    &inner,
                    &job,
                    &mut mapper,
                    &callback,
                    event,
                    NativeTurn {
                        sid: &native_sid,
                        tid: tid.as_deref().ok_or_else(protocol)?,
                        input: attempt.host_input_id(),
                    },
                )
                .await?
                {
                    return Ok(outcome);
                }
            }
            Event::Eof => return Err(error("start_unknown")),
        }
    }
}
async fn normalized(
    inner: &Inner,
    job: &Job,
    mapper: &mut Normalizer,
    callback: &TrustedCallback,
    event: &Value,
) -> Result<Option<Option<String>>, WorkerError> {
    let batch = mapper.push(callback, event);
    if batch.fault.is_some() {
        return Err(error("redaction_failed"));
    }
    let text = batch.signals.into_iter().find_map(|signal| match signal {
        crate::zcode_events::Signal::TurnEnded { text, .. } => Some(text),
        _ => None,
    });
    for draft in batch.drafts {
        append(
            inner,
            job,
            serde_json::to_value(draft).map_err(|_| protocol())?,
        )
        .await?;
    }
    Ok(text)
}
struct NativeTurn<'a> {
    sid: &'a str,
    tid: &'a str,
    input: &'a str,
}
async fn process_event(
    inner: &Inner,
    job: &Job,
    mapper: &mut Normalizer,
    callback: &TrustedCallback,
    event: BufferedEvent,
    binding: NativeTurn<'_>,
) -> Result<Option<WorkerCompletion>, WorkerError> {
    let event = event.take();
    if event.sid != binding.sid
        || event.tid.as_deref() != Some(binding.tid)
        || event.input.as_deref().is_some_and(|v| v != binding.input)
    {
        return Err(protocol());
    }
    let text = normalized(inner, job, mapper, callback, &event.frame).await?;
    Ok(event.terminal.map(|outcome| {
        if outcome == Outcome::Success
            && let Some(text) = text
        {
            WorkerCompletion::normalized(
                outcome,
                crate::codex_events::TurnOutcome {
                    turn_id: job.public_turn.clone(),
                    ok: true,
                    error_code: None,
                    message: None,
                    text: text.filter(|s| !s.is_empty()),
                },
            )
        } else {
            WorkerCompletion::unqualified(outcome, CompletionUnavailable::Disposition)
        }
    }))
}

mod event_profile {
    use super::*;
    use serde_json::Map;
    pub(super) struct Event {
        pub sid: String,
        pub tid: Option<String>,
        pub input: Option<String>,
        pub frame: Value,
        pub terminal: Option<Outcome>,
    }
    impl Event {
        pub fn bytes(&self) -> usize {
            self.frame.to_string().len()
        }
    }
    fn fields(
        o: &Map<String, Value>,
        required: &[&str],
        optional: &[&str],
    ) -> Result<(), WorkerError> {
        if required.iter().any(|k| !o.contains_key(*k))
            || o.keys()
                .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
        {
            Err(protocol())
        } else {
            Ok(())
        }
    }
    fn string<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a str, WorkerError> {
        o.get(key).and_then(Value::as_str).ok_or_else(protocol)
    }
    fn optional_string(o: &Map<String, Value>, key: &str) -> Result<Option<String>, WorkerError> {
        o.get(key)
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(protocol))
            .transpose()
    }
    fn number(v: &Value) -> Result<(), WorkerError> {
        if !v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
            Err(protocol())
        } else {
            Ok(())
        }
    }
    fn uint(v: &Value) -> Result<(), WorkerError> {
        if !v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991) {
            Err(protocol())
        } else {
            Ok(())
        }
    }
    fn optional_bool(o: &Map<String, Value>, key: &str) -> Result<(), WorkerError> {
        if o.get(key).is_some_and(|v| !v.is_boolean()) {
            Err(protocol())
        } else {
            Ok(())
        }
    }
    pub(super) fn parse(
        notification: codec::BoundedNotification,
    ) -> Result<Option<Event>, WorkerError> {
        if notification.method() != "session/event" {
            return Ok(None);
        }
        let frame = notification.untrusted_params();
        let o = frame.as_object().ok_or_else(protocol)?;
        let kind = string(o, "type")?;
        if !["model.streaming", "turn.completed", "turn.failed"].contains(&kind) {
            return Ok(None);
        }
        let p = o
            .get("payload")
            .and_then(Value::as_object)
            .ok_or_else(protocol)?;
        let terminal = match kind {
            "model.streaming" => {
                fields(
                    p,
                    &["kind"],
                    &[
                        "assistantMessageId",
                        "delta",
                        "done",
                        "input",
                        "partId",
                        "providerExecuted",
                        "toolCallId",
                        "toolName",
                    ],
                )?;
                let k = string(p, "kind")?;
                if ![
                    "start",
                    "finish",
                    "error",
                    "text_start",
                    "text_delta",
                    "text_end",
                    "reasoning_start",
                    "reasoning_delta",
                    "reasoning_end",
                    "tool_input_start",
                    "tool_input_delta",
                    "tool_input_end",
                    "tool_call",
                ]
                .contains(&k)
                {
                    return Err(protocol());
                }
                for key in [
                    "assistantMessageId",
                    "delta",
                    "partId",
                    "toolCallId",
                    "toolName",
                ] {
                    optional_string(p, key)?;
                }
                optional_bool(p, "done")?;
                optional_bool(p, "providerExecuted")?;
                None
            }
            "turn.completed" => {
                fields(
                    p,
                    &[
                        "response",
                        "tokenCount",
                        "toolCallCount",
                        "duration",
                        "resultType",
                    ],
                    &[
                        "usage",
                        "historyRoundCount",
                        "cacheStats",
                        "inputId",
                        "backgroundSubagentResultConsumed",
                    ],
                )?;
                string(p, "response")?;
                uint(&p["tokenCount"])?;
                uint(&p["toolCallCount"])?;
                number(&p["duration"])?;
                if let Some(v) = p.get("historyRoundCount") {
                    uint(v)?;
                }
                if let Some(v) = p.get("cacheStats") {
                    let cache = v.as_object().ok_or_else(protocol)?;
                    fields(
                        cache,
                        &["totalMessages", "cachedMessages", "lastCacheHit"],
                        &["cacheReadTokens"],
                    )?;
                    uint(&cache["totalMessages"])?;
                    uint(&cache["cachedMessages"])?;
                    if !cache["lastCacheHit"].is_boolean() {
                        return Err(protocol());
                    }
                    if let Some(v) = cache.get("cacheReadTokens") {
                        uint(v)?;
                    }
                }
                optional_bool(p, "backgroundSubagentResultConsumed")?;
                Some(match string(p, "resultType")? {
                    "success" => Outcome::Success,
                    "cancelled" => Outcome::Interrupted,
                    "error_max_turns"
                    | "error_max_budget"
                    | "error_during_execution"
                    | "error_max_tool_calls" => failure(&error("provider_failed")),
                    _ => return Err(protocol()),
                })
            }
            "turn.failed" => {
                fields(
                    p,
                    &["error", "turnPhase"],
                    &["inputId", "backgroundSubagentResultConsumed"],
                )?;
                string(p, "turnPhase")?;
                let e = p["error"].as_object().ok_or_else(protocol)?;
                fields(
                    e,
                    &["type", "message"],
                    &[
                        "stack",
                        "code",
                        "detail",
                        "underlyingErrorMessage",
                        "underlyingErrorDetail",
                        "attribution",
                        "retryable",
                        "data",
                    ],
                )?;
                if string(e, "type")?.trim().is_empty() || string(e, "message")?.trim().is_empty() {
                    return Err(protocol());
                }
                for key in [
                    "stack",
                    "code",
                    "detail",
                    "underlyingErrorMessage",
                    "underlyingErrorDetail",
                ] {
                    optional_string(e, key)?;
                }
                optional_bool(e, "retryable")?;
                optional_bool(p, "backgroundSubagentResultConsumed")?;
                Some(failure(&error("provider_failed")))
            }
            _ => unreachable!(),
        };
        let input = optional_string(p, "inputId")?;
        if input.as_deref().is_some_and(|s| s.trim().is_empty()) {
            return Err(protocol());
        }
        Ok(Some(Event {
            sid: string(o, "sessionId")?.into(),
            tid: optional_string(o, "turnId")?,
            input,
            frame: frame.clone(),
            terminal,
        }))
    }
}

#[cfg(test)]
mod cleanup_wait_tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };

    #[test]
    fn existing_unknown_cleanup_wins_over_an_already_ready_result() {
        let (send, receive) = oneshot::channel();
        send.send(7u8).unwrap();
        let (_closed, watching) = watch::channel(Closed::Unconfirmed);
        let mut waiting = Box::pin(await_owned(receive, watching));
        let Poll::Ready(Err(error)) = waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("unknown cleanup authorized a ready result");
        };
        assert_eq!(error.code, "cleanup_unconfirmed");
    }

    #[test]
    fn cleanup_transition_and_ready_result_in_the_same_poll_fail_closed() {
        let (send, receive) = oneshot::channel();
        let (closed, watching) = watch::channel(Closed::Pending);
        let mut waiting = Box::pin(await_owned(receive, watching));
        let mut context = Context::from_waker(Waker::noop());
        assert!(waiting.as_mut().poll(&mut context).is_pending());
        send.send(7u8).unwrap();
        closed.send_replace(Closed::Unconfirmed);
        let Poll::Ready(Err(error)) = waiting.as_mut().poll(&mut context) else {
            panic!("ready result hid a cleanup transition");
        };
        assert_eq!(error.code, "cleanup_unconfirmed");
    }

    #[test]
    fn confirmed_cleanup_does_not_create_an_absent_native_result() {
        let (send, receive) = oneshot::channel::<u8>();
        let (_closed, watching) = watch::channel(Closed::Confirmed);
        let mut waiting = Box::pin(await_owned(receive, watching));
        let mut context = Context::from_waker(Waker::noop());
        assert!(waiting.as_mut().poll(&mut context).is_pending());
        drop(send);
        let Poll::Ready(Err(error)) = waiting.as_mut().poll(&mut context) else {
            panic!("confirmed cleanup fabricated native success");
        };
        assert_eq!(error.code, "provider_unavailable");
    }

    #[test]
    fn lost_pending_cleanup_owner_cannot_authorize_a_ready_result() {
        let (send, receive) = oneshot::channel();
        send.send(7u8).unwrap();
        let (closed, watching) = watch::channel(Closed::Pending);
        drop(closed);
        let mut waiting = Box::pin(await_owned(receive, watching));
        let Poll::Ready(Err(error)) = waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        else {
            panic!("missing cleanup proof authorized a result");
        };
        assert_eq!(error.code, "cleanup_unconfirmed");
    }
}
