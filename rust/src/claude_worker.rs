//! Owned ordinary Claude turns. Trusted host services supply policy, persistence
//! and scoped MCP; this module is not an RPC spawn or authorization endpoint.
//! The first integration retires the process after every turn; warm process
//! reuse, background work and the daemon owner bridge remain separate work.
use crate::turn_coordinator::{Outcome, Ticket};
use crate::turn_driver::{
    DispatchDecision, DispatchGate, Driver, EventSink, Progress, Started, Task, Worker, WorkerError,
};
use crate::turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot};
use crate::worker_process::{Framing, Launch, PreparedInput, Process, StopSignal};
use crate::{claude_events, claude_launch, prompt_attachments};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU8, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::sync::{Notify, oneshot, watch};

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
fn interrupted() -> WorkerError {
    error("interrupted", "Claude turn was cancelled")
}
fn unavailable() -> WorkerError {
    error("provider_unavailable", "Claude worker is unavailable")
}
fn native_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}
fn uuid() -> Result<String, WorkerError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| unavailable())?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let raw = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[12..16],
        &raw[16..20],
        &raw[20..]
    ))
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SessionStage {
    Reserved,
    Initialized,
    /// The joined worker proves stdin dispatch never reached its first poll.
    AbortedBeforeInput,
}
pub struct SessionWrite {
    session: SessionKey,
    ticket: Ticket,
    native_id: String,
    previous_id: String,
    stage: SessionStage,
    permission_mode: Option<String>,
    seal: Arc<()>,
}
impl SessionWrite {
    pub fn session(&self) -> &SessionKey {
        &self.session
    }
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn native_id(&self) -> &str {
        &self.native_id
    }
    pub fn previous_id(&self) -> &str {
        &self.previous_id
    }
    pub fn stage(&self) -> SessionStage {
        self.stage
    }
    pub fn permission_mode(&self) -> Option<&str> {
        self.permission_mode.as_deref()
    }
    /// A trusted store calls this only after its checked durable transaction.
    pub fn acknowledge(self) -> SessionReceipt {
        SessionReceipt(self.seal)
    }
}
pub struct SessionReceipt(Arc<()>);
#[derive(Clone, Copy)]
pub enum StoreError {
    Rejected,
    Unknown,
}
pub trait SessionStore: Send + Sync + 'static {
    /// Reserve checks dispatch authority; Initialized may retain diagnostic
    /// evidence after cancellation but must never resurrect/replace a session.
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>>;
}

#[derive(Clone)]
pub struct McpContext {
    pub session: SessionKey,
    pub ticket: Ticket,
    pub generation: u64,
    /// Host-selected Pult input identity, before Driver acceptance. Consumers
    /// still wait for the actual accepted user receipt before using provenance.
    pub public_turn: String,
    pub approval: Approval,
}
pub trait ScopedMcp: Send + Sync + 'static {
    /// All resources remain owned by exact ticket/generation even on panic.
    fn prepare(&self, context: McpContext) -> Task<Result<PathBuf, WorkerError>>;
    /// Synchronous in-memory revocation only; never waits for filesystem IO.
    fn revoke(&self, ticket: &Ticket, generation: u64);
    fn cleanup(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>>;
}
pub struct Services {
    pub driver: Weak<Driver>,
    pub sink: Arc<dyn EventSink>,
    pub gate: Arc<dyn DispatchGate>,
    pub store: Arc<dyn SessionStore>,
    pub redactors: Arc<dyn Fn() -> Box<dyn claude_events::Redactor> + Send + Sync>,
    pub fatal_storage: Arc<dyn Fn() + Send + Sync>,
    pub mcp: Option<Arc<dyn ScopedMcp>>,
}
pub struct Config {
    pub session: SessionKey,
    pub home: PathBuf,
    pub launch: Launch,
    pub provider_session_id: Option<String>,
    pub initialized: bool,
    pub fork_on_resume: bool,
    pub broker: bool,
    pub setting_sources: Option<String>,
    pub protect_dirs: Vec<String>,
    pub add_dirs: Vec<String>,
    pub add_dir_roots: Vec<String>,
    pub start_timeout: Duration,
    pub attachments: Vec<prompt_attachments::PromptAttachment>,
}
#[derive(Clone, Copy)]
enum Closed {
    Pending,
    Confirmed,
    Unconfirmed,
}
struct Identity {
    native_id: String,
    initialized: bool,
    fork: bool,
}
struct State {
    active: Option<Arc<Job>>,
    closed: bool,
    retired: bool,
    generation: u64,
    identity: Identity,
}
struct Inner {
    config: Config,
    services: Services,
    state: Mutex<State>,
}
struct Job {
    ticket: Ticket,
    generation: u64,
    public_id: String,
    input_id: String,
    cancel: watch::Sender<bool>,
    closed: watch::Sender<Closed>,
    retry: Notify,
    signal: Mutex<Option<StopSignal>>,
    dispatch: AtomicU8,
}
impl Job {
    fn cancel(&self) {
        let _ = self
            .dispatch
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
        self.cancel.send_replace(true);
        if let Some(signal) = self.signal.lock().expect("Claude signal").as_ref() {
            signal.request_stop();
        }
        self.retry.notify_one();
    }
    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
}
pub struct ClaudeWorker(Arc<Inner>);
impl ClaudeWorker {
    pub fn new(config: Config, services: Services) -> Result<Arc<Self>, WorkerError> {
        if config.session.validate().is_err()
            || !config.home.is_absolute()
            || config.launch.validate_shape().is_err()
            || config.start_timeout.is_zero()
            || config.start_timeout > Duration::from_secs(120)
            || (config.broker && services.mcp.is_none())
            || (config.initialized && config.provider_session_id.is_none())
            || config.attachments.len() > prompt_attachments::MAX_PROMPT_ATTACHMENTS
        {
            return Err(error(
                "invalid_params",
                "invalid Claude worker configuration",
            ));
        }
        let id = config.provider_session_id.clone().map_or_else(uuid, Ok)?;
        if !native_id(&id) {
            return Err(error("invalid_params", "invalid Claude session identity"));
        }
        let identity = Identity {
            native_id: id,
            initialized: config.initialized,
            fork: config.fork_on_resume,
        };
        Ok(Arc::new(Self(Arc::new(Inner {
            config,
            services,
            state: Mutex::new(State {
                active: None,
                closed: false,
                retired: false,
                generation: 0,
                identity,
            }),
        }))))
    }
    /// Admission hint only: this facade must never send another turn. Recreate
    /// from fresh checked owner state only after Driver cleanup is confirmed;
    /// false is not readiness, and true is never process/IO cleanup proof.
    pub fn is_retired(&self) -> bool {
        self.0.state.lock().expect("Claude state").retired
    }
    pub fn begin_shutdown(&self) {
        let job = {
            let mut state = self.0.state.lock().expect("Claude state");
            state.closed = true;
            state.active.clone()
        };
        if let Some(job) = job {
            job.cancel();
        }
    }
}
impl Drop for ClaudeWorker {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}
impl Worker for ClaudeWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let runtime = match tokio::runtime::Handle::try_current() {
            Ok(v) => v,
            Err(_) => return Box::pin(async { Err(unavailable()) }),
        };
        if ticket.session() != &self.0.config.session
            || snapshot.key != self.0.config.session
            || snapshot.provider != Provider::Claude
            || snapshot.cwd != self.0.config.launch.cwd
            || snapshot.validate().is_err()
        {
            return Box::pin(async { Err(error("invalid_params", "invalid Claude turn scope")) });
        }
        if self.is_retired() {
            return Box::pin(async { Err(retired_error()) });
        }
        let progress = match self
            .0
            .services
            .driver
            .upgrade()
            .and_then(|driver| driver.progress_for_ticket(&ticket))
        {
            Some(v) => v,
            None => return Box::pin(async { Err(unavailable()) }),
        };
        let mut state = self.0.state.lock().expect("Claude state");
        if state.retired {
            return Box::pin(async { Err(retired_error()) });
        }
        if state.closed || state.active.is_some() {
            return Box::pin(async { Err(error("busy", "Claude worker already owns a turn")) });
        }
        let Some(generation) = state.generation.checked_add(1) else {
            return Box::pin(async { Err(unavailable()) });
        };
        let input_id = match uuid() {
            Ok(v) => v,
            Err(e) => return Box::pin(async { Err(e) }),
        };
        state.generation = generation;
        let job = Arc::new(Job {
            ticket,
            generation,
            public_id: format!("claude-turn-{input_id}"),
            input_id,
            cancel: watch::channel(false).0,
            closed: watch::channel(Closed::Pending).0,
            retry: Notify::new(),
            signal: Mutex::new(None),
            dispatch: AtomicU8::new(0),
        });
        let identity = Identity {
            native_id: state.identity.native_id.clone(),
            initialized: state.identity.initialized,
            fork: state.identity.fork,
        };
        state.active = Some(job.clone());
        drop(state);
        let (started, receiver) = oneshot::channel();
        runtime.spawn(run(
            self.0.clone(),
            job,
            snapshot,
            text,
            identity,
            progress,
            started,
        ));
        Box::pin(async move { receiver.await.unwrap_or_else(|_| Err(unavailable())) })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        let job = self
            .0
            .state
            .lock()
            .expect("Claude state")
            .active
            .clone()
            .filter(|job| job.ticket == ticket);
        if let Some(job) = job {
            job.cancel();
            let mut closed = job.closed.subscribe();
            Box::pin(async move {
                loop {
                    let status = *closed.borrow();
                    match status {
                        Closed::Confirmed => return Ok(()),
                        Closed::Unconfirmed => {
                            return Err(error(
                                "cleanup_unconfirmed",
                                "Claude cleanup is unconfirmed",
                            ));
                        }
                        Closed::Pending => {}
                    }
                    if closed.changed().await.is_err() {
                        return Err(unavailable());
                    }
                }
            })
        } else {
            Box::pin(async { Ok(()) })
        }
    }
}

fn retired_error() -> WorkerError {
    error(
        "worker_retired",
        "Claude worker requires recreation from checked owner state",
    )
}
fn retire(inner: &Inner) {
    // Never clear the active job/closed watch: retirement revokes new admission,
    // while the existing owner still joins persistence, process and MCP cleanup.
    inner.state.lock().expect("Claude state").retired = true;
}
fn fatal(inner: &Inner) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (inner.services.fatal_storage)()
    }));
}
async fn persist(
    inner: &Inner,
    job: &Job,
    id: &str,
    previous: &str,
    stage: SessionStage,
    mode: Option<String>,
) -> Result<(), WorkerError> {
    let seal = Arc::new(());
    let expected = seal.clone();
    let store = inner.services.store.clone();
    let request = SessionWrite {
        session: inner.config.session.clone(),
        ticket: job.ticket.clone(),
        native_id: id.into(),
        previous_id: previous.into(),
        stage,
        permission_mode: mode,
        seal,
    };
    match tokio::spawn(async move { store.persist(request).await }).await {
        Ok(Ok(receipt)) if Arc::ptr_eq(&expected, &receipt.0) => Ok(()),
        Ok(Err(StoreError::Rejected)) => Err(error(
            "access_denied",
            "Claude session persistence was rejected",
        )),
        _ => {
            fatal(inner);
            Err(error(
                "storage_unknown",
                "Claude session persistence is unconfirmed",
            ))
        }
    }
}
async fn append(inner: &Inner, value: Value) -> Result<(), WorkerError> {
    let sink = inner.services.sink.clone();
    match tokio::spawn(async move { sink.append(value).await }).await {
        Ok(Ok(receipt))
            if receipt.id > 0 && receipt.id <= 9_007_199_254_740_991 && !receipt.ts.is_empty() =>
        {
            Ok(())
        }
        _ => {
            fatal(inner);
            Err(error(
                "storage_unknown",
                "Claude event persistence is unconfirmed",
            ))
        }
    }
}
async fn effective(
    inner: &Arc<Inner>,
    job: &Arc<Job>,
    snapshot: &TurnSnapshot,
) -> Result<Approval, WorkerError> {
    let gate = inner.services.gate.clone();
    let ticket = job.ticket.clone();
    let snapshot = snapshot.clone();
    tokio::task::spawn_blocking(move || {
        let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            gate.check(&ticket, &snapshot)
        }))
        .unwrap_or(DispatchDecision::Deny);
        match decision {
            DispatchDecision::Allow => Ok(snapshot.settings.approval),
            DispatchDecision::Restrict(mode) if rank(mode) <= rank(snapshot.settings.approval) => {
                Ok(mode)
            }
            _ => Err(error(
                "access_denied",
                "Claude dispatch authority was revoked",
            )),
        }
    })
    .await
    .map_err(|_| unavailable())?
}
// The caller retains the vault through every blocking/async task and panic.
// Only stdin writing borrows the guard; child cleanup ownership stays in vault.
struct FirstInput {
    future: Task<Result<(), WorkerError>>,
    result: Poll<Result<(), WorkerError>>,
}
#[cfg(test)]
struct PollFault {
    panic_on: usize,
    polls: Arc<std::sync::atomic::AtomicUsize>,
}
#[cfg(test)]
fn simulate_poll_panic(
    mut retained: Task<Result<(), WorkerError>>,
    fault: PollFault,
) -> Task<Result<(), WorkerError>> {
    Box::pin(std::future::poll_fn(move |cx| {
        // Keep the real send future and its owned Process guard in this future.
        // Only the poll result is synthetic: this does not exercise write_all.
        let _keep_guard = &mut retained;
        let poll = fault.polls.fetch_add(1, Ordering::AcqRel) + 1;
        assert!(poll != fault.panic_on, "synthetic native stdin poll panic");
        cx.waker().wake_by_ref();
        Poll::Pending
    }))
}
async fn checked_send(
    gate: Arc<dyn DispatchGate>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    approval: Approval,
    process: &mut Option<Process>,
    frame: PreparedInput,
    #[cfg(test)] poll_fault: Option<PollFault>,
) -> Result<(), WorkerError> {
    let vault = Arc::new(tokio::sync::Mutex::new(Some(
        process.take().ok_or_else(unavailable)?,
    )));
    let writing = vault.clone();
    let first = tokio::task::spawn_blocking(move || {
        let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            gate.check(&job.ticket, &snapshot)
        }))
        .unwrap_or(DispatchDecision::Deny);
        let allowed = match decision {
            DispatchDecision::Allow => snapshot.settings.approval == approval,
            DispatchDecision::Restrict(mode) => {
                rank(mode) <= rank(snapshot.settings.approval) && mode == approval
            }
            DispatchDecision::Deny => false,
        };
        if !allowed {
            return Err(error(
                "access_changed",
                "Claude dispatch authority changed before input",
            ));
        }
        if job.cancelled()
            || job
                .dispatch
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err(interrupted());
        }
        // This private, fresh vault has no other locker. Avoid async lock/coop
        // before the first input poll after the final check and cancellation CAS.
        let mut guard = writing.try_lock_owned().map_err(|_| unavailable())?;
        let future: Task<Result<(), WorkerError>> = Box::pin(async move {
            guard
                .as_mut()
                .ok_or_else(unavailable)?
                .send_prepared(frame)
                .await
                .map_err(|_| error("unknown_send", "Claude input delivery is unknown"))
        });
        #[cfg(test)]
        let future = match poll_fault {
            Some(fault) => simulate_poll_panic(future, fault),
            None => future,
        };
        let mut future = future;
        let result = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()));
        Ok(FirstInput { future, result })
    })
    .await;
    let result = match first {
        Ok(Ok(FirstInput {
            result: Poll::Ready(result),
            ..
        })) => result,
        Ok(Ok(FirstInput {
            future,
            result: Poll::Pending,
        })) => {
            // A later poll can panic too. Joining this owned task drops its
            // guard before recovery; it is never aborted or detached on cancel.
            tokio::spawn(future)
                .await
                .unwrap_or_else(|_| Err(unavailable()))
        }
        Ok(Err(err)) => Err(err),
        Err(_) => Err(unavailable()),
    };
    // Even an unwind in the first poll never took Process out of this vault.
    *process = vault.lock().await.take();
    result
}

fn reported_mode_allowed(approval: Approval, reported: Option<&str>) -> bool {
    match reported {
        None => true, // Older native versions omit the diagnostic mode field.
        Some("manual" | "default" | "plan") => true,
        Some("acceptEdits") => matches!(
            approval,
            Approval::Workspace | Approval::Full | Approval::Inherit
        ),
        Some("bypassPermissions" | "dontAsk" | "auto") => {
            matches!(approval, Approval::Full | Approval::Inherit)
        }
        Some(_) => false,
    }
}

fn rank(mode: Approval) -> u8 {
    match mode {
        Approval::ReadOnly => 0,
        Approval::Ask => 1,
        Approval::Workspace => 2,
        Approval::Full | Approval::Inherit => 3,
    }
}
fn normalizer(
    inner: &Inner,
    job: &Job,
    id: &str,
) -> Result<claude_events::Normalizer, WorkerError> {
    let redactor = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (inner.services.redactors)()
    }))
    .map_err(|_| unavailable())?;
    claude_events::Normalizer::new(
        claude_events::Binding {
            session: inner.config.session.clone(),
            ticket: job.ticket.clone(),
            generation: job.generation,
            provider_session_id: id.into(),
            public_turn_id: job.public_id.clone(),
            user_message_uuid: job.input_id.clone(),
            session_started: false,
        },
        Default::default(),
        redactor,
    )
    .map_err(|_| unavailable())
}
async fn receipt_ready(progress: &mut watch::Receiver<Progress>, job: &Job) -> bool {
    loop {
        match progress.borrow().clone() {
            Progress::Running(receipt) => {
                return receipt.user_event_id > 0 && receipt.turn_id == job.public_id;
            }
            Progress::Starting => {}
            _ => return false,
        }
        if progress.changed().await.is_err() {
            return false;
        }
    }
}
async fn revoke_and_cleanup(inner: &Inner, job: &Job) -> bool {
    if !inner.config.broker {
        return true;
    }
    let Some(mcp) = inner.services.mcp.clone() else {
        return false;
    };
    let revoked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        mcp.revoke(&job.ticket, job.generation)
    }))
    .is_ok();
    let ticket = job.ticket.clone();
    let generation = job.generation;
    let cleaned = matches!(
        tokio::spawn(async move { mcp.cleanup(ticket, generation).await }).await,
        Ok(Ok(()))
    );
    if !revoked {
        fatal(inner);
    }
    revoked && cleaned
}
async fn cleanup(inner: &Inner, job: &Job, process: &mut Option<Process>) {
    if inner.config.broker
        && let Some(mcp) = &inner.services.mcp
    {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mcp.revoke(&job.ticket, job.generation)
        }));
    }
    if let Some(signal) = job.signal.lock().expect("Claude signal").as_ref() {
        signal.request_stop();
    }
    loop {
        let process_ok = if let Some(process) = process.as_mut() {
            process.stop().await.is_ok()
        } else {
            true
        };
        let mcp_ok = revoke_and_cleanup(inner, job).await;
        if process_ok && mcp_ok {
            break;
        }
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
        job.closed.send_replace(Closed::Pending);
    }
    job.signal.lock().expect("Claude signal").take();
}

#[allow(clippy::too_many_arguments)]
async fn run(
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    mut identity: Identity,
    mut progress: watch::Receiver<Progress>,
    started: oneshot::Sender<Result<Started, WorkerError>>,
) {
    let mut started = Some(started);
    let mut process = None;
    let (done, done_rx) = oneshot::channel();
    let mut result = turn(
        &inner,
        &job,
        &snapshot,
        text,
        &mut identity,
        &mut process,
        &mut progress,
        &mut started,
        done_rx,
    )
    .await;
    cleanup(&inner, &job, &mut process).await;
    // Revoke/retire the process and MCP first, then clear only a reservation
    // whose input was never dispatched. CAS=1 is uncertain even if write failed.
    if job.dispatch.load(Ordering::Acquire) != 1
        && let Err(err) = persist(
            &inner,
            &job,
            &identity.native_id,
            &identity.native_id,
            SessionStage::AbortedBeforeInput,
            None,
        )
        .await
    {
        result = Err(err);
    }
    {
        let mut state = inner.state.lock().expect("Claude state");
        if state
            .active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &job))
        {
            state.active = None;
        }
    }
    job.closed.send_replace(Closed::Confirmed);
    match result {
        Ok(outcome) => {
            let _ = done.send(if job.cancelled() {
                Outcome::Interrupted
            } else {
                outcome
            });
        }
        Err(err) => {
            if let Some(sender) = started.take() {
                let _ = sender.send(Err(err));
            } else {
                let _ = done.send(failure(&err.code, &err.message));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn turn(
    inner: &Arc<Inner>,
    job: &Arc<Job>,
    snapshot: &TurnSnapshot,
    text: String,
    identity: &mut Identity,
    process: &mut Option<Process>,
    progress: &mut watch::Receiver<Progress>,
    started: &mut Option<oneshot::Sender<Result<Started, WorkerError>>>,
    done: oneshot::Receiver<Outcome>,
) -> Result<Outcome, WorkerError> {
    if job.cancelled() {
        return Err(interrupted());
    }
    let approval = effective(inner, job, snapshot).await?;
    persist(
        inner,
        job,
        &identity.native_id,
        &identity.native_id,
        SessionStage::Reserved,
        None,
    )
    .await?;
    if job.cancelled() {
        return Err(interrupted());
    }
    let mcp_path = if inner.config.broker {
        let mcp = inner.services.mcp.clone().ok_or_else(unavailable)?;
        let context = McpContext {
            session: inner.config.session.clone(),
            ticket: job.ticket.clone(),
            generation: job.generation,
            public_turn: job.public_id.clone(),
            approval,
        };
        Some(
            tokio::spawn(async move { mcp.prepare(context).await })
                .await
                .map_err(|_| unavailable())??,
        )
    } else {
        None
    };
    if job.cancelled() {
        return Err(interrupted());
    }
    let options = claude_launch::Options {
        session_id: identity.native_id.clone(),
        resume: identity.initialized,
        fork_on_resume: identity.fork,
        model: snapshot.settings.model.clone(),
        effort: snapshot.settings.effort.clone(),
        approval,
        setting_sources: inner.config.setting_sources.clone(),
        mcp_config_path: mcp_path
            .map(|p| p.to_str().map(str::to_owned).ok_or_else(unavailable))
            .transpose()?,
        protect_dirs: inner.config.protect_dirs.clone(),
        add_dirs: inner.config.add_dirs.clone(),
        add_dir_roots: inner.config.add_dir_roots.clone(),
        ..Default::default()
    };
    let args = claude_launch::argv(&options)
        .map_err(|_| error("invalid_params", "invalid Claude launch policy"))?;
    let mut launch = inner.config.launch.clone();
    launch.args.extend(args.into_iter().map(Into::into));
    match Process::spawn_owned(launch, Framing::claude()).await {
        Ok(value) => *process = Some(value),
        Err(failure) => {
            *process = failure.process.map(|p| *p);
            return Err(unavailable());
        }
    }
    let signal = process.as_ref().ok_or_else(unavailable)?.stop_signal();
    *job.signal.lock().expect("Claude signal") = Some(signal);
    if job.cancelled() {
        return Err(interrupted());
    }
    append(inner,json!({"sessionId":inner.config.session.name,"provider":"claude","kind":"status.changed","data":{"status":"working","turnId":job.public_id}})).await?;
    // Input is encoded on the blocking pool before the final policy check.
    let context = if claude_launch::is_slash_command_turn(&text, inner.config.attachments.len()) {
        None
    } else {
        Some(format!(
            "<pult_runtime_context>\nprovider: claude; access: {}\n</pult_runtime_context>",
            approval.as_str()
        ))
    };
    let input_id = job.input_id.clone();
    let home = inner.config.home.clone();
    let session = inner.config.session.name.clone();
    let attachments = inner.config.attachments.clone();
    let frame = tokio::task::spawn_blocking(move || {
        let blocks = prompt_attachments::claude_prompt_attachment_blocks(
            &prompt_attachments::PromptAttachmentScope {
                home: &home,
                session_id: &session,
            },
            &attachments,
        )?;
        claude_launch::user_turn(&text, &input_id, context.as_deref(), &blocks)
            .and_then(|value| Framing::claude().encode(&value))
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| error("invalid_params", "Claude native input is unavailable"))?;
    checked_send(
        inner.services.gate.clone(),
        job.clone(),
        snapshot.clone(),
        approval,
        process,
        frame,
        #[cfg(test)]
        None,
    )
    .await?;
    let callback = claude_events::TrustedCallback {
        ticket: job.ticket.clone(),
        generation: job.generation,
    };
    let mut mapper = normalizer(inner, job, &identity.native_id)?;
    let mut cancel = job.cancel.subscribe();
    let mut output = process
        .as_mut()
        .ok_or_else(unavailable)?
        .take_output()
        .map_err(|_| unavailable())?;
    let deadline = tokio::time::sleep(inner.config.start_timeout);
    tokio::pin!(deadline);
    let mut accepted = false;
    let mut done = Some(done);
    let mut pending = VecDeque::new();
    let mut pending_bytes = 0usize;
    let mut init_seen = false;
    let mut acknowledged_id = None;
    loop {
        let frame = tokio::select! {biased; _=cancel.changed()=>return if accepted {Ok(Outcome::Interrupted)}else{Err(interrupted())}, _=&mut deadline,if !accepted=>return Err(error("unknown_send","Claude input acknowledgement timed out")),frame=output.recv()=>frame};
        let Some(frame) = frame else {
            return if accepted {
                Ok(failure(
                    "provider_unavailable",
                    "Claude exited without its matching result",
                ))
            } else {
                Err(unavailable())
            };
        };
        let frame = frame.map_err(|_| unavailable())?;
        if frame["type"] == "system" && frame["subtype"] == "init" {
            // Init can arrive from a subagent on the same process stream. Only
            // root attribution may establish this Ticket's durable identity.
            match frame.get("parent_tool_use_id") {
                None | Some(Value::Null) => {}
                Some(Value::String(parent)) if parent.is_empty() => {}
                Some(Value::String(_)) => {
                    retire(inner);
                    return Err(error(
                        "not_implemented",
                        "Claude subagent init is not owned by this root turn",
                    ));
                }
                Some(_) => {
                    retire(inner);
                    return Err(error(
                        "protocol_error",
                        "Claude init has invalid parent attribution",
                    ));
                }
            }
            let id = frame["session_id"]
                .as_str()
                .filter(|id| native_id(id))
                .ok_or_else(unavailable)?;
            if id != identity.native_id && !(identity.initialized && identity.fork) {
                return Err(error(
                    "protocol_error",
                    "Claude init identity did not match its owned conversation",
                ));
            }
            // Only an omitted field is legacy absence. Malformed presence must
            // not silently become None and bypass the reported-mode validation.
            let reported = match frame.get("permissionMode") {
                None => None,
                Some(Value::String(value))
                    if value.len() <= 128 && !value.chars().any(char::is_control) =>
                {
                    Some(value.clone())
                }
                Some(_) => {
                    retire(inner);
                    return Err(error(
                        "protocol_error",
                        "Claude reported an invalid permission mode",
                    ));
                }
            };
            // Native identity is diagnostic evidence, not permission to keep
            // running. The owner retains a valid matching ID/sticky report even
            // when it durably rejects the launch/current policy afterwards.
            let launch_allows = reported_mode_allowed(approval, reported.as_deref());
            if let Err(error) = persist(
                inner,
                job,
                id,
                &identity.native_id,
                SessionStage::Initialized,
                reported,
            )
            .await
            {
                retire(inner);
                return Err(error);
            }
            if !launch_allows {
                retire(inner);
                return Err(error(
                    "access_denied",
                    "Claude reported an unexpected permission mode",
                ));
            }
            if id != identity.native_id {
                identity.native_id = id.into();
                mapper = normalizer(inner, job, id)?;
            }
            identity.initialized = true;
            identity.fork = false;
            init_seen = true;
            let mut state = inner.state.lock().expect("Claude state");
            state.identity = Identity {
                native_id: identity.native_id.clone(),
                initialized: true,
                fork: false,
            };
        }
        let matching_ack = (frame["type"] == "command_lifecycle"
            && frame["command_uuid"].as_str() == Some(job.input_id.as_str()))
            || (frame["type"] == "result"
                && frame["user_message_uuids"]
                    .as_array()
                    .is_some_and(|values| {
                        values
                            .iter()
                            .any(|v| v.as_str() == Some(job.input_id.as_str()))
                    }));
        if matching_ack
            && let Some(sid) = frame["session_id"].as_str().filter(|id| native_id(id))
            && (sid == identity.native_id || identity.fork)
        {
            acknowledged_id = Some(sid.to_owned());
        }
        if frame["session_id"].as_str() != Some(identity.native_id.as_str()) {
            continue;
        }
        if !accepted && init_seen && acknowledged_id.as_deref() == Some(identity.native_id.as_str())
        {
            let completion = done.take().ok_or_else(unavailable)?;
            // The caller keeps ownership even if its start future disappeared.
            let sender = started.take().ok_or_else(unavailable)?;
            let _ = sender.send(Ok(Started {
                turn_id: job.public_id.clone(),
                done: Box::pin(async move {
                    completion
                        .await
                        .unwrap_or_else(|_| failure("worker_failed", "Claude completion was lost"))
                }),
            }));
            accepted = true;
            if !receipt_ready(progress, job).await {
                return Ok(Outcome::Interrupted);
            }
        }
        if !accepted {
            pending_bytes = pending_bytes
                .saturating_add(serde_json::to_vec(&frame).map_err(|_| unavailable())?.len());
            if pending.len() >= 128 || pending_bytes > 2 * 1024 * 1024 {
                return Err(error("capacity", "Claude pre-ack event budget exceeded"));
            }
            pending.push_back(frame);
            continue;
        }
        pending.push_back(frame);
        while let Some(frame) = pending.pop_front() {
            let batch = mapper.push(&callback, &frame);
            let stop_outcome = batch.signals.iter().find_map(|signal| match signal {
                claude_events::Signal::Deferred(
                    claude_events::Deferred::Subagent | claude_events::Deferred::Background,
                ) => Some(failure(
                    "not_implemented",
                    "Claude background execution requires the host lifecycle bridge",
                )),
                claude_events::Signal::Deferred(
                    claude_events::Deferred::CommandLifecycleFallback,
                ) => Some(failure(
                    "protocol_error",
                    "Claude completed the command without a matching result",
                )),
                claude_events::Signal::RetryStorm { .. } => Some(failure(
                    "blocked_network",
                    "Claude exceeded the retry limit",
                )),
                claude_events::Signal::ProviderBlocked { .. } => Some(failure(
                    "provider_unavailable",
                    "Claude provider blocked execution",
                )),
                _ => None,
            });
            for draft in batch.drafts {
                append(
                    inner,
                    serde_json::to_value(draft).map_err(|_| unavailable())?,
                )
                .await?;
            }
            // Preserve normalized provider evidence before the Driver terminal.
            // A stop signal still takes precedence over a coincident success.
            if let Some(outcome) = stop_outcome {
                return Ok(outcome);
            }
            if let Some(terminal) = batch.terminal {
                return Ok(if terminal.ok {
                    Outcome::Success
                } else {
                    failure(
                        "provider_unavailable",
                        terminal.message.as_deref().unwrap_or("Claude turn failed"),
                    )
                });
            }
        }
    }
}

#[cfg(test)]
mod vault_tests {
    use super::*;
    use crate::{turn_coordinator::Coordinator, turn_snapshot::TurnSettings};
    use std::{collections::BTreeMap, sync::atomic::AtomicUsize};
    async fn panic_retains_process(panic_on: usize) {
        crate::panic_guard::install();
        let temp = tempfile::tempdir().unwrap();
        // Cargo integration-test targets build this real supervisor. Running
        // this module alone also requires `cargo build --bin pult-worker-holder`.
        let holder = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("pult-worker-holder");
        assert!(
            holder.is_file(),
            "build the real pult-worker-holder before vault unit tests"
        );
        let mut process=Some(Process::spawn_owned(Launch {
            holder, program:"/usr/bin/python3".into(),
            args:vec!["-u".into(),"-c".into(),"import json,os,sys;print(json.dumps({'pid':os.getpid()}),flush=True);sys.stdin.read()".into()],
            cwd:temp.path().into(),env:BTreeMap::from([("PATH".into(),"/usr/bin:/bin".into()),("HOME".into(),temp.path().as_os_str().to_owned())]),
        },Framing::claude()).await.unwrap_or_else(|_|panic!("synthetic process startup failed")));
        let holder = process.as_ref().unwrap().pid();
        let child = process.as_mut().unwrap().recv().await.unwrap().unwrap()["pid"]
            .as_i64()
            .unwrap() as i32;
        let signal = process.as_ref().unwrap().stop_signal();
        let snapshot = TurnSnapshot {
            key: SessionKey {
                name: "vault".into(),
                created_at: "2026-11-12T00:00:00Z".into(),
            },
            provider: Provider::Claude,
            cwd: temp.path().into(),
            settings: TurnSettings::default(),
        };
        let mut coordinator = Coordinator::new(Default::default()).unwrap();
        let ticket = coordinator.reserve(snapshot.clone()).unwrap();
        let job = Arc::new(Job {
            ticket,
            generation: 1,
            public_id: "vault-public".into(),
            input_id: "vault-input".into(),
            cancel: watch::channel(false).0,
            closed: watch::channel(Closed::Pending).0,
            retry: Notify::new(),
            signal: Mutex::new(Some(signal.clone())),
            dispatch: AtomicU8::new(0),
        });
        let polls = Arc::new(AtomicUsize::new(0));
        let frame = Framing::claude().encode(&json!({"fixture":true})).unwrap();
        let result = checked_send(
            Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            job.clone(),
            snapshot,
            Approval::Ask,
            &mut process,
            frame,
            Some(PollFault {
                panic_on,
                polls: polls.clone(),
            }),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(polls.load(Ordering::Acquire), panic_on);
        assert_eq!(job.dispatch.load(Ordering::Acquire), 1);
        let mut retained = process.expect("panic lost cleanup ownership from the private vault");
        assert_eq!(retained.pid(), holder);
        assert!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(child), None).is_ok(),
            "the proof must retain a still-live provider until explicit stop"
        );
        retained.stop().await.unwrap();
        assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(child), None).is_err());
        assert!(!signal.request_stop());
    }
    #[tokio::test]
    async fn first_poll_join_error_retains_real_process_until_proven_cleanup() {
        tokio::time::timeout(Duration::from_secs(10), panic_retains_process(1))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn later_poll_join_error_retains_real_process_until_proven_cleanup() {
        tokio::time::timeout(Duration::from_secs(10), panic_retains_process(2))
            .await
            .unwrap();
    }
}
